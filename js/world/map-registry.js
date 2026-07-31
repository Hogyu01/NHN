import { compareDiagnostics, DIAGNOSTIC_SEVERITY } from "../core/diagnostic.js";
import { cloneValue, freezeDeep } from "../core/result.js";
import {
  BASE_MAP_ID,
  isMapRole,
  isStableMapIdentifier,
  MAP_LIMITS,
  MAP_ROLE,
} from "./map-schema.js";
import { createMapDiagnostic } from "./map-validator.js";

function roleSeverity(role) {
  return role === MAP_ROLE.BASE
    ? DIAGNOSTIC_SEVERITY.FATAL_BOOT
    : DIAGNOSTIC_SEVERITY.QUARANTINED_CONTENT;
}

/**
 * Session-bounded Map registry. Definitions are cloned/frozen on entry and no mutable Map object is
 * exposed. Invalid optional content is recorded separately instead of consuming registry capacity.
 */
export class MapRegistry {
  #entries = new Map();
  #quarantine = [];
  #sealed = false;

  constructor({ maximumMaps = MAP_LIMITS.maximumRegisteredMaps, baseMapId = BASE_MAP_ID } = {}) {
    if (!Number.isSafeInteger(maximumMaps) || maximumMaps < 1 || maximumMaps > MAP_LIMITS.maximumRegisteredMaps) {
      throw new RangeError(`maximumMaps는 1..${MAP_LIMITS.maximumRegisteredMaps}여야 합니다.`);
    }
    if (!isStableMapIdentifier(baseMapId)) throw new TypeError("baseMapId는 stable ID여야 합니다.");
    this.maximumMaps = maximumMaps;
    this.baseMapId = baseMapId;
  }

  register({ definition, filename, role }) {
    this.#assertMutable();
    if (!definition || typeof definition !== "object") throw new TypeError("Map definition이 필요합니다.");
    if (typeof filename !== "string" || filename.trim() === "") throw new TypeError("Map filename이 필요합니다.");
    if (!isMapRole(role)) throw new TypeError(`알 수 없는 Map role입니다: ${role}`);
    const mapId = definition.mapId;
    if (!isStableMapIdentifier(mapId)) throw new TypeError("Map definition mapId는 stable ID여야 합니다.");

    if (this.#entries.has(mapId)) {
      const first = this.#entries.get(mapId);
      const diagnostic = createMapDiagnostic({
        severity: roleSeverity(role),
        filename,
        mapId,
        itemId: mapId,
        fieldPath: "$.mapId",
        errorType: "ID_ERROR",
        code: "MAP_ID_DUPLICATE",
        details: { firstFilename: first.filename, firstRole: first.role },
      });
      return freezeDeep({ ok: false, code: diagnostic.code, diagnostics: [diagnostic] });
    }

    if (this.#entries.size >= this.maximumMaps) {
      const diagnostic = createMapDiagnostic({
        severity: roleSeverity(role),
        filename,
        mapId,
        itemId: mapId,
        fieldPath: "$.mapId",
        errorType: "RANGE_ERROR",
        code: "MAP_REGISTRY_CAPACITY_EXCEEDED",
        details: { maximum: this.maximumMaps, attemptedCount: this.#entries.size + 1 },
      });
      return freezeDeep({ ok: false, code: diagnostic.code, diagnostics: [diagnostic] });
    }

    const record = freezeDeep({
      mapId,
      filename,
      role,
      definition: freezeDeep(cloneValue(definition)),
    });
    this.#entries.set(mapId, record);
    return freezeDeep({ ok: true, code: "MAP_REGISTERED", record });
  }

  quarantine({ filename, role, mapId = null, diagnostics }) {
    this.#assertMutable();
    if (role === MAP_ROLE.BASE) throw new Error("Base Map은 quarantine할 수 없습니다.");
    if (!isMapRole(role)) throw new TypeError(`알 수 없는 Map role입니다: ${role}`);
    if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
      throw new TypeError("quarantine에는 하나 이상의 diagnostic이 필요합니다.");
    }
    const record = freezeDeep({
      filename,
      role,
      mapId: isStableMapIdentifier(mapId) ? mapId : null,
      diagnostics: [...diagnostics].sort(compareDiagnostics),
    });
    this.#quarantine.push(record);
    return record;
  }

  removeToQuarantine(mapId, diagnostics) {
    this.#assertMutable();
    const record = this.#entries.get(mapId);
    if (!record) throw new RangeError(`등록되지 않은 Map입니다: ${mapId}`);
    if (record.role === MAP_ROLE.BASE) throw new Error("Base Map은 registry에서 제거할 수 없습니다.");
    this.#entries.delete(mapId);
    return this.quarantine({
      filename: record.filename,
      role: record.role,
      mapId: record.mapId,
      diagnostics,
    });
  }

  has(mapId) {
    return this.#entries.has(mapId);
  }

  get(mapId) {
    return this.#entries.get(mapId)?.definition ?? null;
  }

  getRecord(mapId) {
    return this.#entries.get(mapId) ?? null;
  }

  entries() {
    return Object.freeze([...this.#entries.values()]);
  }

  mapIds() {
    return Object.freeze([...this.#entries.keys()].sort((left, right) => left.localeCompare(right, "en")));
  }

  quarantineEntries() {
    return Object.freeze([...this.#quarantine]);
  }

  seal() {
    this.#sealed = true;
    return this;
  }

  get sealed() {
    return this.#sealed;
  }

  snapshot() {
    const registered = [...this.#entries.values()]
      .map((record) => freezeDeep({
        mapId: record.mapId,
        filename: record.filename,
        role: record.role,
        width: record.definition.width,
        height: record.definition.height,
      }))
      .sort((left, right) => left.mapId.localeCompare(right.mapId, "en"));
    return freezeDeep({
      baseMapId: this.baseMapId,
      maximumMaps: this.maximumMaps,
      registeredCount: registered.length,
      registered,
      quarantinedCount: this.#quarantine.length,
      quarantined: [...this.#quarantine],
      sealed: this.#sealed,
    });
  }

  #assertMutable() {
    if (this.#sealed) throw new Error("sealed MapRegistry는 변경할 수 없습니다.");
  }
}
