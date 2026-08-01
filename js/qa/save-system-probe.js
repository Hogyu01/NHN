import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { freezeDeep } from "../core/result.js";
import { createRngRegistryState } from "../core/rng.js";
import { generateDailyContractOffers } from "../domain/contract.js";
import { createEconomyState } from "../domain/economy.js";
import { createEventState } from "../domain/events.js";
import { createFacilityState } from "../domain/facility.js";
import { createInventoryAccountingState } from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import { generateDailyMarket } from "../domain/market.js";
import { createMenuState } from "../domain/menu.js";
import { createRecipeState } from "../domain/recipe.js";
import { createReputationCampaignFields } from "../domain/reputation.js";
import { createSaleSlotsState } from "../domain/sale-slots.js";
import { createSalesState } from "../domain/sales.js";
import { createProgressionState, createUnlockCatalog } from "../domain/unlocks.js";
import {
  buildSavePayload,
  createSaveEnvelope,
  isNormalizationIdempotent,
  readSaveEnvelope,
  SAVE_FORMAT_VERSION,
} from "../infrastructure/save-system.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function allIngredientIds(recipes) {
  return [...new Set(recipes.flatMap((recipe) =>
    recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))].sort();
}

export function buildFixtureSnapshot({
  canonicalRecipes, canonicalFacilities, canonicalIngredients, balance, seed = 0x27, checkpointPhase = "PLANNING_READY",
} = {}) {
  const campaignId = createCampaignId(seed, 0);
  const recipes = createRecipeState({
    recipes: canonicalRecipes,
    ingredientIds: allIngredientIds(canonicalRecipes),
  });
  const unlockCatalog = createUnlockCatalog({ recipes: canonicalRecipes, facilities: canonicalFacilities });
  const marketGeneration = generateDailyMarket({
    rngState: createRngRegistryState(seed),
    day: 3,
    ingredients: canonicalIngredients,
    purchaseLimitQuantity: balance.market.defaultPurchaseLimitQuantity,
  });
  const contractGeneration = generateDailyContractOffers({
    rngState: marketGeneration.rngState,
    day: 3,
    ingredients: canonicalIngredients,
    configuration: balance.contract,
    fixedCostG: balance.economy.fixedCostG,
  });
  return {
    formatVersion: 1,
    revision: 12,
    runtimePhase: checkpointPhase === "TERMINAL" ? "TERMINAL" : "PLANNING",
    checkpointPhase,
    generationId: 0,
    campaign: {
      campaignId,
      masterSeed: seed,
      day: 3,
      consecutiveArrearsCount: 0,
      canonicalDayResults: [],
      ...createReputationCampaignFields(40),
    },
    recipes,
    menu: createMenuState({ day: 3, recipes }),
    saleSlots: createSaleSlotsState({ day: 3 }),
    facilities: createFacilityState({ facilities: canonicalFacilities }),
    progression: createProgressionState({ unlockCatalog }),
    events: createEventState(),
    market: marketGeneration.market,
    contracts: contractGeneration.contracts,
    economy: createEconomyState({ cashG: 420, debtG: 500, arrearsG: 0 }),
    inventory: createInventoryState({
      lots: [{
        lotId: "qa.save.lot.000",
        ingredientId: allIngredientIds(canonicalRecipes)[0],
        quantity: 10,
        unreservedQuantity: 10,
        quality: 70,
        bookCostG: 20,
        acquiredDay: 3,
      }],
    }),
    inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 20 }),
    sales: createSalesState({ day: 3 }),
    rng: contractGeneration.rngState,
    idCounters: createIdServiceState({ campaignId, day: 3, generationId: 0 }),
    extensions: {},
    boot: { maps: { activeMapId: "map.base_restaurant" } },
    service: { lifecycle: "INACTIVE" },
  };
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id, description, validates, status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runSaveSystemProbe({ recipes, facilities, ingredients, balance }) {
  const results = [];
  const fixtureBase = { canonicalRecipes: recipes, canonicalFacilities: facilities, canonicalIngredients: ingredients, balance };

  results.push(await runCase(
    "planning-ready-round-trip",
    "PLANNING_READY snapshot을 serialize→hash 검증→schema/invariant 검증까지 byte 그대로 왕복한다",
    "Requirement 18.1~18.6",
    async () => {
      const snapshot = buildFixtureSnapshot(fixtureBase);
      const created = await createSaveEnvelope(snapshot);
      assert(created.ok, `envelope 생성 실패: ${created.code} ${JSON.stringify(created.details ?? "")}`);
      assert(created.envelope.formatVersion === SAVE_FORMAT_VERSION, "formatVersion이 다릅니다.");
      const read = await readSaveEnvelope(JSON.stringify(created.envelope));
      assert(read.ok, `envelope 재해석 실패: ${read.code}`);
      const { canonicalStringify } = await import("../infrastructure/canonical-json.js");
      assert(canonicalStringify(read.payload) === canonicalStringify(created.payload), "왕복 payload가 다릅니다.");
      return { payloadSha256: created.envelope.payloadSha256 };
    },
  ));

  results.push(await runCase(
    "terminal-checkpoint-saveable",
    "TERMINAL checkpoint도 그대로 저장할 수 있다",
    "Requirement 18.6",
    async () => {
      const snapshot = buildFixtureSnapshot({ ...fixtureBase, checkpointPhase: "TERMINAL" });
      const created = await createSaveEnvelope(snapshot);
      assert(created.ok, `TERMINAL 저장 실패: ${created.code}`);
      assert(created.envelope.checkpointPhase === "TERMINAL", "checkpointPhase가 TERMINAL이 아닙니다.");
      return { checkpointPhase: created.envelope.checkpointPhase };
    },
  ));

  results.push(await runCase(
    "service-phase-save-forbidden",
    "SERVICE/PAUSED/SETTLEMENT 중간 저장은 SAVE_PHASE_FORBIDDEN으로 거절한다",
    "Requirement 18.5",
    async () => {
      const codes = [];
      for (const runtimePhase of ["SERVICE", "PAUSED", "SETTLEMENT"]) {
        const snapshot = buildFixtureSnapshot(fixtureBase);
        snapshot.runtimePhase = runtimePhase;
        snapshot.checkpointPhase = null;
        const created = await createSaveEnvelope(snapshot);
        assert(!created.ok && created.code === "SAVE_PHASE_FORBIDDEN",
          `${runtimePhase}: 예상과 다른 결과 ${created.ok ? "ok" : created.code}`);
        codes.push(created.code);
      }
      return { codes };
    },
  ));

  results.push(await runCase(
    "tampered-payload-hash-rejected",
    "payload가 hash와 다르게 변조되면 SAVE_HASH_MISMATCH로 거절한다",
    "Requirement 18.2~18.4",
    async () => {
      const snapshot = buildFixtureSnapshot(fixtureBase);
      const created = await createSaveEnvelope(snapshot);
      assert(created.ok, "envelope 생성 실패");
      const tampered = { ...created.envelope, payloadCanonicalJson: created.envelope.payloadCanonicalJson.replace("420", "999999") };
      const read = await readSaveEnvelope(JSON.stringify(tampered));
      assert(!read.ok && read.code === "SAVE_HASH_MISMATCH", `예상과 다른 결과: ${read.ok ? "ok" : read.code}`);
      return { code: read.code };
    },
  ));

  results.push(await runCase(
    "corrupt-invariant-rejected",
    "reserve>cash 같은 invariant 위반 payload는 schema 통과 후에도 SAVE_PAYLOAD_INVALID로 거절한다",
    "Requirement 18.8, 20.7",
    async () => {
      const snapshot = buildFixtureSnapshot(fixtureBase);
      snapshot.economy = { ...snapshot.economy, contractReserveG: snapshot.economy.cashG + 1 };
      const created = await createSaveEnvelope(snapshot);
      assert(!created.ok && created.code === "SAVE_PAYLOAD_INVALID", `예상과 다른 결과: ${created.ok ? "ok" : created.code}`);
      return { code: created.code };
    },
  ));

  results.push(await runCase(
    "normalization-idempotent",
    "정규화를 두 번 적용해도 canonical JSON이 동일하다",
    "Requirement 18.1",
    async () => {
      const snapshot = buildFixtureSnapshot(fixtureBase);
      const idempotent = await isNormalizationIdempotent(snapshot);
      assert(idempotent, "정규화가 두 번째 적용에서 달라졌습니다.");
      return { idempotent };
    },
  ));

  results.push(await runCase(
    "camera-and-service-not-persisted",
    "Camera(world 파생값)와 Service transient는 저장 payload에 없다",
    "Requirement 18.1",
    () => {
      const snapshot = buildFixtureSnapshot(fixtureBase);
      const payload = buildSavePayload(snapshot);
      assert(!("camera" in payload), "camera가 payload에 포함됐습니다.");
      assert(!("service" in payload), "service가 payload에 포함됐습니다.");
      assert(!("revision" in payload) && !("runtimePhase" in payload), "revision/runtimePhase가 payload에 포함됐습니다.");
      return { keys: Object.keys(payload) };
    },
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}
