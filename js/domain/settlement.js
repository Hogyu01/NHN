import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { checkedAddG, checkedSubtractG } from "../core/money.js";
import { validateEconomyState } from "./economy.js";
import { reconcileInventoryAccounting, validateInventoryAccountingState } from "./inventory-accounting.js";
import { validateInventoryState } from "./inventory.js";
import { validateSalesState } from "./sales.js";
import { validateServiceTimerState, RUNTIME_PHASE, SERVICE_LIFECYCLE } from "./timer-state.js";
import { createCanonicalDayResult } from "./day-result.js";
import { verifyDaySettlementReconciliation } from "./reconciliation.js";

export const SETTLEMENT_COMMAND = Object.freeze({
  SETTLE_DAY: "settlement.day.settle",
});

export const SETTLE_DAY_READ_SET = Object.freeze([
  "runtimePhase", "campaign", "economy", "inventory", "inventoryAccounting", "sales", "service", "idCounters",
]);
export const SETTLE_DAY_WRITE_SET = Object.freeze(["campaign", "idCounters"]);

const MESSAGE_BY_CODE = Object.freeze({
  SETTLEMENT_PHASE_INVALID: "Settlement_Phase가 아닌 상태에서는 결산할 수 없습니다.",
  SETTLEMENT_ALREADY_SEALED: "이 day는 이미 결산이 봉인됐습니다.",
  SETTLEMENT_STATE_INVALID: "결산에 필요한 상태가 유효하지 않습니다.",
  SETTLEMENT_RECONCILIATION_FAILED: "결산 대사가 실패해 결과를 봉인할 수 없습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "결산 명령 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Requirement 5.6: Operating_Profit = Revenue - COGS - Waste - FixedCost - Wage - ContractLoss */
export function calculateOperatingProfit({
  revenueG, cogsG, cookingWasteExpenseG, fixedCostIncurredG, staffWageExpenseG, contractFailureLossG,
}) {
  let profit = revenueG;
  profit = checkedSubtractG(profit, cogsG, "operatingProfit cogs");
  profit = checkedSubtractG(profit, cookingWasteExpenseG, "operatingProfit waste");
  profit = checkedSubtractG(profit, fixedCostIncurredG, "operatingProfit fixedCost");
  profit = checkedSubtractG(profit, staffWageExpenseG, "operatingProfit wage");
  profit = checkedSubtractG(profit, contractFailureLossG, "operatingProfit contractLoss");
  return profit;
}

function validateSettlementContext(context) {
  const campaign = context.read("campaign");
  const economy = context.read("economy");
  const inventory = context.read("inventory");
  const inventoryAccounting = context.read("inventoryAccounting");
  const sales = context.read("sales");
  const service = context.read("service");

  if (context.phase !== RUNTIME_PHASE.SETTLEMENT) {
    return failure("SETTLEMENT_PHASE_INVALID", { phase: context.phase });
  }
  if (campaign.canonicalDayResults.some((result) => result.day === campaign.day)) {
    return failure("SETTLEMENT_ALREADY_SEALED", { day: campaign.day });
  }
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("SETTLEMENT_STATE_INVALID", { cause: economyValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("SETTLEMENT_STATE_INVALID", { cause: inventoryValidation.code });
  const accountingValidation = validateInventoryAccountingState(inventoryAccounting);
  if (!accountingValidation.ok) return failure("SETTLEMENT_STATE_INVALID", { cause: accountingValidation.code });
  const reconciliationValidation = reconcileInventoryAccounting(inventory, inventoryAccounting);
  if (!reconciliationValidation.ok) return failure("SETTLEMENT_STATE_INVALID", { cause: reconciliationValidation.code });
  const salesValidation = validateSalesState(sales);
  if (!salesValidation.ok) return failure("SETTLEMENT_STATE_INVALID", { cause: salesValidation.code });
  const serviceValidation = validateServiceTimerState(service);
  if (!serviceValidation.ok) return failure("SETTLEMENT_STATE_INVALID", { cause: serviceValidation.code });

  return validationSuccess({ campaign, economy, inventory, inventoryAccounting, sales, service });
}

/**
 * Requirement 5, Requirement 13 AC5, Requirement 16 AC4, Requirement 17 AC2~8을 만족하는
 * Canonical_Day_Result 하나를 계산한다. staffWageExpenseG는 Staff_System(Requirement 12, Should)이
 * 아직 구현되지 않아 항상 0G다.
 */
export function planDaySettlement(context, payload = {}) {
  const validation = validateSettlementContext(context);
  if (!validation.ok) return validation;
  const { campaign, economy, inventory, inventoryAccounting, sales, service } = validation.details;
  const day = campaign.day;

  const reconciled = verifyDaySettlementReconciliation({ economy, inventoryAccounting, day });
  if (!reconciled.ok) return failure("SETTLEMENT_RECONCILIATION_FAILED", { cause: reconciled.code, details: reconciled.details });
  const { cash, inventory: inventoryTotals } = reconciled.details;

  const revenueG = sales.revenueG;
  const cogsG = inventoryTotals.cogsG;
  const cookingWasteExpenseG = inventoryTotals.cookingWasteExpenseG;
  const staffWageExpenseG = 0;

  let fixedCostIncurredG = 0;
  let contractFailureLossG = 0;
  let investmentG = 0;
  let debtPaymentG = 0;
  let contractPrepaidPaymentG = 0;
  let contractBalancePaymentG = 0;
  const transactionIds = [];
  const costMovementIds = [];
  for (const entry of economy.ledger) {
    if (entry.day !== day) continue;
    transactionIds.push(entry.transactionId);
    if (entry.category === "FIXED_COST") fixedCostIncurredG = checkedAddG(fixedCostIncurredG, entry.amountG, "fixedCost");
    else if (entry.category === "FACILITY_INVESTMENT") investmentG = checkedAddG(investmentG, entry.amountG, "investment");
    else if (entry.category === "DEBT_PRINCIPAL") debtPaymentG = checkedAddG(debtPaymentG, entry.amountG, "debtPayment");
    else if (entry.category === "CONTRACT_PREPAID") contractPrepaidPaymentG = checkedAddG(contractPrepaidPaymentG, entry.amountG, "contractPrepaid");
    else if (entry.category === "CONTRACT_BALANCE") contractBalancePaymentG = checkedAddG(contractBalancePaymentG, entry.amountG, "contractBalance");
  }
  for (const movement of inventoryAccounting.costMovements) {
    if (movement.day !== day) continue;
    costMovementIds.push(movement.movementId);
    if (movement.type === "PREPAID_TO_LOSS") {
      contractFailureLossG = checkedAddG(contractFailureLossG, movement.amountG, "contractFailureLoss");
    }
  }

  const operatingProfitG = calculateOperatingProfit({
    revenueG, cogsG, cookingWasteExpenseG, fixedCostIncurredG, staffWageExpenseG, contractFailureLossG,
  });
  const operatingCashInflowG = revenueG;
  const operatingCashOutflowG = checkedAddG(
    checkedAddG(inventoryTotals.marketAcquisitionG, contractPrepaidPaymentG, "operatingOutflow prepaid"),
    checkedAddG(contractBalancePaymentG, fixedCostIncurredG, "operatingOutflow fixed"),
    "operatingCashOutflow",
  );
  const investingCashOutflowG = investmentG;
  const financingCashOutflowG = debtPaymentG;
  const netCashChangeG = cash.netCashChangeG;

  const marketPurchased = sales.sales.length === 0 && inventoryTotals.marketAcquisitionG === 0 ? 0 :
    inventory.lots.filter((lot) => lot.acquiredDay === day).length;
  const contractAcquired = inventory.lots.filter((lot) => lot.acquiredDay === day &&
    inventoryTotals.successfulContractAcquisitionG > 0).length;
  const cooked = service.completedDishes.length;
  const sold = sales.soldQuantity;
  const orderIds = sales.sales.map((sale) => sale.orderId);
  const unmetDemand = service.unmetDemandCount;
  const wasted = service.completedDishes.filter((dish) => dish.state === "WASTED").length;

  const reputationCauses = campaign.reputationHistory
    .filter((entry) => entry.day === day)
    .map((entry) => ({ causeId: entry.causeId, appliedDelta: entry.appliedDelta }));
  const reputationDelta = reputationCauses.reduce((total, cause) => total + cause.appliedDelta, 0);

  const endingInventory = inventory.lots.map((lot) => ({
    ingredientId: lot.ingredientId,
    quantity: lot.quantity,
    bookCostG: lot.bookCostG,
  }));
  const endingInventoryBookCostG = endingInventory.reduce(
    (total, line) => checkedAddG(total, line.bookCostG, "endingInventoryBookCost"), 0,
  );

  const result = {
    day,
    revenueG,
    soldQuantity: sold,
    quantitySummary: { marketPurchased, contractAcquired, cooked, sold, wasted, unmetDemand },
    cogsG,
    cookingWasteExpenseG,
    fixedCostIncurredG,
    staffWageExpenseG,
    contractFailureLossG,
    operatingProfitG,
    netCashChangeG,
    operatingCashInflowG,
    operatingCashOutflowG,
    investingCashOutflowG,
    investmentG,
    financingCashOutflowG,
    debtPaymentG,
    endingCashG: economy.cashG,
    endingArrearsG: economy.arrearsG,
    endingInventoryBookCostG,
    endingInventory,
    endingPrepaidAssetG: economy.contractPrepaidAssetG,
    reputationDelta,
    reputationCauses,
    transactionIds,
    orderIds,
    costMovementIds,
    reconciliation: { cash: "PASS", inventory: "PASS" },
  };

  return success({ campaign, day, result, payload });
}

function failureOrSuccessWrapper(code, details) {
  return failure(code, details);
}

function success(plan) {
  return Object.freeze({ ok: true, plan: freezeDeep(plan) });
}

export function createSettleDayAtomicTransaction() {
  return defineAtomicTransaction({
    name: SETTLEMENT_COMMAND.SETTLE_DAY,
    readSet: SETTLE_DAY_READ_SET,
    writeSet: SETTLE_DAY_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SETTLEMENT],
    validatePayload(ctx) {
      if (!isPlainRecord(ctx.command.payload)) return failureOrSuccessWrapper("SETTLEMENT_STATE_INVALID");
      return validationSuccess();
    },
    preflight(ctx) {
      return planDaySettlement(ctx, ctx.command.payload);
    },
    mutate(draft) {
      const context = {
        phase: draft.read("runtimePhase"),
        read: (slice) => draft.read(slice),
      };
      const planned = planDaySettlement(context, draft.command.payload);
      if (!planned.ok) return planned;
      let resultId;
      try {
        const ids = IdService.fromState(draft.read("idCounters"));
        resultId = ids.next("day-result", { day: planned.plan.day });
        draft.replace("idCounters", ids.snapshot());
      } catch (error) {
        return failure("SETTLEMENT_STATE_INVALID", { cause: error?.code });
      }
      let canonicalResult;
      try {
        canonicalResult = createCanonicalDayResult({ ...planned.plan.result, resultId });
      } catch (error) {
        return failure("SETTLEMENT_STATE_INVALID", { cause: error?.code });
      }
      const campaignDraft = draft.write("campaign");
      campaignDraft.canonicalDayResults = [...campaignDraft.canonicalDayResults, canonicalResult];
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const context = { phase: before.runtimePhase, read: (slice) => before[slice] };
      const planned = planDaySettlement(context, ctx.command.payload);
      if (!planned.ok) return planned;
      const sealed = after.campaign.canonicalDayResults.find((result) => result.day === planned.plan.day);
      if (!sealed) return failure("SETTLEMENT_STATE_INVALID");
      if (before.campaign.canonicalDayResults.length + 1 !== after.campaign.canonicalDayResults.length) {
        return failure("SETTLEMENT_ALREADY_SEALED");
      }
      return validationSuccess();
    },
    events(before, after) {
      const sealed = after.campaign.canonicalDayResults[after.campaign.canonicalDayResults.length - 1];
      return [{
        type: "settlement.day-sealed",
        payload: { day: sealed.day, resultId: sealed.resultId, operatingProfitG: sealed.operatingProfitG },
      }];
    },
  });
}

export class SettlementSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("SettlementSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(SETTLEMENT_COMMAND.SETTLE_DAY, createSettleDayAtomicTransaction());
    this.registered = true;
    return this;
  }

  settleDay(input) {
    return this.commandBus.dispatch(commandEnvelope(
      SETTLEMENT_COMMAND.SETTLE_DAY,
      SETTLE_DAY_READ_SET,
      SETTLE_DAY_WRITE_SET,
      input,
    ));
  }
}

function commandEnvelope(type, readSet, writeSet, input) {
  return {
    commandId: input?.commandId,
    expectedRevision: input?.expectedRevision,
    generationId: input?.generationId,
    issuedAtSimulationMs: input?.issuedAtSimulationMs,
    type,
    payload: input?.payload,
    readSet: [...readSet],
    writeSet: [...writeSet],
  };
}

export function registerSettlementSystem(commandBus) {
  return new SettlementSystem(commandBus, { register: true });
}
