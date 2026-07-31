import { freezeDeep } from "../core/result.js";

export const FEATURE_GATE_KIND = Object.freeze({
  MUST: "MUST",
  SHOULD: "SHOULD",
});

export const FEATURE_DEFINITIONS = freezeDeep([
  { featureId: "staff", priority: "SHOULD", requiredGate: FEATURE_GATE_KIND.MUST, namespace: "extensions.staff" },
  { featureId: "supplier", priority: "SHOULD", requiredGate: FEATURE_GATE_KIND.MUST, namespace: "extensions.supplier" },
  { featureId: "additionalEvents", priority: "SHOULD", requiredGate: FEATURE_GATE_KIND.MUST, namespace: "extensions.additionalEvents" },
  { featureId: "additionalFacility", priority: "SHOULD", requiredGate: FEATURE_GATE_KIND.MUST, namespace: "extensions.additionalFacility" },
  { featureId: "mobileManagement", priority: "SHOULD", requiredGate: FEATURE_GATE_KIND.MUST, namespace: "extensions.mobileManagement" },
  { featureId: "extendedAudio", priority: "SHOULD", requiredGate: FEATURE_GATE_KIND.MUST, namespace: "extensions.extendedAudio" },
  { featureId: "phaseBgm", priority: "SHOULD", requiredGate: FEATURE_GATE_KIND.MUST, namespace: "extensions.phaseBgm" },
  { featureId: "complexNegotiation", priority: "COULD", requiredGate: FEATURE_GATE_KIND.SHOULD, namespace: "extensions.complexNegotiation" },
  { featureId: "optionalMaps", priority: "COULD", requiredGate: FEATURE_GATE_KIND.SHOULD, namespace: "extensions.optionalMaps" },
  { featureId: "mobileDirectService", priority: "COULD", requiredGate: FEATURE_GATE_KIND.SHOULD, namespace: "extensions.mobileDirectService" },
]);

export const FEATURE_IDS = Object.freeze(FEATURE_DEFINITIONS.map((definition) => definition.featureId));
const FEATURE_ID_SET = new Set(FEATURE_IDS);

export const DEFAULT_FEATURE_FLAGS = freezeDeep(Object.fromEntries(
  FEATURE_IDS.map((featureId) => [featureId, false]),
));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(fieldPath, code, details = undefined) {
  return freezeDeep({ fieldPath, code, ...(details === undefined ? {} : { details }) });
}

/** Strict feature flag schema validation. Values are never coerced to booleans. */
export function validateFeatureFlags(input, { allowPartial = false } = {}) {
  const issues = [];
  if (!isPlainObject(input)) {
    issues.push(issue("$", "FEATURE_FLAGS_TYPE_INVALID", { actualType: typeof input }));
  } else {
    for (const key of Object.keys(input)) {
      if (!FEATURE_ID_SET.has(key)) {
        issues.push(issue(`$.${key}`, "FEATURE_FLAG_UNKNOWN"));
      } else if (typeof input[key] !== "boolean") {
        issues.push(issue(`$.${key}`, "FEATURE_FLAG_TYPE_INVALID", { actualType: typeof input[key] }));
      }
    }
    if (!allowPartial) {
      for (const featureId of FEATURE_IDS) {
        if (!Object.prototype.hasOwnProperty.call(input, featureId)) {
          issues.push(issue(`$.${featureId}`, "FEATURE_FLAG_MISSING"));
        }
      }
    }
  }

  if (issues.length > 0) {
    return freezeDeep({ ok: false, code: "FEATURE_FLAGS_INVALID", issues });
  }

  return freezeDeep({
    ok: true,
    value: {
      ...DEFAULT_FEATURE_FLAGS,
      ...input,
    },
  });
}

export function createFeatureFlags(overrides = {}) {
  const result = validateFeatureFlags(overrides, { allowPartial: true });
  if (!result.ok) {
    const error = new TypeError(`feature flag schema가 유효하지 않습니다: ${result.issues.map((entry) => entry.code).join(", ")}`);
    error.code = result.code;
    error.issues = result.issues;
    throw error;
  }
  return result.value;
}

export function getFeatureDefinition(featureId) {
  return FEATURE_DEFINITIONS.find((definition) => definition.featureId === featureId) ?? null;
}
