import { cloneValue, freezeDeep } from "./result.js";

export const DIAGNOSTIC_SEVERITY = Object.freeze({
  FATAL_BOOT: "FATAL_BOOT",
  BLOCKING_STATE: "BLOCKING_STATE",
  RECOVERABLE_COMMAND: "RECOVERABLE_COMMAND",
  QUARANTINED_CONTENT: "QUARANTINED_CONTENT",
  DEGRADED_EFFECT: "DEGRADED_EFFECT",
  INTERNAL_INVARIANT: "INTERNAL_INVARIANT",
});

const SEVERITIES = new Set(Object.values(DIAGNOSTIC_SEVERITY));

/**
 * @typedef {object} Diagnostic
 * @property {string} diagnosticId
 * @property {keyof typeof DIAGNOSTIC_SEVERITY | string} severity
 * @property {string} subsystem
 * @property {string} code
 * @property {string} errorType
 * @property {string} [filename]
 * @property {string} [itemId]
 * @property {string} [fieldPath]
 * @property {string} [mapId]
 * @property {string} [commandId]
 * @property {string} [causeId]
 * @property {number} [revision]
 * @property {number} [simulationTimeMs]
 * @property {unknown} [details]
 */

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field}는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function identifierPart(value) {
  return String(value ?? "none").replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 80);
}

/**
 * @param {Partial<Diagnostic> & Pick<Diagnostic, "severity" | "subsystem" | "code" | "errorType">} input
 * @returns {Readonly<Diagnostic>}
 */
export function createDiagnostic(input) {
  const severity = requireText(input.severity, "severity");
  if (!SEVERITIES.has(severity)) {
    throw new TypeError(`알 수 없는 diagnostic severity입니다: ${severity}`);
  }

  const subsystem = requireText(input.subsystem, "subsystem");
  const code = requireText(input.code, "code");
  const errorType = requireText(input.errorType, "errorType");
  const diagnosticId = input.diagnosticId ?? [
    "diagnostic",
    identifierPart(subsystem),
    identifierPart(code),
    identifierPart(input.commandId),
    identifierPart(input.revision),
    identifierPart(input.itemId),
  ].join(":");

  const diagnostic = {
    diagnosticId: requireText(diagnosticId, "diagnosticId"),
    severity,
    subsystem,
    code,
    errorType,
  };

  for (const field of [
    "filename",
    "itemId",
    "fieldPath",
    "mapId",
    "commandId",
    "causeId",
  ]) {
    if (input[field] !== undefined) {
      diagnostic[field] = String(input[field]);
    }
  }

  for (const field of ["revision", "simulationTimeMs"]) {
    if (input[field] !== undefined) {
      if (!Number.isSafeInteger(input[field]) || input[field] < 0) {
        throw new TypeError(`${field}는 0 이상의 safe integer여야 합니다.`);
      }
      diagnostic[field] = input[field];
    }
  }

  if (input.details !== undefined) {
    diagnostic.details = cloneValue(input.details);
  }

  return freezeDeep(diagnostic);
}

/**
 * @param {unknown} error
 * @returns {{name: string, message: string}}
 */
export function describeError(error) {
  if (error instanceof Error) {
    return Object.freeze({ name: error.name, message: error.message });
  }
  return Object.freeze({ name: "NonErrorThrown", message: String(error) });
}

/**
 * @param {unknown} error
 * @param {Partial<Diagnostic> & Pick<Diagnostic, "severity" | "subsystem" | "code" | "errorType">} context
 * @returns {Readonly<Diagnostic>}
 */
export function diagnosticFromError(error, context) {
  const details = {
    ...(context.details && typeof context.details === "object" ? context.details : {}),
    error: describeError(error),
  };
  return createDiagnostic({ ...context, details });
}

function optionalText(value) {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * The user-facing source is always a filename/storage key when one exists. API-only
 * diagnostics fall back to the subsystem as required by the presentation contract.
 *
 * @param {Diagnostic} diagnostic
 * @returns {string}
 */
export function diagnosticSource(diagnostic) {
  return optionalText(diagnostic?.filename) || optionalText(diagnostic?.subsystem) || "unknown";
}

/**
 * Produces an insertion-ordered presentation record. `source` and `errorType` are
 * deliberately the first two fields; shells and reports must not lead with `code`.
 *
 * @param {Diagnostic} diagnostic
 */
export function toDiagnosticPresentation(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") {
    throw new TypeError("diagnostic은 object여야 합니다.");
  }
  return freezeDeep({
    source: diagnosticSource(diagnostic),
    errorType: optionalText(diagnostic.errorType) || "UNKNOWN_ERROR",
    itemId: optionalText(diagnostic.itemId) || null,
    fieldPath: optionalText(diagnostic.fieldPath) || null,
    code: optionalText(diagnostic.code) || "UNKNOWN_CODE",
    severity: optionalText(diagnostic.severity) || "INTERNAL_INVARIANT",
    details: diagnostic.details === undefined ? null : cloneValue(diagnostic.details),
  });
}

/**
 * Stable filename/errorType-first ordering for aggregate validation output.
 *
 * @param {Diagnostic} left
 * @param {Diagnostic} right
 */
export function compareDiagnostics(left, right) {
  const leftFields = [
    diagnosticSource(left),
    optionalText(left.errorType),
    optionalText(left.itemId),
    optionalText(left.fieldPath),
    optionalText(left.code),
    optionalText(left.diagnosticId),
  ];
  const rightFields = [
    diagnosticSource(right),
    optionalText(right.errorType),
    optionalText(right.itemId),
    optionalText(right.fieldPath),
    optionalText(right.code),
    optionalText(right.diagnosticId),
  ];
  for (let index = 0; index < leftFields.length; index += 1) {
    const comparison = leftFields[index].localeCompare(rightFields[index], "en");
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/**
 * @param {Diagnostic} diagnostic
 * @returns {string}
 */
export function formatDiagnostic(diagnostic) {
  const presentation = toDiagnosticPresentation(diagnostic);
  const secondary = [
    presentation.itemId ? `item=${presentation.itemId}` : null,
    presentation.fieldPath ? `field=${presentation.fieldPath}` : null,
    `code=${presentation.code}`,
  ].filter(Boolean).join(" | ");
  return `${presentation.source} | ${presentation.errorType}\n${secondary}`;
}

/**
 * @param {readonly Diagnostic[]} diagnostics
 * @returns {string}
 */
export function formatDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) {
    throw new TypeError("diagnostics는 배열이어야 합니다.");
  }
  return [...diagnostics].sort(compareDiagnostics).map(formatDiagnostic).join("\n\n");
}
