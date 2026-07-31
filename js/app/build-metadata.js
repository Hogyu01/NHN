import { freezeDeep } from "../core/result.js";

export const BUILD_METADATA_SCHEMA_VERSION = 1;
export const BUILD_MODE = Object.freeze({
  DEVELOPMENT: "DEVELOPMENT",
  PUBLIC: "PUBLIC",
});

export const DEFAULT_BUILD_METADATA = freezeDeep({
  schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
  buildId: "dungeon-restaurant-management-mvp.task-6",
  buildMode: BUILD_MODE.DEVELOPMENT,
  contentVersion: 1,
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(fieldPath, code, expected, actual) {
  return Object.freeze({ fieldPath, code, expected, actual });
}

/**
 * Validates metadata without coercion. A build ID is mandatory because every feature gate artifact
 * is bound to exactly one build.
 */
export function validateBuildMetadata(input) {
  const issues = [];
  if (!isPlainObject(input)) {
    issues.push(issue("$", "BUILD_METADATA_TYPE_INVALID", "object", typeof input));
  } else {
    if (input.schemaVersion !== BUILD_METADATA_SCHEMA_VERSION) {
      issues.push(issue("$.schemaVersion", "BUILD_METADATA_SCHEMA_VERSION_INVALID", BUILD_METADATA_SCHEMA_VERSION, input.schemaVersion));
    }
    if (typeof input.buildId !== "string" || input.buildId.trim() === "" || input.buildId.length > 128) {
      issues.push(issue("$.buildId", "BUILD_ID_INVALID", "non-empty string (max 128)", input.buildId));
    }
    if (!Object.values(BUILD_MODE).includes(input.buildMode)) {
      issues.push(issue("$.buildMode", "BUILD_MODE_INVALID", Object.values(BUILD_MODE), input.buildMode));
    }
    if (!Number.isSafeInteger(input.contentVersion) || input.contentVersion < 1) {
      issues.push(issue("$.contentVersion", "BUILD_CONTENT_VERSION_INVALID", "safe integer >= 1", input.contentVersion));
    }
  }

  if (issues.length > 0) {
    return freezeDeep({
      ok: false,
      code: "BUILD_METADATA_INVALID",
      issues,
    });
  }

  return freezeDeep({
    ok: true,
    value: {
      schemaVersion: input.schemaVersion,
      buildId: input.buildId,
      buildMode: input.buildMode,
      contentVersion: input.contentVersion,
    },
  });
}
