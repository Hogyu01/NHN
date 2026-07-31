import { toDiagnosticPresentation } from "../core/diagnostic.js";
import {
  BOOT_STAGE,
  BOOT_STAGE_ORDER,
  BOOT_STATUS,
  BootStateProjection,
  bootStagePass,
  bootStageSkipped,
  executeBootPipeline,
} from "../app/bootstrap.js";
import { DataLoader } from "../infrastructure/data-loader.js";
import {
  BASE_MAP_ID,
  MAP_LIMITS,
  MAP_ROLE,
} from "../world/map-schema.js";
import {
  MapLoader,
  mapLoadReportToBootOutcome,
} from "../world/map-loader.js";
import { MapValidator } from "../world/map-validator.js";

const QA_ID = "map-validation";
const FLOOR_TILE_ID = "tile.fixture.floor";

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

function layers(width, height) {
  const area = width * height;
  return {
    ground: Array(area).fill(FLOOR_TILE_ID),
    collision: Array(area).fill(0),
    below: Array(area).fill(null),
    above: Array(area).fill(null),
  };
}

function point(pointId, tileX, tileY, offsetX = 16, offsetY = 16) {
  return { pointId, tileX, tileY, offsetX, offsetY };
}

function genericMap(mapId, width = 1, height = 1) {
  return {
    schemaVersion: 1,
    mapId,
    width,
    height,
    tileSize: 32,
    layers: layers(width, height),
    objects: [],
    zones: [],
    navigation: {
      playerStart: point(`${mapId}.player-start`, 0, 0),
      spawnPoint: point(`${mapId}.spawn`, 0, 0),
      exitPoint: point(`${mapId}.exit`, 0, 0),
      approachPoints: [],
      seatPoints: [],
      tableServiceTargets: [],
      transitions: [],
    },
    expansionRegions: [],
  };
}

function baseMap() {
  const width = 30;
  const height = 20;
  const tableTiles = [
    [15, 5], [19, 5], [23, 5],
    [15, 10], [19, 10], [23, 10],
  ];
  const objects = [];
  const seatPoints = [];
  const tableServiceTargets = [];
  const approachPoints = [];

  tableTiles.forEach(([tileX, tileY], index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const tableId = `table.${ordinal}`;
    const approachId = `approach.table.${ordinal}`;
    objects.push({
      objectId: tableId,
      kind: "TABLE",
      rect: { x: tileX * 32, y: tileY * 32, width: 32, height: 32 },
      blocksMovement: false,
    });
    approachPoints.push(point(approachId, tileX, tileY + 1));
    tableServiceTargets.push({
      targetId: `service-target.${ordinal}`,
      tableId,
      tileX,
      tileY,
      offsetX: 16,
      offsetY: 16,
      proximityRadius: 48,
      approachTileIds: [approachId],
    });
    for (const [side, seatX, facing] of [
      ["a", tileX - 1, "RIGHT"],
      ["b", tileX + 1, "LEFT"],
    ]) {
      seatPoints.push({
        ...point(`point.seat.${ordinal}.${side}`, seatX, tileY),
        seatId: `seat.${ordinal}.${side}`,
        tableId,
        activeByDefault: true,
        facing,
      });
    }
  });

  const zoneDefinitions = [
    ["board", 2, 2],
    ["stove", 5, 2],
    ["counter", 8, 2],
    ["storage", 11, 2],
  ];
  const zones = zoneDefinitions.map(([semantic, tileX, tileY]) => {
    const approachId = `approach.zone.${semantic}`;
    approachPoints.push(point(approachId, tileX, tileY + 1));
    return {
      zoneId: `zone.${semantic}`,
      semantic,
      rect: { x: tileX * 32, y: tileY * 32, width: 32, height: 32 },
      approachTileIds: [approachId],
    };
  });

  return {
    schemaVersion: 1,
    mapId: BASE_MAP_ID,
    width,
    height,
    tileSize: 32,
    layers: layers(width, height),
    objects,
    zones,
    navigation: {
      playerStart: point("point.player-start", 2, 6, 16, 24),
      spawnPoint: point("point.spawn", 2, 18),
      exitPoint: point("point.exit", 4, 18),
      approachPoints,
      seatPoints,
      tableServiceTargets,
      transitions: [],
    },
    expansionRegions: [{
      regionId: "region.expansion.closed",
      rect: { x: 25 * 32, y: 13 * 32, width: 4 * 32, height: 5 * 32 },
      openByDefault: false,
      collisionWhenClosed: true,
      seatIds: [],
    }],
  };
}

export {
  baseMap as createBaseMapFixture,
  genericMap as createGenericMapFixture,
};

function entry(filename, role, data) {
  return { filename, role, data, expectedMapId: data?.mapId };
}

function hasCode(report, code) {
  return report.diagnostics.some((diagnostic) => diagnostic.code === code);
}

function validStageCallbacks(mapOutcome, observed) {
  return Object.fromEntries(BOOT_STAGE_ORDER.map((stageId) => [stageId, async () => {
    observed.push(stageId);
    if (stageId === BOOT_STAGE.MAP) return mapOutcome;
    if (stageId === BOOT_STAGE.SAVE) {
      return bootStageSkipped({ checkpoint: null }, "SAVE_DEFERRED", { boundaryEstablished: true });
    }
    return bootStagePass({ stageId }, { stageId }, `${stageId}_READY`);
  }]));
}

/**
 * Task 7 unit, boundary-matrix and generated-dimension validation using production Map modules.
 * Property 19: Map limits, Base validity, optional isolation.
 * **Validates: Requirements 20.1, 20.4, 20.5, 20.6, 28.5, 28.6, 28.7, 31.2, 31.4, 31.6, 33.1, 33.2, 33.6, 33.7, 33.8**
 */
export async function runMapValidationProbe() {
  const validator = new MapValidator({ knownTileIds: [FLOOR_TILE_ID] });
  const loader = new MapLoader({ mapValidator: validator });
  const results = await Promise.all([
    runCase(
      "valid-size-boundaries",
      "1×1, 128×127 non-square, 128×128 Map을 Base와 함께 등록한다",
      "Requirements 20.5, 33.1, 33.2",
      async () => {
        const report = await loader.loadDefinitions([
          entry("memory/base.json", MAP_ROLE.BASE, baseMap()),
          entry("memory/one.json", MAP_ROLE.OPTIONAL, genericMap("map.fixture.one", 1, 1)),
          entry("memory/non-square.json", MAP_ROLE.OPTIONAL, genericMap("map.fixture.non-square", 128, 127)),
          entry("memory/max.json", MAP_ROLE.OPTIONAL, genericMap("map.fixture.max", 128, 128)),
        ]);
        assert(report.canStart && report.registryConformance.registeredCount === 4, "유효 경계 Map이 모두 등록되지 않았습니다.");
        assert(report.activeMapValidity.ok, "유효 Base active validity가 실패했습니다.");
        return {
          mapIds: report.registryConformance.mapIds,
          maxArea: 128 * 128,
          nonSquareArea: 128 * 127,
        };
      },
    ),
    runCase(
      "generated-valid-dimensions",
      "생성한 축 경계 조합 전부가 구조 계약을 만족한다",
      "Requirements 20.5, 33.1",
      () => {
        const dimensions = [[1, 1], [1, 128], [128, 1], [31, 97], [64, 127], [127, 128], [128, 127], [128, 128]];
        const checked = [];
        dimensions.forEach(([width, height], index) => {
          const definition = genericMap(`map.generated.valid.${index}`, width, height);
          const validation = validator.validateDefinition({
            definition,
            filename: `memory/generated-valid-${index}.json`,
            role: MAP_ROLE.OPTIONAL,
            expectedMapId: definition.mapId,
          });
          assert(validation.ok, `${width}×${height}가 거절됐습니다: ${validation.diagnostics.map((entry) => entry.code).join(",")}`);
          checked.push({ width, height, area: width * height });
        });
        return { checked };
      },
    ),
    runCase(
      "invalid-axis-mutations",
      "0, 129, non-integer 축을 coercion하지 않고 거절한다",
      "Requirements 20.1, 20.5, 33.1",
      () => {
        const mutations = [
          ["zero-width", 0, 1, "VALUE_BELOW_MINIMUM"],
          ["zero-height", 1, 0, "VALUE_BELOW_MINIMUM"],
          ["too-wide", 129, 1, "VALUE_ABOVE_MAXIMUM"],
          ["fractional", 1.5, 1, "TYPE_MISMATCH"],
        ];
        const observed = [];
        mutations.forEach(([id, width, height, expectedCode]) => {
          const definition = genericMap(`map.invalid.${id}`, 1, 1);
          definition.width = width;
          definition.height = height;
          const validation = validator.validateDefinition({
            definition,
            filename: `memory/${id}.json`,
            role: MAP_ROLE.OPTIONAL,
          });
          assert(!validation.ok && validation.diagnostics.some((entry) => entry.code === expectedCode), `${id} mutation이 ${expectedCode}로 거절되지 않았습니다.`);
          assert(definition.width === width && definition.height === height, `${id} 입력이 보정됐습니다.`);
          observed.push({ id, expectedCode });
        });
        return { observed };
      },
    ),
    runCase(
      "duplicate-map-id-quarantine",
      "Base와 같은 Map_ID의 optional Map만 격리하고 Base를 유지한다",
      "Requirements 31.2, 31.4, 33.2, 33.7",
      async () => {
        const duplicate = genericMap(BASE_MAP_ID, 1, 1);
        const report = await loader.loadDefinitions([
          entry("memory/base.json", MAP_ROLE.BASE, baseMap()),
          entry("memory/duplicate.json", MAP_ROLE.OPTIONAL, duplicate),
        ]);
        assert(report.canStart && report.activeMapValidity.ok, "optional duplicate가 Base start를 막았습니다.");
        assert(report.registryConformance.registeredCount === 1 && report.quarantined.length === 1, "duplicate 격리 수가 잘못됐습니다.");
        assert(hasCode(report, "DUPLICATE_ID"), "duplicate Map_ID 진단이 없습니다.");
        return { registered: report.registryConformance.mapIds, quarantined: report.quarantined.length };
      },
    ),
    runCase(
      "seventeenth-map-quarantine",
      "Base 포함 16개까지만 등록하고 17번째 optional Map을 격리한다",
      "Requirements 31.2, 31.4, 33.2",
      async () => {
        const entries = [entry("memory/base.json", MAP_ROLE.BASE, baseMap())];
        for (let index = 1; index <= 16; index += 1) {
          const map = genericMap(`map.optional.${String(index).padStart(2, "0")}`);
          entries.push(entry(`memory/optional-${index}.json`, MAP_ROLE.OPTIONAL, map));
        }
        const report = await loader.loadDefinitions(entries);
        assert(report.canStart, "17번째 optional Map이 Base start를 막았습니다.");
        assert(report.registryConformance.registeredCount === MAP_LIMITS.maximumRegisteredMaps, "registry 등록 수가 16이 아닙니다.");
        assert(report.quarantined.length === 1 && hasCode(report, "MAP_REGISTRY_CAPACITY_EXCEEDED"), "17번째 Map이 capacity 진단으로 격리되지 않았습니다.");
        return { registered: report.registryConformance.registeredCount, quarantined: report.quarantined.length };
      },
    ),
    runCase(
      "optional-cross-reference-quarantine",
      "destination Map이 없는 optional transition을 격리하고 Base 판정을 보존한다",
      "Requirements 20.1, 31.4, 33.7",
      async () => {
        const optional = genericMap("map.optional.broken-transition", 2, 2);
        optional.navigation.transitions.push({
          ...point("point.transition.out", 1, 1),
          transitionId: "transition.out",
          destinationMapId: "map.missing",
          destinationEntryId: "point.entry",
        });
        const report = await loader.loadDefinitions([
          entry("memory/base.json", MAP_ROLE.BASE, baseMap()),
          entry("memory/broken-transition.json", MAP_ROLE.OPTIONAL, optional),
        ]);
        assert(report.canStart && report.activeMapValidity.ok, "broken optional transition이 Base를 오염시켰습니다.");
        assert(report.quarantined.length === 1 && hasCode(report, "TRANSITION_DESTINATION_MAP_NOT_FOUND"), "broken transition이 격리되지 않았습니다.");
        return { code: report.code, active: report.activeMapValidity.code };
      },
    ),
    runCase(
      "local-reference-and-region-quarantine",
      "zone approach와 expansion seat의 dangling reference를 해당 optional Map에서만 집계한다",
      "Requirements 20.1, 28.5, 28.6, 31.4",
      async () => {
        const optional = genericMap("map.optional.broken-local", 2, 2);
        optional.zones.push({
          zoneId: "zone.board",
          semantic: "board",
          rect: { x: 0, y: 0, width: 32, height: 32 },
          approachTileIds: ["approach.missing"],
        });
        optional.expansionRegions.push({
          regionId: "region.broken",
          rect: { x: 32, y: 32, width: 32, height: 32 },
          openByDefault: false,
          collisionWhenClosed: true,
          seatIds: ["seat.missing"],
        });
        const report = await loader.loadDefinitions([
          entry("memory/base.json", MAP_ROLE.BASE, baseMap()),
          entry("memory/broken-local.json", MAP_ROLE.OPTIONAL, optional),
        ]);
        assert(report.canStart && report.quarantined.length === 1, "local optional defect 격리에 실패했습니다.");
        assert(hasCode(report, "APPROACH_POINT_REFERENCE_NOT_FOUND"), "zone reference 진단이 없습니다.");
        assert(hasCode(report, "EXPANSION_REGION_SEAT_REFERENCE_NOT_FOUND"), "region seat 진단이 없습니다.");
        return { codes: report.quarantined[0].diagnostics.map((entry) => entry.code) };
      },
    ),
    runCase(
      "optional-parse-quarantine",
      "깨진 optional JSON은 parse diagnostic과 원래 filename/Map_ID로 격리한다",
      "Requirements 20.4, 20.6, 31.4, 33.7",
      async () => {
        const memory = new Map([
          ["memory/base.json", JSON.stringify(baseMap())],
          ["memory/broken-json.json", "{broken-json"],
        ]);
        const dataLoader = new DataLoader({
          validator: validator.schemaValidator,
          loadText: async ({ filename }) => memory.get(filename),
        });
        const parseLoader = new MapLoader({ mapValidator: validator, dataLoader });
        const report = await parseLoader.load([
          { filename: "memory/base.json", role: MAP_ROLE.BASE, expectedMapId: BASE_MAP_ID },
          { filename: "memory/broken-json.json", role: MAP_ROLE.PROTOTYPE, expectedMapId: "map.prototype.fixture" },
        ]);
        assert(report.canStart && report.quarantined.length === 1, "깨진 Prototype JSON이 Base를 막았습니다.");
        assert(report.quarantined[0].mapId === "map.prototype.fixture" && hasCode(report, "JSON_PARSE_FAILED"), "quarantine identity/parse 진단이 잘못됐습니다.");
        const presentation = toDiagnosticPresentation(report.quarantined[0].diagnostics[0]);
        assert(presentation.source === "memory/broken-json.json" && presentation.errorType === "PARSE_ERROR", "filename/errorType-first 진단이 아닙니다.");
        return { presentation };
      },
    ),
    runCase(
      "base-structure-fatal",
      "width 0 Base를 FATAL로 거절하고 active Map을 생성하지 않는다",
      "Requirements 20.4, 20.5, 20.6, 33.1, 33.8",
      async () => {
        const invalid = baseMap();
        invalid.width = 0;
        const report = await loader.loadDefinitions([entry("memory/base-zero.json", MAP_ROLE.BASE, invalid)]);
        assert(!report.canStart && report.blocked && report.activeMap === null, "invalid Base가 campaign start를 허용했습니다.");
        assert(hasCode(report, "VALUE_BELOW_MINIMUM"), "Base width 진단이 없습니다.");
        assert(report.diagnostics.every((entry) => entry.severity === "FATAL_BOOT"), "Base failure가 FATAL_BOOT가 아닙니다.");
        return { diagnostics: report.diagnostics, activeCode: report.activeMapValidity.code };
      },
    ),
    runCase(
      "base-active-validity-separate",
      "schema-valid하지만 storage semantic이 없는 Base를 별도 Active_Map_Validity에서 차단한다",
      "Requirements 33.4, 33.6, 33.8",
      async () => {
        const invalid = baseMap();
        invalid.zones = invalid.zones.filter((zone) => zone.semantic !== "storage");
        const report = await loader.loadDefinitions([entry("memory/base-active-invalid.json", MAP_ROLE.BASE, invalid)]);
        assert(report.registryConformance.ok, "active-only 결함이 Registry_Conformance를 실패시켰습니다.");
        assert(!report.activeMapValidity.ok && !report.canStart, "invalid active Base가 start를 허용했습니다.");
        assert(hasCode(report, "BASE_SEMANTIC_CARDINALITY_INVALID"), "Base semantic active 진단이 없습니다.");
        return {
          diagnostics: report.activeMapValidity.diagnostics,
          registryCode: report.registryConformance.code,
          activeCode: report.activeMapValidity.code,
        };
      },
    ),
    runCase(
      "staged-bootstrap-map-boundary",
      "optional quarantine는 MAP stage를 통과하고 invalid Base는 MAP에서 후속 stage를 차단한다",
      "Requirements 20.4, 20.6, 33.6, 33.7, 33.8",
      async () => {
        const optional = genericMap("map.optional.stage-broken", 2, 2);
        optional.navigation.transitions.push({
          ...point("point.transition.stage", 1, 1),
          transitionId: "transition.stage",
          destinationMapId: "map.missing",
          destinationEntryId: "point.missing",
        });
        const quarantined = await loader.loadDefinitions([
          entry("memory/base.json", MAP_ROLE.BASE, baseMap()),
          entry("memory/stage-broken.json", MAP_ROLE.OPTIONAL, optional),
        ]);
        const validObserved = [];
        const validPipeline = await executeBootPipeline({
          stages: validStageCallbacks(mapLoadReportToBootOutcome(quarantined), validObserved),
          projection: new BootStateProjection(),
        });
        assert(validPipeline.ok && validPipeline.projection.status === BOOT_STATUS.READY, "optional quarantine가 MAP boot를 차단했습니다.");

        const invalid = baseMap();
        invalid.zones = invalid.zones.filter((zone) => zone.semantic !== "storage");
        const blockedReport = await loader.loadDefinitions([entry("memory/base-invalid.json", MAP_ROLE.BASE, invalid)]);
        const blockedObserved = [];
        const blockedPipeline = await executeBootPipeline({
          stages: validStageCallbacks(mapLoadReportToBootOutcome(blockedReport), blockedObserved),
          projection: new BootStateProjection(),
        });
        assert(!blockedPipeline.ok && blockedPipeline.failedStage === BOOT_STAGE.MAP, "invalid Base가 MAP stage에서 차단되지 않았습니다.");
        assert(JSON.stringify(blockedObserved) === JSON.stringify([
          BOOT_STAGE.SHELL,
          BOOT_STAGE.BUILD_FLAGS,
          BOOT_STAGE.DATA,
          BOOT_STAGE.MAP,
        ]), "MAP failure 뒤 stage callback이 실행됐습니다.");
        return {
          optionalPipeline: validPipeline.code,
          blockedStage: blockedPipeline.failedStage,
          observed: blockedObserved,
        };
      },
    ),
    runCase(
      "registry-sealed-immutable",
      "load 완료 뒤 registry와 Map definition을 외부 mutation에서 보호한다",
      "Requirements 31.6, 33.2",
      async () => {
        const report = await loader.loadDefinitions([entry("memory/base.json", MAP_ROLE.BASE, baseMap())]);
        const definition = report.registry.get(BASE_MAP_ID);
        assert(report.registry.sealed && Object.isFrozen(definition) && Object.isFrozen(definition.layers.ground), "registry/definition이 immutable하지 않습니다.");
        let rejected = false;
        try {
          report.registry.register({ definition: genericMap("map.late"), filename: "memory/late.json", role: MAP_ROLE.OPTIONAL });
        } catch {
          rejected = true;
        }
        assert(rejected, "sealed registry가 late registration을 허용했습니다.");
        return { sealed: report.registry.sealed, registered: report.registryConformance.registeredCount };
      },
    ),
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  const baseFailure = results.find((result) => result.id === "base-active-validity-separate")?.details?.diagnostics ?? [];
  return Object.freeze({
    qaId: QA_ID,
    property: "Property 19: Map limits, Base validity, optional isolation",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
    evidence: Object.freeze({ baseFailure: Object.freeze([...baseFailure]) }),
  });
}

export function runMapValidationShellSmoke({ root, app, report }) {
  assert(report?.status === "PASS", "Map validation probe가 PASS가 아닙니다.");
  const mapStage = app.getBootState().stages.find((stage) => stage.stageId === BOOT_STAGE.MAP);
  assert(mapStage?.status === "PASS" && mapStage.code === "MAP_READY", "Task 9 canonical MAP stage가 PASS/MAP_READY가 아닙니다.");
  assert(mapStage.details?.manifestFilename === "data/maps/map-manifest.json", "canonical Map manifest 경로가 boot stage에 기록되지 않았습니다.");
  assert(mapStage.details?.specificationCount === 2, "canonical Map specification 수가 2가 아닙니다.");
  assert(app.mapLoadReport?.activeMapValidity.ok, "실제 browser Base Active_Map_Validity가 PASS가 아닙니다.");
  assert(app.mapLoadReport?.activeMapValidity.details.accessibility === "PASS", "실제 browser Base accessibility가 PASS가 아닙니다.");
  assert(app.mapLoadReport?.registryConformance.registeredCount === 2, "Base/Prototype canonical Map이 모두 등록되지 않았습니다.");
  const diagnostic = report.evidence.baseFailure[0];
  assert(diagnostic?.severity === "FATAL_BOOT", "Base failure evidence가 FATAL_BOOT가 아닙니다.");

  app.hub?.stop({ deactivate: true });
  app.shell.errorScreen.show([diagnostic], { blockStart: true });
  const errorScreen = root.querySelector("#screen-error");
  const primary = errorScreen?.querySelector(".diagnostic-primary")?.textContent ?? "";
  const startButton = root.querySelector("#btn-start");
  const creditsButton = root.querySelector("#btn-credits");
  assert(errorScreen && !errorScreen.classList.contains("hidden"), "Base Map failure 뒤 error screen이 보이지 않습니다.");
  assert(primary.includes("memory/base-active-invalid.json") && primary.includes("INVARIANT_ERROR"), "Map 오류가 filename/errorType-first가 아닙니다.");
  assert(startButton?.disabled, "Base Map failure가 start를 차단하지 않았습니다.");
  app.shell.credits.open(creditsButton);
  assert(!root.querySelector("#credits-overlay")?.classList.contains("hidden"), "Base Map failure에서 Credits가 열리지 않습니다.");
  app.shell.credits.close();
  assert(!errorScreen.classList.contains("hidden"), "Credits 종료 뒤 Map error route가 사라졌습니다.");

  root.documentElement.dataset.mapFaultInjection = "base";
  root.documentElement.dataset.mapStageCode = mapStage.code;
  return Object.freeze({
    mapStageCode: mapStage.code,
    startBlocked: true,
    errorVisible: true,
    creditsAccessible: true,
  });
}

export function publishMapValidationReport(root, report, shellSmoke = null) {
  if (!root?.body || typeof root.createElement !== "function") return report;
  root.querySelector("#map-validation-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "map-validation-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");
  const heading = root.createElement("h2");
  heading.textContent = `Map registry & loader: ${report.status}`;
  const summary = root.createElement("p");
  summary.textContent = `${report.passed}/${report.total} 검사 통과${shellSmoke ? " · Base fatal shell PASS" : ""}`;
  const list = root.createElement("ol");
  for (const result of report.results) {
    const item = root.createElement("li");
    item.className = result.status === "PASS" ? "qa-pass" : "qa-fail";
    item.textContent = `${result.status} — ${result.description}`;
    if (result.error) {
      const error = root.createElement("pre");
      error.textContent = result.error;
      item.append(error);
    }
    list.append(item);
  }
  section.append(heading, summary, list);
  root.body.append(section);
  root.body.dataset.mapValidationQa = report.status.toLowerCase();
  root.body.dataset.mapValidationQaPassed = String(report.passed);
  root.body.dataset.mapValidationQaTotal = String(report.total);
  root.dispatchEvent(new CustomEvent("map-validation:qa-complete", { detail: { report, shellSmoke } }));
  console.group(`QA: ${QA_ID} — ${report.status}`);
  console.table(report.results);
  console.groupEnd();
  return report;
}
