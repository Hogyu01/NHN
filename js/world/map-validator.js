import {
  compareDiagnostics,
  createDiagnostic,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { cloneValue, freezeDeep } from "../core/result.js";
import { DataValidator, resolveValidationSeverity, VALIDATION_BOUNDARY } from "../infrastructure/data-validator.js";
import { SchemaRegistry } from "../infrastructure/schema-registry.js";
import {
  BASE_MAP_ID,
  BASE_REQUIRED_SEMANTICS,
  isStableMapIdentifier,
  MAP_DEFINITION_SCHEMA,
  MAP_LAYER_NAMES,
  MAP_ROLE,
  MAP_SCHEMA_NAME,
  mapWorldSize,
  PROTOTYPE_REQUIRED_SEMANTICS,
} from "./map-schema.js";
import {
  isGuestNavigationPointPassable as guestPointPassable,
  isPlayerNavigationPointPassable as playerPointPassable,
} from "./passability-grid.js";

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function boundaryForRole(role) {
  return role === MAP_ROLE.BASE ? VALIDATION_BOUNDARY.MAP_BASE : VALIDATION_BOUNDARY.MAP_OPTIONAL;
}

function resultClassification(boundary) {
  return boundary === VALIDATION_BOUNDARY.MAP_BASE ? "FATAL" : "QUARANTINED";
}

function identifierPart(value) {
  return String(value ?? "none").replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 100) || "none";
}

export function createMapDiagnostic({
  severity,
  filename,
  errorType,
  code,
  fieldPath,
  itemId = undefined,
  mapId = undefined,
  details = undefined,
  sequence = 0,
}) {
  return createDiagnostic({
    diagnosticId: [
      "diagnostic",
      "MapValidator",
      identifierPart(filename),
      identifierPart(errorType),
      identifierPart(code),
      identifierPart(fieldPath),
      String(sequence).padStart(6, "0"),
    ].join(":"),
    severity,
    subsystem: "MapValidator",
    filename,
    errorType,
    code,
    fieldPath,
    itemId,
    mapId,
    details,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function tileCellId(cell) {
  if (typeof cell === "string") return cell;
  if (isPlainObject(cell) && typeof cell.tileId === "string") return cell.tileId;
  return null;
}

function isStableId(value) {
  return typeof value === "string" && STABLE_ID_PATTERN.test(value);
}

function inTileBounds(definition, point) {
  return Number.isSafeInteger(point?.tileX) && Number.isSafeInteger(point?.tileY) &&
    point.tileX >= 0 && point.tileY >= 0 && point.tileX < definition.width && point.tileY < definition.height;
}

function rectInWorld(definition, rect) {
  const world = mapWorldSize(definition);
  return world && Number.isSafeInteger(rect?.x) && Number.isSafeInteger(rect?.y) &&
    Number.isSafeInteger(rect?.width) && Number.isSafeInteger(rect?.height) &&
    rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
    rect.x + rect.width <= world.width && rect.y + rect.height <= world.height;
}

function navigationEntryIds(definition) {
  const navigation = definition.navigation;
  return new Set([
    navigation.playerStart.pointId,
    navigation.spawnPoint.pointId,
    navigation.exitPoint.pointId,
    ...navigation.approachPoints.map((point) => point.pointId),
    ...navigation.seatPoints.map((point) => point.pointId),
    ...navigation.transitions.map((point) => point.pointId),
  ]);
}

function validityResult({ ok, code, filename, mapId, role, boundary, diagnostics, definition = null, details = undefined }) {
  return freezeDeep({
    ok,
    code,
    filename,
    mapId,
    role,
    boundary,
    classification: resultClassification(boundary),
    diagnostics: [...diagnostics].sort(compareDiagnostics),
    ...(definition === null ? {} : { definition }),
    ...(details === undefined ? {} : { details }),
  });
}

/** Full structural, geometry, local-reference, registry-reference and active-map validation. */
export class MapValidator {
  constructor({ schemaValidator = null, knownTileIds = null } = {}) {
    this.schemaValidator = schemaValidator ?? new DataValidator({
      registry: new SchemaRegistry([[MAP_SCHEMA_NAME, MAP_DEFINITION_SCHEMA]]),
    });
    if (!this.schemaValidator || typeof this.schemaValidator.validate !== "function") {
      throw new TypeError("MapValidator schemaValidator는 validate를 제공해야 합니다.");
    }
    if (knownTileIds !== null && !(knownTileIds instanceof Set) && !Array.isArray(knownTileIds)) {
      throw new TypeError("knownTileIds는 Set, 배열 또는 null이어야 합니다.");
    }
    this.knownTileIds = knownTileIds === null ? null : new Set(knownTileIds);
  }

  validateDefinition({ definition, filename, role, expectedMapId = undefined }) {
    const boundary = boundaryForRole(role);
    const schema = this.schemaValidator.validate({
      filename,
      schemaName: MAP_SCHEMA_NAME,
      boundary,
      data: definition,
    });
    if (!schema.ok) {
      return validityResult({
        ok: false,
        code: "MAP_SCHEMA_INVALID",
        filename,
        mapId: isStableMapIdentifier(definition?.mapId) ? definition.mapId : expectedMapId ?? null,
        role,
        boundary,
        diagnostics: schema.diagnostics,
      });
    }

    const mapId = definition.mapId;
    const severity = resolveValidationSeverity(boundary);
    const diagnostics = [];
    let sequence = 0;
    const add = (errorType, code, fieldPath, itemId = undefined, details = undefined) => {
      diagnostics.push(createMapDiagnostic({
        severity,
        filename,
        mapId,
        errorType,
        code,
        fieldPath,
        itemId,
        details,
        sequence,
      }));
      sequence += 1;
    };

    if (expectedMapId !== undefined && mapId !== expectedMapId) {
      add("ID_ERROR", "MAP_ID_MANIFEST_MISMATCH", "$.mapId", mapId, { expected: expectedMapId, actual: mapId });
    }
    if (role === MAP_ROLE.BASE && mapId !== BASE_MAP_ID) {
      add("ID_ERROR", "BASE_MAP_ID_MISMATCH", "$.mapId", mapId, { expected: BASE_MAP_ID });
    }
    if (role !== MAP_ROLE.BASE && mapId === BASE_MAP_ID) {
      add("ID_ERROR", "NON_BASE_ROLE_USES_BASE_MAP_ID", "$.mapId", mapId, { role });
    }

    const area = definition.width * definition.height;
    for (const layerName of MAP_LAYER_NAMES) {
      const layer = definition.layers[layerName];
      if (layer.length !== area) {
        add("INVARIANT_ERROR", "MAP_LAYER_LENGTH_MISMATCH", `$.layers.${layerName}`, mapId, {
          layerName,
          expected: area,
          actual: layer.length,
        });
      }
    }

    for (const layerName of ["ground", "below", "above"]) {
      definition.layers[layerName].forEach((cell, index) => {
        if (layerName === "ground" && cell === null) {
          add("REFERENCE_ERROR", "GROUND_TILE_REQUIRED", `$.layers.${layerName}[${index}]`, mapId);
          return;
        }
        if (cell === null) return;
        const id = tileCellId(cell);
        if (!isStableId(id)) {
          add("REFERENCE_ERROR", "TILE_REFERENCE_INVALID", `$.layers.${layerName}[${index}]`, mapId, { value: cell });
        } else if (this.knownTileIds && !this.knownTileIds.has(id)) {
          add("REFERENCE_ERROR", "TILE_REFERENCE_NOT_FOUND", `$.layers.${layerName}[${index}]`, id);
        }
      });
    }

    const namespaces = new Map();
    const addUnique = (namespace, id, path) => {
      let values = namespaces.get(namespace);
      if (!values) {
        values = new Map();
        namespaces.set(namespace, values);
      }
      if (values.has(id)) {
        add("ID_ERROR", "MAP_LOCAL_ID_DUPLICATE", path, id, {
          namespace,
          firstFieldPath: values.get(id),
        });
      } else {
        values.set(id, path);
      }
    };

    const tableIds = new Set();
    definition.objects.forEach((object, index) => {
      const path = `$.objects[${index}]`;
      addUnique("object", object.objectId, `${path}.objectId`);
      if (!rectInWorld(definition, object.rect)) {
        add("RANGE_ERROR", "MAP_OBJECT_OUT_OF_BOUNDS", `${path}.rect`, object.objectId, { rect: object.rect });
      }
      if (object.kind === "TABLE") tableIds.add(object.objectId);
    });

    definition.zones.forEach((zone, index) => {
      const path = `$.zones[${index}]`;
      addUnique("zone", zone.zoneId, `${path}.zoneId`);
      if (!rectInWorld(definition, zone.rect)) {
        add("RANGE_ERROR", "MAP_ZONE_OUT_OF_BOUNDS", `${path}.rect`, zone.zoneId, { rect: zone.rect });
      }
    });

    const navigation = definition.navigation;
    const pointRecords = [
      [navigation.playerStart, "$.navigation.playerStart", "PLAYER"],
      [navigation.spawnPoint, "$.navigation.spawnPoint", "GUEST"],
      [navigation.exitPoint, "$.navigation.exitPoint", "GUEST"],
      ...navigation.approachPoints.map((point, index) => [point, `$.navigation.approachPoints[${index}]`, "PLAYER"]),
      ...navigation.seatPoints.map((point, index) => [point, `$.navigation.seatPoints[${index}]`, "GUEST"]),
      ...navigation.transitions.map((point, index) => [point, `$.navigation.transitions[${index}]`, "PLAYER"]),
    ];
    for (const [point, path, gridKind] of pointRecords) {
      addUnique("navigation-point", point.pointId, `${path}.pointId`);
      if (!inTileBounds(definition, point)) {
        add("RANGE_ERROR", "NAVIGATION_POINT_OUT_OF_BOUNDS", path, point.pointId, {
          tileX: point.tileX,
          tileY: point.tileY,
          width: definition.width,
          height: definition.height,
        });
      } else if (gridKind === "PLAYER" && !playerPointPassable(definition, point)) {
        add("INVARIANT_ERROR", "PLAYER_NAVIGATION_POINT_BLOCKED", path, point.pointId);
      } else if (gridKind === "GUEST" && !guestPointPassable(definition, point)) {
        add("INVARIANT_ERROR", "GUEST_NAVIGATION_POINT_BLOCKED", path, point.pointId);
      }
    }

    const approachPointIds = new Set(navigation.approachPoints.map((point) => point.pointId));
    const validateApproachReferences = (ids, path, itemId) => {
      for (let index = 0; index < ids.length; index += 1) {
        if (!approachPointIds.has(ids[index])) {
          add("REFERENCE_ERROR", "APPROACH_POINT_REFERENCE_NOT_FOUND", `${path}[${index}]`, itemId, {
            approachPointId: ids[index],
          });
        }
      }
    };

    definition.zones.forEach((zone, index) => {
      validateApproachReferences(zone.approachTileIds, `$.zones[${index}].approachTileIds`, zone.zoneId);
    });

    const seatIds = new Set();
    navigation.seatPoints.forEach((seat, index) => {
      const path = `$.navigation.seatPoints[${index}]`;
      addUnique("seat", seat.seatId, `${path}.seatId`);
      seatIds.add(seat.seatId);
      if (!tableIds.has(seat.tableId)) {
        add("REFERENCE_ERROR", "SEAT_TABLE_REFERENCE_NOT_FOUND", `${path}.tableId`, seat.seatId, { tableId: seat.tableId });
      }
    });

    navigation.tableServiceTargets.forEach((target, index) => {
      const path = `$.navigation.tableServiceTargets[${index}]`;
      addUnique("service-target", target.targetId, `${path}.targetId`);
      if (!inTileBounds(definition, target)) {
        add("RANGE_ERROR", "SERVICE_TARGET_OUT_OF_BOUNDS", path, target.targetId, {
          tileX: target.tileX,
          tileY: target.tileY,
        });
      }
      if (!tableIds.has(target.tableId)) {
        add("REFERENCE_ERROR", "SERVICE_TARGET_TABLE_REFERENCE_NOT_FOUND", `${path}.tableId`, target.targetId, {
          tableId: target.tableId,
        });
      }
      validateApproachReferences(target.approachTileIds, `${path}.approachTileIds`, target.targetId);
    });

    navigation.transitions.forEach((transition, index) => {
      addUnique("transition", transition.transitionId, `$.navigation.transitions[${index}].transitionId`);
    });

    definition.expansionRegions.forEach((region, index) => {
      const path = `$.expansionRegions[${index}]`;
      addUnique("expansion-region", region.regionId, `${path}.regionId`);
      if (!rectInWorld(definition, region.rect)) {
        add("RANGE_ERROR", "EXPANSION_REGION_OUT_OF_BOUNDS", `${path}.rect`, region.regionId, { rect: region.rect });
      }
      region.seatIds.forEach((seatId, seatIndex) => {
        if (!seatIds.has(seatId)) {
          add("REFERENCE_ERROR", "EXPANSION_REGION_SEAT_REFERENCE_NOT_FOUND", `${path}.seatIds[${seatIndex}]`, region.regionId, { seatId });
          return;
        }
        const seat = navigation.seatPoints.find((candidate) => candidate.seatId === seatId);
        if (!region.openByDefault && seat?.activeByDefault) {
          add("INVARIANT_ERROR", "CLOSED_REGION_ACTIVE_SEAT_CONFLICT", `${path}.seatIds[${seatIndex}]`, region.regionId, { seatId });
        }
      });
    });

    const ok = diagnostics.length === 0;
    return validityResult({
      ok,
      code: ok ? "MAP_DEFINITION_VALID" : "MAP_DEFINITION_INVALID",
      filename,
      mapId,
      role,
      boundary,
      diagnostics,
      definition: ok ? freezeDeep(cloneValue(definition)) : null,
    });
  }

  validateRegistryReferences({ record, registry }) {
    const { definition, filename, role, mapId } = record;
    const boundary = boundaryForRole(role);
    const severity = resolveValidationSeverity(boundary);
    const diagnostics = [];
    let sequence = 0;
    for (let index = 0; index < definition.navigation.transitions.length; index += 1) {
      const transition = definition.navigation.transitions[index];
      const path = `$.navigation.transitions[${index}]`;
      const destination = registry.get(transition.destinationMapId);
      if (!destination) {
        diagnostics.push(createMapDiagnostic({
          severity,
          filename,
          mapId,
          errorType: "REFERENCE_ERROR",
          code: "TRANSITION_DESTINATION_MAP_NOT_FOUND",
          fieldPath: `${path}.destinationMapId`,
          itemId: transition.transitionId,
          details: { destinationMapId: transition.destinationMapId },
          sequence,
        }));
        sequence += 1;
        continue;
      }
      if (!navigationEntryIds(destination).has(transition.destinationEntryId)) {
        diagnostics.push(createMapDiagnostic({
          severity,
          filename,
          mapId,
          errorType: "REFERENCE_ERROR",
          code: "TRANSITION_DESTINATION_ENTRY_NOT_FOUND",
          fieldPath: `${path}.destinationEntryId`,
          itemId: transition.transitionId,
          details: {
            destinationMapId: transition.destinationMapId,
            destinationEntryId: transition.destinationEntryId,
          },
          sequence,
        }));
        sequence += 1;
      }
    }
    return validityResult({
      ok: diagnostics.length === 0,
      code: diagnostics.length === 0 ? "MAP_REGISTRY_REFERENCES_VALID" : "MAP_REGISTRY_REFERENCES_INVALID",
      filename,
      mapId,
      role,
      boundary,
      diagnostics,
      definition,
    });
  }

  validateActiveMap({ registry, activeMapId = BASE_MAP_ID, accessibilityValidator = null }) {
    const record = registry.getRecord(activeMapId);
    if (!record) {
      const boundary = activeMapId === BASE_MAP_ID ? VALIDATION_BOUNDARY.MAP_BASE : VALIDATION_BOUNDARY.MAP_OPTIONAL;
      const diagnostic = createMapDiagnostic({
        severity: resolveValidationSeverity(boundary),
        filename: "data/maps/map-manifest.json",
        mapId: activeMapId,
        errorType: "REFERENCE_ERROR",
        code: "ACTIVE_MAP_NOT_REGISTERED",
        fieldPath: "$.activeMapId",
        itemId: activeMapId,
        details: { registeredMapIds: registry.mapIds() },
      });
      return validityResult({
        ok: false,
        code: diagnostic.code,
        filename: diagnostic.filename,
        mapId: activeMapId,
        role: activeMapId === BASE_MAP_ID ? MAP_ROLE.BASE : MAP_ROLE.OPTIONAL,
        boundary,
        diagnostics: [diagnostic],
      });
    }

    const { definition, filename, role, mapId } = record;
    const boundary = boundaryForRole(role);
    const severity = resolveValidationSeverity(boundary);
    const diagnostics = [];
    let sequence = 0;
    const add = (errorType, code, fieldPath, itemId = mapId, details = undefined) => {
      diagnostics.push(createMapDiagnostic({
        severity,
        filename,
        mapId,
        errorType,
        code,
        fieldPath,
        itemId,
        details,
        sequence,
      }));
      sequence += 1;
    };

    if (role === MAP_ROLE.BASE || mapId === BASE_MAP_ID) {
      if (definition.width !== 30 || definition.height !== 20) {
        add("INVARIANT_ERROR", "BASE_MAP_DIMENSIONS_INVALID", "$", mapId, {
          expected: { width: 30, height: 20 },
          actual: { width: definition.width, height: definition.height },
        });
      }
      const tables = definition.objects.filter((object) => object.kind === "TABLE");
      if (tables.length !== 6) {
        add("INVARIANT_ERROR", "BASE_TABLE_COUNT_INVALID", "$.objects", mapId, { expected: 6, actual: tables.length });
      }
      const tableIds = new Set(tables.map((table) => table.objectId));
      const activeSeats = definition.navigation.seatPoints.filter((seat) => seat.activeByDefault);
      if (activeSeats.length !== 12) {
        add("INVARIANT_ERROR", "BASE_ACTIVE_SEAT_COUNT_INVALID", "$.navigation.seatPoints", mapId, {
          expected: 12,
          actual: activeSeats.length,
        });
      }
      for (const tableId of tableIds) {
        const seatCount = activeSeats.filter((seat) => seat.tableId === tableId).length;
        if (seatCount !== 2) {
          add("INVARIANT_ERROR", "BASE_SEATS_PER_TABLE_INVALID", "$.navigation.seatPoints", tableId, {
            expected: 2,
            actual: seatCount,
          });
        }
      }
      const targets = definition.navigation.tableServiceTargets;
      if (targets.length !== 6 || [...tableIds].some((tableId) => targets.filter((target) => target.tableId === tableId).length !== 1)) {
        add("INVARIANT_ERROR", "BASE_TABLE_SERVICE_TARGETS_INVALID", "$.navigation.tableServiceTargets", mapId, {
          expected: 6,
          actual: targets.length,
        });
      }
      for (const semantic of BASE_REQUIRED_SEMANTICS) {
        const count = definition.zones.filter((zone) => zone.semantic === semantic).length;
        if (count !== 1) {
          add("INVARIANT_ERROR", "BASE_SEMANTIC_CARDINALITY_INVALID", "$.zones", semantic, { semantic, expected: 1, actual: count });
        }
      }
      const closedRegions = definition.expansionRegions.filter((region) => !region.openByDefault);
      if (closedRegions.length < 1) {
        add("INVARIANT_ERROR", "BASE_CLOSED_EXPANSION_REGION_MISSING", "$.expansionRegions", mapId);
      }
    }

    if (role === MAP_ROLE.PROTOTYPE) {
      if (definition.width !== 15 || definition.height !== 15) {
        add("INVARIANT_ERROR", "PROTOTYPE_MAP_DIMENSIONS_INVALID", "$", mapId, {
          expected: { width: 15, height: 15 },
          actual: { width: definition.width, height: definition.height },
        });
      }
      for (const semantic of PROTOTYPE_REQUIRED_SEMANTICS) {
        const count = definition.zones.filter((zone) => zone.semantic === semantic).length;
        if (count !== 1) {
          add("INVARIANT_ERROR", "PROTOTYPE_SEMANTIC_CARDINALITY_INVALID", "$.zones", semantic, {
            semantic,
            expected: 1,
            actual: count,
          });
        }
      }
    }

    const geometryDiagnosticCount = diagnostics.length;
    let accessibility = "NOT_INSTALLED";
    let accessibilityReport = null;
    if (accessibilityValidator !== null) {
      if (typeof accessibilityValidator !== "function") throw new TypeError("accessibilityValidator는 함수 또는 null이어야 합니다.");
      const result = accessibilityValidator(definition, {
        filename,
        mapId,
        role,
        boundary,
        severity,
      });
      if (!result || typeof result.ok !== "boolean" || !Array.isArray(result.diagnostics)) {
        throw new TypeError("accessibilityValidator 결과 계약이 잘못됐습니다.");
      }
      accessibility = result.ok ? "PASS" : "FAIL";
      accessibilityReport = result.report ?? null;
      diagnostics.push(...result.diagnostics);
    }

    return validityResult({
      ok: diagnostics.length === 0,
      code: diagnostics.length === 0 ? "ACTIVE_MAP_VALID" : "ACTIVE_MAP_INVALID",
      filename,
      mapId,
      role,
      boundary,
      diagnostics,
      definition,
      details: {
        geometry: geometryDiagnosticCount === 0 ? "PASS" : "FAIL",
        accessibility,
        ...(accessibilityReport === null ? {} : { accessibilityReport }),
      },
    });
  }
}
