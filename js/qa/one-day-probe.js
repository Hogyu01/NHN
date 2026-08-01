import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { freezeDeep } from "../core/result.js";
import { createRngRegistryState } from "../core/rng.js";
import { GameStore } from "../core/store.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";
import { generateDailyContractOffers, registerContractSystem } from "../domain/contract.js";
import { registerDayLoopController } from "../domain/day-loop.js";
import { registerDirectServiceSystem } from "../domain/direct-service.js";
import { createEconomyState } from "../domain/economy.js";
import { createEventState, generateDailyEvent, registerEventSystem } from "../domain/events.js";
import { createFacilityState, registerFacilitySystem } from "../domain/facility.js";
import { createInventoryAccountingState, registerInventoryAccounting } from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import { generateDailyMarket, registerMarketSystem } from "../domain/market.js";
import { createMenuState, registerMenuSystem } from "../domain/menu.js";
import { registerOrderSystem } from "../domain/orders.js";
import { createRecipeState } from "../domain/recipe.js";
import { createReputationCampaignFields, registerReputationSystem } from "../domain/reputation.js";
import { createSaleSlotsState } from "../domain/sale-slots.js";
import { createSalesState } from "../domain/sales.js";
import { registerSettlementSystem } from "../domain/settlement.js";
import { createServiceTimerState } from "../domain/timer-state.js";
import { createProgressionState, createUnlockCatalog, registerUnlockPublisher } from "../domain/unlocks.js";
import { runOneDayScenario } from "../app/one-day-scenario.js";

const QA_GENERATION_ID = 24;

/**
 * Node QA harness. AppBootstrap의 STORE_READY 단계와 동일한 방식으로 실제
 * generateDailyMarket/generateDailyContractOffers/generateDailyEvent를 이미 로드된
 * canonical 문서(ingredients/recipes/upgrades/events/balance/guests)로 초기 state를
 * 구성하고, production과 동일한 System 전체를 commandBus에 등록한다 — fs를 직접
 * 읽지 않아 browser에서도 import 가능하다 (파일 로딩은 호출자의 책임이다).
 */
export function createOneDayHarness(documents, { seed = 0x4e484e01, day = 1 } = {}) {
  const generationId = QA_GENERATION_ID;
  const campaignId = createCampaignId(seed, 0);

  const marketGeneration = generateDailyMarket({
    rngState: createRngRegistryState(seed),
    day,
    ingredients: documents.ingredients.ingredients,
    purchaseLimitQuantity: documents.balance.market.defaultPurchaseLimitQuantity,
  });
  const contractGeneration = generateDailyContractOffers({
    rngState: marketGeneration.rngState,
    day,
    ingredients: documents.ingredients.ingredients,
    configuration: documents.balance.contract,
    fixedCostG: documents.balance.economy.fixedCostG,
  });
  const eventGeneration = generateDailyEvent({
    rngState: contractGeneration.rngState,
    day,
    eventDefinitions: documents.events.events,
  });
  const unlockCatalog = createUnlockCatalog({
    recipes: documents.recipes.recipes,
    facilities: documents.upgrades.facilities,
  });
  const progression = createProgressionState({ unlockCatalog });
  const events = createEventState({ activeEvent: eventGeneration.event });
  const facilities = createFacilityState({ facilities: documents.upgrades.facilities });
  const recipes = createRecipeState({
    recipes: documents.recipes.recipes,
    ingredientIds: documents.ingredients.ingredients.map((ingredient) => ingredient.ingredientId),
  });
  const menu = createMenuState({ day, recipes });
  const saleSlots = createSaleSlotsState({ day });

  const store = new GameStore({
    formatVersion: 1,
    revision: 0,
    runtimePhase: "TITLE",
    checkpointPhase: null,
    generationId,
    campaign: {
      campaignId,
      masterSeed: seed,
      day,
      consecutiveArrearsCount: 0,
      canonicalDayResults: [],
      ...createReputationCampaignFields(documents.balance.campaign.startReputation),
    },
    progression,
    events,
    facilities,
    economy: createEconomyState({
      cashG: documents.balance.campaign.startCashG,
      debtG: documents.balance.campaign.startDebtG,
    }),
    inventory: createInventoryState(),
    inventoryAccounting: createInventoryAccountingState(),
    recipes,
    menu,
    saleSlots,
    sales: createSalesState({ day }),
    service: createServiceTimerState({
      durationMs: documents.balance.service.durationMs,
      cleanupOvertimeMs: documents.balance.service.cleanupOvertimeMs,
    }),
    market: marketGeneration.market,
    contracts: contractGeneration.contracts,
    rng: eventGeneration.rngState,
    idCounters: createIdServiceState({ campaignId, day, generationId }),
    featureFlags: {},
    extensions: {},
  });

  const commandBus = new CommandBus({ store });
  registerCashTransactionAPI(commandBus);
  registerInventoryAccounting(commandBus);
  const marketSystem = registerMarketSystem(commandBus);
  registerFacilitySystem(commandBus, {
    basePatienceMs: documents.balance.service.basePatienceMs,
    minimumPatienceMs: documents.balance.service.minimumPatienceMs,
    maximumPatienceMs: documents.balance.service.maximumPatienceMs,
  });
  registerContractSystem(commandBus);
  const menuSystem = registerMenuSystem(commandBus);
  const dayLoopController = registerDayLoopController(commandBus, {
    guestArchetypes: documents.guests.guestArchetypes,
  });
  const directServiceSystem = registerDirectServiceSystem(commandBus, {
    wrongServePenaltyMs: documents.balance.service.wrongServePenaltyMs,
    reactionDurationMs: documents.balance.service.reactionFrameMs *
      documents.balance.service.reactionFrameCount,
  });
  const orderSystem = registerOrderSystem(commandBus);
  registerReputationSystem(commandBus);
  registerUnlockPublisher(commandBus);
  registerEventSystem(commandBus, documents.events.events);
  const settlementSystem = registerSettlementSystem(commandBus);

  return {
    store,
    commandBus,
    marketSystem,
    menuSystem,
    dayLoopController,
    directServiceSystem,
    orderSystem,
    settlementSystem,
  };
}

function staticResult(id, description, condition, details = undefined) {
  return Object.freeze({
    id,
    description,
    status: condition ? "PASS" : "FAIL",
    ...(details === undefined ? {} : { details }),
    ...(!condition ? { error: description } : {}),
  });
}

/** Node에서 real command trace로 조달→메뉴→Service→order→cook→sale→Settlement를 검증한다. */
export async function runOneDayProbe(documents) {
  const results = [];
  try {
    const harness = createOneDayHarness(documents);
    const scenario = await runOneDayScenario(harness);
    const snapshot = scenario.finalSnapshot;
    results.push(staticResult(
      "canonical-one-day-trace",
      "market→menu→service→order→cook→sale→settlement 전체를 real command로 완료한다",
      snapshot.runtimePhase === "SETTLEMENT" &&
        snapshot.campaign.canonicalDayResults.some((result) => result.day === snapshot.campaign.day),
      { trace: scenario.trace },
    ));
    results.push(staticResult(
      "single-sale-committed",
      "정확히 1건의 판매가 sales에 기록된다",
      snapshot.sales.sales.length === 1,
    ));
  } catch (error) {
    results.push(staticResult(
      "canonical-one-day-trace",
      "market→menu→service→order→cook→sale→settlement 전체를 real command로 완료한다",
      false,
      { error: error instanceof Error ? error.message : String(error), code: error?.code },
    ));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}

function publishBrowserReport(root, report) {
  root.body.dataset.oneDayQa = report.status.toLowerCase();
  root.body.dataset.oneDayQaPassed = String(report.passed);
  root.body.dataset.oneDayQaTotal = String(report.total);
  root.documentElement.dataset.oneDayPhase = report.runtimePhase ?? "unknown";
}

/** 실제 부팅된 production app(store/commandBus/각 System)을 그대로 재사용하는 browser smoke. */
export async function runOneDayBrowserProbe({ root, app }) {
  const results = [];
  let runtimePhase = "unknown";
  try {
    const scenario = await runOneDayScenario(app);
    runtimePhase = scenario.finalSnapshot.runtimePhase;
    results.push(staticResult(
      "browser-one-day-trace",
      "browser에 실제 부팅된 단일 app에서 one-day vertical slice를 real command로 완료한다",
      runtimePhase === "SETTLEMENT",
      { trace: scenario.trace },
    ));
  } catch (error) {
    runtimePhase = app.store.runtimePhase;
    results.push(staticResult(
      "browser-one-day-trace",
      "browser에 실제 부팅된 단일 app에서 one-day vertical slice를 real command로 완료한다",
      false,
      { error: error instanceof Error ? error.message : String(error), code: error?.code },
    ));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const report = freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    runtimePhase,
    results,
  });
  publishBrowserReport(root, report);
  return report;
}
