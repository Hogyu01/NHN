import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { GameStore } from "../core/store.js";
import { createReputationCampaignFields } from "../domain/reputation.js";
import {
  calculateOperatingProfit,
  registerSettlementSystem,
  SETTLEMENT_COMMAND,
} from "../domain/settlement.js";
import { createEconomyState } from "../domain/economy.js";
import { LEDGER_CATEGORY, LEDGER_DIRECTION, LEDGER_TYPE } from "../domain/economy-ledger.js";
import { createInventoryState } from "../domain/inventory.js";
import { createInventoryAccountingState, COST_MOVEMENT_TYPE } from "../domain/inventory-accounting.js";
import { createSalesState } from "../domain/sales.js";
import { COOK_JUDGMENT } from "../domain/timing-cook.js";
import { createServiceTimerState, RUNTIME_PHASE, SERVICE_LIFECYCLE } from "../domain/timer-state.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ledgerEntry({ transactionId, day, category, type, direction, amountG, causeId }) {
  return { transactionId, day, category, type, direction, amountG, causeId };
}

const MOVEMENT_LOCATIONS = Object.freeze({
  [COST_MOVEMENT_TYPE.MARKET_ACQUISITION]: { source: "EXTERNAL_MARKET", destination: "LOT" },
  [COST_MOVEMENT_TYPE.DISH_TO_COGS]: { source: "COMPLETED_DISH", destination: "COGS" },
  [COST_MOVEMENT_TYPE.DISH_TO_WASTE]: { source: "COMPLETED_DISH", destination: "WASTE" },
});

function costMovement({ movementId, day, type, amountG, quantity = 1 }) {
  const { source, destination } = MOVEMENT_LOCATIONS[type];
  return {
    movementId, day, type, source, destination, amountG, quantity,
    causeId: `qa.settlement.cause.${movementId}`,
    references: {}, lines: [],
  };
}

/** 하루 결산 직전(SETTLEMENT phase) 상태를 손으로 구성해 결산 계산을 검증한다. */
function buildSettlementSnapshot({ day = 1 } = {}) {
  const campaignId = createCampaignId(0x5e77, 0);
  const ledger = [
    ledgerEntry({
      transactionId: "tx.sale.1", day, category: LEDGER_CATEGORY.SALE, type: LEDGER_TYPE.SALE_REVENUE,
      direction: LEDGER_DIRECTION.INFLOW, amountG: 500, causeId: "cause.sale.1",
    }),
    ledgerEntry({
      transactionId: "tx.market.1", day, category: LEDGER_CATEGORY.MARKET, type: LEDGER_TYPE.MARKET_PURCHASE,
      direction: LEDGER_DIRECTION.OUTFLOW, amountG: 120, causeId: "cause.market.1",
    }),
    ledgerEntry({
      transactionId: "tx.fixed.1", day, category: LEDGER_CATEGORY.FIXED_COST, type: LEDGER_TYPE.FIXED_COST_PAYMENT,
      direction: LEDGER_DIRECTION.OUTFLOW, amountG: 40, causeId: "cause.fixed.1",
    }),
  ];
  const costMovements = [
    costMovement({ movementId: "mv.market.1", day, type: COST_MOVEMENT_TYPE.MARKET_ACQUISITION, amountG: 120 }),
    costMovement({ movementId: "mv.cogs.1", day, type: COST_MOVEMENT_TYPE.DISH_TO_COGS, amountG: 80 }),
    costMovement({ movementId: "mv.waste.1", day, type: COST_MOVEMENT_TYPE.DISH_TO_WASTE, amountG: 20 }),
  ];

  return {
    formatVersion: 1,
    revision: 0,
    runtimePhase: RUNTIME_PHASE.SETTLEMENT,
    checkpointPhase: null,
    generationId: 0,
    campaign: {
      campaignId,
      masterSeed: 0x5e77,
      day,
      consecutiveArrearsCount: 0,
      canonicalDayResults: [],
      ...createReputationCampaignFields(30),
      reputationHistory: [{ causeId: "cause.sale.1", day, requestedDelta: 2, appliedDelta: 2, previousReputation: 30, reputation: 32 }],
    },
    economy: createEconomyState({ cashG: 340, debtG: 500, arrearsG: 0, contractPrepaidAssetG: 0, ledger }),
    inventory: createInventoryState({
      lots: [{ lotId: "lot.1", ingredientId: "ingredient.a", quantity: 5, quality: 70, bookCostG: 100, acquiredDay: day }],
    }),
    inventoryAccounting: createInventoryAccountingState({
      costMovements,
      openingInventoryBookCostG: 80,
      marketAcquisitionG: 120,
      cogsG: 80,
      cookingWasteExpenseG: 20,
    }),
    sales: createSalesState({
      day, revenueG: 500, soldQuantity: 1,
      sales: [{
        saleId: "tx.sale.1", transactionId: "tx.sale.1", cogsMovementId: "mv.cogs.1", causeId: "cause.sale.1",
        orderId: "order.1", guestId: "guest.1", recipeId: "recipe.1", dishId: "dish.1", saleSlotId: "slot.1",
        day, priceG: 500, bookCostG: 80, quality: 70,
        cookJudgment: COOK_JUDGMENT.SUCCESS, reputationDelta: 2, committedAtMs: 1000,
      }],
    }),
    service: createServiceTimerState({
      durationMs: 105_000, cleanupOvertimeMs: 12_000, lifecycle: SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP,
      remainingMs: 0, resultsClosed: true, unmetDemandCount: 1,
      startedDay: day, startedPlanId: "menu.plan.1", startedPlanRevision: 1,
      settlementTransitionToken: "qa.settlement.token.1", endReason: "TIMER_ZERO",
      plans: [0, 1, 2, 3].map((planSequence) => ({
        guestId: `qa.settlement.guest.${planSequence}`,
        entityId: `qa.settlement.entity.${planSequence}`,
        planSequence,
        archetypeId: "guest.human_adventurer",
        arrivalAtMs: planSequence * 1_000,
        recipePreference: ["recipe.1"],
      })),
      completedDishes: [{ dishId: "dish.1", recipeId: "recipe.1", quality: 70, bookCostG: 80, createdOrderId: "order.1", sourceSaleSlotId: "slot.1", state: "SOLD" }],
    }),
    idCounters: createIdServiceState({ campaignId, day, generationId: 0 }),
  };
}

async function operatingProfitFormula() {
  const profit = calculateOperatingProfit({
    revenueG: 500, cogsG: 80, cookingWasteExpenseG: 20, fixedCostIncurredG: 40, staffWageExpenseG: 0, contractFailureLossG: 0,
  });
  assert(profit === 360, `Operating_Profit 계산이 틀렸습니다: ${profit}`);
  return { operatingProfitG: profit };
}

async function settleDaySealsCorrectResult() {
  const store = new GameStore(buildSettlementSnapshot());
  const bus = new CommandBus({ store });
  registerSettlementSystem(bus);
  const result = await bus.dispatch({
    type: SETTLEMENT_COMMAND.SETTLE_DAY,
    readSet: ["runtimePhase", "campaign", "economy", "inventory", "inventoryAccounting", "sales", "service", "idCounters"],
    writeSet: ["campaign", "idCounters"],
    commandId: "qa.settlement.settle.1",
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs: 0,
    payload: {},
  });
  assert(result.ok, `결산 command가 거절됐습니다: ${result.code}`);
  const sealed = store.getSnapshot().campaign.canonicalDayResults[0];
  assert(sealed.revenueG === 500, `revenueG가 틀렸습니다: ${sealed.revenueG}`);
  assert(sealed.cogsG === 80, `cogsG가 틀렸습니다: ${sealed.cogsG}`);
  assert(sealed.cookingWasteExpenseG === 20, `cookingWasteExpenseG가 틀렸습니다: ${sealed.cookingWasteExpenseG}`);
  assert(sealed.fixedCostIncurredG === 40, `fixedCostIncurredG가 틀렸습니다: ${sealed.fixedCostIncurredG}`);
  assert(sealed.operatingProfitG === 360, `operatingProfitG가 틀렸습니다: ${sealed.operatingProfitG}`);
  assert(sealed.netCashChangeG === 340, `netCashChangeG가 틀렸습니다: ${sealed.netCashChangeG}`);
  assert(sealed.endingCashG === 340, `endingCashG가 틀렸습니다: ${sealed.endingCashG}`);
  assert(sealed.reputationDelta === 2, `reputationDelta가 틀렸습니다: ${sealed.reputationDelta}`);
  assert(sealed.reconciliation.cash === "PASS" && sealed.reconciliation.inventory === "PASS",
    "reconciliation 결과가 PASS가 아닙니다.");
  return { day: sealed.day, resultId: sealed.resultId };
}

async function duplicateSettlementRejected() {
  const store = new GameStore(buildSettlementSnapshot());
  const bus = new CommandBus({ store });
  registerSettlementSystem(bus);
  const dispatch = (commandId) => bus.dispatch({
    type: SETTLEMENT_COMMAND.SETTLE_DAY,
    readSet: ["runtimePhase", "campaign", "economy", "inventory", "inventoryAccounting", "sales", "service", "idCounters"],
    writeSet: ["campaign", "idCounters"],
    commandId,
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs: 0,
    payload: {},
  });
  const first = await dispatch("qa.settlement.dup.1");
  assert(first.ok, `첫 결산이 거절됐습니다: ${first.code}`);
  const second = await dispatch("qa.settlement.dup.2");
  assert(!second.ok && second.code === "SETTLEMENT_ALREADY_SEALED",
    `중복 결산이 거절되지 않았습니다: ${second.ok ? "accepted" : second.code}`);
  return { duplicateRejected: true };
}

async function wrongPhaseRejected() {
  const snapshot = buildSettlementSnapshot();
  snapshot.runtimePhase = RUNTIME_PHASE.SERVICE;
  const store = new GameStore(snapshot);
  const bus = new CommandBus({ store });
  registerSettlementSystem(bus);
  const result = await bus.dispatch({
    type: SETTLEMENT_COMMAND.SETTLE_DAY,
    readSet: ["runtimePhase", "campaign", "economy", "inventory", "inventoryAccounting", "sales", "service", "idCounters"],
    writeSet: ["campaign", "idCounters"],
    commandId: "qa.settlement.wrong-phase",
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs: 0,
    payload: {},
  });
  assert(!result.ok, `SERVICE phase에서 결산이 거절되지 않았습니다: ${result.ok ? "accepted" : result.code}`);
  return { rejected: true, code: result.code };
}

async function reconciliationMismatchBlocked() {
  const snapshot = buildSettlementSnapshot();
  // accounting 누적치를 원장과 어긋나게 조작한다.
  snapshot.inventoryAccounting = { ...snapshot.inventoryAccounting, cogsG: 999 };
  const store = new GameStore(snapshot);
  const bus = new CommandBus({ store });
  registerSettlementSystem(bus);
  const result = await bus.dispatch({
    type: SETTLEMENT_COMMAND.SETTLE_DAY,
    readSet: ["runtimePhase", "campaign", "economy", "inventory", "inventoryAccounting", "sales", "service", "idCounters"],
    writeSet: ["campaign", "idCounters"],
    commandId: "qa.settlement.mismatch",
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs: 0,
    payload: {},
  });
  assert(!result.ok, "재고 대사가 어긋났는데도 결산이 통과됐습니다.");
  assert(store.getSnapshot().campaign.canonicalDayResults.length === 0,
    "대사 실패에도 결과가 봉인됐습니다.");
  return { blocked: true };
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

export async function runSettlementProbe() {
  const results = await Promise.all([
    runCase("operating-profit-formula", "Operating_Profit 공식이 Requirement 5.6과 일치한다",
      "Requirement 5.6", operatingProfitFormula),
    runCase("settle-day-seals-correct-result", "결산 command가 올바른 Canonical_Day_Result를 봉인한다",
      "Requirement 5.6, 5.7, 5.12, 5.13, 16.4", settleDaySealsCorrectResult),
    runCase("duplicate-settlement-rejected", "같은 day를 두 번 결산하면 거절된다",
      "Requirement 5.12", duplicateSettlementRejected),
    runCase("wrong-phase-rejected", "Settlement_Phase가 아니면 결산이 거절된다",
      "Requirement 2.1", wrongPhaseRejected),
    runCase("reconciliation-mismatch-blocked", "대사가 어긋나면 결과 봉인을 차단한다",
      "Requirement 5.11", reconciliationMismatchBlocked),
  ]);
  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({ status: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results });
}
