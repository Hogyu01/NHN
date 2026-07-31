import {
  commandFailure,
  commandSuccess,
  cloneValue,
  freezeDeep,
} from "./result.js";
import {
  createDiagnostic,
  diagnosticFromError,
  DIAGNOSTIC_SEVERITY,
  describeError,
} from "./diagnostic.js";
import {
  createCommittedEvents,
  createEffectRequests,
  EventEffectJournal,
} from "./events.js";
import { AtomicTransaction, isStableIdentifier } from "./transaction.js";
import { GameStore } from "./store.js";

function rejectionDiagnostic(code, errorType, store, command, details, severity = DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND) {
  return createDiagnostic({
    severity,
    subsystem: "core.command-bus",
    code,
    errorType,
    commandId: typeof command?.commandId === "string" ? command.commandId : undefined,
    revision: store.revision,
    simulationTimeMs: Number.isSafeInteger(command?.issuedAtSimulationMs)
      ? command.issuedAtSimulationMs
      : undefined,
    details,
  });
}

function reject(store, diagnostic) {
  return commandFailure(store.revision, diagnostic.code, [diagnostic]);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateAndFreezeCommand(input, store) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return reject(store, rejectionDiagnostic(
      "MALFORMED_COMMAND",
      "CommandEnvelopeError",
      store,
      input,
      { field: "$", expected: "object" },
    ));
  }

  const checks = [
    [isStableIdentifier(input.commandId), "INVALID_COMMAND_ID", "commandId"],
    [isStableIdentifier(input.type), "INVALID_COMMAND_TYPE", "type"],
    [Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, "INVALID_EXPECTED_REVISION", "expectedRevision"],
    [Number.isSafeInteger(input.generationId) && input.generationId >= 0, "INVALID_GENERATION_ID", "generationId"],
    [Number.isSafeInteger(input.issuedAtSimulationMs) && input.issuedAtSimulationMs >= 0, "INVALID_SIMULATION_TIME", "issuedAtSimulationMs"],
    [own(input, "payload"), "MISSING_PAYLOAD", "payload"],
    [Array.isArray(input.readSet), "INVALID_READ_SET", "readSet"],
    [Array.isArray(input.writeSet), "INVALID_WRITE_SET", "writeSet"],
  ];
  for (const [condition, code, field] of checks) {
    if (!condition) {
      return reject(store, rejectionDiagnostic(
        code,
        "CommandEnvelopeError",
        store,
        input,
        { field },
      ));
    }
  }

  try {
    return Object.freeze({ ok: true, command: freezeDeep(cloneValue(input)) });
  } catch (error) {
    return reject(store, diagnosticFromError(error, {
      severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
      subsystem: "core.command-bus",
      code: "COMMAND_CLONE_FAILED",
      errorType: "CommandEnvelopeError",
      commandId: input.commandId,
      revision: store.revision,
      simulationTimeMs: input.issuedAtSimulationMs,
    }));
  }
}

function addHandler(registry, type, handler) {
  if (typeof type !== "string" || type.trim() === "" || typeof handler !== "function") {
    throw new TypeError("handler type과 함수가 필요합니다.");
  }
  const handlers = registry.get(type) ?? new Set();
  handlers.add(handler);
  registry.set(type, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) registry.delete(type);
  };
}

/**
 * Coordinates the fixed domain write path:
 * envelope/duplicate/stale/generation guard → transaction validation → touched draft mutation →
 * postconditions/reconciliation → one store commit → committed event publication → effect delivery.
 */
export class CommandBus {
  constructor({
    store,
    journal = new EventEffectJournal(),
    invariants = [],
    commandGuards = [],
    onDiagnostic = null,
  }) {
    if (!(store instanceof GameStore)) {
      throw new TypeError("CommandBus에는 GameStore가 필요합니다.");
    }
    if (!(journal instanceof EventEffectJournal)) {
      throw new TypeError("journal은 EventEffectJournal이어야 합니다.");
    }
    if (!Array.isArray(invariants) || invariants.some((item) => typeof item !== "function")) {
      throw new TypeError("invariants는 함수 배열이어야 합니다.");
    }
    if (!Array.isArray(commandGuards) || commandGuards.some((item) => typeof item !== "function")) {
      throw new TypeError("commandGuards는 함수 배열이어야 합니다.");
    }
    if (onDiagnostic !== null && typeof onDiagnostic !== "function") {
      throw new TypeError("onDiagnostic은 함수 또는 null이어야 합니다.");
    }

    this.store = store;
    this.journal = journal;
    this.invariants = Object.freeze([...invariants]);
    this.commandGuards = Object.freeze([...commandGuards]);
    this.onDiagnostic = onDiagnostic;
    this._transactions = new Map();
    this._eventHandlers = new Map();
    this._effectHandlers = new Map();
    this._postCommitDeliveryDepth = 0;
  }

  register(type, transaction) {
    if (!isStableIdentifier(type)) {
      throw new TypeError("등록할 command type이 유효하지 않습니다.");
    }
    if (!(transaction instanceof AtomicTransaction)) {
      throw new TypeError("AtomicTransaction만 등록할 수 있습니다.");
    }
    if (this._transactions.has(type)) {
      throw new Error(`이미 등록된 command type입니다: ${type}`);
    }
    this._transactions.set(type, transaction);
    return this;
  }

  subscribeEvent(type, handler) {
    return addHandler(this._eventHandlers, type, handler);
  }

  registerEffectHandler(type, handler) {
    return addHandler(this._effectHandlers, type, handler);
  }

  getSignalSnapshot() {
    return this.journal.snapshot();
  }

  /**
   * @param {import("./transaction.js").Command | object} input
   * @returns {Promise<import("./result.js").CommandResult>}
   */
  async dispatch(input) {
    if (this._postCommitDeliveryDepth > 0) {
      return reject(this.store, rejectionDiagnostic(
        "REENTRANT_DISPATCH_FORBIDDEN",
        "CommandOrderingError",
        this.store,
        input,
        { reason: "effect/event adapter는 domain command를 자동 dispatch할 수 없습니다." },
      ));
    }

    const envelope = validateAndFreezeCommand(input, this.store);
    if (!envelope.ok) return envelope;
    const command = envelope.command;

    // Duplicate precedes stale/generation checks so replay never re-observes a prior effect.
    if (this.store.hasProcessedCommand(command.commandId)) {
      return reject(this.store, rejectionDiagnostic(
        "DUPLICATE_COMMAND",
        "DuplicateCommandError",
        this.store,
        command,
      ));
    }
    if (command.expectedRevision !== this.store.revision) {
      return reject(this.store, rejectionDiagnostic(
        "STALE_REVISION",
        "RevisionGuardError",
        this.store,
        command,
        { expected: command.expectedRevision, actual: this.store.revision },
      ));
    }
    if (command.generationId !== this.store.generationId) {
      return reject(this.store, rejectionDiagnostic(
        "STALE_GENERATION",
        "GenerationGuardError",
        this.store,
        command,
        { expected: command.generationId, actual: this.store.generationId },
      ));
    }

    // Feature and policy guards run before command lookup and AtomicTransaction.prepare, so a
    // disabled optional command cannot create a touched-slice draft even when a handler exists.
    for (let index = 0; index < this.commandGuards.length; index += 1) {
      let outcome;
      try {
        outcome = this.commandGuards[index](command, Object.freeze({
          revision: this.store.revision,
          generationId: this.store.generationId,
          runtimePhase: this.store.runtimePhase,
          snapshot: this.store.getSnapshot(),
        }));
        if (outcome && typeof outcome.then === "function") {
          throw new TypeError("command guard는 Promise를 반환할 수 없습니다.");
        }
      } catch (error) {
        const diagnostic = diagnosticFromError(error, {
          severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
          subsystem: "core.command-bus",
          code: "COMMAND_GUARD_FAILED",
          errorType: "CommandGuardError",
          commandId: command.commandId,
          revision: this.store.revision,
          simulationTimeMs: command.issuedAtSimulationMs,
          details: { guardIndex: index },
        });
        return commandFailure(this.store.revision, diagnostic.code, [diagnostic]);
      }

      if (outcome === undefined || outcome === true || outcome?.ok === true) continue;
      if (outcome?.ok === false && typeof outcome.code === "string") {
        const diagnostics = Array.isArray(outcome.diagnostics) && outcome.diagnostics.length > 0
          ? outcome.diagnostics
          : [rejectionDiagnostic(
            outcome.code,
            "CommandGuardRejection",
            this.store,
            command,
            outcome.details,
          )];
        return commandFailure(this.store.revision, outcome.code, diagnostics);
      }
      return reject(this.store, rejectionDiagnostic(
        "COMMAND_GUARD_REJECTED",
        "CommandGuardRejection",
        this.store,
        command,
        { guardIndex: index },
      ));
    }

    const transaction = this._transactions.get(command.type);
    if (!transaction) {
      return reject(this.store, rejectionDiagnostic(
        "UNKNOWN_COMMAND_TYPE",
        "CommandRegistrationError",
        this.store,
        command,
        { type: command.type },
      ));
    }

    const capacity = this.store.canCommitCommand(command.commandId);
    if (!capacity.ok) {
      return reject(this.store, rejectionDiagnostic(
        capacity.code,
        "CommandIdCapacityError",
        this.store,
        command,
      ));
    }

    const before = this.store.getSnapshot();
    const prepared = transaction.prepare(command, before, this.invariants);
    if (!prepared.ok) {
      return commandFailure(this.store.revision, prepared.code, prepared.diagnostics);
    }

    const nextRevision = this.store.revision + 1;
    let events;
    let effects;
    try {
      events = createCommittedEvents(prepared.eventDescriptors, command, nextRevision);
      effects = createEffectRequests(prepared.effectDescriptors, command, nextRevision, events);
    } catch (error) {
      const diagnostic = diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "core.command-bus",
        code: "SIGNAL_ENVELOPE_FAILED",
        errorType: "SignalEnvelopeError",
        commandId: command.commandId,
        revision: this.store.revision,
        simulationTimeMs: command.issuedAtSimulationMs,
      });
      return commandFailure(this.store.revision, diagnostic.code, [diagnostic]);
    }

    try {
      this.store.commit(prepared.candidate, command);
    } catch (error) {
      const diagnostic = diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "core.command-bus",
        code: error?.code ?? "STORE_COMMIT_FAILED",
        errorType: "StoreCommitError",
        commandId: command.commandId,
        revision: this.store.revision,
        simulationTimeMs: command.issuedAtSimulationMs,
      });
      return commandFailure(this.store.revision, diagnostic.code, [diagnostic]);
    }

    this.journal.appendCommitted(events, effects);
    const degradedDiagnostics = await this._deliverPostCommit(command, events, effects);
    if (degradedDiagnostics.length > 0) {
      this.journal.appendDiagnostics(degradedDiagnostics);
      this._notifyDiagnostics(degradedDiagnostics);
    }

    return commandSuccess(this.store.revision, events, effects, degradedDiagnostics);
  }

  async _deliverPostCommit(command, events, effects) {
    const diagnostics = [];
    this._postCommitDeliveryDepth += 1;
    try {
      for (const event of events) {
        const handlers = [
          ...(this._eventHandlers.get(event.type) ?? []),
          ...(this._eventHandlers.get("*") ?? []),
        ];
        for (let index = 0; index < handlers.length; index += 1) {
          try {
            const outcome = await handlers[index](event, this.store.getSnapshot());
            if (outcome === false || outcome?.ok === false) {
              throw new Error(outcome?.code ?? "event consumer rejected delivery");
            }
          } catch (error) {
            diagnostics.push(createDiagnostic({
              diagnosticId: `${command.commandId}:event-delivery:${event.eventId}:${index}`,
              severity: DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT,
              subsystem: "core.command-bus",
              code: "COMMITTED_EVENT_CONSUMER_FAILED",
              errorType: "PostCommitDeliveryError",
              commandId: command.commandId,
              revision: this.store.revision,
              simulationTimeMs: command.issuedAtSimulationMs,
              details: { eventId: event.eventId, eventType: event.type, error: describeError(error) },
            }));
          }
        }
      }

      for (const effect of effects) {
        const handlers = [...(this._effectHandlers.get(effect.type) ?? [])];
        for (let index = 0; index < handlers.length; index += 1) {
          try {
            const outcome = await handlers[index](effect, this.store.getSnapshot());
            if (outcome === false || outcome?.ok === false) {
              throw new Error(outcome?.code ?? "effect handler rejected request");
            }
          } catch (error) {
            diagnostics.push(createDiagnostic({
              diagnosticId: `${command.commandId}:effect-delivery:${effect.effectId}:${index}`,
              severity: DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT,
              subsystem: "core.command-bus",
              code: "EFFECT_HANDLER_FAILED",
              errorType: "EffectDeliveryError",
              commandId: command.commandId,
              revision: this.store.revision,
              simulationTimeMs: command.issuedAtSimulationMs,
              details: { effectId: effect.effectId, effectType: effect.type, error: describeError(error) },
            }));
          }
        }
      }
    } finally {
      this._postCommitDeliveryDepth -= 1;
    }
    return Object.freeze(diagnostics);
  }

  _notifyDiagnostics(diagnostics) {
    if (!this.onDiagnostic) return;
    for (const diagnostic of diagnostics) {
      try {
        this.onDiagnostic(diagnostic);
      } catch {
        // Diagnostic observers are non-authoritative and cannot affect committed state.
      }
    }
  }
}
