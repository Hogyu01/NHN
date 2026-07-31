import { checkedAddG, checkedSubtractG, requirePositiveG } from "../core/money.js";
import { freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier, defineAtomicTransaction } from "../core/transaction.js";
import {
  calculateAvailableCashG,
  validateCampaignArrearsState,
  validateEconomyState,
  validateEconomyTransition,
  validateUnchangedEconomyFields,
} from "./economy.js";
import {
  getLedgerPolicy,
  LEDGER_CATEGORY,
  LEDGER_CATEGORY_POLICY,
  LEDGER_DIRECTION,
  LEDGER_TYPE,
  planLedgerAppend,
  reconcileCashWithLedger,
} from "./economy-ledger.js";

export const CASH_TRANSACTION_COMMAND = Object.freeze({
  APPLY: "economy.cash.apply",
  PAY_ARREARS: "economy.arrears.pay",
  REPAY_DEBT_PRINCIPAL: "economy.debt.repay-principal",
});

export const CONTRACT_RESERVE_OPERATION = Object.freeze({
  RESERVE: "RESERVE",
  RELEASE: "RELEASE",
});

const GENERIC_WRITE_SET = Object.freeze(["economy"]);
const ARREARS_WRITE_SET = Object.freeze(["economy", "campaign"]);
const DEBT_WRITE_SET = Object.freeze(["economy"]);
const NO_READ_SET = Object.freeze([]);
const CASH_PHASES = Object.freeze(["PLANNING", "SERVICE", "SETTLEMENT"]);
const SPECIAL_CATEGORIES = new Set([
  LEDGER_CATEGORY.ARREARS_PAYMENT,
  LEDGER_CATEGORY.DEBT_PRINCIPAL,
]);

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function planSuccess(plan) {
  return Object.freeze({ ok: true, plan: freezeDeep(plan) });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateBaseTransactionRequest(request) {
  if (!isPlainRecord(request)) return failure("INVALID_CASH_TRANSACTION", { field: "$" });
  if (!isStableIdentifier(request.transactionId)) {
    return failure("INVALID_TRANSACTION_ID", { field: "transactionId" });
  }
  if (!Number.isSafeInteger(request.day) || request.day < 1 || request.day > 14) {
    return failure("INVALID_TRANSACTION_DAY", { field: "day", value: request.day });
  }
  const policy = getLedgerPolicy(request.category);
  if (!policy) return failure("INVALID_TRANSACTION_CATEGORY", { category: request.category });
  if (request.type !== policy.type) {
    return failure("LEDGER_TYPE_MISMATCH", { category: request.category, expected: policy.type, actual: request.type });
  }
  if (request.direction !== policy.direction) {
    return failure("LEDGER_DIRECTION_MISMATCH", {
      category: request.category,
      expected: policy.direction,
      actual: request.direction,
    });
  }
  try {
    requirePositiveG(request.amountG, "amountG");
  } catch {
    return failure("INVALID_TRANSACTION_AMOUNT", { field: "amountG", value: request.amountG });
  }
  if (!isStableIdentifier(request.causeId)) return failure("INVALID_CAUSE_ID", { field: "causeId" });
  return validationSuccess();
}

export function validateCashTransactionRequest(request, { allowSpecial = false } = {}) {
  const base = validateBaseTransactionRequest(request);
  if (!base.ok) return base;
  if (!allowSpecial && SPECIAL_CATEGORIES.has(request.category)) {
    return failure("SPECIAL_TRANSACTION_COMMAND_REQUIRED", { category: request.category });
  }
  return validationSuccess();
}

function validateEconomyForCommand(economy) {
  const validation = validateEconomyState(economy);
  return validation.ok ? validation : failure("ECONOMY_STATE_INVALID", { cause: validation.code });
}

function validateCategoryPhase(category, runtimePhase) {
  const policy = getLedgerPolicy(category);
  if (!policy?.phases.includes(runtimePhase)) {
    return failure("ILLEGAL_CASH_TRANSACTION_PHASE", {
      category,
      actual: runtimePhase,
      allowed: policy?.phases ?? [],
    });
  }
  return validationSuccess();
}

function calculateCashPlan(economy, request) {
  const availableCashG = calculateAvailableCashG(economy);
  if (request.direction === LEDGER_DIRECTION.INFLOW) {
    try {
      return planSuccess({
        cashG: checkedAddG(economy.cashG, request.amountG, "cash inflow"),
        contractReserveG: economy.contractReserveG,
      });
    } catch {
      return failure("CASH_OVERFLOW", { cashG: economy.cashG, amountG: request.amountG });
    }
  }

  if (request.category === LEDGER_CATEGORY.CONTRACT_BALANCE) {
    if (request.amountG > economy.contractReserveG) {
      return failure("INSUFFICIENT_CONTRACT_RESERVE", {
        amountG: request.amountG,
        contractReserveG: economy.contractReserveG,
      });
    }
    try {
      return planSuccess({
        cashG: checkedSubtractG(economy.cashG, request.amountG, "contract balance cash"),
        contractReserveG: checkedSubtractG(
          economy.contractReserveG,
          request.amountG,
          "contract reserve balance",
        ),
      });
    } catch {
      return failure("CASH_UNDERFLOW", { cashG: economy.cashG, amountG: request.amountG });
    }
  }

  if (request.amountG > availableCashG) {
    return failure("INSUFFICIENT_AVAILABLE_CASH", { amountG: request.amountG, availableCashG });
  }
  try {
    return planSuccess({
      cashG: checkedSubtractG(economy.cashG, request.amountG, "cash outflow"),
      contractReserveG: economy.contractReserveG,
    });
  } catch {
    return failure("CASH_UNDERFLOW", { cashG: economy.cashG, amountG: request.amountG });
  }
}

function buildLedgerCashPlan(economy, request, runtimePhase) {
  const stateValidation = validateEconomyForCommand(economy);
  if (!stateValidation.ok) return stateValidation;
  const requestValidation = validateBaseTransactionRequest(request);
  if (!requestValidation.ok) return requestValidation;
  const phaseValidation = validateCategoryPhase(request.category, runtimePhase);
  if (!phaseValidation.ok) return phaseValidation;

  const ledgerAppend = planLedgerAppend(economy, request);
  if (!ledgerAppend.ok) return ledgerAppend;
  const cashPlan = calculateCashPlan(economy, request);
  if (!cashPlan.ok) return cashPlan;

  return planSuccess({
    cashG: cashPlan.plan.cashG,
    contractReserveG: cashPlan.plan.contractReserveG,
    debtG: economy.debtG,
    arrearsG: economy.arrearsG,
    ledger: ledgerAppend.ledger,
    processedTransactionIds: ledgerAppend.processedTransactionIds,
    entry: ledgerAppend.entry,
  });
}

export function planCashTransaction(economy, request, runtimePhase) {
  const requestValidation = validateCashTransactionRequest(request);
  if (!requestValidation.ok) return requestValidation;
  return buildLedgerCashPlan(economy, request, runtimePhase);
}

function applyEconomyPlan(economyDraft, plan) {
  economyDraft.cashG = plan.cashG;
  economyDraft.contractReserveG = plan.contractReserveG;
  economyDraft.debtG = plan.debtG;
  economyDraft.arrearsG = plan.arrearsG;
  economyDraft.ledger = [...plan.ledger];
  economyDraft.processedTransactionIds = [...plan.processedTransactionIds];
}

/**
 * The only low-level cash mutation function. It fully plans and validates before assigning any
 * field, so callers inside an AtomicTransaction never observe a partial cash/ledger write.
 */
export function applyCashTransactionToDraft(economyDraft, request, runtimePhase) {
  const planned = planCashTransaction(economyDraft, request, runtimePhase);
  if (!planned.ok) return planned;
  applyEconomyPlan(economyDraft, planned.plan);
  return planned;
}

function specialTransactionRequest(payload, category) {
  const policy = getLedgerPolicy(category);
  return {
    transactionId: payload?.transactionId,
    day: payload?.day,
    category,
    type: policy.type,
    direction: policy.direction,
    amountG: payload?.amountG,
    causeId: payload?.causeId,
  };
}

export function validateSpecialPaymentPayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_CASH_TRANSACTION", { field: "$" });
  const required = ["transactionId", "day", "amountG", "causeId"];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      return failure("MISSING_TRANSACTION_FIELD", { field });
    }
  }
  if (!isStableIdentifier(payload.transactionId)) return failure("INVALID_TRANSACTION_ID");
  if (!Number.isSafeInteger(payload.day) || payload.day < 1 || payload.day > 14) {
    return failure("INVALID_TRANSACTION_DAY", { value: payload.day });
  }
  try {
    requirePositiveG(payload.amountG, "amountG");
  } catch {
    return failure("INVALID_TRANSACTION_AMOUNT", { value: payload.amountG });
  }
  if (!isStableIdentifier(payload.causeId)) return failure("INVALID_CAUSE_ID");
  return validationSuccess();
}

export function planArrearsPayment(economy, campaign, payload, runtimePhase) {
  const payloadValidation = validateSpecialPaymentPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  const stateValidation = validateEconomyForCommand(economy);
  if (!stateValidation.ok) return stateValidation;
  const campaignValidation = validateCampaignArrearsState(campaign);
  if (!campaignValidation.ok) return campaignValidation;
  if (runtimePhase !== "PLANNING") {
    return failure("ARREARS_PAYMENT_REQUIRES_PLANNING", { actual: runtimePhase });
  }
  if (economy.arrearsG <= 0) return failure("NO_ARREARS");

  const availableCashG = calculateAvailableCashG(economy);
  const maximumG = Math.min(availableCashG, economy.arrearsG);
  if (payload.amountG > maximumG) {
    return failure("ARREARS_PAYMENT_EXCEEDS_MAXIMUM", { amountG: payload.amountG, maximumG });
  }

  const request = specialTransactionRequest(payload, LEDGER_CATEGORY.ARREARS_PAYMENT);
  const ledgerAppend = planLedgerAppend(economy, request);
  if (!ledgerAppend.ok) return ledgerAppend;
  try {
    const arrearsG = checkedSubtractG(economy.arrearsG, payload.amountG, "Arrears payment");
    return planSuccess({
      cashG: checkedSubtractG(economy.cashG, payload.amountG, "Arrears cash payment"),
      contractReserveG: economy.contractReserveG,
      debtG: economy.debtG,
      arrearsG,
      ledger: ledgerAppend.ledger,
      processedTransactionIds: ledgerAppend.processedTransactionIds,
      entry: ledgerAppend.entry,
      consecutiveArrearsCount: arrearsG === 0 ? 0 : campaign.consecutiveArrearsCount,
      expenseRecognizedG: 0,
    });
  } catch {
    return failure("ARREARS_PAYMENT_UNDERFLOW");
  }
}

export function applyArrearsPaymentToDraft(economyDraft, campaignDraft, payload, runtimePhase) {
  const planned = planArrearsPayment(economyDraft, campaignDraft, payload, runtimePhase);
  if (!planned.ok) return planned;
  applyEconomyPlan(economyDraft, planned.plan);
  campaignDraft.consecutiveArrearsCount = planned.plan.consecutiveArrearsCount;
  return planned;
}

export function planDebtPrincipalPayment(economy, payload, runtimePhase) {
  const payloadValidation = validateSpecialPaymentPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  const stateValidation = validateEconomyForCommand(economy);
  if (!stateValidation.ok) return stateValidation;
  if (runtimePhase !== "PLANNING") {
    return failure("DEBT_PAYMENT_REQUIRES_PLANNING", { actual: runtimePhase });
  }
  if (economy.arrearsG > 0) {
    return failure("ARREARS_DEBT_PRINCIPAL_BLOCKED", { arrearsG: economy.arrearsG });
  }
  if (economy.debtG <= 0) return failure("NO_DEBT_PRINCIPAL");
  if (payload.amountG > economy.debtG) {
    return failure("DEBT_PAYMENT_EXCEEDS_PRINCIPAL", { amountG: payload.amountG, debtG: economy.debtG });
  }
  const availableCashG = calculateAvailableCashG(economy);
  if (payload.amountG > availableCashG) {
    return failure("INSUFFICIENT_AVAILABLE_CASH", { amountG: payload.amountG, availableCashG });
  }

  const request = specialTransactionRequest(payload, LEDGER_CATEGORY.DEBT_PRINCIPAL);
  const ledgerAppend = planLedgerAppend(economy, request);
  if (!ledgerAppend.ok) return ledgerAppend;
  try {
    return planSuccess({
      cashG: checkedSubtractG(economy.cashG, payload.amountG, "debt principal cash"),
      contractReserveG: economy.contractReserveG,
      debtG: checkedSubtractG(economy.debtG, payload.amountG, "debt principal"),
      arrearsG: economy.arrearsG,
      ledger: ledgerAppend.ledger,
      processedTransactionIds: ledgerAppend.processedTransactionIds,
      entry: ledgerAppend.entry,
    });
  } catch {
    return failure("DEBT_PAYMENT_UNDERFLOW");
  }
}

export function applyDebtPrincipalPaymentToDraft(economyDraft, payload, runtimePhase) {
  const planned = planDebtPrincipalPayment(economyDraft, payload, runtimePhase);
  if (!planned.ok) return planned;
  applyEconomyPlan(economyDraft, planned.plan);
  return planned;
}

/**
 * Contract reserve movement is not a cash flow and therefore never writes EconomyLedger. Contract
 * transactions call this inside their own AtomicTransaction draft beside contract/prepaid state.
 */
export function planContractReserveChange(economy, { operation, amountG } = {}) {
  const stateValidation = validateEconomyForCommand(economy);
  if (!stateValidation.ok) return stateValidation;
  if (!Object.values(CONTRACT_RESERVE_OPERATION).includes(operation)) {
    return failure("INVALID_CONTRACT_RESERVE_OPERATION", { operation });
  }
  try {
    requirePositiveG(amountG, "amountG");
  } catch {
    return failure("INVALID_RESERVE_AMOUNT", { amountG });
  }

  if (operation === CONTRACT_RESERVE_OPERATION.RESERVE) {
    const availableCashG = calculateAvailableCashG(economy);
    if (amountG > availableCashG) {
      return failure("INSUFFICIENT_AVAILABLE_CASH", { amountG, availableCashG });
    }
    try {
      return planSuccess({
        contractReserveG: checkedAddG(economy.contractReserveG, amountG, "contract reserve"),
      });
    } catch {
      return failure("CONTRACT_RESERVE_OVERFLOW");
    }
  }

  if (amountG > economy.contractReserveG) {
    return failure("INSUFFICIENT_CONTRACT_RESERVE", { amountG, contractReserveG: economy.contractReserveG });
  }
  return planSuccess({
    contractReserveG: checkedSubtractG(economy.contractReserveG, amountG, "contract reserve release"),
  });
}

export function applyContractReserveChangeToDraft(economyDraft, request) {
  const planned = planContractReserveChange(economyDraft, request);
  if (!planned.ok) return planned;
  economyDraft.contractReserveG = planned.plan.contractReserveG;
  return planned;
}

function validateLedgerTransactionPostcondition(beforeEconomy, afterEconomy, plan, allowedFields) {
  const transition = validateEconomyTransition(beforeEconomy, afterEconomy);
  if (!transition.ok) return transition;
  if (transition.details?.appendedCount !== 1) {
    return failure("CASH_TRANSACTION_LEDGER_CARDINALITY", { appendedCount: transition.details?.appendedCount });
  }
  const unchanged = validateUnchangedEconomyFields(beforeEconomy, afterEconomy, allowedFields);
  if (!unchanged.ok) return unchanged;
  for (const field of ["cashG", "contractReserveG", "debtG", "arrearsG"]) {
    if (afterEconomy[field] !== plan[field]) {
      return failure("CASH_TRANSACTION_RESULT_MISMATCH", { field, expected: plan[field], actual: afterEconomy[field] });
    }
  }
  const lastEntry = afterEconomy.ledger[afterEconomy.ledger.length - 1];
  if (lastEntry.transactionId !== plan.entry.transactionId) {
    return failure("CASH_TRANSACTION_LEDGER_MISMATCH");
  }
  const reconciliation = reconcileCashWithLedger(beforeEconomy.cashG, afterEconomy.cashG, [lastEntry]);
  if (!reconciliation.ok) return failure(reconciliation.code, reconciliation);
  return validationSuccess();
}

function eventForPlan(plan, extra = {}) {
  return [{
    eventId: `${plan.entry.transactionId}:committed`,
    causeId: plan.entry.causeId,
    type: "economy.cash-transaction-committed",
    payload: {
      ...plan.entry,
      endingCashG: plan.cashG,
      endingContractReserveG: plan.contractReserveG,
      ...extra,
    },
  }];
}

export function createCashTransactionAtomicTransaction() {
  return defineAtomicTransaction({
    name: "economy.cash.apply",
    readSet: NO_READ_SET,
    writeSet: GENERIC_WRITE_SET,
    allowedPhases: CASH_PHASES,
    validatePayload(ctx) {
      return validateCashTransactionRequest(ctx.command.payload);
    },
    preflight(ctx) {
      return planCashTransaction(ctx.read("economy"), ctx.command.payload, ctx.phase);
    },
    mutate(draft) {
      const runtimePhase = getLedgerPolicy(draft.command.payload.category)?.phases[0];
      return applyCashTransactionToDraft(
        draft.write("economy"),
        draft.command.payload,
        runtimePhase,
      );
    },
    postconditions(before, after, ctx) {
      const plan = planCashTransaction(before.economy, ctx.command.payload, before.runtimePhase);
      if (!plan.ok) return plan;
      return validateLedgerTransactionPostcondition(
        before.economy,
        after.economy,
        plan.plan,
        ["cashG", "contractReserveG", "ledger", "processedTransactionIds"],
      );
    },
    events(before, _after, ctx) {
      const plan = planCashTransaction(before.economy, ctx.command.payload, before.runtimePhase);
      return plan.ok ? eventForPlan(plan.plan) : [];
    },
  });
}

export function createArrearsPaymentAtomicTransaction() {
  return defineAtomicTransaction({
    name: "economy.arrears.pay",
    readSet: NO_READ_SET,
    writeSet: ARREARS_WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      return validateSpecialPaymentPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planArrearsPayment(ctx.read("economy"), ctx.read("campaign"), ctx.command.payload, ctx.phase);
    },
    mutate(draft) {
      return applyArrearsPaymentToDraft(
        draft.write("economy"),
        draft.write("campaign"),
        draft.command.payload,
        "PLANNING",
      );
    },
    postconditions(before, after, ctx) {
      const plan = planArrearsPayment(before.economy, before.campaign, ctx.command.payload, before.runtimePhase);
      if (!plan.ok) return plan;
      const economyResult = validateLedgerTransactionPostcondition(
        before.economy,
        after.economy,
        plan.plan,
        ["cashG", "arrearsG", "ledger", "processedTransactionIds"],
      );
      if (!economyResult.ok) return economyResult;
      if (after.campaign.consecutiveArrearsCount !== plan.plan.consecutiveArrearsCount) {
        return failure("CONSECUTIVE_ARREARS_RESET_MISMATCH");
      }
      return validationSuccess();
    },
    events(before, _after, ctx) {
      const plan = planArrearsPayment(before.economy, before.campaign, ctx.command.payload, before.runtimePhase);
      return plan.ok ? eventForPlan(plan.plan, {
        endingArrearsG: plan.plan.arrearsG,
        consecutiveArrearsCount: plan.plan.consecutiveArrearsCount,
        expenseRecognizedG: 0,
      }) : [];
    },
  });
}

export function createDebtPrincipalPaymentAtomicTransaction() {
  return defineAtomicTransaction({
    name: "economy.debt.repay-principal",
    readSet: NO_READ_SET,
    writeSet: DEBT_WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      return validateSpecialPaymentPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planDebtPrincipalPayment(ctx.read("economy"), ctx.command.payload, ctx.phase);
    },
    mutate(draft) {
      return applyDebtPrincipalPaymentToDraft(draft.write("economy"), draft.command.payload, "PLANNING");
    },
    postconditions(before, after, ctx) {
      const plan = planDebtPrincipalPayment(before.economy, ctx.command.payload, before.runtimePhase);
      if (!plan.ok) return plan;
      return validateLedgerTransactionPostcondition(
        before.economy,
        after.economy,
        plan.plan,
        ["cashG", "debtG", "ledger", "processedTransactionIds"],
      );
    },
    events(before, _after, ctx) {
      const plan = planDebtPrincipalPayment(before.economy, ctx.command.payload, before.runtimePhase);
      return plan.ok ? eventForPlan(plan.plan, { endingDebtG: plan.plan.debtG }) : [];
    },
  });
}

function commandEnvelope(type, writeSet, input) {
  const payload = input?.payload;
  return {
    commandId: input?.commandId,
    expectedRevision: input?.expectedRevision,
    generationId: input?.generationId,
    issuedAtSimulationMs: input?.issuedAtSimulationMs,
    type,
    payload,
    causeId: payload?.causeId,
    readSet: [],
    writeSet: [...writeSet],
  };
}

/** Production facade that registers and dispatches every command allowed to change cash. */
export class CashTransactionAPI {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("CashTransactionAPI에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(CASH_TRANSACTION_COMMAND.APPLY, createCashTransactionAtomicTransaction());
    this.commandBus.register(CASH_TRANSACTION_COMMAND.PAY_ARREARS, createArrearsPaymentAtomicTransaction());
    this.commandBus.register(
      CASH_TRANSACTION_COMMAND.REPAY_DEBT_PRINCIPAL,
      createDebtPrincipalPaymentAtomicTransaction(),
    );
    this.registered = true;
    return this;
  }

  apply(input) {
    return this.commandBus.dispatch(commandEnvelope(CASH_TRANSACTION_COMMAND.APPLY, GENERIC_WRITE_SET, input));
  }

  payArrears(input) {
    return this.commandBus.dispatch(commandEnvelope(CASH_TRANSACTION_COMMAND.PAY_ARREARS, ARREARS_WRITE_SET, input));
  }

  repayDebtPrincipal(input) {
    return this.commandBus.dispatch(commandEnvelope(
      CASH_TRANSACTION_COMMAND.REPAY_DEBT_PRINCIPAL,
      DEBT_WRITE_SET,
      input,
    ));
  }
}

export function registerCashTransactionAPI(commandBus) {
  return new CashTransactionAPI(commandBus, { register: true });
}

export const CASH_TRANSACTION_POLICIES = LEDGER_CATEGORY_POLICY;
export { LEDGER_CATEGORY, LEDGER_DIRECTION, LEDGER_TYPE };
