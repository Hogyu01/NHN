import {
  BASE_MAP_ID,
  BASE_REQUIRED_SEMANTICS,
  MAP_ROLE,
  mapWorldSize,
  PROTOTYPE_REQUIRED_SEMANTICS,
} from "../world/map-schema.js";
import {
  CANONICAL_MAP_MANIFEST_FILENAME,
  CANONICAL_PROTOTYPE_MAP_ID,
  validateMapManifestDefinition,
} from "../world/map-manifest.js";
import { validateMapAccessibility } from "../world/map-accessibility.js";

const QA_ID = "canonical-maps";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runCase(id, description, validates, execute) {
  return Promise.resolve().then(execute).then(
    (details) => Object.freeze({ id, description, validates, status: "PASS", details }),
    (error) => Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function diagnosticCodes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

/**
 * Task 9 canonical-data examples over the production manifest, registry and accessibility path.
 * **Validates: Requirements 1.1, 1.3, 1.4, 20.4, 20.5, 20.6, 28.4, 28.7, 31.4, 33.3, 33.4, 33.5, 33.6, 33.7, 33.8, 33.13, 33.17, 34.4, 34.5**
 */
export async function runCanonicalMapProbe({
  manifestReport,
  mapLoadReport,
  mapValidator,
  mapLoader,
}) {
  if (!manifestReport?.ok || !mapLoadReport?.registry || !mapValidator || !mapLoader) {
    throw new TypeError("canonical Map probe에는 유효한 manifest/load/validator/loader가 필요합니다.");
  }
  const manifest = manifestReport.manifest;
  const registry = mapLoadReport.registry;
  const base = registry.get(BASE_MAP_ID);
  const prototype = registry.get(CANONICAL_PROTOTYPE_MAP_ID);

  const results = await Promise.all([
    runCase(
      "canonical-manifest-contract",
      "canonical manifest가 Base와 Prototype 경로·role·active ID를 정확히 authoring한다",
      "Requirements 20.4, 33.3, 33.5, 33.6",
      () => {
        assert(manifestReport.filename === CANONICAL_MAP_MANIFEST_FILENAME, "canonical manifest 경로가 다릅니다.");
        assert(manifest.activeMapId === BASE_MAP_ID, "canonical active Map이 Base가 아닙니다.");
        assert(manifest.maps.length === 2, `canonical Map 수가 2가 아닙니다: ${manifest.maps.length}`);
        const expected = [
          [BASE_MAP_ID, "data/maps/base-restaurant.json", MAP_ROLE.BASE],
          [CANONICAL_PROTOTYPE_MAP_ID, "data/maps/prototype-fixture.json", MAP_ROLE.PROTOTYPE],
        ];
        const actual = manifest.maps.map((entry) => [entry.mapId, entry.filename, entry.role]);
        assert(JSON.stringify(actual) === JSON.stringify(expected), `manifest entries=${JSON.stringify(actual)}`);
        assert(mapLoadReport.registryConformance.registeredCount === 2, "manifest Map 2개가 모두 등록되지 않았습니다.");
        return { activeMapId: manifest.activeMapId, entries: actual };
      },
    ),
    runCase(
      "manifest-rejects-invalid-without-coercion",
      "dangling active ID와 중복 filename을 fallback/coercion 없이 거절한다",
      "Requirements 20.4, 20.6, 33.6, 33.8",
      () => {
        const dangling = clone(manifest);
        dangling.activeMapId = "map.missing";
        const danglingResult = validateMapManifestDefinition(dangling);
        assert(!danglingResult.ok && diagnosticCodes(danglingResult).includes("REFERENCE_NOT_FOUND"), "dangling activeMapId가 거절되지 않았습니다.");
        assert(dangling.activeMapId === "map.missing", "dangling activeMapId가 보정됐습니다.");

        const duplicateFilename = clone(manifest);
        duplicateFilename.maps[1].filename = duplicateFilename.maps[0].filename;
        const duplicateResult = validateMapManifestDefinition(duplicateFilename);
        assert(!duplicateResult.ok && diagnosticCodes(duplicateResult).includes("MAP_MANIFEST_FILENAME_DUPLICATE"), "중복 filename이 거절되지 않았습니다.");
        assert(duplicateFilename.maps[1].filename === duplicateFilename.maps[0].filename, "중복 filename이 보정됐습니다.");
        return {
          danglingCodes: diagnosticCodes(danglingResult),
          duplicateCodes: diagnosticCodes(duplicateResult),
        };
      },
    ),
    runCase(
      "base-exact-map-contract",
      "Base가 30×20/960×640, 6 tables, table당 2 active seats, 총 12 seats를 정확히 유지한다",
      "Requirements 28.7, 33.3, 33.17, 34.4",
      () => {
        assert(base, "Base Map이 registry에 없습니다.");
        const world = mapWorldSize(base);
        assert(base.width === 30 && base.height === 20, "Base dimensions가 30×20이 아닙니다.");
        assert(world.width === 960 && world.height === 640, "Base World가 960×640이 아닙니다.");
        const tables = base.objects.filter((object) => object.kind === "TABLE");
        const activeSeats = base.navigation.seatPoints.filter((seat) => seat.activeByDefault);
        assert(tables.length === 6, `table count=${tables.length}`);
        assert(activeSeats.length === 12, `active seat count=${activeSeats.length}`);
        for (const table of tables) {
          const seats = activeSeats.filter((seat) => seat.tableId === table.objectId);
          const targets = base.navigation.tableServiceTargets.filter((target) => target.tableId === table.objectId);
          assert(seats.length === 2, `${table.objectId} active seats=${seats.length}`);
          assert(targets.length === 1, `${table.objectId} service targets=${targets.length}`);
        }
        return { dimensions: "30x20", world, tableCount: tables.length, activeSeatCount: activeSeats.length };
      },
    ),
    runCase(
      "base-authored-semantics-and-region",
      "Base가 authored start/spawn/exit, unique 4 semantics, service targets와 closed region을 제공한다",
      "Requirements 1.1, 1.3, 1.4, 28.4, 33.3, 33.4",
      () => {
        for (const point of [base.navigation.playerStart, base.navigation.spawnPoint, base.navigation.exitPoint]) {
          assert(typeof point?.pointId === "string" && point.pointId.length > 0, "필수 authored navigation point가 없습니다.");
        }
        for (const semantic of BASE_REQUIRED_SEMANTICS) {
          assert(base.zones.filter((zone) => zone.semantic === semantic).length === 1, `${semantic} semantic이 unique하지 않습니다.`);
        }
        const closedRegions = base.expansionRegions.filter((region) => !region.openByDefault);
        assert(closedRegions.length >= 1 && closedRegions.every((region) => region.collisionWhenClosed), "closed Expansion_Region이 없습니다.");
        return {
          points: [base.navigation.playerStart.pointId, base.navigation.spawnPoint.pointId, base.navigation.exitPoint.pointId],
          semantics: BASE_REQUIRED_SEMANTICS,
          serviceTargetCount: base.navigation.tableServiceTargets.length,
          closedRegionIds: closedRegions.map((region) => region.regionId),
        };
      },
    ),
    runCase(
      "base-active-accessibility",
      "Base active validity와 Spawn→12 Seats→Exit 및 Player→모든 target 접근성이 PASS다",
      "Requirements 33.6, 33.8, 33.13, 34.5",
      () => {
        assert(mapLoadReport.activeMapValidity.ok, "Base Active_Map_Validity가 FAIL입니다.");
        assert(mapLoadReport.activeMapValidity.details.accessibility === "PASS", "Base accessibility가 PASS가 아닙니다.");
        const summary = mapLoadReport.activeMapValidity.details.accessibilityReport.summary;
        assert(summary.activeSeatCount === 12, `accessibility active seats=${summary.activeSeatCount}`);
        assert(summary.guestPathCount === 24, `guest path count=${summary.guestPathCount}`);
        assert(summary.semanticZoneCount === 4, `semantic route count=${summary.semanticZoneCount}`);
        assert(summary.tableServiceTargetCount === 6, `service route count=${summary.tableServiceTargetCount}`);
        assert(summary.failedRouteCount === 0, `failed routes=${summary.failedRouteCount}`);
        return summary;
      },
    ),
    runCase(
      "prototype-semantic-compatibility",
      "Prototype fixture는 15×15와 board/stove/counter semantic compatibility를 보존한다",
      "Requirements 1.1, 33.5, 33.7",
      () => {
        assert(prototype, "Prototype fixture가 registry에 없습니다.");
        const validity = mapValidator.validateActiveMap({
          registry,
          activeMapId: CANONICAL_PROTOTYPE_MAP_ID,
          accessibilityValidator: validateMapAccessibility,
        });
        assert(validity.ok, `Prototype active validity=${diagnosticCodes(validity).join(",")}`);
        assert(prototype.width === 15 && prototype.height === 15, "Prototype dimensions가 15×15가 아닙니다.");
        for (const semantic of PROTOTYPE_REQUIRED_SEMANTICS) {
          assert(prototype.zones.filter((zone) => zone.semantic === semantic).length === 1, `${semantic} compatibility가 없습니다.`);
        }
        return {
          dimensions: "15x15",
          semantics: PROTOTYPE_REQUIRED_SEMANTICS,
          accessibility: validity.details.accessibility,
        };
      },
    ),
    runCase(
      "invalid-optional-quarantine-keeps-base",
      "invalid optional fixture는 quarantine되지만 fallback 없이 canonical Base start는 유지한다",
      "Requirements 20.6, 31.4, 33.7, 33.8",
      async () => {
        const invalidOptional = clone(prototype);
        invalidOptional.mapId = "map.optional.invalid_fixture";
        invalidOptional.width = 0;
        const report = await mapLoader.loadDefinitions([
          { filename: "memory/base-canonical.json", role: MAP_ROLE.BASE, data: base, expectedMapId: BASE_MAP_ID },
          { filename: "memory/invalid-optional.json", role: MAP_ROLE.OPTIONAL, data: invalidOptional, expectedMapId: invalidOptional.mapId },
        ]);
        assert(report.canStart && report.activeMapValidity.ok && report.activeMap?.mapId === BASE_MAP_ID, "invalid optional이 Base start를 막았습니다.");
        assert(report.quarantined.length === 1, `quarantine count=${report.quarantined.length}`);
        assert(report.quarantined[0].mapId === invalidOptional.mapId, "invalid optional identity가 보존되지 않았습니다.");
        return {
          activeMapId: report.activeMapId,
          quarantinedMapId: report.quarantined[0].mapId,
          codes: diagnosticCodes(report),
        };
      },
    ),
    runCase(
      "missing-base-never-falls-back",
      "Base가 없으면 Prototype을 fallback Base로 사용하지 않고 start를 차단한다",
      "Requirements 33.7, 33.8",
      async () => {
        const report = await mapLoader.loadDefinitions([
          { filename: "memory/prototype-only.json", role: MAP_ROLE.PROTOTYPE, data: prototype, expectedMapId: CANONICAL_PROTOTYPE_MAP_ID },
        ]);
        assert(!report.canStart && report.activeMap === null, "Prototype-only registry가 Base start를 허용했습니다.");
        assert(diagnosticCodes(report).includes("BASE_MAP_SPEC_CARDINALITY_INVALID"), "Base 누락 진단이 없습니다.");
        assert(diagnosticCodes(report).includes("ACTIVE_MAP_NOT_REGISTERED"), "active Base 누락 진단이 없습니다.");
        return { codes: diagnosticCodes(report) };
      },
    ),
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}
