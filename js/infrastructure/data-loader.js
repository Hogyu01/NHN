import {
  compareDiagnostics,
  createDiagnostic,
  describeError,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import {
  DataValidator,
  resolveValidationSeverity,
  VALIDATION_BOUNDARY,
  VALIDATION_ERROR_TYPE,
} from "./data-validator.js";

class DataLoadFailure extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DataLoadFailure";
    this.code = code;
    this.details = details;
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field}는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

async function fetchText(specification) {
  if (typeof globalThis.fetch !== "function") {
    throw new DataLoadFailure("FETCH_UNAVAILABLE", "이 환경에는 fetch adapter가 없습니다.");
  }
  const target = specification.url ?? specification.source ?? specification.filename;
  const response = await globalThis.fetch(target, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new DataLoadFailure(
      "HTTP_STATUS_NOT_OK",
      `${specification.filename} load가 HTTP ${response.status}로 실패했습니다.`,
      { status: response.status, statusText: response.statusText, target: String(target) },
    );
  }
  return response.text();
}

function diagnosticIdPart(value) {
  return String(value).replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 120) || "none";
}

function loaderDiagnostic(specification, errorType, code, details) {
  const filename = requireText(specification.filename ?? specification.storageKey, "filename/storageKey");
  const boundary = specification.boundary ?? VALIDATION_BOUNDARY.STATIC_REQUIRED;
  return createDiagnostic({
    diagnosticId: [
      "diagnostic",
      "DataLoader",
      diagnosticIdPart(filename),
      diagnosticIdPart(errorType),
      diagnosticIdPart(code),
    ].join(":"),
    severity: resolveValidationSeverity(boundary),
    subsystem: "DataLoader",
    filename,
    errorType,
    code,
    fieldPath: "$",
    details,
  });
}

function isQuarantineBoundary(boundary) {
  return boundary === VALIDATION_BOUNDARY.STATIC_OPTIONAL || boundary === VALIDATION_BOUNDARY.MAP_OPTIONAL;
}

/**
 * Adapter-driven JSON loader. The default adapter uses same-origin fetch; Node tooling injects an
 * fs adapter. Every source is read and parsed before aggregate validation so one failure never
 * hides errors in later files.
 */
export class DataLoader {
  constructor({ validator = new DataValidator(), loadText = fetchText } = {}) {
    if (!validator || typeof validator.validateDocuments !== "function") {
      throw new TypeError("validator는 validateDocuments를 제공해야 합니다.");
    }
    if (typeof loadText !== "function") throw new TypeError("loadText는 함수여야 합니다.");
    this.validator = validator;
    this.loadText = loadText;
  }

  async loadJson(specification) {
    return this.loadAll([specification]);
  }

  async loadAll(specifications) {
    if (!Array.isArray(specifications) || specifications.length === 0) {
      throw new TypeError("specifications는 하나 이상의 배열이어야 합니다.");
    }

    const seenSources = new Set();
    for (const specification of specifications) {
      const source = requireText(specification.filename ?? specification.storageKey, "filename/storageKey");
      requireText(specification.schemaName, "schemaName");
      resolveValidationSeverity(specification.boundary ?? VALIDATION_BOUNDARY.STATIC_REQUIRED);
      if (seenSources.has(source)) throw new Error(`중복 load source입니다: ${source}`);
      seenSources.add(source);
    }

    const attempts = await Promise.all(specifications.map(async (specification, index) => {
      try {
        const text = await this.loadText(Object.freeze({ ...specification }));
        if (typeof text !== "string") {
          throw new DataLoadFailure("LOAD_TEXT_TYPE_INVALID", "load adapter가 문자열을 반환하지 않았습니다.", {
            actualType: typeof text,
          });
        }
        try {
          return Object.freeze({
            index,
            specification,
            text,
            data: JSON.parse(text),
            diagnostic: null,
          });
        } catch (error) {
          return Object.freeze({
            index,
            specification,
            text,
            data: undefined,
            diagnostic: loaderDiagnostic(
              specification,
              VALIDATION_ERROR_TYPE.PARSE,
              "JSON_PARSE_FAILED",
              { error: describeError(error) },
            ),
          });
        }
      } catch (error) {
        const code = error instanceof DataLoadFailure ? error.code : "DATA_LOAD_FAILED";
        const extraDetails = error instanceof DataLoadFailure ? error.details : undefined;
        return Object.freeze({
          index,
          specification,
          text: null,
          data: undefined,
          diagnostic: loaderDiagnostic(
            specification,
            VALIDATION_ERROR_TYPE.LOAD,
            code,
            { error: describeError(error), ...(extraDetails === undefined ? {} : { load: extraDetails }) },
          ),
        });
      }
    }));

    const parsedAttempts = attempts.filter((attempt) => !attempt.diagnostic);
    const validation = parsedAttempts.length > 0
      ? this.validator.validateDocuments(parsedAttempts.map((attempt) => ({
        filename: attempt.specification.filename,
        storageKey: attempt.specification.storageKey,
        schemaName: attempt.specification.schemaName,
        boundary: attempt.specification.boundary,
        data: attempt.data,
      })))
      : Object.freeze({
        ok: false,
        code: "VALIDATION_NOT_RUN_NO_PARSED_DOCUMENTS",
        canStart: true,
        diagnostics: Object.freeze([]),
        documentResults: Object.freeze([]),
        summary: Object.freeze({ total: 0, hasBlocking: false }),
      });

    const resultBySource = new Map(validation.documentResults.map((result) => [result.source, result]));
    const loaderDiagnostics = attempts.flatMap((attempt) => attempt.diagnostic ? [attempt.diagnostic] : []);
    const diagnostics = [...loaderDiagnostics, ...validation.diagnostics].sort(compareDiagnostics);
    const accepted = [];
    const rejected = [];
    const quarantined = [];

    for (const attempt of attempts) {
      const source = attempt.specification.filename ?? attempt.specification.storageKey;
      const documentResult = resultBySource.get(source);
      const sourceDiagnostics = attempt.diagnostic
        ? [attempt.diagnostic]
        : documentResult?.diagnostics ?? [];
      if (sourceDiagnostics.length === 0) {
        accepted.push(Object.freeze({
          filename: source,
          schemaName: attempt.specification.schemaName,
          boundary: attempt.specification.boundary ?? VALIDATION_BOUNDARY.STATIC_REQUIRED,
          data: freezeDeep(attempt.data),
        }));
      } else {
        const record = Object.freeze({
          filename: source,
          schemaName: attempt.specification.schemaName,
          boundary: attempt.specification.boundary ?? VALIDATION_BOUNDARY.STATIC_REQUIRED,
          diagnostics: Object.freeze([...sourceDiagnostics].sort(compareDiagnostics)),
        });
        rejected.push(record);
        if (isQuarantineBoundary(record.boundary)) quarantined.push(record);
      }
    }

    const blocked = diagnostics.some((diagnostic) =>
      diagnostic.severity === "FATAL_BOOT" ||
      diagnostic.severity === "BLOCKING_STATE" ||
      diagnostic.severity === "INTERNAL_INVARIANT");

    return Object.freeze({
      ok: diagnostics.length === 0,
      code: diagnostics.length === 0 ? "DATA_LOAD_VALID" : "DATA_LOAD_INVALID",
      blocked,
      canStart: !blocked,
      accepted: Object.freeze(accepted),
      rejected: Object.freeze(rejected),
      quarantined: Object.freeze(quarantined),
      diagnostics: Object.freeze(diagnostics),
      validation,
    });
  }
}
