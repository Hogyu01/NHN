import { checkedAddG, requireNonNegativeG, requirePositiveG, sumG } from "../core/money.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import { COOK_JUDGMENT } from "./timing-cook.js";

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_SALES_STATE: "Sales 상태 형식이 올바르지 않습니다.",
  INVALID_SALE_RECORD: "판매 기록 형식이 올바르지 않습니다.",
  INVALID_SALE_IDENTIFIER: "판매 기록 ID가 올바르지 않습니다.",
  INVALID_SALE_DAY: "판매 기록 day가 올바르지 않습니다.",
  INVALID_SALE_AMOUNT: "판매 금액이 올바르지 않습니다.",
  INVALID_SALE_QUALITY: "판매 dish Quality가 올바르지 않습니다.",
  DUPLICATE_SALE_ID: "판매 ID가 이미 처리되었습니다.",
  SALES_TOTAL_MISMATCH: "판매 집계와 append-only 기록 합계가 일치하지 않습니다.",
  SALES_HISTORY_MUTATED: "기존 판매 기록은 변경할 수 없습니다.",
  SALES_OVERFLOW: "판매 집계가 safe integer 범위를 초과했습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "Sales 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
}

function success(plan) {
  return Object.freeze({ ok: true, plan: freezeDeep(plan) });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function equivalent(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equivalent(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equivalent(left[key], right[key]));
  }
  return false;
}

export function validateSaleRecord(record) {
  if (!isPlainRecord(record)) return failure("INVALID_SALE_RECORD");
  for (const field of [
    "saleId", "transactionId", "cogsMovementId", "causeId", "orderId", "guestId",
    "recipeId", "dishId", "saleSlotId",
  ]) {
    if (!isStableIdentifier(record[field])) {
      return failure("INVALID_SALE_IDENTIFIER", { field, value: record[field] });
    }
  }
  if (record.saleId !== record.transactionId) {
    return failure("INVALID_SALE_IDENTIFIER", {
      field: "transactionId",
      saleId: record.saleId,
      transactionId: record.transactionId,
    });
  }
  if (!Number.isSafeInteger(record.day) || record.day < 1 || record.day > 14) {
    return failure("INVALID_SALE_DAY", { day: record.day });
  }
  try {
    requirePositiveG(record.priceG, "priceG");
    requireNonNegativeG(record.bookCostG, "bookCostG");
  } catch {
    return failure("INVALID_SALE_AMOUNT", { priceG: record.priceG, bookCostG: record.bookCostG });
  }
  if (!Number.isSafeInteger(record.quality) || record.quality < 0 || record.quality > 100) {
    return failure("INVALID_SALE_QUALITY", { quality: record.quality });
  }
  if (![COOK_JUDGMENT.SUCCESS, COOK_JUDGMENT.NORMAL].includes(record.cookJudgment)) {
    return failure("INVALID_SALE_RECORD", { field: "cookJudgment", value: record.cookJudgment });
  }
  if (!Number.isSafeInteger(record.reputationDelta) ||
      !Number.isSafeInteger(record.committedAtMs) || record.committedAtMs < 0) {
    return failure("INVALID_SALE_RECORD", {
      reputationDelta: record.reputationDelta,
      committedAtMs: record.committedAtMs,
    });
  }
  return validationSuccess();
}

export function validateSalesState(state) {
  if (!isPlainRecord(state) || !Number.isSafeInteger(state.day) || state.day < 1 || state.day > 14 ||
      !Array.isArray(state.sales) || !Array.isArray(state.processedSaleIds) ||
      !Number.isSafeInteger(state.soldQuantity) || state.soldQuantity < 0) {
    return failure("INVALID_SALES_STATE");
  }
  try {
    requireNonNegativeG(state.revenueG, "revenueG");
  } catch {
    return failure("INVALID_SALES_STATE", { revenueG: state.revenueG });
  }
  if (state.sales.length !== state.processedSaleIds.length || state.soldQuantity !== state.sales.length) {
    return failure("SALES_TOTAL_MISMATCH", {
      saleCount: state.sales.length,
      processedCount: state.processedSaleIds.length,
      soldQuantity: state.soldQuantity,
    });
  }
  const ids = new Set();
  for (let index = 0; index < state.sales.length; index += 1) {
    const validation = validateSaleRecord(state.sales[index]);
    if (!validation.ok) return failure(validation.code, { index, ...validation.details });
    const saleId = state.sales[index].saleId;
    if (ids.has(saleId) || state.processedSaleIds[index] !== saleId) {
      return failure("DUPLICATE_SALE_ID", { saleId, index });
    }
    if (state.sales[index].day !== state.day) {
      return failure("INVALID_SALE_DAY", { stateDay: state.day, saleDay: state.sales[index].day });
    }
    ids.add(saleId);
  }
  try {
    const revenueG = sumG(state.sales.map((sale) => sale.priceG), "sales revenue");
    if (revenueG !== state.revenueG) {
      return failure("SALES_TOTAL_MISMATCH", { expectedRevenueG: revenueG, actualRevenueG: state.revenueG });
    }
  } catch {
    return failure("SALES_OVERFLOW");
  }
  return validationSuccess({ soldQuantity: state.soldQuantity, revenueG: state.revenueG });
}

export function createSalesState({
  day,
  revenueG = 0,
  soldQuantity = 0,
  sales = [],
  processedSaleIds = sales.map((sale) => sale.saleId),
} = {}) {
  const state = {
    day,
    revenueG,
    soldQuantity,
    sales: cloneValue(sales),
    processedSaleIds: [...processedSaleIds],
  };
  const validation = validateSalesState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 SalesState입니다: ${validation.code}`);
    error.code = validation.code;
    error.details = validation.details;
    throw error;
  }
  return freezeDeep(state);
}

export function applySaleRecordToDraft(salesDraft, recordInput) {
  const before = validateSalesState(salesDraft);
  if (!before.ok) return before;
  const record = cloneValue(recordInput);
  const recordValidation = validateSaleRecord(record);
  if (!recordValidation.ok) return recordValidation;
  if (record.day !== salesDraft.day) {
    return failure("INVALID_SALE_DAY", { stateDay: salesDraft.day, saleDay: record.day });
  }
  if (salesDraft.processedSaleIds.includes(record.saleId)) {
    return failure("DUPLICATE_SALE_ID", { saleId: record.saleId });
  }
  try {
    salesDraft.revenueG = checkedAddG(salesDraft.revenueG, record.priceG, "Revenue");
    if (salesDraft.soldQuantity === Number.MAX_SAFE_INTEGER) throw new RangeError("sold quantity overflow");
    salesDraft.soldQuantity += 1;
  } catch {
    return failure("SALES_OVERFLOW");
  }
  salesDraft.sales.push(record);
  salesDraft.processedSaleIds.push(record.saleId);
  const after = validateSalesState(salesDraft);
  return after.ok ? success({ sale: record }) : after;
}

export function validateSalesAppendOnly(before, after) {
  const beforeValidation = validateSalesState(before);
  if (!beforeValidation.ok) return beforeValidation;
  const afterValidation = validateSalesState(after);
  if (!afterValidation.ok) return afterValidation;
  if (after.sales.length < before.sales.length) return failure("SALES_HISTORY_MUTATED");
  for (let index = 0; index < before.sales.length; index += 1) {
    if (!equivalent(before.sales[index], after.sales[index]) ||
        before.processedSaleIds[index] !== after.processedSaleIds[index]) {
      return failure("SALES_HISTORY_MUTATED", { index });
    }
  }
  return validationSuccess({ appendedCount: after.sales.length - before.sales.length });
}

export function projectSales(state) {
  const validation = validateSalesState(state);
  if (!validation.ok) {
    const error = new TypeError(`Sales projection이 유효하지 않습니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep({
    day: state.day,
    revenueG: state.revenueG,
    soldQuantity: state.soldQuantity,
    sales: cloneValue(state.sales),
  });
}
