import {
  compareDiagnostics,
  formatDiagnostic,
  toDiagnosticPresentation,
} from "../core/diagnostic.js";
import { DataLoader } from "../infrastructure/data-loader.js";
import {
  DataValidator,
  VALIDATION_BOUNDARY,
} from "../infrastructure/data-validator.js";
import {
  createDefaultSchemaRegistry,
  DATA_SCHEMA,
} from "../infrastructure/schema-registry.js";

const QA_ID = "data-validation";

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

function fixtures() {
  const ingredients = {
    schemaVersion: 1,
    ingredients: [
      {
        ingredientId: "ingredient.slime-jelly",
        displayName: "슬라임 젤리",
        basePriceG: 8,
        marketAvailabilityRate: 80,
        qualityDistribution: [
          { minQuality: 0, maxQuality: 59, weight: 0.4 },
          { minQuality: 60, maxQuality: 100, weight: 0.6 },
        ],
      },
      {
        ingredientId: "ingredient.dungeon-herb",
        displayName: "던전 약초",
        basePriceG: 6,
        marketAvailabilityRate: 75,
        qualityDistribution: [{ minQuality: 0, maxQuality: 100, weight: 1 }],
      },
    ],
  };
  const recipes = {
    schemaVersion: 1,
    recipes: [{
      recipeId: "recipe.slime-stew",
      displayName: "슬라임 스튜",
      basePriceG: 28,
      ingredientRequirements: [
        { ingredientId: "ingredient.slime-jelly", quantity: 1 },
        { ingredientId: "ingredient.dungeon-herb", quantity: 1 },
      ],
      timing: {
        targetOffsetMs: 2_000,
        successWindowMs: 200,
        normalWindowMs: 500,
        failureOffsetMs: 3_000,
      },
    }],
  };
  const map = {
    schemaVersion: 1,
    mapId: "map.fixture",
    width: 2,
    height: 2,
    tileSize: 32,
    layers: {
      ground: ["floor", "floor", "floor", "floor"],
      collision: [0, 0, 0, 0],
      below: [null, null, null, null],
      above: [null, null, null, null],
    },
  };
  const save = {
    formatVersion: 1,
    checkpointPhase: "PLANNING_READY",
    economy: { cashG: 300, contractReserveG: 20, debtG: 500, arrearsG: 0 },
    inventory: {
      lots: [{
        lotId: "lot.0001",
        ingredientId: "ingredient.slime-jelly",
        quantity: 2,
        unreservedQuantity: 1,
        quality: 70,
        bookCostG: 16,
        acquiredDay: 1,
      }],
      reservations: [{
        reservationId: "reservation.0001",
        saleSlotId: "slot.0001",
        lotId: "lot.0001",
        ingredientId: "ingredient.slime-jelly",
        quantity: 1,
      }],
    },
    menu: {
      saleSlots: [{
        saleSlotId: "slot.0001",
        recipeId: "recipe.slime-stew",
        state: "ASSIGNED",
        activeOrderId: "order.0001",
      }],
    },
    campaign: {
      day: 1,
      reputation: 30,
      processedCauseIds: ["cause.day-1"],
      canonicalDayResults: [],
    },
  };
  return { ingredients, recipes, map, save };
}

function documents(values = fixtures()) {
  return [
    {
      filename: "data/ingredients.json",
      schemaName: DATA_SCHEMA.INGREDIENT_REGISTRY_V1,
      boundary: VALIDATION_BOUNDARY.STATIC_REQUIRED,
      data: values.ingredients,
    },
    {
      filename: "data/recipes.json",
      schemaName: DATA_SCHEMA.RECIPE_REGISTRY_V1,
      boundary: VALIDATION_BOUNDARY.STATIC_REQUIRED,
      data: values.recipes,
    },
    {
      filename: "data/maps/fixture.json",
      schemaName: DATA_SCHEMA.MAP_DEFINITION_CORE_V1,
      boundary: VALIDATION_BOUNDARY.MAP_BASE,
      data: values.map,
    },
    {
      storageKey: "dungeonRestaurant.save.current",
      schemaName: DATA_SCHEMA.SAVE_STATE_CORE_V1,
      boundary: VALIDATION_BOUNDARY.SAVE,
      data: values.save,
    },
  ];
}

function hasCode(report, code) {
  return report.diagnostics.some((diagnostic) => diagnostic.code === code);
}

/**
 * Task 4 bounded mutation probe. It exercises production schemas/loader directly and introduces
 * one constraint violation per focused case; no test-only validator is used.
 *
 * Property 27: Validator soundness와 진단 순서
 * **Validates: Requirements 14.5, 18.8, 18.9, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 33.1**
 */
export async function runDataValidationProbe() {
  const validator = new DataValidator({ registry: createDefaultSchemaRegistry() });
  const results = await Promise.all([
    runCase(
      "valid-foundation-documents",
      "유효한 static/Map/save 문서는 field·type·ID·range·reference·invariant 검사를 통과한다",
      "Requirements 20.1, 20.3, 20.7",
      () => {
        const report = validator.validateDocuments(documents());
        assert(report.ok && report.diagnostics.length === 0, "유효 fixture가 거절됐습니다.");
        return { documents: report.documentResults.length, code: report.code };
      },
    ),
    runCase(
      "percentage-ratio-rejected-without-coercion",
      "외부 rate의 0..1 normalized ratio를 percentage로 자동 보정하지 않고 거절한다",
      "Requirement 20.2",
      () => {
        const values = fixtures();
        values.ingredients.ingredients[0].marketAvailabilityRate = 0.6;
        const report = validator.validateDocuments(documents(values));
        assert(hasCode(report, "PERCENTAGE_NORMALIZED_RATIO_FORBIDDEN"), "0.6 ratio가 거절되지 않았습니다.");
        assert(values.ingredients.ingredients[0].marketAvailabilityRate === 0.6, "ratio가 percentage로 보정됐습니다.");
        return { valueAfterValidation: values.ingredients.ingredients[0].marketAvailabilityRate };
      },
    ),
    runCase(
      "zero-map-dimensions-rejected",
      "width/height 0을 각각 range 오류로 거절한다",
      "Requirements 20.5, 33.1",
      () => {
        const widthValues = fixtures();
        widthValues.map.width = 0;
        const heightValues = fixtures();
        heightValues.map.height = 0;
        const widthReport = validator.validateDocuments(documents(widthValues));
        const heightReport = validator.validateDocuments(documents(heightValues));
        assert(hasCode(widthReport, "VALUE_BELOW_MINIMUM"), "width 0이 거절되지 않았습니다.");
        assert(hasCode(heightReport, "VALUE_BELOW_MINIMUM"), "height 0이 거절되지 않았습니다.");
        return { widthErrors: widthReport.diagnostics.length, heightErrors: heightReport.diagnostics.length };
      },
    ),
    runCase(
      "dangling-recipe-reference-rejected",
      "Recipe의 존재하지 않는 ingredient 참조를 filename/errorType 진단으로 거절한다",
      "Requirements 14.5, 20.1, 20.4",
      () => {
        const values = fixtures();
        values.recipes.recipes[0].ingredientRequirements[1].ingredientId = "ingredient.missing";
        const report = validator.validateDocuments(documents(values));
        const diagnostic = report.diagnostics.find((entry) => entry.code === "REFERENCE_NOT_FOUND");
        assert(diagnostic, "dangling Recipe reference가 거절되지 않았습니다.");
        assert(diagnostic.filename === "data/recipes.json" && diagnostic.errorType === "REFERENCE_ERROR", "진단 source/type이 잘못됐습니다.");
        return toDiagnosticPresentation(diagnostic);
      },
    ),
    runCase(
      "duplicate-id-rejected",
      "동일 namespace의 중복 stable ID를 집계하고 거절한다",
      "Requirement 20.1",
      () => {
        const values = fixtures();
        values.ingredients.ingredients[1].ingredientId = values.ingredients.ingredients[0].ingredientId;
        const report = validator.validateDocuments(documents(values));
        assert(hasCode(report, "DUPLICATE_ID"), "duplicate ingredient ID가 거절되지 않았습니다.");
        return { duplicateCount: report.diagnostics.filter((entry) => entry.code === "DUPLICATE_ID").length };
      },
    ),
    runCase(
      "quality-distribution-contract",
      "Quality 경계와 distribution weight 합 1±0.000001을 각각 검사한다",
      "Requirement 20.3",
      () => {
        const boundaryValues = fixtures();
        boundaryValues.ingredients.ingredients[0].qualityDistribution[0].minQuality = -1;
        const sumValues = fixtures();
        sumValues.ingredients.ingredients[0].qualityDistribution[1].weight = 0.5;
        const boundaryReport = validator.validateDocuments(documents(boundaryValues));
        const sumReport = validator.validateDocuments(documents(sumValues));
        assert(hasCode(boundaryReport, "QUALITY_OUT_OF_RANGE"), "Quality -1이 거절되지 않았습니다.");
        assert(hasCode(sumReport, "QUALITY_DISTRIBUTION_WEIGHT_SUM"), "weight 합 0.9가 거절되지 않았습니다.");
        return { tolerance: 0.000001 };
      },
    ),
    runCase(
      "corrupt-save-invariant-rejected",
      "cash보다 큰 reserve와 lot/reservation 불일치를 corrupt save로 거절한다",
      "Requirements 18.8, 20.7",
      () => {
        const values = fixtures();
        values.save.economy.contractReserveG = 301;
        values.save.inventory.lots[0].unreservedQuantity = 2;
        const report = validator.validateDocuments(documents(values));
        assert(hasCode(report, "SAVE_RESERVE_EXCEEDS_CASH"), "reserve>cash가 거절되지 않았습니다.");
        assert(hasCode(report, "SAVE_LOT_RESERVATION_MISMATCH"), "lot/reservation 불일치가 거절되지 않았습니다.");
        const saveResult = report.documentResults.find((entry) => entry.source === "dungeonRestaurant.save.current");
        assert(saveResult.classification === "BLOCKING", "save corruption이 BLOCKING으로 분류되지 않았습니다.");
        return { codes: saveResult.diagnostics.map((entry) => entry.code) };
      },
    ),
    runCase(
      "type-is-not-silently-coerced",
      "숫자 문자열을 integer로 coercion하지 않는다",
      "Requirement 20.1",
      () => {
        const values = fixtures();
        values.save.economy.cashG = "300";
        const report = validator.validateDocuments(documents(values));
        assert(hasCode(report, "TYPE_MISMATCH"), "문자열 cash가 number로 coercion됐습니다.");
        assert(values.save.economy.cashG === "300", "입력 save가 mutation됐습니다.");
        return { retainedType: typeof values.save.economy.cashG };
      },
    ),
    runCase(
      "severity-boundary-classification",
      "required/optional/save/API failure를 FATAL/QUARANTINED/BLOCKING/RECOVERABLE로 분류한다",
      "Requirements 20.4, 20.6, 20.7",
      () => {
        const values = fixtures();
        values.ingredients.ingredients[0].marketAvailabilityRate = 0.5;
        const required = validator.validate(documents(values)[0]);

        const optionalMap = clone(fixtures().map);
        optionalMap.width = 0;
        const optional = validator.validate({
          filename: "data/maps/optional.json",
          schemaName: DATA_SCHEMA.MAP_DEFINITION_CORE_V1,
          boundary: VALIDATION_BOUNDARY.MAP_OPTIONAL,
          data: optionalMap,
        });
        const save = clone(fixtures().save);
        save.economy.contractReserveG = 999;
        const blocking = validator.validate({
          storageKey: "dungeonRestaurant.save.current",
          schemaName: DATA_SCHEMA.SAVE_STATE_CORE_V1,
          boundary: VALIDATION_BOUNDARY.SAVE,
          data: save,
        });
        const recoverable = validator.validate({
          filename: "api:contract-offer",
          schemaName: DATA_SCHEMA.API_PERCENTAGE_V1,
          boundary: VALIDATION_BOUNDARY.API,
          data: { rate: 0.7 },
        });
        const classes = [required, optional, blocking, recoverable].map((report) => report.documentResults[0].classification);
        assert(JSON.stringify(classes) === JSON.stringify(["FATAL", "QUARANTINED", "BLOCKING", "RECOVERABLE"]), `분류가 잘못됐습니다: ${classes.join(",")}`);
        return { classes };
      },
    ),
    runCase(
      "aggregate-and-presentation-order",
      "여러 파일 오류를 모두 집계하고 source/errorType을 item/field/code보다 먼저 제시한다",
      "Requirement 20.4",
      () => {
        const values = fixtures();
        values.ingredients.ingredients[0].marketAvailabilityRate = 0.5;
        values.ingredients.ingredients[1].ingredientId = values.ingredients.ingredients[0].ingredientId;
        values.recipes.recipes[0].ingredientRequirements[1].ingredientId = "ingredient.missing";
        values.map.width = 0;
        values.save.economy.contractReserveG = 999;
        const report = validator.validateDocuments(documents(values));
        assert(report.diagnostics.length >= 5, "다중 오류가 fail-fast로 누락됐습니다.");
        const sorted = [...report.diagnostics].sort(compareDiagnostics);
        assert(report.diagnostics.every((entry, index) => entry === sorted[index]), "진단이 stable presentation 순서가 아닙니다.");
        for (const diagnostic of report.diagnostics) {
          const presentation = toDiagnosticPresentation(diagnostic);
          const keys = Object.keys(presentation);
          assert(keys[0] === "source" && keys[1] === "errorType", "presentation 첫 필드가 source/errorType이 아닙니다.");
          const firstLine = formatDiagnostic(diagnostic).split("\n")[0];
          assert(firstLine === `${presentation.source} | ${presentation.errorType}`, "formatter 첫 줄이 source/errorType이 아닙니다.");
        }
        return { aggregated: report.diagnostics.length, first: toDiagnosticPresentation(report.diagnostics[0]) };
      },
    ),
    runCase(
      "loader-parse-load-aggregation",
      "DataLoader가 parse/load 오류 뒤에도 나머지 파일을 읽고 optional 오류만 quarantine한다",
      "Requirements 20.1, 20.4, 20.6",
      async () => {
        const values = fixtures();
        const memory = new Map([
          ["data/ingredients.json", JSON.stringify(values.ingredients)],
          ["data/recipes.json", JSON.stringify(values.recipes)],
          ["data/maps/broken-json.json", "{not-json"],
        ]);
        const loader = new DataLoader({
          validator,
          loadText: async ({ filename }) => {
            if (!memory.has(filename)) throw new Error(`missing: ${filename}`);
            return memory.get(filename);
          },
        });
        const report = await loader.loadAll([
          {
            filename: "data/ingredients.json",
            schemaName: DATA_SCHEMA.INGREDIENT_REGISTRY_V1,
            boundary: VALIDATION_BOUNDARY.STATIC_REQUIRED,
          },
          {
            filename: "data/recipes.json",
            schemaName: DATA_SCHEMA.RECIPE_REGISTRY_V1,
            boundary: VALIDATION_BOUNDARY.STATIC_REQUIRED,
          },
          {
            filename: "data/maps/broken-json.json",
            schemaName: DATA_SCHEMA.MAP_DEFINITION_CORE_V1,
            boundary: VALIDATION_BOUNDARY.MAP_OPTIONAL,
          },
          {
            filename: "data/maps/missing.json",
            schemaName: DATA_SCHEMA.MAP_DEFINITION_CORE_V1,
            boundary: VALIDATION_BOUNDARY.MAP_OPTIONAL,
          },
        ]);
        assert(report.accepted.length === 2, "유효 parsed 문서가 승인되지 않았습니다.");
        assert(report.diagnostics.some((entry) => entry.errorType === "PARSE_ERROR"), "parse 오류가 누락됐습니다.");
        assert(report.diagnostics.some((entry) => entry.errorType === "LOAD_ERROR"), "load 오류가 누락됐습니다.");
        assert(report.quarantined.length === 2 && !report.blocked, "optional 오류가 quarantine 경계를 넘었습니다.");
        return { accepted: report.accepted.length, quarantined: report.quarantined.length };
      },
    ),
    runCase(
      "schema-registry-duplicate-guard",
      "SchemaRegistry가 같은 이름의 schema 재등록을 거절한다",
      "Requirement 20.1",
      () => {
        const registry = createDefaultSchemaRegistry();
        let rejected = false;
        try {
          registry.register(DATA_SCHEMA.API_PERCENTAGE_V1, { type: "object" });
        } catch {
          rejected = true;
        }
        assert(rejected, "schema 이름 중복이 허용됐습니다.");
        return { registered: registry.names().length };
      },
    ),
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    property: "Property 27: Validator soundness와 진단 순서",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}

export function runDataValidationShellSmoke({ root, shell, report }) {
  assert(report?.status === "PASS", "validator probe가 PASS가 아니어서 shell smoke를 실행할 수 없습니다.");
  const values = fixtures();
  values.recipes.recipes[0].ingredientRequirements[0].ingredientId = "ingredient.missing";
  const validation = new DataValidator().validateDocuments(documents(values));
  shell.errorScreen.show(validation.diagnostics, { blockStart: true });

  const errorScreen = root.querySelector("#screen-error");
  const firstPrimary = errorScreen?.querySelector(".diagnostic-primary");
  const firstSecondary = errorScreen?.querySelector(".diagnostic-secondary");
  const startButton = root.querySelector("#btn-start");
  const creditsButton = root.querySelector("#btn-credits");
  assert(errorScreen && !errorScreen.classList.contains("hidden"), "fatal validation 뒤 error route가 표시되지 않았습니다.");
  assert(firstPrimary?.textContent.includes("data/"), "오류 첫 표시가 filename/storage key가 아닙니다.");
  assert(firstPrimary?.textContent.includes("_ERROR"), "오류 첫 표시가 errorType을 포함하지 않습니다.");
  assert(firstSecondary?.textContent.includes("code="), "item/field/code 상세가 primary 뒤에 없습니다.");
  assert(startButton?.disabled, "fatal validation 뒤 campaign start가 차단되지 않았습니다.");
  assert(creditsButton && !creditsButton.disabled, "error route에서 credits 접근이 사라졌습니다.");

  shell.credits.open(creditsButton);
  const creditsOverlay = root.querySelector("#credits-overlay");
  assert(creditsOverlay && !creditsOverlay.classList.contains("hidden"), "error route에서 credits가 열리지 않았습니다.");
  shell.credits.close();
  assert(!errorScreen.classList.contains("hidden"), "credits를 닫은 뒤 error route가 사라졌습니다.");

  return Object.freeze({
    errorVisible: true,
    startBlocked: true,
    creditsAccessible: true,
    diagnosticCount: validation.diagnostics.length,
  });
}

export function publishDataValidationReport(root, report, shellSmoke = null) {
  if (!root?.body || typeof root.createElement !== "function") return report;
  root.querySelector("#data-validation-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "data-validation-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");

  const heading = root.createElement("h2");
  heading.textContent = `Data validation: ${report.status}`;
  section.append(heading);
  const summary = root.createElement("p");
  summary.textContent = `${report.passed}/${report.total} 검사 통과${shellSmoke ? " · error/credits shell PASS" : ""}`;
  section.append(summary);
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
  section.append(list);
  root.body.append(section);
  root.body.dataset.dataValidationQa = report.status.toLowerCase();
  root.dispatchEvent(new CustomEvent("data-validation:qa-complete", {
    detail: { report, shellSmoke },
  }));
  console.group(`QA: ${QA_ID} — ${report.status}`);
  console.table(report.results);
  console.groupEnd();
  return report;
}
