import { freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import { requireNonNegativeG, requireSafeIntegerG } from "../core/money.js";

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_CANONICAL_DAY_RESULT: "Canonical_Day_Result 형식이 올바르지 않습니다.",
  INVALID_DAY_RESULT_ID: "Canonical_Day_Result ID가 올바르지 않습니다.",
  INVALID_DAY_RESULT_DAY: "Canonical_Day_Result day가 올바르지 않습니다.",
  INVALID_DAY_RESULT_AMOUNT: "Canonical_Day_Result 금액 필드가 올바르지 않습니다.",
  INVALID_DAY_RESULT_QUANTITY: "Canonical_Day_Result 수량 필드가 올바르지 않습니다.",
  INVALID_DAY_RESULT_RECONCILIATION: "Canonical_Day_Result reconciliation 필드가 올바르지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "Canonical_Day_Result 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const AMOUNT_FIELDS = Object.freeze([
  "revenueG", "cogsG", "cookingWasteExpenseG", "fixedCostIncurredG", "staffWageExpenseG",
  "contractFailureLossG", "operatingCashInflowG", "operatingCashOutflowG",
  "investingCashOutflowG", "investmentG", "financingCashOutflowG", "debtPaymentG",
  "endingCashG", "endingArrearsG", "endingInventoryBookCostG", "endingPrepaidAssetG",
]);

const QUANTITY_SUMMARY_FIELDS = Object.freeze([
  "marketPurchased", "contractAcquired", "cooked", "sold", "wasted", "unmetDemand",
]);

const ID_LIST_FIELDS = Object.freeze(["transactionIds", "orderIds", "costMovementIds"]);

function validQuantity(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateCanonicalDayResult(result) {
  if (!isPlainRecord(result)) return failure("INVALID_CANONICAL_DAY_RESULT", { field: "$" });
  if (!isStableIdentifier(result.resultId)) {
    return failure("INVALID_DAY_RESULT_ID", { field: "resultId" });
  }
  if (!Number.isSafeInteger(result.day) || result.day < 1 || result.day > 14) {
    return failure("INVALID_DAY_RESULT_DAY", { day: result.day });
  }
  for (const field of AMOUNT_FIELDS) {
    try {
      requireSafeIntegerG(result[field], field);
    } catch {
      return failure("INVALID_DAY_RESULT_AMOUNT", { field, value: result[field] });
    }
  }
  try {
    requireNonNegativeG(result.operatingProfitG === undefined ? 0 : Math.abs(result.operatingProfitG), "operatingProfitG");
  } catch {
    return failure("INVALID_DAY_RESULT_AMOUNT", { field: "operatingProfitG" });
  }
  if (!Number.isSafeInteger(result.operatingProfitG)) {
    return failure("INVALID_DAY_RESULT_AMOUNT", { field: "operatingProfitG" });
  }
  if (!Number.isSafeInteger(result.netCashChangeG)) {
    return failure("INVALID_DAY_RESULT_AMOUNT", { field: "netCashChangeG" });
  }
  if (!validQuantity(result.soldQuantity)) {
    return failure("INVALID_DAY_RESULT_QUANTITY", { field: "soldQuantity" });
  }
  if (!isPlainRecord(result.quantitySummary)) {
    return failure("INVALID_DAY_RESULT_QUANTITY", { field: "quantitySummary" });
  }
  for (const field of QUANTITY_SUMMARY_FIELDS) {
    if (!validQuantity(result.quantitySummary[field])) {
      return failure("INVALID_DAY_RESULT_QUANTITY", { field: `quantitySummary.${field}` });
    }
  }
  if (!Array.isArray(result.endingInventory) || result.endingInventory.some((line) =>
    !isStableIdentifier(line?.ingredientId) || !validQuantity(line?.quantity) ||
    !Number.isSafeInteger(line?.bookCostG) || line.bookCostG < 0)) {
    return failure("INVALID_DAY_RESULT_QUANTITY", { field: "endingInventory" });
  }
  if (!Number.isSafeInteger(result.reputationDelta)) {
    return failure("INVALID_DAY_RESULT_AMOUNT", { field: "reputationDelta" });
  }
  if (!Array.isArray(result.reputationCauses) || result.reputationCauses.some((cause) =>
    !isStableIdentifier(cause?.causeId) || !Number.isSafeInteger(cause?.appliedDelta))) {
    return failure("INVALID_DAY_RESULT_QUANTITY", { field: "reputationCauses" });
  }
  for (const field of ID_LIST_FIELDS) {
    if (!Array.isArray(result[field]) || result[field].some((id) => !isStableIdentifier(id))) {
      return failure("INVALID_DAY_RESULT_QUANTITY", { field });
    }
  }
  if (!isPlainRecord(result.reconciliation) ||
      result.reconciliation.cash !== "PASS" || result.reconciliation.inventory !== "PASS") {
    return failure("INVALID_DAY_RESULT_RECONCILIATION", { field: "reconciliation" });
  }
  return validationSuccess();
}

export function createCanonicalDayResult(input) {
  const result = {
    resultId: input?.resultId,
    day: input?.day,
    revenueG: input?.revenueG,
    soldQuantity: input?.soldQuantity,
    quantitySummary: { ...input?.quantitySummary },
    cogsG: input?.cogsG,
    cookingWasteExpenseG: input?.cookingWasteExpenseG,
    fixedCostIncurredG: input?.fixedCostIncurredG,
    staffWageExpenseG: input?.staffWageExpenseG,
    contractFailureLossG: input?.contractFailureLossG,
    operatingProfitG: input?.operatingProfitG,
    netCashChangeG: input?.netCashChangeG,
    operatingCashInflowG: input?.operatingCashInflowG,
    operatingCashOutflowG: input?.operatingCashOutflowG,
    investingCashOutflowG: input?.investingCashOutflowG,
    investmentG: input?.investmentG,
    financingCashOutflowG: input?.financingCashOutflowG,
    debtPaymentG: input?.debtPaymentG,
    endingCashG: input?.endingCashG,
    endingArrearsG: input?.endingArrearsG,
    endingInventoryBookCostG: input?.endingInventoryBookCostG,
    endingInventory: [...(input?.endingInventory ?? [])],
    endingPrepaidAssetG: input?.endingPrepaidAssetG,
    reputationDelta: input?.reputationDelta,
    reputationCauses: [...(input?.reputationCauses ?? [])],
    transactionIds: [...(input?.transactionIds ?? [])],
    orderIds: [...(input?.orderIds ?? [])],
    costMovementIds: [...(input?.costMovementIds ?? [])],
    reconciliation: { ...input?.reconciliation },
  };
  const validation = validateCanonicalDayResult(result);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 Canonical_Day_Result입니다: ${validation.code}`);
    error.code = validation.code;
    error.details = validation.details;
    throw error;
  }
  return freezeDeep(result);
}
