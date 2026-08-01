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
  registerOrderSystem(bus);
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
    serviceCleanupSystem, settlementSystem, campaignOutcomeSystem, dayInitializationSystem, scheduler, timerSystem,
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
      return { day: snapshot.campaign.day };
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
