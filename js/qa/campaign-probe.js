import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { freezeDeep } from "../core/result.js";
import { createRngRegistryState } from "../core/rng.js";
import { Scheduler } from "../core/scheduler.js";
import { GameStore } from "../core/store.js";
import { CampaignManager } from "../domain/campaign.js";
import { CONTRACT_STATUS, generateDailyContractOffers, registerContractSystem } from "../domain/contract.js";
import { DAY_LOOP_TRIGGER, registerDayLoopController } from "../domain/day-loop.js";
import { registerDayInitializationSystem } from "../domain/day-initialization.js";
import { registerDirectServiceSystem } from "../domain/direct-service.js";
import { createEconomyState } from "../domain/economy.js";
import { createEventState, generateDailyEvent } from "../domain/events.js";
import { createFacilityState } from "../domain/facility.js";
import { createInventoryAccountingState, registerInventoryAccounting } from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import { generateDailyMarket, registerMarketSystem } from "../domain/market.js";
import { createMenuState, registerMenuSystem } from "../domain/menu.js";
import { registerOrderSystem } from "../domain/orders.js";
import { createRecipeState } from "../domain/recipe.js";
import { createReputationCampaignFields } from "../domain/reputation.js";
import { createSaleSlotsState } from "../domain/sale-slots.js";
import { createSalesState } from "../domain/sales.js";
import { registerServiceCleanupSystem } from "../domain/service-cleanup.js";
import { registerCampaignOutcomeSystem, TERMINAL_TYPE } from "../domain/terminal-result.js";
import { createServiceTimerState, RUNTIME_PHASE } from "../domain/timer-state.js";
import { COOK_TRIGGER } from "../domain/timing-cook.js";
import { TimerSystem } from "../domain/timer-system.js";
import { registerSettlementSystem } from "../domain/settlement.js";
import { createProgressionState, createUnlockCatalog } from "../domain/unlocks.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";

const QA_GENERATION_ID = 29;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function allIngredientIds(recipes) {
  return [...new Set(recipes.flatMap((recipe) =>
    recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))].sort();
}

function createLots(recipes, quantity = 80) {
  return allIngredientIds(recipes).map((ingredientId, index) => ({
    lotId: `qa.campaign.lot.${String(index).padStart(3, "0")}`,
    ingredientId,
    quantity,
    quality: 70,
    bookCostG: quantity * 2,
    acquiredDay: 1,
  }));
}

function createHarness({ recipes, facilities, ingredients, events, balance, guestArchetypes, seed = 0x29, day = 1 }) {
  const campaignId = createCampaignId(seed, 0);
  const recipeState = createRecipeState({ recipes, ingredientIds: allIngredientIds(recipes) });
  const unlockCatalog = createUnlockCatalog({ recipes, facilities });
  const marketGeneration = generateDailyMarket({
    rngState: createRngRegistryState(seed),
    day,
    ingredients,
    purchaseLimitQuantity: balance.market.defaultPurchaseLimitQuantity,
  });
  const contractGeneration = generateDailyContractOffers({
    rngState: marketGeneration.rngState,
    day,
    ingredients,
    configuration: balance.contract,
    fixedCostG: balance.economy.fixedCostG,
  });
  const eventGeneration = generateDailyEvent({
    rngState: contractGeneration.rngState,
    day,
    eventDefinitions: events,
  });
  const syntheticHistory = Array.from({ length: day - 1 }, (_unused, index) => ({
    day: index + 1,
    eventId: `qa.campaign.synthetic-event.${index + 1}`,
  }));
  const initialState = {
    formatVersion: 1,
    revision: 0,
    runtimePhase: RUNTIME_PHASE.PLANNING,
    checkpointPhase: "PLANNING_READY",
    generationId: QA_GENERATION_ID,
    campaign: {
      campaignId,
      masterSeed: seed,
      day,
      consecutiveArrearsCount: 0,
      canonicalDayResults: [],
      settlementOutcomeSealedForDay: null,
      terminalResult: null,
      ...createReputationCampaignFields(30),
    },
    progression: createProgressionState({ unlockCatalog }),
    events: createEventState({
      activeEvent: eventGeneration.event,
      history: [...syntheticHistory, { day, eventId: eventGeneration.event.eventId }],
    }),
    facilities: createFacilityState({ facilities }),
    recipes: recipeState,
    menu: createMenuState({ day, recipes: recipeState }),
    saleSlots: createSaleSlotsState({ day }),
    economy: createEconomyState({ cashG: 300, debtG: 500 }),
    inventory: createInventoryState({ lots: createLots(recipes) }),
    inventoryAccounting: createInventoryAccountingState({
      openingInventoryBookCostG: createLots(recipes).reduce((total, lot) => total + lot.bookCostG, 0),
    }),
    sales: createSalesState({ day }),
    service: createServiceTimerState({
      durationMs: balance.service.durationMs,
      cleanupOvertimeMs: balance.service.cleanupOvertimeMs,
    }),
    market: marketGeneration.market,
    contracts: contractGeneration.contracts,
    rng: eventGeneration.rngState,
    idCounters: createIdServiceState({ campaignId, day, generationId: QA_GENERATION_ID }),
  };
  const store = new GameStore(initialState);
  const bus = new CommandBus({ store });
  registerCashTransactionAPI(bus);
  registerInventoryAccounting(bus);
  const marketSystem = registerMarketSystem(bus);
  const contractSystem = registerContractSystem(bus);
  const menuSystem = registerMenuSystem(bus);
  const dayLoopController = registerDayLoopController(bus, { guestArchetypes });
  const directServiceSystem = registerDirectServiceSystem(bus, {
    wrongServePenaltyMs: balance.service.wrongServePenaltyMs,
    reactionDurationMs: balance.service.reactionFrameMs * balance.service.reactionFrameCount,
  });
  const orderSystem = registerOrderSystem(bus);
  const serviceCleanupSystem = registerServiceCleanupSystem(bus);
  const settlementSystem = registerSettlementSystem(bus);
  const campaignOutcomeSystem = registerCampaignOutcomeSystem(bus);
  const dayInitializationSystem = registerDayInitializationSystem(bus, { ingredients, eventDefinitions: events, balance });
  const scheduler = new Scheduler();
  const timerSystem = new TimerSystem({
    store, commandBus: bus, scheduler, directServiceSystem, menuSystem, serviceCleanupSystem, dayLoopController,
  });
  const campaignManager = new CampaignManager({
    store, commandBus: bus, campaignOutcomeSystem, dayInitializationSystem, contractSystem, dayLoopController,
  });
  return {
    store, bus, marketSystem, contractSystem, menuSystem, dayLoopController, directServiceSystem,
    serviceCleanupSystem, settlementSystem, campaignOutcomeSystem, dayInitializationSystem, orderSystem, scheduler, timerSystem,
    campaignManager, recipes,
  };
}

function commandInput(harness, commandId, payload) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: harness.scheduler.simulationTimeMs,
    payload,
  };
}

function activeRecipe(snapshot) {
  return snapshot.recipes.definitions.find((recipe) => snapshot.recipes.unlockedRecipeIds.includes(recipe.recipeId));
}

function seedSeatedGuest(harness) {
  const snapshot = harness.store.getSnapshot();
  const plan = snapshot.service.plans[0];
  assert(plan, "service start did not create a guest plan");
  harness.store.commit({
    ...snapshot,
    service: {
      ...snapshot.service,
      guests: [...snapshot.service.guests, {
        guestId: plan.guestId,
        entityId: plan.entityId,
        state: "SEATED",
        seatId: `qa-seat:${plan.guestId}`,
        reaction: null,
      }],
    },
  }, {
    commandId: `qa:seed-seated-guest:${harness.store.revision}`,
    expectedRevision: harness.store.revision,
  });
  return plan.guestId;
}

/** PLANNING부터 SETTLEMENT(결산까지)를 손님/조리 없이 최단 경로로 밀어붙인다. */
async function runMinimalDayToSettlement(harness) {
  const recipe = activeRecipe(harness.store.getSnapshot());
  const edited = await harness.menuSystem.editEntry(commandInput(harness, `edit:${harness.store.revision}`, {
    recipeId: recipe.recipeId, enabled: true, priceG: recipe.basePriceG, plannedQuantity: 1,
  }));
  assert(edited.ok, `menu edit 실패: ${edited.code}`);
  const confirmed = await harness.menuSystem.confirmPlan(commandInput(harness, `confirm:${harness.store.revision}`, {
    day: harness.store.getSnapshot().campaign.day,
  }));
  assert(confirmed.ok, `menu confirm 실패: ${confirmed.code}`);
  const started = await harness.dayLoopController.confirmServiceStart(commandInput(harness, `start:${harness.store.revision}`, {
    day: harness.store.getSnapshot().campaign.day,
  }));
  assert(started.ok, `service start 실패: ${started.code}`);
  const durationMs = harness.store.getSnapshot().service.durationMs;
  const transitionToken = harness.store.getSnapshot().service.settlementTransitionToken;
  const targetMs = harness.scheduler.simulationTimeMs + durationMs;
  harness.timerSystem.armServiceTimer({ serviceToken: transitionToken, durationMs });
  const zero = await harness.timerSystem.tick(targetMs);
  assert(zero.dispatched.length === 1 && zero.dispatched[0].result.ok, "TIMER_ZERO 실패");
  const cleanup = await harness.timerSystem.runCleanupToCompletion({ transitionToken });
  assert(cleanup.completion.ok, `cleanup 완료 실패: ${cleanup.completion.code}`);
  assert(harness.store.runtimePhase === RUNTIME_PHASE.SETTLEMENT, "Settlement에 도달하지 못했습니다.");
  const settled = await harness.settlementSystem.settleDay(commandInput(harness, `settle:${harness.store.revision}`, {
    day: harness.store.getSnapshot().campaign.day,
  }));
  assert(settled.ok, `결산 실패: ${settled.code}`);
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

export async function runCampaignProbe({ recipes, facilities, ingredients, events, balance, guestArchetypes }) {
  const results = [];
  const base = { recipes, facilities, ingredients, events, balance, guestArchetypes };

  results.push(await runCase(
    "day-advance-reaches-next-planning-ready",
    "최소 하루를 마치면 market/event가 새로 생성되고 day+1 PLANNING_READY로 정규화된다",
    "Requirement 15.1~15.5, 18.1, 19.7",
    async () => {
      const harness = createHarness(base);
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && !advance.terminal, `day 진행 실패: ${JSON.stringify(advance)}`);
      const snapshot = harness.store.getSnapshot();
      assert(snapshot.campaign.day === 2, `day가 2가 아닙니다: ${snapshot.campaign.day}`);
      assert(snapshot.runtimePhase === RUNTIME_PHASE.PLANNING, "PLANNING으로 돌아오지 못했습니다.");
      assert(snapshot.checkpointPhase === "PLANNING_READY", "checkpointPhase가 PLANNING_READY가 아닙니다.");
      assert(snapshot.market.day === 2 && snapshot.contracts.day === 2, "market/contracts day가 갱신되지 않았습니다.");
      assert(snapshot.menu.day === 2 && !snapshot.menu.locked && !snapshot.menu.cleanupComplete,
        "Day 2 메뉴 초안이 새로 열리지 않았습니다.");
      assert(snapshot.saleSlots.day === 2 && snapshot.saleSlots.slots.length === 0,
        "Day 2 판매 슬롯이 초기화되지 않았습니다.");
      return { day: snapshot.campaign.day };
    },
  ));

  results.push(await runCase(
    "day2-order-can-start-cooking",
    "Day 2 menu confirmation and service start after settlement still allow an accepted order to start cooking.",
    "Regression: Day 2 service cook start",
    async () => {
      const harness = createHarness(base);
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && !advance.terminal, "failed to advance to Day 2");

      const recipe = activeRecipe(harness.store.getSnapshot());
      const edited = await harness.menuSystem.editEntry(commandInput(harness, `day2:edit:${harness.store.revision}`, {
        recipeId: recipe.recipeId, enabled: true, priceG: recipe.basePriceG, plannedQuantity: 1,
      }));
      assert(edited.ok, `Day 2 menu edit failed: ${edited.code}`);
      const confirmed = await harness.menuSystem.confirmPlan(commandInput(harness, `day2:confirm:${harness.store.revision}`, {
        day: 2,
      }));
      assert(confirmed.ok, `Day 2 menu confirmation failed: ${confirmed.code}`);
      const started = await harness.dayLoopController.confirmServiceStart(commandInput(harness, `day2:start:${harness.store.revision}`, {
        day: 2,
      }));
      assert(started.ok, `Day 2 service start failed: ${started.code}`);

      const guestId = seedSeatedGuest(harness);
      const order = await harness.orderSystem.createOrder(commandInput(harness, `day2:order:${harness.store.revision}`, {
        guestId,
      }));
      assert(order.ok, `Day 2 order failed: ${order.code}`);
      const activeOrder = harness.store.getSnapshot().service.orders.find((candidate) => candidate.state === "ACTIVE");
      assert(activeOrder, "Day 2 active order was not created");
      const cook = await harness.directServiceSystem.startCook(commandInput(harness, `day2:cook:${harness.store.revision}`, {
        recipeId: activeOrder.recipeId,
        saleSlotId: activeOrder.saleSlotId,
        sourceOrderId: activeOrder.orderId,
        trigger: COOK_TRIGGER.PLAYER,
      }));
      assert(cook.ok, `Day 2 cook start failed: ${cook.code}`);
      return { day: harness.store.getSnapshot().campaign.day, cookId: harness.store.getSnapshot().service.timingCook.cookId };
    },
  ));

  results.push(await runCase(
    "day2-cook-after-day1-dish-sold",
    "Day 1에 조리·완판까지 마쳐도, service.completedDishes가 매일 새로 시작하는 것과 달리 inventory.completedDishes의 SOLD 이력이 남아있어 Day 2 조리 시작이 CARRIED_DISH_REFERENCE_MISMATCH로 막히면 안 된다.",
    "Regression: DISH_MIRROR_MISMATCH after a fully-served prior day",
    async () => {
      const harness = createHarness(base);
      const recipe = activeRecipe(harness.store.getSnapshot());
      const edited = await harness.menuSystem.editEntry(commandInput(harness, `d1:edit:${harness.store.revision}`, {
        recipeId: recipe.recipeId, enabled: true, priceG: recipe.basePriceG, plannedQuantity: 1,
      }));
      assert(edited.ok, `Day 1 menu edit failed: ${edited.code}`);
      const confirmed = await harness.menuSystem.confirmPlan(commandInput(harness, `d1:confirm:${harness.store.revision}`, { day: 1 }));
      assert(confirmed.ok, `Day 1 menu confirm failed: ${confirmed.code}`);
      const started = await harness.dayLoopController.confirmServiceStart(commandInput(harness, `d1:start:${harness.store.revision}`, { day: 1 }));
      assert(started.ok, `Day 1 service start failed: ${started.code}`);

      const guestId = seedSeatedGuest(harness);
      const order = await harness.orderSystem.createOrder(commandInput(harness, `d1:order:${harness.store.revision}`, { guestId }));
      assert(order.ok, `Day 1 order failed: ${order.code}`);
      const activeOrder = harness.store.getSnapshot().service.orders.find((candidate) => candidate.state === "ACTIVE");
      assert(activeOrder, "Day 1 active order was not created");
      const cook = await harness.directServiceSystem.startCook(commandInput(harness, `d1:cook-start:${harness.store.revision}`, {
        recipeId: activeOrder.recipeId, saleSlotId: activeOrder.saleSlotId, sourceOrderId: activeOrder.orderId, trigger: COOK_TRIGGER.PLAYER,
      }));
      assert(cook.ok, `Day 1 cook start failed: ${cook.code}`);

      const targetAtMs = harness.store.getSnapshot().service.timingCook.targetAtMs;
      const completed = await harness.directServiceSystem.completeCook({
        commandId: `d1:cook-complete:${harness.store.revision}`,
        expectedRevision: harness.store.revision,
        generationId: harness.store.generationId,
        issuedAtSimulationMs: targetAtMs,
        payload: { inputAtMs: targetAtMs },
      });
      assert(completed.ok, `Day 1 cook complete failed: ${completed.code}`);

      const served = await harness.directServiceSystem.serve(commandInput(harness, `d1:serve:${harness.store.revision}`, {
        targetOrderId: activeOrder.orderId,
      }));
      assert(served.ok, `Day 1 serve failed: ${served.code}`);
      assert(harness.store.getSnapshot().service.carriedDishId === null, "serve 뒤에도 carriedDishId가 남아있습니다.");
      assert(harness.store.getSnapshot().inventory.completedDishes.some((dish) => dish.state === "SOLD"),
        "Day 1에 SOLD dish가 기록되지 않았습니다.");

      const durationMs = harness.store.getSnapshot().service.durationMs;
      const transitionToken = harness.store.getSnapshot().service.settlementTransitionToken;
      const targetMs = harness.scheduler.simulationTimeMs + durationMs;
      harness.timerSystem.armServiceTimer({ serviceToken: transitionToken, durationMs });
      const zero = await harness.timerSystem.tick(targetMs);
      assert(zero.dispatched.length === 1 && zero.dispatched[0].result.ok, "TIMER_ZERO 실패");
      const cleanup = await harness.timerSystem.runCleanupToCompletion({ transitionToken });
      assert(cleanup.completion.ok, `cleanup 완료 실패: ${cleanup.completion.code}`);
      const settled = await harness.settlementSystem.settleDay(commandInput(harness, `d1:settle:${harness.store.revision}`, {
        day: harness.store.getSnapshot().campaign.day,
      }));
      assert(settled.ok, `Day 1 결산 실패: ${settled.code}`);

      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && !advance.terminal, "failed to advance to Day 2");
      assert(harness.store.getSnapshot().campaign.day === 2, "Day 2로 넘어가지 못했습니다.");

      const recipe2 = activeRecipe(harness.store.getSnapshot());
      const edited2 = await harness.menuSystem.editEntry(commandInput(harness, `d2:edit:${harness.store.revision}`, {
        recipeId: recipe2.recipeId, enabled: true, priceG: recipe2.basePriceG, plannedQuantity: 1,
      }));
      assert(edited2.ok, `Day 2 menu edit failed: ${edited2.code}`);
      const confirmed2 = await harness.menuSystem.confirmPlan(commandInput(harness, `d2:confirm:${harness.store.revision}`, { day: 2 }));
      assert(confirmed2.ok, `Day 2 menu confirm failed: ${confirmed2.code}`);
      const started2 = await harness.dayLoopController.confirmServiceStart(commandInput(harness, `d2:start:${harness.store.revision}`, { day: 2 }));
      assert(started2.ok, `Day 2 service start failed: ${started2.code}`);

      const guestId2 = seedSeatedGuest(harness);
      const order2 = await harness.orderSystem.createOrder(commandInput(harness, `d2:order:${harness.store.revision}`, { guestId: guestId2 }));
      assert(order2.ok, `Day 2 order failed: ${order2.code}`);
      const activeOrder2 = harness.store.getSnapshot().service.orders.find((candidate) => candidate.state === "ACTIVE");
      assert(activeOrder2, "Day 2 active order was not created");
      const cook2 = await harness.directServiceSystem.startCook(commandInput(harness, `d2:cook-start:${harness.store.revision}`, {
        recipeId: activeOrder2.recipeId, saleSlotId: activeOrder2.saleSlotId, sourceOrderId: activeOrder2.orderId, trigger: COOK_TRIGGER.PLAYER,
      }));
      assert(cook2.ok, `Day 2 cook start failed (${cook2.code}) — 하루 전 판매 이력 때문에 조리가 막히면 안 됩니다.`);
      return {
        day: harness.store.getSnapshot().campaign.day,
        cook2Id: harness.store.getSnapshot().service.timingCook.cookId,
      };
    },
  ));

  results.push(await runCase(
    "day14-victory",
    "day14에 비파산·debt0·reputation70+이면 VICTORY로 판정하고 day15를 만들지 않는다",
    "Requirement 17.1, 17.4",
    async () => {
      const harness = createHarness({ ...base, day: 14 });
      const snapshot = harness.store.getSnapshot();
      harness.store.commit({
        ...snapshot,
        economy: { ...snapshot.economy, debtG: 0 },
        campaign: { ...snapshot.campaign, reputation: 70 },
      }, { commandId: `qa:seed-victory:${harness.store.revision}`, expectedRevision: harness.store.revision });
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && advance.terminal, `terminal 판정 실패: ${JSON.stringify(advance)}`);
      assert(advance.terminalResult.type === TERMINAL_TYPE.VICTORY, `VICTORY가 아닙니다: ${advance.terminalResult.type}`);
      assert(harness.store.runtimePhase === RUNTIME_PHASE.TERMINAL, "TERMINAL phase에 도달하지 못했습니다.");
      assert(harness.store.getSnapshot().campaign.day === 14, "day15가 생성됐습니다.");
      return { terminalType: advance.terminalResult.type };
    },
  ));

  results.push(await runCase(
    "day14-goal-not-met",
    "day14에 비파산이지만 승리 조건 미달이면 GOAL_NOT_MET으로 판정한다",
    "Requirement 17.5",
    async () => {
      const harness = createHarness({ ...base, day: 14 });
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && advance.terminal, `terminal 판정 실패: ${JSON.stringify(advance)}`);
      assert(advance.terminalResult.type === TERMINAL_TYPE.GOAL_NOT_MET,
        `GOAL_NOT_MET이 아닙니다: ${advance.terminalResult.type}`);
      return { terminalType: advance.terminalResult.type };
    },
  ));

  results.push(await runCase(
    "bankruptcy-priority-over-day14-and-arrears-threshold",
    "day14가 아니어도 Arrears>=80G면 즉시 파산이 승리/목표미달보다 우선한다",
    "Requirement 17.1~17.3",
    async () => {
      const harness = createHarness({ ...base, day: 3 });
      const snapshot = harness.store.getSnapshot();
      harness.store.commit({
        ...snapshot,
        economy: { ...snapshot.economy, arrearsG: 80, debtG: 0 },
        campaign: { ...snapshot.campaign, reputation: 100 },
      }, { commandId: `qa:seed-bankruptcy:${harness.store.revision}`, expectedRevision: harness.store.revision });
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && advance.terminal, `terminal 판정 실패: ${JSON.stringify(advance)}`);
      assert(advance.terminalResult.type === TERMINAL_TYPE.BANKRUPTCY,
        `BANKRUPTCY가 아닙니다: ${advance.terminalResult.type}`);
      assert(harness.store.getSnapshot().campaign.day === 3, "day가 임의로 바뀌었습니다.");
      return { terminalType: advance.terminalResult.type, day: 3 };
    },
  ));

  results.push(await runCase(
    "terminal-cleans-up-pending-contract-reserve-and-prepaid-loss",
    "종료 시 아직 ACCEPTED_PENDING인 계약은 reserve를 해제하고 prepaid를 손실로 전환해 한 번만 정리한다",
    "Requirement 17.7",
    async () => {
      const harness = createHarness({ ...base, day: 3 });
      const offer = harness.store.getSnapshot().contracts.offers[0];
      assert(offer, "day3 contract offer가 없습니다.");
      const accepted = await harness.contractSystem.acceptContract(commandInput(harness, `accept:${harness.store.revision}`, {
        day: 3, offerId: offer.offerId, fixedCostRiskConfirmed: true,
      }));
      assert(accepted.ok, `계약 수락 실패: ${accepted.code}`);
      const contractId = harness.store.getSnapshot().contracts.contracts[0].contractId;
      const reserveBefore = harness.store.getSnapshot().economy.contractReserveG;
      const prepaidAssetBefore = harness.store.getSnapshot().economy.contractPrepaidAssetG;
      const balanceG = harness.store.getSnapshot().contracts.contracts[0].balanceG;
      const prepaidG = harness.store.getSnapshot().contracts.contracts[0].prepaidG;

      const snapshot = harness.store.getSnapshot();
      harness.store.commit({
        ...snapshot,
        economy: { ...snapshot.economy, arrearsG: 80, debtG: 0 },
        campaign: { ...snapshot.campaign, reputation: 100 },
      }, { commandId: `qa:seed-bankruptcy-with-contract:${harness.store.revision}`, expectedRevision: harness.store.revision });
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && advance.terminal, `terminal 판정 실패: ${JSON.stringify(advance)}`);

      const after = harness.store.getSnapshot();
      const contract = after.contracts.contracts.find((c) => c.contractId === contractId);
      assert(contract.status === "TERMINAL_CANCELLED", `계약 상태가 다릅니다: ${contract.status}`);
      assert(after.economy.contractReserveG === reserveBefore - balanceG,
        `reserve가 해제되지 않았습니다: ${after.economy.contractReserveG}`);
      assert(after.economy.contractPrepaidAssetG === prepaidAssetBefore - prepaidG,
        `prepaid asset이 손실 전환되지 않았습니다: ${after.economy.contractPrepaidAssetG}`);
      return { contractId, status: contract.status, releasedG: balanceG, lossG: prepaidG };
    },
  ));

  results.push(await runCase(
    "bankruptcy-via-consecutive-arrears-count",
    "Arrears>0이 두 번 연속되면(count>=2) 금액이 작아도 파산 처리한다",
    "Requirement 17.2, 17.3",
    async () => {
      const harness = createHarness({ ...base, day: 5 });
      const snapshot = harness.store.getSnapshot();
      harness.store.commit({
        ...snapshot,
        economy: { ...snapshot.economy, arrearsG: 1 },
        campaign: { ...snapshot.campaign, consecutiveArrearsCount: 1 },
      }, { commandId: `qa:seed-consecutive:${harness.store.revision}`, expectedRevision: harness.store.revision });
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && advance.terminal, `terminal 판정 실패: ${JSON.stringify(advance)}`);
      assert(advance.terminalResult.type === TERMINAL_TYPE.BANKRUPTCY,
        `BANKRUPTCY가 아닙니다: ${advance.terminalResult.type}`);
      assert(advance.terminalResult.consecutiveArrearsCount === 2, "consecutiveArrearsCount가 2가 아닙니다.");
      return { consecutiveArrearsCount: advance.terminalResult.consecutiveArrearsCount };
    },
  ));

  results.push(await runCase(
    "cash-zero-alone-continues",
    "cash=0만으로는 종료하지 않고 캠페인이 계속된다",
    "Requirement 17.6",
    async () => {
      const harness = createHarness({ ...base, day: 4 });
      const snapshot = harness.store.getSnapshot();
      harness.store.commit({
        ...snapshot,
        economy: { ...snapshot.economy, cashG: 0, arrearsG: 0 },
      }, { commandId: `qa:seed-cash-zero:${harness.store.revision}`, expectedRevision: harness.store.revision });
      await runMinimalDayToSettlement(harness);
      const advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok && !advance.terminal, `종료되지 않아야 하는데 종료됐습니다: ${JSON.stringify(advance)}`);
      assert(harness.store.getSnapshot().campaign.day === 5, "day가 진행되지 않았습니다.");
      return { day: harness.store.getSnapshot().campaign.day };
    },
  ));

  results.push(await runCase(
    "pending-contract-resolved-on-arrival-day",
    "day1에 수락한 계약이 도착일에 정확히 한 번 resolve된다",
    "Requirement 6.10, 6.15",
    async () => {
      const harness = createHarness({ ...base, day: 1 });
      const offer = harness.store.getSnapshot().contracts.offers[0];
      assert(offer, "day1 contract offer가 없습니다.");
      const accepted = await harness.contractSystem.acceptContract(commandInput(harness, `accept:${harness.store.revision}`, {
        day: 1, offerId: offer.offerId, fixedCostRiskConfirmed: true,
      }));
      assert(accepted.ok, `계약 수락 실패: ${accepted.code}`);
      const contractId = harness.store.getSnapshot().contracts.contracts[0].contractId;
      const resolutionDay = harness.store.getSnapshot().contracts.contracts[0].resolutionDay;
      await runMinimalDayToSettlement(harness);
      let advance = await harness.campaignManager.advanceAfterSettlement();
      assert(advance.ok, `day 진행 실패: ${JSON.stringify(advance)}`);
      while (!advance.terminal && harness.store.getSnapshot().campaign.day < resolutionDay) {
        await runMinimalDayToSettlement(harness);
        advance = await harness.campaignManager.advanceAfterSettlement();
        assert(advance.ok, `day 진행 실패: ${JSON.stringify(advance)}`);
      }
      const contract = harness.store.getSnapshot().contracts.contracts.find((c) => c.contractId === contractId);
      assert(contract.status !== CONTRACT_STATUS.ACCEPTED_PENDING, `계약이 아직 pending입니다: ${contract.status}`);
      return { contractId, status: contract.status, resolutionDay };
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
