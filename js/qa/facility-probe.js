import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { cloneValue } from "../core/result.js";
import { GameStore } from "../core/store.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";
import { createEconomyState } from "../domain/economy.js";
import { createEventState, ZERO_EVENT_MODIFIERS } from "../domain/events.js";
import {
  createFacilityState,
  FACILITY_KIND,
  projectFacilities,
  registerFacilitySystem,
  validateFacilityLedgerLinks,
  validateFacilityState,
} from "../domain/facility.js";
import {
  createInventoryAccountingState,
  registerInventoryAccounting,
} from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import { createMarketOfferId, createMarketState, registerMarketSystem } from "../domain/market.js";
import { createMenuState } from "../domain/menu.js";
import { createRecipeState } from "../domain/recipe.js";
import { createReputationCampaignFields, registerReputationSystem } from "../domain/reputation.js";
import { createSaleSlotsState } from "../domain/sale-slots.js";
import {
  createProgressionState,
  createUnlockCatalog,
  registerUnlockPublisher,
  validateProgressionState,
} from "../domain/unlocks.js";

const QA_GENERATION_ID = 19;
const FACILITY_PROPERTY_SAMPLES = 128;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function equivalent(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function projectionConfiguration(balance) {
  return {
    basePatienceMs: balance.service.basePatienceMs,
    minimumPatienceMs: balance.service.minimumPatienceMs,
    maximumPatienceMs: balance.service.maximumPatienceMs,
  };
}

function progressionWithFacilities(recipes, facilities, unlockedFacilityIds = []) {
  const unlockCatalog = createUnlockCatalog({ recipes, facilities });
  const progression = cloneValue(createProgressionState({ unlockCatalog }));
  const unlocked = new Set(unlockedFacilityIds);
  progression.publishedUnlockIds = progression.unlockCatalog
    .filter((entry) => unlocked.has(entry.targetId))
    .map((entry) => entry.unlockId)
    .sort();
  progression.unlockedFacilityIds = [...unlocked].sort();
  const validation = validateProgressionState(progression);
  assert(validation.ok, `QA progression fixture가 유효하지 않습니다: ${validation.code}`);
  return progression;
}

function activeEvent(day, modifiers) {
  return {
    eventId: `event.qa_facility_day_${day}`,
    displayName: "시설 검증 사건",
    description: "시설 효과와 사건 효과의 합성을 검증합니다.",
    generatedDay: day,
    durationDays: 1,
    modifiers: { ...ZERO_EVENT_MODIFIERS, ...modifiers },
  };
}

function createOffer(day, stock = 42) {
  const ingredientId = "ingredient.qa_facility";
  return {
    offerId: createMarketOfferId(day, ingredientId),
    ingredientId,
    generatedDay: day,
    basePriceG: 1,
    priceDeltaPercent: 0,
    unitPriceG: 1,
    initialQuantity: stock,
    availableQuantity: stock,
    quality: 50,
  };
}

function createHarness({
  recipes: canonicalRecipes,
  facilities,
  balance,
  baseMap,
  seed = 0x19a11ce,
  day = 1,
  reputation = 100,
  runtimePhase = "PLANNING",
  cashG = 500,
  contractReserveG = 0,
  unlockedFacilityIds = facilities.map((entry) => entry.facilityId),
  eventModifiers = ZERO_EVENT_MODIFIERS,
  includeMarketOffer = false,
  snapshot = null,
} = {}) {
  let initialState;
  if (snapshot !== null) {
    initialState = cloneValue(snapshot);
    initialState.runtimePhase = runtimePhase;
    initialState.checkpointPhase = runtimePhase === "PLANNING" ? "PLANNING_READY" : null;
    initialState.campaign.day = day;
    initialState.menu.day = day;
    initialState.saleSlots = createSaleSlotsState({ day });
    initialState.market = createMarketState({
      day,
      purchaseLimitQuantity: initialState.market.purchaseLimitQuantity,
      offers: includeMarketOffer ? [createOffer(day)] : [],
    });
    initialState.idCounters = createIdServiceState({
      campaignId: initialState.campaign.campaignId,
      day,
      generationId: initialState.generationId,
      counters: initialState.idCounters.counters,
    });
  } else {
    const campaignId = createCampaignId(seed, 0);
    const recipeState = createRecipeState({ recipes: canonicalRecipes });
    const modifiers = { ...ZERO_EVENT_MODIFIERS, ...eventModifiers };
    const marketLimit = balance.market.defaultPurchaseLimitQuantity +
      Math.max(0, modifiers.marketPurchaseLimitBonusQuantity);
    initialState = {
      formatVersion: 1,
      revision: 0,
      runtimePhase,
      checkpointPhase: runtimePhase === "PLANNING" ? "PLANNING_READY" : null,
      generationId: QA_GENERATION_ID,
      campaign: {
        campaignId,
        masterSeed: seed,
        day,
        consecutiveArrearsCount: 0,
        ...createReputationCampaignFields(reputation),
      },
      progression: progressionWithFacilities(canonicalRecipes, facilities, unlockedFacilityIds),
      events: createEventState({ activeEvent: activeEvent(day, modifiers) }),
      economy: createEconomyState({ cashG, contractReserveG }),
      facilities: createFacilityState({ facilities }),
      recipes: recipeState,
      menu: createMenuState({ day, recipes: recipeState }),
      saleSlots: createSaleSlotsState({ day }),
      market: createMarketState({
        day,
        purchaseLimitQuantity: marketLimit,
        offers: includeMarketOffer ? [createOffer(day)] : [],
      }),
      inventory: createInventoryState(),
      inventoryAccounting: createInventoryAccountingState(),
      idCounters: createIdServiceState({
        campaignId,
        day,
        generationId: QA_GENERATION_ID,
      }),
      world: {
        activeMapId: baseMap.mapId,
        authoredMapDefinition: cloneValue(baseMap),
      },
      untouched: { marker: "task-19-structural-sharing" },
    };
  }
  const store = new GameStore(initialState);
  const bus = new CommandBus({ store });
  registerCashTransactionAPI(bus);
  registerInventoryAccounting(bus);
  const marketSystem = registerMarketSystem(bus);
  const facilitySystem = registerFacilitySystem(bus, projectionConfiguration(balance));
  const reputationSystem = registerReputationSystem(bus);
  const unlockPublisher = registerUnlockPublisher(bus);
  return {
    store,
    bus,
    facilitySystem,
    marketSystem,
    reputationSystem,
    unlockPublisher,
  };
}

function commandInput(harness, commandId, payload, overrides = {}) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: harness.store.revision * 20,
    payload,
    ...overrides,
  };
}

function facilityPurchaseInput(harness, commandId, facilityId, overrides = {}) {
  return commandInput(harness, commandId, {
    day: harness.store.getSnapshot().campaign.day,
    facilityId,
  }, overrides);
}

function marketPurchaseInput(harness, commandId, quantity) {
  const market = harness.store.getSnapshot().market;
  return commandInput(harness, commandId, {
    day: market.day,
    offerId: market.offers[0].offerId,
    quantity,
  });
}

async function assertRejectedUnchanged(harness, execute, expectedCode, label) {
  const before = harness.store.getSnapshot();
  const beforeValue = cloneValue(before);
  const signalsBefore = harness.bus.getSignalSnapshot();
  const metadataBefore = harness.store.getCommandMetadata();
  const revisionBefore = harness.store.revision;
  const commitsBefore = harness.store.commitCount;
  const result = await execute();
  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), beforeValue), `${label}: state가 변경됐습니다.`);
  assert(harness.store.revision === revisionBefore, `${label}: revision이 변경됐습니다.`);
  assert(harness.store.commitCount === commitsBefore, `${label}: commit이 발생했습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadataBefore), `${label}: command metadata가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signalsBefore), `${label}: event/effect journal이 변경됐습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 실패 결과에 signal이 있습니다.`);
  return 1;
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Canonical unit examples. **Validates: Requirements 13.1, 13.2, 13.4, 28.2, 28.7** */
function canonicalStagesAndUnpurchasedProjection(recipes, facilities, balance, baseMap) {
  const harness = createHarness({
    recipes,
    facilities,
    balance,
    baseMap,
    reputation: 100,
    unlockedFacilityIds: [],
  });
  const projection = harness.facilitySystem.project(harness.store.getSnapshot());
  assert(projection.mustStageCount === 3 && projection.stages.length === 3, "Must stage가 정확히 3개가 아닙니다.");
  for (const kind of Object.values(FACILITY_KIND)) {
    assert(projection.stages.filter((stage) => stage.kind === kind).length === 1, `${kind} stage가 정확히 하나가 아닙니다.`);
  }
  assert(projection.purchasedFacilityIds.length === 0, "새 campaign에 구매 시설이 있습니다.");
  assert(projection.effects.facilityTimingWindowBonusMs === 0, "미구매 kitchen 효과가 적용됐습니다.");
  assert(projection.effects.facilityPatienceBonusMs === 0, "미구매 hall 효과가 적용됐습니다.");
  assert(projection.effects.facilityMarketPurchaseLimitBonusQuantity === 0, "미구매 storage 효과가 적용됐습니다.");
  assert(projection.effects.currentPatienceMs === balance.service.basePatienceMs, "미구매 patience가 base와 다릅니다.");
  assert(
    projection.effects.currentMarketPurchaseLimitQuantity === balance.market.defaultPurchaseLimitQuantity,
    "미구매 Market_Purchase_Limit가 base와 다릅니다.",
  );

  for (const stage of projection.stages) {
    assert(stage.costG > 0 && stage.condition.type === "REPUTATION", `${stage.facilityId} 비용/조건 projection이 없습니다.`);
    assert(stage.condition.met && !stage.condition.published, `${stage.facilityId} actual threshold와 게시 상태가 분리되지 않았습니다.`);
    assert(stage.effectiveTiming === "SAME_DAY", `${stage.facilityId} 적용 시점이 SAME_DAY가 아닙니다.`);
    assert(!stage.purchased && !stage.purchaseEnabled && stage.disabledReason === "FACILITY_STAGE_LOCKED",
      `${stage.facilityId} 잠금 projection이 잘못됐습니다.`);
    assert(stage.effect.beforeValue !== undefined && stage.effect.afterValue !== undefined,
      `${stage.facilityId} 전후 값이 없습니다.`);
  }
  const kitchen = projection.stages.find((stage) => stage.kind === FACILITY_KIND.KITCHEN);
  assert(kitchen.effect.afterValue.timingWindowBonusMs - kitchen.effect.beforeValue.timingWindowBonusMs === 120,
    "kitchen 전후 bonus가 120ms가 아닙니다.");
  for (let index = 0; index < kitchen.effect.beforeValue.recipes.length; index += 1) {
    const before = kitchen.effect.beforeValue.recipes[index];
    const after = kitchen.effect.afterValue.recipes[index];
    assert(after.successWindowMs - before.successWindowMs === 120, "kitchen success window 전후가 +120ms가 아닙니다.");
    assert(after.normalWindowMs - before.normalWindowMs === 120, "kitchen normal window 전후가 +120ms가 아닙니다.");
  }
  const hall = projection.stages.find((stage) => stage.kind === FACILITY_KIND.HALL);
  const storage = projection.stages.find((stage) => stage.kind === FACILITY_KIND.STORAGE);
  assert(hall.effect.beforeValue === 30_000 && hall.effect.afterValue === 35_000, "hall 전후가 30000→35000ms가 아닙니다.");
  assert(storage.effect.beforeValue === 30 && storage.effect.afterValue === 42, "storage 전후가 30→42가 아닙니다.");
  return { kinds: projection.stages.map((stage) => stage.kind), stageCount: projection.mustStageCount };
}

/** State validator edge examples. **Validates: Requirements 13.1, 13.2, 28.5, 28.6** */
function invalidDefinitionExamples(facilities) {
  const fixtures = [];
  const duplicate = cloneValue(facilities);
  duplicate[1] = cloneValue(duplicate[0]);
  fixtures.push(duplicate);
  const zeroEffect = cloneValue(facilities);
  zeroEffect[0].effect.value = 0;
  fixtures.push(zeroEffect);
  const spatialMust = cloneValue(facilities);
  spatialMust[0].opensRegionId = "region.missing";
  fixtures.push(spatialMust);
  let rejected = 0;
  for (const fixture of fixtures) {
    try {
      createFacilityState({ facilities: fixture });
    } catch (error) {
      assert(typeof error?.code === "string", "invalid facility definition이 명시 code 없이 실패했습니다.");
      rejected += 1;
    }
  }
  assert(rejected === fixtures.length, "invalid facility definition 일부가 승인됐습니다.");
  return { invalidDefinitionsRejected: rejected };
}

/** Approved examples. **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 13.3, 13.5, 28.5, 28.7** */
async function approvedPurchasesSameDay(recipes, facilities, balance, baseMap) {
  const harness = createHarness({ recipes, facilities, balance, baseMap, cashG: 500 });
  const authoredWorldBefore = harness.store.getSnapshot().world;
  const authoredMapBefore = cloneValue(authoredWorldBefore.authoredMapDefinition);
  const definitions = harness.store.getSnapshot().facilities.definitions;
  const expectedByKind = {
    [FACILITY_KIND.KITCHEN]: 120,
    [FACILITY_KIND.HALL]: 5_000,
    [FACILITY_KIND.STORAGE]: 12,
  };
  let commits = 0;
  let timingWindowChecks = 0;
  for (const definition of definitions) {
    const beforeProjection = harness.facilitySystem.project(harness.store.getSnapshot());
    const beforeStage = beforeProjection.stages.find((stage) => stage.facilityId === definition.facilityId);
    const result = await harness.facilitySystem.purchase(facilityPurchaseInput(
      harness,
      `qa:facility:approved:${definition.kind.toLowerCase()}`,
      definition.facilityId,
    ));
    assert(result.ok, `${definition.kind} 구매가 실패했습니다: ${result.code}`);
    assert(result.events.length === 1 && result.events[0].type === "facility.stage-purchased",
      `${definition.kind} committed event cardinality/type이 잘못됐습니다.`);
    commits += 1;
    const after = harness.store.getSnapshot();
    const projection = harness.facilitySystem.project(after);
    const stage = projection.stages.find((entry) => entry.facilityId === definition.facilityId);
    assert(stage.purchased && !stage.purchaseEnabled, `${definition.kind} 구매 상태가 projection에 반영되지 않았습니다.`);
    assert(stage.effect.currentValue !== beforeStage.effect.currentValue || definition.kind === FACILITY_KIND.KITCHEN,
      `${definition.kind} same-day current value가 변경되지 않았습니다.`);
    const ledgerEntry = after.economy.ledger[after.economy.ledger.length - 1];
    const investment = after.facilities.investments[after.facilities.investments.length - 1];
    assert(ledgerEntry.category === "FACILITY_INVESTMENT" && ledgerEntry.type === "FACILITY_INVESTMENT" &&
      ledgerEntry.direction === "OUTFLOW", `${definition.kind} ledger 분류가 잘못됐습니다.`);
    assert(ledgerEntry.amountG === definition.costG && investment.costG === definition.costG,
      `${definition.kind} ledger/investment 비용이 canonical cost와 다릅니다.`);
    assert(ledgerEntry.transactionId === investment.transactionId && ledgerEntry.causeId === investment.causeId,
      `${definition.kind} investment ledger link가 끊겼습니다.`);
    assert(investment.effectiveTiming === "SAME_DAY", `${definition.kind} investment 적용 시점이 잘못됐습니다.`);
    assert(after.world === authoredWorldBefore && equivalent(after.world.authoredMapDefinition, authoredMapBefore),
      `${definition.kind} non-spatial 구매가 authored Map을 변경했습니다.`);

    if (definition.kind === FACILITY_KIND.KITCHEN) {
      assert(projection.effects.facilityTimingWindowBonusMs === expectedByKind[definition.kind],
        "kitchen same-day bonus가 +120ms가 아닙니다.");
      for (const current of projection.effects.timingWindows) {
        const prior = beforeProjection.effects.timingWindows.find((entry) => entry.recipeId === current.recipeId);
        assert(current.successWindowMs - prior.successWindowMs === 120, "success window가 정확히 +120ms가 아닙니다.");
        assert(current.normalWindowMs - prior.normalWindowMs === 120, "normal window가 정확히 +120ms가 아닙니다.");
        timingWindowChecks += 2;
      }
    } else if (definition.kind === FACILITY_KIND.HALL) {
      assert(projection.effects.currentPatienceMs - beforeProjection.effects.currentPatienceMs === 5_000,
        "hall same-day patience가 정확히 +5000ms가 아닙니다.");
    } else {
      assert(projection.effects.currentMarketPurchaseLimitQuantity -
        beforeProjection.effects.currentMarketPurchaseLimitQuantity === 12,
      "storage same-day purchase limit가 정확히 +12가 아닙니다.");
    }
  }
  const final = harness.store.getSnapshot();
  assert(harness.store.commitCount === 3 && final.revision === 3, "세 시설 구매가 각각 single commit이 아닙니다.");
  assert(final.facilities.investments.length === 3 && final.economy.ledger.length === 3,
    "투자 기록/ledger cardinality가 3이 아닙니다.");
  assert(final.economy.cashG === 200, "세 시설 canonical 비용 합산 뒤 cash가 200G가 아닙니다.");
  const links = validateFacilityLedgerLinks(final.facilities, final.economy);
  assert(links.ok && links.details.linkedInvestments === 3, "최종 facility investment ledger 대사가 실패했습니다.");
  return {
    commits,
    timingWindowChecks,
    patienceDeltaMs: 5_000,
    marketLimitDelta: 12,
    investmentLedgerEntries: final.economy.ledger.length,
    mapMutations: 0,
  };
}

/** Storage integration example. **Validates: Requirements 7.5, 7.6, 13.3, 13.5** */
async function storageLimitAffectsMarketPurchase(recipes, facilities, balance, baseMap) {
  const harness = createHarness({
    recipes,
    facilities,
    balance,
    baseMap,
    cashG: 500,
    includeMarketOffer: true,
  });
  let exactRejections = 0;
  exactRejections += await assertRejectedUnchanged(
    harness,
    () => harness.marketSystem.purchaseOffer(marketPurchaseInput(harness, "qa:facility:market:before", 31)),
    "MARKET_PURCHASE_LIMIT_EXCEEDED",
    "storage 구매 전 quantity 31",
  );
  const storage = facilities.find((entry) => entry.kind === FACILITY_KIND.STORAGE);
  const facilityResult = await harness.facilitySystem.purchase(facilityPurchaseInput(
    harness,
    "qa:facility:market:storage",
    storage.facilityId,
  ));
  assert(facilityResult.ok, `storage 구매가 실패했습니다: ${facilityResult.code}`);
  assert(harness.store.getSnapshot().market.purchaseLimitQuantity === 42, "storage 구매 직후 market limit가 42가 아닙니다.");
  const purchase = await harness.marketSystem.purchaseOffer(marketPurchaseInput(
    harness,
    "qa:facility:market:after",
    31,
  ));
  assert(purchase.ok, `storage 구매 뒤 quantity 31 시장 구매가 실패했습니다: ${purchase.code}`);
  const after = harness.store.getSnapshot();
  assert(after.market.purchasedQuantity === 31 && after.market.purchaseLimitQuantity === 42,
    "storage 한도가 MarketSystem의 실제 guard에 반영되지 않았습니다.");
  assert(after.inventory.lots.length === 1 && after.inventory.lots[0].quantity === 31,
    "storage 한도 승인 구매가 실제 lot 31개를 만들지 않았습니다.");
  return {
    exactRejections,
    purchaseLimitBefore: 30,
    purchaseLimitAfter: 42,
    approvedQuantity: 31,
    remainingPurchaseLimitQuantity: 11,
    partialMutations: 0,
  };
}

/** Task 18 integration. **Validates: Requirements 13.3, 14.2, 14.3, 14.4, 16.5** */
async function nextPlanningUnlockIntegration(recipes, facilities, balance, baseMap) {
  const kitchen = facilities.find((entry) => entry.kind === FACILITY_KIND.KITCHEN);
  const dayOne = createHarness({
    recipes,
    facilities,
    balance,
    baseMap,
    day: 1,
    reputation: kitchen.unlockReputation - 1,
    unlockedFacilityIds: [],
  });
  const crossing = await dayOne.reputationSystem.applyCause(commandInput(dayOne, "qa:facility:unlock:cross", {
    causeId: "cause.qa.facility.unlock.cross",
    delta: 1,
  }));
  assert(crossing.ok, `facility threshold crossing이 실패했습니다: ${crossing.code}`);
  assert(dayOne.store.getSnapshot().progression.pendingUnlocks.length === 1,
    "facility crossing이 pending unlock 하나를 만들지 않았습니다.");
  let exactRejections = 0;
  exactRejections += await assertRejectedUnchanged(
    dayOne,
    () => dayOne.facilitySystem.purchase(facilityPurchaseInput(
      dayOne,
      "qa:facility:unlock:same-day-purchase",
      kitchen.facilityId,
    )),
    "FACILITY_STAGE_LOCKED",
    "threshold crossing 당일 facility 구매",
  );
  exactRejections += await assertRejectedUnchanged(
    dayOne,
    () => dayOne.unlockPublisher.publishForPlanning(commandInput(
      dayOne,
      "qa:facility:unlock:same-day-publish",
      { day: 1 },
    )),
    "NO_UNLOCKS_DUE",
    "threshold crossing 당일 facility 게시",
  );

  const dayTwo = createHarness({
    recipes,
    facilities,
    balance,
    baseMap,
    day: 2,
    snapshot: dayOne.store.getSnapshot(),
  });
  const published = await dayTwo.unlockPublisher.publishForPlanning(commandInput(
    dayTwo,
    "qa:facility:unlock:next-planning",
    { day: 2 },
  ));
  assert(published.ok && published.events.length === 1,
    `다음 Planning facility 게시가 실패했습니다: ${published.code}`);
  assert(dayTwo.store.getSnapshot().progression.unlockedFacilityIds.includes(kitchen.facilityId),
    "게시된 facility가 unlockedFacilityIds에 없습니다.");
  const purchased = await dayTwo.facilitySystem.purchase(facilityPurchaseInput(
    dayTwo,
    "qa:facility:unlock:purchase",
    kitchen.facilityId,
  ));
  assert(purchased.ok, `다음 Planning 게시 뒤 facility 구매가 실패했습니다: ${purchased.code}`);
  assert(dayTwo.facilitySystem.project(dayTwo.store.getSnapshot()).effects.facilityTimingWindowBonusMs === 120,
    "다음 Planning 해금 구매의 same-day kitchen 효과가 없습니다.");
  return {
    pendingUnlocks: 1,
    publishedUnlocks: published.events.length,
    purchasesAfterPublication: 1,
    exactRejections,
    partialMutations: 0,
  };
}

/** Atomic rejection matrix. **Validates: Requirements 4.4, 4.6, 4.7, 13.3, 13.5** */
async function purchaseAtomicRejections(recipes, facilities, balance, baseMap) {
  const kitchen = facilities.find((entry) => entry.kind === FACILITY_KIND.KITCHEN);
  let exactRejections = 0;

  const duplicate = createHarness({ recipes, facilities, balance, baseMap });
  const first = await duplicate.facilitySystem.purchase(facilityPurchaseInput(
    duplicate,
    "qa:facility:reject:duplicate:first",
    kitchen.facilityId,
  ));
  assert(first.ok, "duplicate setup 구매가 실패했습니다.");
  exactRejections += await assertRejectedUnchanged(
    duplicate,
    () => duplicate.facilitySystem.purchase(facilityPurchaseInput(
      duplicate,
      "qa:facility:reject:duplicate:second",
      kitchen.facilityId,
    )),
    "FACILITY_ALREADY_PURCHASED",
    "중복 facility 구매",
  );

  const locked = createHarness({ recipes, facilities, balance, baseMap, unlockedFacilityIds: [] });
  exactRejections += await assertRejectedUnchanged(
    locked,
    () => locked.facilitySystem.purchase(facilityPurchaseInput(
      locked,
      "qa:facility:reject:locked",
      kitchen.facilityId,
    )),
    "FACILITY_STAGE_LOCKED",
    "잠긴 facility 구매",
  );

  const insufficient = createHarness({
    recipes,
    facilities,
    balance,
    baseMap,
    cashG: kitchen.costG,
    contractReserveG: 1,
  });
  exactRejections += await assertRejectedUnchanged(
    insufficient,
    () => insufficient.facilitySystem.purchase(facilityPurchaseInput(
      insufficient,
      "qa:facility:reject:cash",
      kitchen.facilityId,
    )),
    "INSUFFICIENT_AVAILABLE_CASH",
    "Available_Cash 부족 facility 구매",
  );

  const stale = createHarness({ recipes, facilities, balance, baseMap });
  exactRejections += await assertRejectedUnchanged(
    stale,
    () => stale.facilitySystem.purchase(facilityPurchaseInput(
      stale,
      "qa:facility:reject:stale",
      kitchen.facilityId,
      { expectedRevision: stale.store.revision + 1 },
    )),
    "STALE_REVISION",
    "stale facility 구매",
  );

  const service = createHarness({ recipes, facilities, balance, baseMap, runtimePhase: "SERVICE" });
  exactRejections += await assertRejectedUnchanged(
    service,
    () => service.facilitySystem.purchase(facilityPurchaseInput(
      service,
      "qa:facility:reject:phase",
      kitchen.facilityId,
    )),
    "ILLEGAL_PHASE",
    "Planning 외 facility 구매",
  );

  const unknown = createHarness({ recipes, facilities, balance, baseMap });
  exactRejections += await assertRejectedUnchanged(
    unknown,
    () => unknown.facilitySystem.purchase(facilityPurchaseInput(
      unknown,
      "qa:facility:reject:unknown",
      "facility.missing_stage",
    )),
    "FACILITY_NOT_FOUND",
    "알 수 없는 facility reference",
  );

  const wrongDay = createHarness({ recipes, facilities, balance, baseMap });
  exactRejections += await assertRejectedUnchanged(
    wrongDay,
    () => wrongDay.facilitySystem.purchase(commandInput(
      wrongDay,
      "qa:facility:reject:day",
      { day: 2, facilityId: kitchen.facilityId },
    )),
    "FACILITY_PURCHASE_DAY_MISMATCH",
    "facility day mismatch",
  );
  return { successfulSetupCommits: 1, exactRejections, partialMutations: 0 };
}

/**
 * Design Property 25 generated sweep over all Must kinds, event modifiers, cash/reserve states,
 * and authored Map geometry. **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 28.5, 28.7**
 */
async function facilitySpatialNonSpatialProperty(recipes, facilities, balance, baseMap) {
  let successfulPurchases = 0;
  let exactEffectChecks = 0;
  let ledgerLinkChecks = 0;
  let mapDeepEqualChecks = 0;
  for (let sample = 0; sample < FACILITY_PROPERTY_SAMPLES; sample += 1) {
    const definition = facilities[sample % facilities.length];
    const modifiers = {
      guestCountDelta: sample % 3,
      patienceDeltaMs: (sample % 5) * 500,
      timingWindowBonusMs: (sample % 7) * 10,
      marketPurchaseLimitBonusQuantity: sample % 4,
    };
    const reserveG = sample % 13;
    const harness = createHarness({
      recipes,
      facilities,
      balance,
      baseMap,
      seed: (0x19000000 + sample) >>> 0,
      cashG: definition.costG + reserveG + 50,
      contractReserveG: reserveG,
      unlockedFacilityIds: [definition.facilityId],
      eventModifiers: modifiers,
    });
    const before = harness.store.getSnapshot();
    const beforeProjection = projectFacilities(before, projectionConfiguration(balance));
    const beforeWorld = before.world;
    const beforeMap = cloneValue(before.world.authoredMapDefinition);
    const result = await harness.facilitySystem.purchase(facilityPurchaseInput(
      harness,
      `qa:facility:property:${String(sample).padStart(3, "0")}`,
      definition.facilityId,
    ));
    assert(result.ok, `property sample ${sample} 구매 실패: ${result.code}`);
    const after = harness.store.getSnapshot();
    const afterProjection = harness.facilitySystem.project(after);
    assert(after.world === beforeWorld && equivalent(after.world.authoredMapDefinition, beforeMap),
      `property sample ${sample}: non-spatial purchase가 authored Map을 변경했습니다.`);
    mapDeepEqualChecks += 1;
    assert(after.facilities.purchasedFacilityIds.includes(definition.facilityId),
      `property sample ${sample}: purchased index가 누락됐습니다.`);
    assert(after.facilities.investments.length === 1 && after.economy.ledger.length === 1,
      `property sample ${sample}: investment/ledger cardinality가 1이 아닙니다.`);
    const links = validateFacilityLedgerLinks(after.facilities, after.economy);
    assert(links.ok, `property sample ${sample}: investment ledger link 실패 ${links.code}`);
    ledgerLinkChecks += 1;

    if (definition.kind === FACILITY_KIND.KITCHEN) {
      assert(afterProjection.effects.totalTimingWindowBonusMs -
        beforeProjection.effects.totalTimingWindowBonusMs === definition.effect.value,
      `property sample ${sample}: kitchen aggregate delta가 다릅니다.`);
      for (const afterWindow of afterProjection.effects.timingWindows) {
        const beforeWindow = beforeProjection.effects.timingWindows.find(
          (entry) => entry.recipeId === afterWindow.recipeId,
        );
        assert(afterWindow.successWindowMs - beforeWindow.successWindowMs === definition.effect.value,
          `property sample ${sample}: success window delta가 다릅니다.`);
        assert(afterWindow.normalWindowMs - beforeWindow.normalWindowMs === definition.effect.value,
          `property sample ${sample}: normal window delta가 다릅니다.`);
        exactEffectChecks += 2;
      }
    } else if (definition.kind === FACILITY_KIND.HALL) {
      assert(afterProjection.effects.currentPatienceMs - beforeProjection.effects.currentPatienceMs ===
        definition.effect.value, `property sample ${sample}: hall patience delta가 다릅니다.`);
      exactEffectChecks += 1;
    } else {
      assert(afterProjection.effects.currentMarketPurchaseLimitQuantity -
        beforeProjection.effects.currentMarketPurchaseLimitQuantity === definition.effect.value,
      `property sample ${sample}: storage limit delta가 다릅니다.`);
      exactEffectChecks += 1;
    }
    successfulPurchases += 1;
  }
  return {
    propertySamples: FACILITY_PROPERTY_SAMPLES,
    successfulPurchases,
    exactEffectChecks,
    ledgerLinkChecks,
    mapDeepEqualChecks,
    mapMutations: 0,
  };
}

export async function runFacilityProbe({ recipes, facilities, balance, baseMap } = {}) {
  assert(Array.isArray(recipes) && recipes.length >= 2, "canonical Recipe 입력이 없습니다.");
  assert(Array.isArray(facilities) && facilities.length === 3, "canonical facility 입력이 정확히 3개가 아닙니다.");
  assert(balance?.service && balance?.market, "canonical balance 입력이 없습니다.");
  assert(baseMap?.mapId === "map.base_restaurant", "canonical Base Map 입력이 없습니다.");
  const definitions = [
    ["canonical-stages-unpurchased-projection", "kind별 정확히 한 stage와 비용·조건·전후·same-day/unpurchased projection", ["13.1", "13.2", "13.4", "28.2", "28.7"], () => canonicalStagesAndUnpurchasedProjection(recipes, facilities, balance, baseMap)],
    ["invalid-definition-examples", "중복 kind/effect/spatial Must definition의 명시 거절", ["13.1", "13.2", "28.5", "28.6"], () => invalidDefinitionExamples(facilities)],
    ["approved-purchases-same-day", "kitchen/hall/storage 구매의 exact same-day 효과·투자 ledger·Map 불변", ["4.1", "4.2", "4.4", "4.5", "13.3", "13.5", "28.5", "28.7"], () => approvedPurchasesSameDay(recipes, facilities, balance, baseMap)],
    ["storage-market-limit-integration", "storage +12가 실제 MarketSystem 전량 구매 guard에 즉시 반영", ["7.5", "7.6", "13.3", "13.5"], () => storageLimitAffectsMarketPurchase(recipes, facilities, balance, baseMap)],
    ["next-planning-unlock-integration", "Task 18 crossing 당일 잠금과 다음 Planning 게시 후 구매", ["13.3", "14.2", "14.3", "14.4", "16.5"], () => nextPlanningUnlockIntegration(recipes, facilities, balance, baseMap)],
    ["purchase-atomic-rejections", "duplicate/locked/cash/stale/phase/reference/day 전체 원자 거절", ["4.4", "4.6", "4.7", "13.3", "13.5"], () => purchaseAtomicRejections(recipes, facilities, balance, baseMap)],
    ["property-25-facility-isolation", "128 generated purchases의 exact effect·ledger·authored Map deep-equal", ["13.1", "13.2", "13.3", "13.4", "13.5", "28.5", "28.7"], () => facilitySpatialNonSpatialProperty(recipes, facilities, balance, baseMap)],
  ];
  const results = [];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const detailsFor = (id) => results.find((result) => result.id === id)?.details ?? {};
  return Object.freeze({
    qaId: "task-19-must-facility-system-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    canonicalStageCount: detailsFor("canonical-stages-unpurchased-projection").stageCount ?? 0,
    approvedPurchaseCount: detailsFor("approved-purchases-same-day").commits ?? 0,
    timingWindowCheckCount: detailsFor("approved-purchases-same-day").timingWindowChecks ?? 0,
    investmentLedgerEntryCount: detailsFor("approved-purchases-same-day").investmentLedgerEntries ?? 0,
    storageMarketApprovedQuantity: detailsFor("storage-market-limit-integration").approvedQuantity ?? 0,
    unlockPublicationCount: detailsFor("next-planning-unlock-integration").publishedUnlocks ?? 0,
    exactRejectionCount:
      (detailsFor("storage-market-limit-integration").exactRejections ?? 0) +
      (detailsFor("next-planning-unlock-integration").exactRejections ?? 0) +
      (detailsFor("purchase-atomic-rejections").exactRejections ?? 0),
    propertySampleCount: detailsFor("property-25-facility-isolation").propertySamples ?? 0,
    exactEffectCheckCount: detailsFor("property-25-facility-isolation").exactEffectChecks ?? 0,
    mapDeepEqualCheckCount:
      (detailsFor("approved-purchases-same-day").commits ?? 0) +
      (detailsFor("property-25-facility-isolation").mapDeepEqualChecks ?? 0),
    partialMutationCount:
      (detailsFor("storage-market-limit-integration").partialMutations ?? 0) +
      (detailsFor("next-planning-unlock-integration").partialMutations ?? 0) +
      (detailsFor("purchase-atomic-rejections").partialMutations ?? 0),
    results: Object.freeze(results),
  });
}
