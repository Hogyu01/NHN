import { freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import {
  checkedSubtractG,
  requireNonNegativeG,
} from "../core/money.js";
import {
  projectEconomyLedger,
  validateEconomyLedger,
  validateLedgerAppendOnly,
} from "./economy-ledger.js";

const ECONOMY_MONEY_FIELDS = Object.freeze([
  "cashG",
  "contractReserveG",
  "debtG",
  "arrearsG",
  "contractPrepaidAssetG",
]);

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function sameValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
  }
  return false;
}

export function createEconomyState({
  cashG = 0,
  contractReserveG = 0,
  debtG = 0,
  arrearsG = 0,
  contractPrepaidAssetG = 0,
  ledger = [],
  processedTransactionIds = ledger.map((entry) => entry.transactionId),
} = {}) {
  const state = {
    cashG,
    contractReserveG,
    debtG,
    arrearsG,
    contractPrepaidAssetG,
    ledger: [...ledger],
    processedTransactionIds: [...processedTransactionIds],
  };
  const validation = validateEconomyState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 EconomyState입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(state);
}

export function validateEconomyState(economy) {
  if (!economy || typeof economy !== "object" || Array.isArray(economy)) {
    return failure("INVALID_ECONOMY_STATE", { field: "$" });
  }
  for (const field of ECONOMY_MONEY_FIELDS) {
    try {
      requireNonNegativeG(economy[field], field);
    } catch {
      return failure("INVALID_ECONOMY_MONEY", { field, value: economy[field] });
    }
  }
  if (economy.contractReserveG > economy.cashG) {
    return failure("CONTRACT_RESERVE_EXCEEDS_CASH", {
      cashG: economy.cashG,
      contractReserveG: economy.contractReserveG,
    });
  }
  const ledgerValidation = validateEconomyLedger(economy.ledger, economy.processedTransactionIds);
  if (!ledgerValidation.ok) return ledgerValidation;
  return validationSuccess({ availableCashG: economy.cashG - economy.contractReserveG });
}

export function calculateAvailableCashG(economy) {
  const validation = validateEconomyState(economy);
  if (!validation.ok) {
    const error = new TypeError(`Available_Cash를 계산할 수 없습니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return checkedSubtractG(economy.cashG, economy.contractReserveG, "Available_Cash");
}

export function validateCampaignArrearsState(campaign) {
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
    return failure("INVALID_CAMPAIGN_STATE", { field: "$" });
  }
  if (!Number.isSafeInteger(campaign.consecutiveArrearsCount) || campaign.consecutiveArrearsCount < 0) {
    return failure("INVALID_CONSECUTIVE_ARREARS_COUNT", {
      value: campaign.consecutiveArrearsCount,
    });
  }
  return validationSuccess();
}

/** Validates immutable history and all derived money invariants across an economy transition. */
export function validateEconomyTransition(before, after) {
  const beforeValidation = validateEconomyState(before);
  if (!beforeValidation.ok) return failure("INVALID_ECONOMY_BEFORE", { cause: beforeValidation.code });
  const afterValidation = validateEconomyState(after);
  if (!afterValidation.ok) return failure("INVALID_ECONOMY_AFTER", { cause: afterValidation.code });

  const appendOnly = validateLedgerAppendOnly(before.ledger, after.ledger);
  if (!appendOnly.ok) return appendOnly;
  if (after.processedTransactionIds.length < before.processedTransactionIds.length) {
    return failure("TRANSACTION_INDEX_ENTRY_REMOVED");
  }
  for (let index = 0; index < before.processedTransactionIds.length; index += 1) {
    if (after.processedTransactionIds[index] !== before.processedTransactionIds[index]) {
      return failure("TRANSACTION_INDEX_HISTORY_MUTATED", { index });
    }
  }
  return validationSuccess({ appendedCount: after.ledger.length - before.ledger.length });
}

export function validateUnchangedEconomyFields(before, after, allowedFields) {
  const allowed = new Set(allowedFields);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!allowed.has(key) && !sameValue(before[key], after[key])) {
      return failure("UNDECLARED_ECONOMY_CHANGE", { field: key });
    }
  }
  return validationSuccess();
}

/** Read-only UI/query projection. Available_Cash and control guards are never persisted. */
export function projectEconomy(economy, runtimePhase) {
  const validation = validateEconomyState(economy);
  if (!validation.ok) throw new TypeError(`Economy projection이 유효하지 않습니다: ${validation.code}`);
  if (typeof runtimePhase !== "string" || runtimePhase.trim() === "") {
    throw new TypeError("runtimePhase가 필요합니다.");
  }

  const availableCashG = calculateAvailableCashG(economy);
  const planning = runtimePhase === "PLANNING";
  const arrearsMaximumG = planning ? Math.min(availableCashG, economy.arrearsG) : 0;
  const debtMaximumG = planning && economy.arrearsG === 0
    ? Math.min(availableCashG, economy.debtG)
    : 0;
  const arrearsDisabledReason = !planning
    ? "ARREARS_PAYMENT_REQUIRES_PLANNING"
    : economy.arrearsG <= 0
      ? "NO_ARREARS"
      : availableCashG <= 0
        ? "NO_AVAILABLE_CASH"
        : null;
  const debtDisabledReason = !planning
    ? "DEBT_PAYMENT_REQUIRES_PLANNING"
    : economy.arrearsG > 0
      ? "ARREARS_DEBT_PRINCIPAL_BLOCKED"
      : economy.debtG <= 0
        ? "NO_DEBT_PRINCIPAL"
        : availableCashG <= 0
          ? "NO_AVAILABLE_CASH"
          : null;

  return freezeDeep({
    cashG: economy.cashG,
    contractReserveG: economy.contractReserveG,
    availableCashG,
    debtG: economy.debtG,
    arrearsG: economy.arrearsG,
    contractPrepaidAssetG: economy.contractPrepaidAssetG,
    controls: {
      arrearsPayment: {
        enabled: arrearsDisabledReason === null,
        maximumG: arrearsMaximumG,
        disabledReason: arrearsDisabledReason,
      },
      debtPrincipalPayment: {
        enabled: debtDisabledReason === null,
        maximumG: debtMaximumG,
        disabledReason: debtDisabledReason,
      },
    },
    ledger: projectEconomyLedger(economy),
  });
}
