import { freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import {
  checkedAddG,
  checkedSubtractG,
  requireNonNegativeG,
  requirePositiveG,
  requireSafeIntegerG,
} from "../core/money.js";

export const LEDGER_CATEGORY = Object.freeze({
  SALE: "SALE",
  MARKET: "MARKET",
  CONTRACT_PREPAID: "CONTRACT_PREPAID",
  CONTRACT_BALANCE: "CONTRACT_BALANCE",
  STAFF_WAGE: "STAFF_WAGE",
  FIXED_COST: "FIXED_COST",
  ARREARS_PAYMENT: "ARREARS_PAYMENT",
  FACILITY_INVESTMENT: "FACILITY_INVESTMENT",
  DEBT_PRINCIPAL: "DEBT_PRINCIPAL",
});

export const LEDGER_DIRECTION = Object.freeze({
  INFLOW: "INFLOW",
  OUTFLOW: "OUTFLOW",
});

export const LEDGER_TYPE = Object.freeze({
  SALE_REVENUE: "SALE_REVENUE",
  MARKET_PURCHASE: "MARKET_PURCHASE",
  CONTRACT_PREPAID_PAYMENT: "CONTRACT_PREPAID_PAYMENT",
  CONTRACT_BALANCE_PAYMENT: "CONTRACT_BALANCE_PAYMENT",
  STAFF_WAGE_PAYMENT: "STAFF_WAGE_PAYMENT",
  FIXED_COST_PAYMENT: "FIXED_COST_PAYMENT",
  ARREARS_PAYMENT: "ARREARS_PAYMENT",
  FACILITY_INVESTMENT: "FACILITY_INVESTMENT",
  DEBT_PRINCIPAL_PAYMENT: "DEBT_PRINCIPAL_PAYMENT",
});

export const LEDGER_CATEGORY_POLICY = freezeDeep({
  [LEDGER_CATEGORY.SALE]: {
    type: LEDGER_TYPE.SALE_REVENUE,
    direction: LEDGER_DIRECTION.INFLOW,
    phases: ["SERVICE"],
  },
  [LEDGER_CATEGORY.MARKET]: {
    type: LEDGER_TYPE.MARKET_PURCHASE,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["PLANNING"],
  },
  [LEDGER_CATEGORY.CONTRACT_PREPAID]: {
    type: LEDGER_TYPE.CONTRACT_PREPAID_PAYMENT,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["PLANNING"],
  },
  [LEDGER_CATEGORY.CONTRACT_BALANCE]: {
    type: LEDGER_TYPE.CONTRACT_BALANCE_PAYMENT,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["PLANNING"],
  },
  [LEDGER_CATEGORY.STAFF_WAGE]: {
    type: LEDGER_TYPE.STAFF_WAGE_PAYMENT,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["SETTLEMENT"],
  },
  [LEDGER_CATEGORY.FIXED_COST]: {
    type: LEDGER_TYPE.FIXED_COST_PAYMENT,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["SETTLEMENT"],
  },
  [LEDGER_CATEGORY.ARREARS_PAYMENT]: {
    type: LEDGER_TYPE.ARREARS_PAYMENT,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["PLANNING"],
  },
  [LEDGER_CATEGORY.FACILITY_INVESTMENT]: {
    type: LEDGER_TYPE.FACILITY_INVESTMENT,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["PLANNING"],
  },
  [LEDGER_CATEGORY.DEBT_PRINCIPAL]: {
    type: LEDGER_TYPE.DEBT_PRINCIPAL_PAYMENT,
    direction: LEDGER_DIRECTION.OUTFLOW,
    phases: ["PLANNING"],
  },
});

const ENTRY_FIELDS = Object.freeze([
  "transactionId",
  "day",
  "category",
  "type",
  "direction",
  "amountG",
  "causeId",
]);

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function ledgerEntryEquals(left, right) {
  return ENTRY_FIELDS.every((field) => left?.[field] === right?.[field]);
}

export function getLedgerPolicy(category) {
  return LEDGER_CATEGORY_POLICY[category] ?? null;
}

export function validateLedgerEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return failure("INVALID_LEDGER_ENTRY", { field: "$", expected: "object" });
  }
  for (const field of ENTRY_FIELDS) {
    if (!own(entry, field)) return failure("MISSING_LEDGER_FIELD", { field });
  }
  if (!isStableIdentifier(entry.transactionId)) {
    return failure("INVALID_TRANSACTION_ID", { field: "transactionId" });
  }
  if (!Number.isSafeInteger(entry.day) || entry.day < 1 || entry.day > 14) {
    return failure("INVALID_LEDGER_DAY", { field: "day", value: entry.day });
  }
  const policy = getLedgerPolicy(entry.category);
  if (!policy) return failure("INVALID_LEDGER_CATEGORY", { category: entry.category });
  if (entry.type !== policy.type) {
    return failure("LEDGER_TYPE_MISMATCH", { category: entry.category, expected: policy.type, actual: entry.type });
  }
  if (entry.direction !== policy.direction) {
    return failure("LEDGER_DIRECTION_MISMATCH", {
      category: entry.category,
      expected: policy.direction,
      actual: entry.direction,
    });
  }
  try {
    requirePositiveG(entry.amountG, "amountG");
  } catch {
    return failure("INVALID_TRANSACTION_AMOUNT", { field: "amountG", value: entry.amountG });
  }
  if (!isStableIdentifier(entry.causeId)) {
    return failure("INVALID_CAUSE_ID", { field: "causeId" });
  }
  return validationSuccess();
}

export function createLedgerEntry(input) {
  const entry = {
    transactionId: input?.transactionId,
    day: input?.day,
    category: input?.category,
    type: input?.type,
    direction: input?.direction,
    amountG: input?.amountG,
    causeId: input?.causeId,
  };
  const validation = validateLedgerEntry(entry);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 EconomyLedger entry입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(entry);
}

export function validateEconomyLedger(ledger, processedTransactionIds) {
  if (!Array.isArray(ledger)) return failure("INVALID_LEDGER_COLLECTION", { field: "ledger" });
  if (!Array.isArray(processedTransactionIds)) {
    return failure("INVALID_TRANSACTION_INDEX", { field: "processedTransactionIds" });
  }

  const seen = new Set();
  for (let index = 0; index < ledger.length; index += 1) {
    const entryValidation = validateLedgerEntry(ledger[index]);
    if (!entryValidation.ok) {
      return failure(entryValidation.code, { ledgerIndex: index, ...entryValidation.details });
    }
    const transactionId = ledger[index].transactionId;
    if (seen.has(transactionId)) {
      return failure("DUPLICATE_TRANSACTION_ID", { transactionId, ledgerIndex: index });
    }
    seen.add(transactionId);
  }

  if (processedTransactionIds.length !== ledger.length) {
    return failure("TRANSACTION_INDEX_LENGTH_MISMATCH", {
      ledgerLength: ledger.length,
      indexLength: processedTransactionIds.length,
    });
  }
  const processedSeen = new Set();
  for (let index = 0; index < processedTransactionIds.length; index += 1) {
    const transactionId = processedTransactionIds[index];
    if (!isStableIdentifier(transactionId)) {
      return failure("INVALID_TRANSACTION_ID", { field: `processedTransactionIds[${index}]` });
    }
    if (processedSeen.has(transactionId)) {
      return failure("DUPLICATE_TRANSACTION_ID", { transactionId, index });
    }
    processedSeen.add(transactionId);
    if (ledger[index]?.transactionId !== transactionId) {
      return failure("TRANSACTION_INDEX_ORDER_MISMATCH", {
        index,
        expected: ledger[index]?.transactionId,
        actual: transactionId,
      });
    }
  }
  return validationSuccess();
}

export function hasLedgerTransaction(economy, transactionId) {
  return Array.isArray(economy?.processedTransactionIds) &&
    economy.processedTransactionIds.includes(transactionId);
}

/** Returns new append-only collections without mutating the source arrays. */
export function planLedgerAppend(economy, entryInput) {
  const current = validateEconomyLedger(economy?.ledger, economy?.processedTransactionIds);
  if (!current.ok) return current;

  let entry;
  try {
    entry = createLedgerEntry(entryInput);
  } catch (error) {
    return failure(error?.code ?? "INVALID_LEDGER_ENTRY");
  }
  if (hasLedgerTransaction(economy, entry.transactionId)) {
    return failure("DUPLICATE_TRANSACTION_ID", { transactionId: entry.transactionId });
  }
  return Object.freeze({
    ok: true,
    entry,
    ledger: Object.freeze([...economy.ledger, entry]),
    processedTransactionIds: Object.freeze([...economy.processedTransactionIds, entry.transactionId]),
  });
}

export function validateLedgerAppendOnly(beforeLedger, afterLedger) {
  if (!Array.isArray(beforeLedger) || !Array.isArray(afterLedger)) {
    return failure("INVALID_LEDGER_COLLECTION");
  }
  if (afterLedger.length < beforeLedger.length) {
    return failure("LEDGER_ENTRY_REMOVED", { before: beforeLedger.length, after: afterLedger.length });
  }
  for (let index = 0; index < beforeLedger.length; index += 1) {
    if (!ledgerEntryEquals(beforeLedger[index], afterLedger[index])) {
      return failure("LEDGER_HISTORY_MUTATED", { ledgerIndex: index });
    }
  }
  return validationSuccess({ appendedCount: afterLedger.length - beforeLedger.length });
}

export function summarizeLedger(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries는 배열이어야 합니다.");
  let inflowG = 0;
  let outflowG = 0;
  const byCategory = Object.create(null);
  const byType = Object.create(null);
  const byDay = Object.create(null);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const valid = validateLedgerEntry(entry);
    if (!valid.ok) throw new TypeError(`유효하지 않은 ledger entry입니다: ${valid.code}`);
    if (entry.direction === LEDGER_DIRECTION.INFLOW) {
      inflowG = checkedAddG(inflowG, entry.amountG, "ledger inflow total");
    } else {
      outflowG = checkedAddG(outflowG, entry.amountG, "ledger outflow total");
    }
    byCategory[entry.category] = checkedAddG(byCategory[entry.category] ?? 0, entry.amountG, "category total");
    byType[entry.type] = checkedAddG(byType[entry.type] ?? 0, entry.amountG, "type total");
    byDay[entry.day] = checkedAddG(byDay[entry.day] ?? 0, entry.amountG, "day total");
  }

  return freezeDeep({ inflowG, outflowG, netCashChangeG: checkedSubtractG(inflowG, outflowG), byCategory, byType, byDay });
}

export function reconcileCashWithLedger(beginningCashG, endingCashG, entries) {
  try {
    requireNonNegativeG(beginningCashG, "beginningCashG");
    requireNonNegativeG(endingCashG, "endingCashG");
    const summary = summarizeLedger(entries);
    const expectedEndingCashG = checkedSubtractG(
      checkedAddG(beginningCashG, summary.inflowG, "cash reconciliation inflow"),
      summary.outflowG,
      "cash reconciliation outflow",
    );
    return freezeDeep({
      ok: expectedEndingCashG === endingCashG,
      code: expectedEndingCashG === endingCashG ? "CASH_RECONCILIATION_PASS" : "CASH_RECONCILIATION_FAILED",
      beginningCashG,
      inflowG: summary.inflowG,
      outflowG: summary.outflowG,
      expectedEndingCashG,
      actualEndingCashG: endingCashG,
      deltaG: checkedSubtractG(endingCashG, expectedEndingCashG, "cash reconciliation delta"),
    });
  } catch (error) {
    return freezeDeep({
      ok: false,
      code: "CASH_RECONCILIATION_OVERFLOW",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildLedgerDrillDownIndex(ledger) {
  const validation = validateEconomyLedger(ledger, ledger.map((entry) => entry.transactionId));
  if (!validation.ok) throw new TypeError(`ledger index를 만들 수 없습니다: ${validation.code}`);

  const byTransactionId = Object.create(null);
  const byCauseId = Object.create(null);
  const byCategory = Object.create(null);
  const byType = Object.create(null);
  const byDay = Object.create(null);
  ledger.forEach((entry, ledgerIndex) => {
    const projection = freezeDeep({ ledgerIndex, ...entry });
    byTransactionId[entry.transactionId] = projection;
    (byCauseId[entry.causeId] ??= []).push(projection);
    (byCategory[entry.category] ??= []).push(projection);
    (byType[entry.type] ??= []).push(projection);
    (byDay[entry.day] ??= []).push(projection);
  });
  return freezeDeep({ byTransactionId, byCauseId, byCategory, byType, byDay });
}

export function projectEconomyLedger(economy, { day = null, category = null, type = null } = {}) {
  const validation = validateEconomyLedger(economy?.ledger, economy?.processedTransactionIds);
  if (!validation.ok) throw new TypeError(`EconomyLedger projection이 유효하지 않습니다: ${validation.code}`);
  if (day !== null) requireSafeIntegerG(day, "day", { minimum: 1, maximum: 14 });
  if (category !== null && !getLedgerPolicy(category)) throw new TypeError("알 수 없는 ledger category입니다.");
  if (type !== null && !Object.values(LEDGER_TYPE).includes(type)) throw new TypeError("알 수 없는 ledger type입니다.");

  const entries = economy.ledger.filter((entry) =>
    (day === null || entry.day === day) &&
    (category === null || entry.category === category) &&
    (type === null || entry.type === type));
  return freezeDeep({
    entries: entries.map((entry, ledgerIndex) => ({ ledgerIndex, ...entry })),
    summary: summarizeLedger(entries),
    drillDown: buildLedgerDrillDownIndex(economy.ledger),
  });
}
