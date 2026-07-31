import {
  compareDiagnostics,
  createDiagnostic,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { cloneValue, freezeDeep } from "../core/result.js";
import { DataLoader } from "../infrastructure/data-loader.js";
import { DataValidator, VALIDATION_BOUNDARY } from "../infrastructure/data-validator.js";
import { SchemaRegistry } from "../infrastructure/schema-registry.js";
import {
  BASE_MAP_ID,
  createMapLoadSpecification,
  MAP_LIMITS,
  MAP_ROLE,
} from "./map-schema.js";

export const MAP_MANIFEST_SCHEMA_VERSION = 1;
export const MAP_MANIFEST_SCHEMA_NAME = "map-manifest.v1";
export const CANONICAL_MAP_MANIFEST_ID = "map-manifest.canonical.v1";
export const CANONICAL_MAP_MANIFEST_FILENAME = "data/maps/map-manifest.json";
export const CANONICAL_PROTOTYPE_MAP_ID = "map.prototype_fixture";
export const CANONICAL_MAP_TILE_IDS = Object.freeze([
  "tile.base.floor",
  "tile.prototype.floor",
]);

const CANONICAL_MAP_FILENAME_PATTERN = /^data\/maps\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const MANIFEST_URL = new URL("../../data/maps/map-manifest.json", import.meta.url).href;

export const MAP_MANIFEST_SCHEMA = freezeDeep({
  type: "object",
  required: ["schemaVersion", "manifestId", "activeMapId", "maps"],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: MAP_MANIFEST_SCHEMA_VERSION },
    manifestId: { type: "string", const: CANONICAL_MAP_MANIFEST_ID },
    activeMapId: {
      type: "string",
      format: "stable-id",
      referenceNamespace: "manifest-map",
    },
    maps: {
      type: "array",
      minItems: 1,
      maxItems: MAP_LIMITS.maximumRegisteredMaps,
      items: {
        type: "object",
        itemIdField: "mapId",
        required: ["mapId", "filename", "role"],
        additionalProperties: false,
        properties: {
          mapId: {
            type: "string",
            format: "stable-id",
            idNamespace: "manifest-map",
          },
          filename: { type: "string", minLength: 1 },
          role: { type: "string", enum: Object.values(MAP_ROLE) },
        },
      },
    },
  },
});

function manifestValidator() {
  return new DataValidator({
    registry: new SchemaRegistry([[MAP_MANIFEST_SCHEMA_NAME, MAP_MANIFEST_SCHEMA]]),
  });
}

function identifierPart(value) {
  return String(value ?? "none").replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 100) || "none";
}

function manifestDiagnostic({ filename, errorType, code, fieldPath, itemId, details, sequence }) {
  return createDiagnostic({
    diagnosticId: [
      "diagnostic",
      "MapManifestLoader",
      identifierPart(filename),
      identifierPart(code),
      String(sequence).padStart(6, "0"),
    ].join(":"),
    severity: DIAGNOSTIC_SEVERITY.FATAL_BOOT,
    subsystem: "MapManifestLoader",
    filename,
    errorType,
    code,
    fieldPath,
    itemId,
    details,
  });
}

function validationResult({ filename, diagnostics, manifest = null }) {
  const sorted = Object.freeze([...diagnostics].sort(compareDiagnostics));
  return freezeDeep({
    ok: sorted.length === 0,
    code: sorted.length === 0 ? "MAP_MANIFEST_VALID" : "MAP_MANIFEST_INVALID",
    canStart: sorted.length === 0,
    filename,
    diagnostics: sorted,
    ...(manifest === null ? {} : { manifest }),
  });
}

/** Strict, coercion-free schema and semantic validation for the canonical Map manifest. */
export function validateMapManifestDefinition(
  input,
  { filename = CANONICAL_MAP_MANIFEST_FILENAME } = {},
) {
  const schema = manifestValidator().validate({
    filename,
    schemaName: MAP_MANIFEST_SCHEMA_NAME,
    boundary: VALIDATION_BOUNDARY.MAP_BASE,
    data: input,
  });
  if (!schema.ok) return validationResult({ filename, diagnostics: schema.diagnostics });

  const diagnostics = [];
  let sequence = 0;
  const add = (errorType, code, fieldPath, itemId, details = undefined) => {
    diagnostics.push(manifestDiagnostic({
      filename,
      errorType,
      code,
      fieldPath,
      itemId,
      details,
      sequence,
    }));
    sequence += 1;
  };

  const filenames = new Map();
  input.maps.forEach((entry, index) => {
    const path = `$.maps[${index}]`;
    if (!CANONICAL_MAP_FILENAME_PATTERN.test(entry.filename) || entry.filename === filename) {
      add("REFERENCE_ERROR", "MAP_MANIFEST_FILENAME_INVALID", `${path}.filename`, entry.mapId, {
        filename: entry.filename,
        expected: "data/maps/<name>.json",
      });
    }
    if (filenames.has(entry.filename)) {
      add("ID_ERROR", "MAP_MANIFEST_FILENAME_DUPLICATE", `${path}.filename`, entry.mapId, {
        filename: entry.filename,
        firstFieldPath: filenames.get(entry.filename),
      });
    } else {
      filenames.set(entry.filename, `${path}.filename`);
    }
    if (entry.role === MAP_ROLE.BASE && entry.mapId !== BASE_MAP_ID) {
      add("ID_ERROR", "MAP_MANIFEST_BASE_ID_MISMATCH", `${path}.mapId`, entry.mapId, {
        expected: BASE_MAP_ID,
      });
    }
    if (entry.role !== MAP_ROLE.BASE && entry.mapId === BASE_MAP_ID) {
      add("ID_ERROR", "MAP_MANIFEST_NON_BASE_USES_BASE_ID", `${path}.mapId`, entry.mapId, {
        role: entry.role,
      });
    }
  });

  const baseEntries = input.maps.filter((entry) => entry.role === MAP_ROLE.BASE);
  if (baseEntries.length !== 1) {
    add("INVARIANT_ERROR", "MAP_MANIFEST_BASE_CARDINALITY_INVALID", "$.maps", BASE_MAP_ID, {
      expected: 1,
      actual: baseEntries.length,
    });
  }
  if (input.activeMapId !== BASE_MAP_ID) {
    add("INVARIANT_ERROR", "MAP_MANIFEST_ACTIVE_BASE_REQUIRED", "$.activeMapId", input.activeMapId, {
      expected: BASE_MAP_ID,
    });
  }

  return validationResult({
    filename,
    diagnostics,
    manifest: diagnostics.length === 0 ? freezeDeep(cloneValue(input)) : null,
  });
}

function defaultMapUrl(filename) {
  return new URL(`../../${filename}`, import.meta.url).href;
}

/** Loads the canonical manifest first, then exposes the exact MapLoader specifications it authored. */
export class MapManifestLoader {
  constructor({ dataLoader = null, loadText = undefined, resolveMapUrl = defaultMapUrl } = {}) {
    if (dataLoader !== null && loadText !== undefined) {
      throw new TypeError("dataLoader와 loadText는 동시에 지정할 수 없습니다.");
    }
    this.dataLoader = dataLoader ?? new DataLoader({
      validator: manifestValidator(),
      ...(loadText === undefined ? {} : { loadText }),
    });
    if (!this.dataLoader || typeof this.dataLoader.loadAll !== "function") {
      throw new TypeError("MapManifestLoader DataLoader 계약이 잘못됐습니다.");
    }
    if (typeof resolveMapUrl !== "function") throw new TypeError("resolveMapUrl은 함수여야 합니다.");
    this.resolveMapUrl = resolveMapUrl;
  }

  async load({ filename = CANONICAL_MAP_MANIFEST_FILENAME, url = MANIFEST_URL } = {}) {
    const loadReport = await this.dataLoader.loadAll([{
      filename,
      url,
      schemaName: MAP_MANIFEST_SCHEMA_NAME,
      boundary: VALIDATION_BOUNDARY.MAP_BASE,
    }]);
    if (loadReport.accepted.length !== 1) {
      return freezeDeep({
        ok: false,
        code: "MAP_MANIFEST_LOAD_BLOCKED",
        canStart: false,
        filename,
        diagnostics: loadReport.diagnostics,
        loadReport,
        manifest: null,
        specifications: [],
      });
    }

    const validation = validateMapManifestDefinition(loadReport.accepted[0].data, { filename });
    if (!validation.ok) {
      return freezeDeep({
        ok: false,
        code: validation.code,
        canStart: false,
        filename,
        diagnostics: validation.diagnostics,
        loadReport,
        manifest: null,
        specifications: [],
      });
    }

    const specifications = validation.manifest.maps.map((entry) => createMapLoadSpecification({
      filename: entry.filename,
      role: entry.role,
      expectedMapId: entry.mapId,
      url: this.resolveMapUrl(entry.filename),
    }));
    return freezeDeep({
      ok: true,
      code: "MAP_MANIFEST_READY",
      canStart: true,
      filename,
      diagnostics: [],
      loadReport,
      manifest: validation.manifest,
      specifications,
    });
  }
}
