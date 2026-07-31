import {
  createDiagnostic,
  DIAGNOSTIC_SEVERITY,
  diagnosticFromError,
} from "../core/diagnostic.js";
import {
  freezeDeep,
  validationFailure,
  validationSuccess,
} from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import {
  createFeatureFlags,
  FEATURE_DEFINITIONS,
  FEATURE_GATE_KIND,
  getFeatureDefinition,
} from "./feature-flags.js";

export const FEATURE_GATE_ARTIFACT_SCHEMA_VERSION = 1;
export const FEATURE_GATE_STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  NOT_RUN: "NOT_RUN",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function gateIssue(fieldPath, code) {
  return Object.freeze({ fieldPath, code });
}

export function validateFeatureGateArtifact(input) {
  const issues = [];
  if (!isPlainObject(input)) {
    issues.push(gateIssue("$", "FEATURE_GATE_ARTIFACT_TYPE_INVALID"));
  } else {
    if (input.schemaVersion !== FEATURE_GATE_ARTIFACT_SCHEMA_VERSION) {
      issues.push(gateIssue("$.schemaVersion", "FEATURE_GATE_SCHEMA_VERSION_INVALID"));
    }
    if (!isStableIdentifier(input.gateId)) issues.push(gateIssue("$.gateId", "FEATURE_GATE_ID_INVALID"));
    if (!Object.values(FEATURE_GATE_KIND).includes(input.gateKind)) {
      issues.push(gateIssue("$.gateKind", "FEATURE_GATE_KIND_INVALID"));
    }
    if (typeof input.buildId !== "string" || input.buildId.trim() === "") {
      issues.push(gateIssue("$.buildId", "FEATURE_GATE_BUILD_ID_INVALID"));
    }
    if (!Object.values(FEATURE_GATE_STATUS).includes(input.status)) {
      issues.push(gateIssue("$.status", "FEATURE_GATE_STATUS_INVALID"));
    }
  }
  return issues.length > 0
    ? freezeDeep({ ok: false, code: "FEATURE_GATE_ARTIFACT_INVALID", issues })
    : freezeDeep({
      ok: true,
      value: {
        schemaVersion: input.schemaVersion,
        gateId: input.gateId,
        gateKind: input.gateKind,
        buildId: input.buildId,
        status: input.status,
      },
    });
}

function activationDiagnostic(code, definition, context = {}, details = undefined) {
  return createDiagnostic({
    severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
    subsystem: "app.feature-registry",
    errorType: "FeatureActivationError",
    code,
    commandId: context.commandId,
    revision: context.revision,
    simulationTimeMs: context.simulationTimeMs,
    itemId: definition?.featureId,
    fieldPath: definition ? `$.featureFlags.${definition.featureId}` : "$.featureFlags",
    details: {
      featureId: definition?.featureId ?? context.featureId ?? null,
      requiredGate: definition?.requiredGate ?? null,
      ...(details && typeof details === "object" ? details : {}),
    },
  });
}

function featureFailure(code, definition, context, details) {
  return validationFailure(code, [activationDiagnostic(code, definition, context, details)], details);
}

function normalizeWriteSet(writeSet) {
  if (!Array.isArray(writeSet)) throw new TypeError("optional command writeSet은 배열이어야 합니다.");
  const unique = new Set();
  for (const slice of writeSet) {
    if (!isStableIdentifier(slice)) throw new TypeError(`유효하지 않은 optional write slice입니다: ${slice}`);
    if (unique.has(slice)) throw new TypeError(`중복 optional write slice입니다: ${slice}`);
    unique.add(slice);
  }
  return Object.freeze([...unique]);
}

function sameSet(left, right) {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const values = new Set(right);
  return values.size === right.length && left.every((entry) => values.has(entry));
}

/**
 * Holds only extension declarations until both a flag and the required current-build gate pass.
 * Optional implementations are installed through registerModule/registerCommand, never imported by
 * core code. Command declarations remain available while disabled so dispatch can return the
 * required FEATURE_DISABLED result before transaction draft creation.
 */
export class FeatureRegistry {
  constructor({ flags = {}, buildMetadata = null, gateArtifacts = [] } = {}) {
    this.flags = createFeatureFlags(flags);
    this.buildMetadata = buildMetadata && typeof buildMetadata === "object"
      ? Object.freeze({ ...buildMetadata })
      : null;
    if (!Array.isArray(gateArtifacts)) throw new TypeError("gateArtifacts는 배열이어야 합니다.");

    this._gateArtifacts = new Map();
    this._invalidGateArtifacts = [];
    for (const artifact of gateArtifacts) {
      const validation = validateFeatureGateArtifact(artifact);
      if (!validation.ok) {
        this._invalidGateArtifacts.push(validation);
        continue;
      }
      if (this._gateArtifacts.has(validation.value.gateKind)) {
        throw new Error(`중복 feature gate artifact입니다: ${validation.value.gateKind}`);
      }
      this._gateArtifacts.set(validation.value.gateKind, validation.value);
    }

    this._commandDeclarations = new Map();
    this._registeredCommands = new Map();
    this._registeredModules = new Map();
  }

  isRequested(featureId) {
    if (!getFeatureDefinition(featureId)) return false;
    return this.flags[featureId] === true;
  }

  evaluateActivation(featureId, context = {}) {
    const definition = getFeatureDefinition(featureId);
    if (!definition) {
      return featureFailure("FEATURE_UNKNOWN", null, { ...context, featureId });
    }
    if (!this.flags[featureId]) {
      return featureFailure("FEATURE_DISABLED", definition, context);
    }

    const buildId = this.buildMetadata?.buildId;
    if (typeof buildId !== "string" || buildId.trim() === "") {
      return featureFailure("FEATURE_BUILD_ID_MISSING", definition, context);
    }
    if (this._invalidGateArtifacts.length > 0) {
      return featureFailure("FEATURE_GATE_ARTIFACT_INVALID", definition, context, {
        issues: this._invalidGateArtifacts.flatMap((entry) => entry.issues),
      });
    }

    const artifact = this._gateArtifacts.get(definition.requiredGate);
    if (!artifact) {
      return featureFailure("FEATURE_GATE_ARTIFACT_MISSING", definition, context, { buildId });
    }
    if (artifact.status !== FEATURE_GATE_STATUS.PASS) {
      return featureFailure("FEATURE_GATE_NOT_PASSED", definition, context, {
        buildId,
        gateId: artifact.gateId,
        gateStatus: artifact.status,
      });
    }
    if (artifact.buildId !== buildId) {
      return featureFailure("FEATURE_GATE_BUILD_MISMATCH", definition, context, {
        buildId,
        gateBuildId: artifact.buildId,
        gateId: artifact.gateId,
      });
    }

    return validationSuccess({
      featureId,
      buildId,
      gateId: artifact.gateId,
      gateKind: artifact.gateKind,
    });
  }

  declareCommand({ featureId, type, writeSet = [] }) {
    const definition = getFeatureDefinition(featureId);
    if (!definition) throw new RangeError(`알 수 없는 feature입니다: ${featureId}`);
    if (!isStableIdentifier(type)) throw new TypeError(`유효하지 않은 optional command type입니다: ${type}`);
    const normalizedWriteSet = normalizeWriteSet(writeSet);
    const existing = this._commandDeclarations.get(type);
    if (existing) {
      if (existing.featureId !== featureId || !sameSet(existing.writeSet, normalizedWriteSet)) {
        throw new Error(`optional command declaration 충돌입니다: ${type}`);
      }
      return existing;
    }
    const declaration = freezeDeep({ featureId, type, writeSet: normalizedWriteSet });
    this._commandDeclarations.set(type, declaration);
    return declaration;
  }

  guardCommand(command, { revision = undefined } = {}) {
    const declaration = this._commandDeclarations.get(command?.type);
    if (!declaration) return validationSuccess();
    const context = {
      commandId: command.commandId,
      revision,
      simulationTimeMs: command.issuedAtSimulationMs,
    };
    const activation = this.evaluateActivation(declaration.featureId, context);
    if (!activation.ok) return activation;
    if (!sameSet(declaration.writeSet, command.writeSet)) {
      return featureFailure("FEATURE_WRITE_SET_MISMATCH", getFeatureDefinition(declaration.featureId), context, {
        commandType: declaration.type,
        expected: declaration.writeSet,
        actual: command.writeSet,
      });
    }
    return validationSuccess(activation.details);
  }

  createCommandGuard() {
    return (command, context) => this.guardCommand(command, { revision: context.revision });
  }

  registerCommand({ featureId, type, writeSet = [], commandBus, transaction }) {
    const declaration = this.declareCommand({ featureId, type, writeSet });
    const activation = this.evaluateActivation(featureId);
    if (!activation.ok) return activation;
    if (!commandBus || typeof commandBus.register !== "function") {
      throw new TypeError("optional command 등록에는 CommandBus가 필요합니다.");
    }
    if (this._registeredCommands.has(type)) {
      return featureFailure("FEATURE_COMMAND_ALREADY_REGISTERED", getFeatureDefinition(featureId), {}, { type });
    }
    try {
      commandBus.register(type, transaction);
      this._registeredCommands.set(type, declaration);
      return validationSuccess({ ...activation.details, type });
    } catch (error) {
      return validationFailure("FEATURE_COMMAND_REGISTRATION_FAILED", [diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "app.feature-registry",
        errorType: "FeatureCommandRegistrationError",
        code: "FEATURE_COMMAND_REGISTRATION_FAILED",
        itemId: featureId,
        fieldPath: `$.commands.${type}`,
      })]);
    }
  }

  registerModule({ featureId, moduleId, install }) {
    const definition = getFeatureDefinition(featureId);
    if (!definition) return featureFailure("FEATURE_UNKNOWN", null, { featureId });
    const activation = this.evaluateActivation(featureId);
    if (!activation.ok) return activation;
    if (!isStableIdentifier(moduleId)) throw new TypeError("moduleId는 stable identifier여야 합니다.");
    if (typeof install !== "function") throw new TypeError("install callback이 필요합니다.");
    if (this._registeredModules.has(moduleId)) {
      return featureFailure("FEATURE_MODULE_ALREADY_REGISTERED", definition, {}, { moduleId });
    }
    try {
      const installation = install(Object.freeze({
        featureId,
        namespace: definition.namespace,
        buildId: this.buildMetadata.buildId,
      }));
      if (installation && typeof installation.then === "function") {
        throw new TypeError("feature module install은 동기 함수여야 합니다.");
      }
      this._registeredModules.set(moduleId, freezeDeep({ featureId, moduleId }));
      return validationSuccess({ ...activation.details, moduleId });
    } catch (error) {
      return validationFailure("FEATURE_MODULE_REGISTRATION_FAILED", [diagnosticFromError(error, {
        severity: DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
        subsystem: "app.feature-registry",
        errorType: "FeatureModuleRegistrationError",
        code: "FEATURE_MODULE_REGISTRATION_FAILED",
        itemId: featureId,
        fieldPath: `$.modules.${moduleId}`,
      })]);
    }
  }

  getSnapshot() {
    return freezeDeep({
      buildId: this.buildMetadata?.buildId ?? null,
      flags: this.flags,
      definitions: FEATURE_DEFINITIONS,
      declaredCommands: [...this._commandDeclarations.values()],
      registeredCommands: [...this._registeredCommands.values()],
      registeredModules: [...this._registeredModules.values()],
      gateArtifacts: [...this._gateArtifacts.values()],
      invalidGateArtifactCount: this._invalidGateArtifacts.length,
    });
  }
}
