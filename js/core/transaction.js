import {
  cloneValue,
  freezeDeep,
  validationFailure,
  validationSuccess,
} from "./result.js";
import {
  createDiagnostic,
  diagnosticFromError,
  DIAGNOSTIC_SEVERITY,
} from "./diagnostic.js";
import {
  normalizeEffectDescriptors,
  normalizeEventDescriptors,
} from "./events.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_WRITE_SLICES = new Set(["revision"]);

/**
 * @typedef {object} Command
 * @property {string} commandId Mutation idempotency key.
 * @property {number} expectedRevision Exact state revision expected by the issuer.
 * @property {string} type Registered transaction type.
 * @property {unknown} payload Domain payload validated before draft creation.
 * @property {string} [causeId] Cross-consumer idempotency key.
 * @property {number} issuedAtSimulationMs Domain simulation time, never wall-clock time.
 * @property {number} generationId Restart generation guard.
 * @property {readonly string[]} readSet Declared top-level slices read by the transaction.
 * @property {readonly string[]} writeSet Declared top-level slices cloned into the draft.
 */

/**
 * @typedef {object} AtomicTransactionSpec
 * @property {string} name
 * @property {readonly string[]} readSet
 * @property {readonly string[]} writeSet
 * @property {readonly string[]} allowedPhases
 * @property {(ctx: ReadonlyTransactionContext) => boolean | import("./result.js").ValidationResult | void} validatePayload
 * @property {(ctx: ReadonlyTransactionContext) => boolean | import("./result.js").ValidationResult | void} [preflight]
 * @property {(draft: DraftContext) => boolean | import("./result.js").ValidationResult | void} mutate
 * @property {((before: Readonly<object>, after: Readonly<object>, ctx: ReadonlyTransactionContext) => boolean | import("./result.js").ValidationResult | void) | readonly ((before: Readonly<object>, after: Readonly<object>, ctx: ReadonlyTransactionContext) => boolean | import("./result.js").ValidationResult | void)[]} postconditions
 * @property {(before: Readonly<object>, after: Readonly<object>, ctx: ReadonlyTransactionContext) => readonly object[]} [events]
 * @property {(before: Readonly<object>, after: Readonly<object>, ctx: ReadonlyTransactionContext & {eventDescriptors: readonly object[]}) => readonly object[]} [effects]
 */

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isStableIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function normalizeSliceSet(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${field}는 ${allowEmpty ? "" : "비어 있지 않은 "}배열이어야 합니다.`);
  }
  const seen = new Set();
  const normalized = value.map((slice) => {
    if (!isStableIdentifier(slice)) {
      throw new TypeError(`${field}에 유효하지 않은 slice 이름이 있습니다.`);
    }
    if (seen.has(slice)) {
      throw new TypeError(`${field}에 중복 slice가 있습니다: ${slice}`);
    }
    seen.add(slice);
    return slice;
  });
  return Object.freeze(normalized);
}

function sameSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const values = new Set(actual);
  return values.size === actual.length && expected.every((item) => values.has(item));
}

function defaultDiagnostic({ command, before, severity, code, errorType, details }) {
  return createDiagnostic({
    severity,
    subsystem: "core.transaction",
    code,
    errorType,
    commandId: command?.commandId,
    revision: before?.revision,
    simulationTimeMs: command?.issuedAtSimulationMs,
    details,
  });
}

function assertSynchronous(value, callbackName) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${callbackName} callback은 Promise를 반환할 수 없습니다.`);
  }
}

function normalizeGuardResult(value, fallback) {
  assertSynchronous(value, fallback.errorType);
  if (value === undefined || value === true || value?.ok === true) {
    return validationSuccess(value?.details);
  }
  if (value?.ok === false) {
    const diagnostics = Array.isArray(value.diagnostics) && value.diagnostics.length > 0
      ? value.diagnostics
      : [defaultDiagnostic({ ...fallback, code: value.code ?? fallback.code, details: value.details })];
    return validationFailure(value.code ?? fallback.code, diagnostics, value.details);
  }
  return validationFailure(fallback.code, [defaultDiagnostic(fallback)]);
}

function invokeGuard(callback, args, fallback) {
  try {
    return normalizeGuardResult(callback(...args), fallback);
  } catch (error) {
    return validationFailure(fallback.exceptionCode ?? fallback.code, [
      diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "core.transaction",
        code: fallback.exceptionCode ?? fallback.code,
        errorType: `${fallback.errorType}Exception`,
        commandId: fallback.command?.commandId,
        revision: fallback.before?.revision,
        simulationTimeMs: fallback.command?.issuedAtSimulationMs,
      }),
    ]);
  }
}

/** Read-only view constrained to declared transaction slices. */
export class ReadonlyTransactionContext {
  constructor(before, command, readableSlices) {
    this.command = command;
    this.revision = before.revision;
    this.phase = before.runtimePhase;
    this.generationId = before.generationId;
    this._before = before;
    this._readableSlices = readableSlices;
    Object.freeze(this);
  }

  read(slice) {
    if (!this._readableSlices.has(slice)) {
      throw new Error(`선언되지 않은 slice read입니다: ${slice}`);
    }
    return this._before[slice];
  }
}

/**
 * A touched-slice draft. Only writeSet slices are cloned; untouched slices retain immutable
 * structural sharing. The draft is never exposed after preview/commit.
 */
export class DraftContext {
  constructor(before, command, readSet, writeSet) {
    this.command = command;
    this._before = before;
    this._readableSlices = new Set([...readSet, ...writeSet]);
    this._writeSlices = new Set(writeSet);
    this._draftSlices = new Map();
    this._closed = false;

    for (const slice of writeSet) {
      this._draftSlices.set(slice, cloneValue(before[slice]));
    }
  }

  read(slice) {
    this._assertOpen();
    if (!this._readableSlices.has(slice)) {
      throw new Error(`선언되지 않은 slice read입니다: ${slice}`);
    }
    return this._draftSlices.has(slice)
      ? this._draftSlices.get(slice)
      : this._before[slice];
  }

  write(slice) {
    this._assertOpen();
    if (!this._writeSlices.has(slice)) {
      throw new Error(`선언되지 않은 slice write입니다: ${slice}`);
    }
    return this._draftSlices.get(slice);
  }

  replace(slice, value) {
    this._assertOpen();
    if (!this._writeSlices.has(slice)) {
      throw new Error(`선언되지 않은 slice replace입니다: ${slice}`);
    }
    this._draftSlices.set(slice, cloneValue(value));
  }

  preview() {
    this._assertOpen();
    const candidate = { ...this._before };
    for (const [slice, value] of this._draftSlices) {
      candidate[slice] = value;
    }
    this._closed = true;
    return freezeDeep(candidate);
  }

  _assertOpen() {
    if (this._closed) {
      throw new Error("이미 닫힌 transaction draft입니다.");
    }
  }
}

function normalizePostconditions(value) {
  const callbacks = Array.isArray(value) ? value : [value];
  if (callbacks.length === 0 || callbacks.some((callback) => typeof callback !== "function")) {
    throw new TypeError("postconditions는 하나 이상의 함수여야 합니다.");
  }
  return Object.freeze([...callbacks]);
}

export class AtomicTransaction {
  /** @param {AtomicTransactionSpec} spec */
  constructor(spec) {
    if (!isPlainRecord(spec)) {
      throw new TypeError("AtomicTransaction spec은 object여야 합니다.");
    }
    if (!isStableIdentifier(spec.name)) {
      throw new TypeError("AtomicTransaction name이 유효하지 않습니다.");
    }
    if (typeof spec.validatePayload !== "function") {
      throw new TypeError("validatePayload guard가 필요합니다.");
    }
    if (typeof spec.mutate !== "function") {
      throw new TypeError("mutate callback이 필요합니다.");
    }

    const readSet = normalizeSliceSet(spec.readSet, "readSet");
    const writeSet = normalizeSliceSet(spec.writeSet, "writeSet", { allowEmpty: false });
    for (const slice of writeSet) {
      if (RESERVED_WRITE_SLICES.has(slice)) {
        throw new TypeError(`직접 쓸 수 없는 root metadata입니다: ${slice}`);
      }
    }

    const allowedPhases = normalizeSliceSet(spec.allowedPhases, "allowedPhases", { allowEmpty: false });
    this.name = spec.name;
    this.readSet = readSet;
    this.writeSet = writeSet;
    this.allowedPhases = allowedPhases;
    this.validatePayload = spec.validatePayload;
    this.preflight = spec.preflight ?? (() => validationSuccess());
    this.mutate = spec.mutate;
    this.postconditions = normalizePostconditions(spec.postconditions);
    this.events = spec.events ?? (() => []);
    this.effects = spec.effects ?? (() => []);
    Object.freeze(this);
  }

  /**
   * Runs validation, touched-slice mutation, postconditions/reconciliation, and immutable
   * event/effect planning. No store state or journal is changed here.
   *
   * @param {Command} command
   * @param {Readonly<object>} before
   * @param {readonly Function[]} [globalInvariants]
   */
  prepare(command, before, globalInvariants = []) {
    const readableSlices = new Set([...this.readSet, ...this.writeSet]);
    const context = new ReadonlyTransactionContext(before, command, readableSlices);

    if (!this.allowedPhases.includes(before.runtimePhase)) {
      return validationFailure("ILLEGAL_PHASE", [defaultDiagnostic({
        command,
        before,
        severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
        code: "ILLEGAL_PHASE",
        errorType: "PhaseGuardError",
        details: { actual: before.runtimePhase, allowed: this.allowedPhases },
      })]);
    }

    const payloadResult = invokeGuard(this.validatePayload, [context], {
      command,
      before,
      severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
      code: "INVALID_PAYLOAD",
      exceptionCode: "PAYLOAD_GUARD_EXCEPTION",
      errorType: "PayloadGuardError",
    });
    if (!payloadResult.ok) return payloadResult;

    if (!sameSet(command.readSet, this.readSet)) {
      return validationFailure("READ_SET_MISMATCH", [defaultDiagnostic({
        command,
        before,
        severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
        code: "READ_SET_MISMATCH",
        errorType: "ReadSetGuardError",
        details: { declared: command.readSet, expected: this.readSet },
      })]);
    }

    if (!sameSet(command.writeSet, this.writeSet)) {
      return validationFailure("WRITE_SET_MISMATCH", [defaultDiagnostic({
        command,
        before,
        severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
        code: "WRITE_SET_MISMATCH",
        errorType: "WriteSetGuardError",
        details: { declared: command.writeSet, expected: this.writeSet },
      })]);
    }

    for (const slice of readableSlices) {
      if (!Object.prototype.hasOwnProperty.call(before, slice)) {
        return validationFailure("UNKNOWN_STATE_SLICE", [defaultDiagnostic({
          command,
          before,
          severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
          code: "UNKNOWN_STATE_SLICE",
          errorType: "StateSliceGuardError",
          details: { slice },
        })]);
      }
    }

    const preflightResult = invokeGuard(this.preflight, [context], {
      command,
      before,
      severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
      code: "PREFLIGHT_REJECTED",
      exceptionCode: "PREFLIGHT_EXCEPTION",
      errorType: "PreflightGuardError",
    });
    if (!preflightResult.ok) return preflightResult;

    let draft;
    try {
      draft = new DraftContext(before, command, this.readSet, this.writeSet);
    } catch (error) {
      return validationFailure("DRAFT_CREATION_FAILED", [diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "core.transaction",
        code: "DRAFT_CREATION_FAILED",
        errorType: "DraftCreationError",
        commandId: command.commandId,
        revision: before.revision,
        simulationTimeMs: command.issuedAtSimulationMs,
      })]);
    }

    const mutationResult = invokeGuard(this.mutate, [draft], {
      command,
      before,
      severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
      code: "MUTATION_REJECTED",
      exceptionCode: "MUTATION_EXCEPTION",
      errorType: "DraftMutationError",
    });
    if (!mutationResult.ok) return mutationResult;

    let candidate;
    try {
      candidate = draft.preview();
    } catch (error) {
      return validationFailure("DRAFT_FINALIZATION_FAILED", [diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "core.transaction",
        code: "DRAFT_FINALIZATION_FAILED",
        errorType: "DraftFinalizationError",
        commandId: command.commandId,
        revision: before.revision,
        simulationTimeMs: command.issuedAtSimulationMs,
      })]);
    }

    const allPostconditions = [...this.postconditions, ...globalInvariants];
    for (let index = 0; index < allPostconditions.length; index += 1) {
      const result = invokeGuard(allPostconditions[index], [before, candidate, context], {
        command,
        before,
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        code: "POSTCONDITION_FAILED",
        exceptionCode: "POSTCONDITION_EXCEPTION",
        errorType: "PostconditionError",
        details: { index },
      });
      if (!result.ok) return result;
    }

    try {
      const eventDescriptors = normalizeEventDescriptors(this.events(before, candidate, context));
      const effectContext = Object.freeze(
        Object.assign(Object.create(context), { eventDescriptors }),
      );
      const effectDescriptors = normalizeEffectDescriptors(
        this.effects(before, candidate, effectContext),
      );
      return Object.freeze({ ok: true, candidate, eventDescriptors, effectDescriptors });
    } catch (error) {
      return validationFailure("SIGNAL_PLANNING_FAILED", [diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "core.transaction",
        code: "SIGNAL_PLANNING_FAILED",
        errorType: "SignalPlanningError",
        commandId: command.commandId,
        revision: before.revision,
        simulationTimeMs: command.issuedAtSimulationMs,
      })]);
    }
  }
}

/** @param {AtomicTransactionSpec} spec */
export function defineAtomicTransaction(spec) {
  return new AtomicTransaction(spec);
}
