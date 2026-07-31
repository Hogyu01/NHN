import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import {
  applyCashTransactionToDraft,
  CASH_TRANSACTION_POLICIES,
  LEDGER_CATEGORY,
  LEDGER_DIRECTION,
  LEDGER_TYPE,
} from "./cash-transaction-api.js";
import {
  calculateAvailableCashG,
  validateEconomyState,
  validateEconomyTransition,
} from "./economy.js";
import { reconcileCashWithLedger } from "./economy-ledger.js";
import { validateEventState, ZERO_EVENT_MODIFIERS } from "./events.js";
import { createMarketState, validateMarketState } from "./market.js";
import { validateRecipeState } from "./recipe.js";
import { UNLOCK_KIND, validateProgressionState } from "./unlocks.js";

export const FACILITY_KIND = Object.freeze({
  KITCHEN: "KITCHEN",
  HALL: "HALL",
  STORAGE: "STORAGE",
});

export const FACILITY_EFFECT_TYPE = Object.freeze({
  TIMING_WINDOW_BONUS_MS: "TIMING_WINDOW_BONUS_MS",
  PATIENCE_BONUS_MS: "PATIENCE_BONUS_MS",
  MARKET_PURCHASE_LIMIT_BONUS_QUANTITY: "MARKET_PURCHASE_LIMIT_BONUS_QUANTITY",
});

export const FACILITY_EFFECT_UNIT = Object.freeze({
  MILLISECONDS: "MILLISECONDS",
  QUANTITY: "QUANTITY",
});

export const FACILITY_EFFECTIVE_TIMING = Object.freeze({
  SAME_DAY: "SAME_DAY",
});

export const FACILITY_COMMAND = Object.freeze({
  PURCHASE: "facility.stage.purchase",
});

export const FACILITY_PURCHASE_READ_SET = Object.freeze(["campaign", "progression"]);
export const FACILITY_PURCHASE_WRITE_SET = Object.freeze([
  "economy",
  "facilities",
  "market",
  "idCounters",
]);

const FACILITY_KIND_ORDER = Object.freeze([
  FACILITY_KIND.KITCHEN,
  FACILITY_KIND.HALL,
  FACILITY_KIND.STORAGE,
]);
const FACILITY_PHASES = Object.freeze(["PLANNING"]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const EXPECTED_EFFECT_BY_KIND = freezeDeep({
  [FACILITY_KIND.KITCHEN]: {
    type: FACILITY_EFFECT_TYPE.TIMING_WINDOW_BONUS_MS,
    unit: FACILITY_EFFECT_UNIT.MILLISECONDS,
  },
  [FACILITY_KIND.HALL]: {
    type: FACILITY_EFFECT_TYPE.PATIENCE_BONUS_MS,
    unit: FACILITY_EFFECT_UNIT.MILLISECONDS,
  },
  [FACILITY_KIND.STORAGE]: {
    type: FACILITY_EFFECT_TYPE.MARKET_PURCHASE_LIMIT_BONUS_QUANTITY,
    unit: FACILITY_EFFECT_UNIT.QUANTITY,
  },
});

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function success(plan) {
  return Object.freeze({ ok: true, plan: freezeDeep(plan) });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDefinitions(left, right) {
  return FACILITY_KIND_ORDER.indexOf(left.kind) - FACILITY_KIND_ORDER.indexOf(right.kind) ||
    left.stage - right.stage || compareIds(left.facilityId, right.facilityId);
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

function checkedAddNonNegative(left, right, field) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new TypeError(`${field} 입력은 0 이상의 safe integer여야 합니다.`);
  }
  const result = BigInt(left) + BigInt(right);
  if (result > MAX_SAFE_BIGINT) throw new RangeError(`${field} 결과가 safe integer 범위를 초과했습니다.`);
  return Number(result);
}

function checkedSubtractNonNegative(left, right, field) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0 || right > left) {
    throw new TypeError(`${field} 결과가 음수이거나 입력이 유효하지 않습니다.`);
  }
  return left - right;
}

function requireDay(day, field = "day") {
  return Number.isSafeInteger(day) && day >= 1 && day <= 14
    ? validationSuccess()
    : failure("INVALID_FACILITY_DAY", { field, value: day });
}

export function validateFacilityDefinition(definition, field = "facility") {
  if (!isPlainRecord(definition)) return failure("INVALID_FACILITY_DEFINITION", { field });
  const required = [
    "facilityId",
    "displayName",
    "kind",
    "stage",
    "costG",
    "unlockReputation",
    "effect",
    "effectiveTiming",
  ];
  for (const name of required) {
    if (!own(definition, name)) return failure("MISSING_FACILITY_FIELD", { field: `${field}.${name}` });
  }
  if (!isStableIdentifier(definition.facilityId)) {
    return failure("INVALID_FACILITY_ID", { field: `${field}.facilityId`, value: definition.facilityId });
  }
  if (typeof definition.displayName !== "string" || definition.displayName.trim() === "") {
    return failure("INVALID_FACILITY_DISPLAY_NAME", { facilityId: definition.facilityId });
  }
  if (!FACILITY_KIND_ORDER.includes(definition.kind)) {
    return failure("INVALID_FACILITY_KIND", { facilityId: definition.facilityId, kind: definition.kind });
  }
  if (definition.stage !== 1) {
    return failure("MUST_FACILITY_STAGE_INVALID", { facilityId: definition.facilityId, stage: definition.stage });
  }
  if (!Number.isSafeInteger(definition.costG) || definition.costG <= 0) {
    return failure("INVALID_FACILITY_COST", { facilityId: definition.facilityId, costG: definition.costG });
  }
  if (!Number.isInteger(definition.unlockReputation) ||
      definition.unlockReputation < 0 || definition.unlockReputation > 100) {
    return failure("INVALID_FACILITY_UNLOCK_REPUTATION", {
      facilityId: definition.facilityId,
      unlockReputation: definition.unlockReputation,
    });
  }
  if (!isPlainRecord(definition.effect) ||
      !Number.isSafeInteger(definition.effect.value) || definition.effect.value <= 0) {
    return failure("INVALID_FACILITY_EFFECT", { facilityId: definition.facilityId });
  }
  const expectedEffect = EXPECTED_EFFECT_BY_KIND[definition.kind];
  if (definition.effect.type !== expectedEffect.type || definition.effect.unit !== expectedEffect.unit) {
    return failure("FACILITY_EFFECT_KIND_MISMATCH", {
      facilityId: definition.facilityId,
      kind: definition.kind,
      expected: expectedEffect,
      actual: definition.effect,
    });
  }
  if (definition.effectiveTiming !== FACILITY_EFFECTIVE_TIMING.SAME_DAY) {
    return failure("MUST_FACILITY_EFFECTIVE_TIMING_INVALID", {
      facilityId: definition.facilityId,
      effectiveTiming: definition.effectiveTiming,
    });
  }
  if (own(definition, "opensRegionId") || own(definition, "activatesSeatIds")) {
    return failure("MUST_FACILITY_SPATIAL_EFFECT_FORBIDDEN", { facilityId: definition.facilityId });
  }
  return validationSuccess();
}

export function createFacilityCatalog(facilities) {
  if (!Array.isArray(facilities)) {
    throw Object.assign(new TypeError("facilities 배열이 필요합니다."), { code: "INVALID_FACILITY_CATALOG" });
  }
  const definitions = facilities.map((definition, index) => {
    const validation = validateFacilityDefinition(definition, `facilities[${index}]`);
    if (!validation.ok) {
      throw Object.assign(new TypeError(validation.code), {
        code: validation.code,
        details: validation.details,
      });
    }
    return cloneValue(definition);
  }).sort(compareDefinitions);
  const ids = new Set();
  for (const definition of definitions) {
    if (ids.has(definition.facilityId)) {
      throw Object.assign(new TypeError("facility ID가 중복되었습니다."), {
        code: "DUPLICATE_FACILITY_ID",
        details: { facilityId: definition.facilityId },
      });
    }
    ids.add(definition.facilityId);
  }
  for (const kind of FACILITY_KIND_ORDER) {
    const count = definitions.filter((definition) => definition.kind === kind).length;
    if (count !== 1) {
      throw Object.assign(new TypeError(`${kind} Must stage는 정확히 하나여야 합니다.`), {
        code: "FACILITY_KIND_CARDINALITY_INVALID",
        details: { kind, expected: 1, actual: count },
      });
    }
  }
  if (definitions.length !== FACILITY_KIND_ORDER.length) {
    throw Object.assign(new TypeError("Must facility catalog는 정확히 세 stage여야 합니다."), {
      code: "MUST_FACILITY_CARDINALITY_INVALID",
      details: { expected: FACILITY_KIND_ORDER.length, actual: definitions.length },
    });
  }
  return freezeDeep(definitions);
}

function validateInvestmentRecord(record, definitionsById, field) {
  if (!isPlainRecord(record)) return failure("INVALID_FACILITY_INVESTMENT", { field });
  const required = [
    "facilityId",
    "kind",
    "stage",
    "day",
    "costG",
    "transactionId",
    "causeId",
    "effectiveTiming",
  ];
  for (const name of required) {
    if (!own(record, name)) return failure("MISSING_FACILITY_INVESTMENT_FIELD", { field: `${field}.${name}` });
  }
  if (!isStableIdentifier(record.facilityId) || !definitionsById.has(record.facilityId)) {
    return failure("FACILITY_INVESTMENT_TARGET_NOT_FOUND", { facilityId: record.facilityId, field });
  }
  if (!isStableIdentifier(record.transactionId)) {
    return failure("INVALID_FACILITY_TRANSACTION_ID", { transactionId: record.transactionId, field });
  }
  if (!isStableIdentifier(record.causeId)) {
    return failure("INVALID_FACILITY_CAUSE_ID", { causeId: record.causeId, field });
  }
  const day = requireDay(record.day, `${field}.day`);
  if (!day.ok) return day;
  const definition = definitionsById.get(record.facilityId);
  const expected = {
    kind: definition.kind,
    stage: definition.stage,
    costG: definition.costG,
    effectiveTiming: definition.effectiveTiming,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (record[name] !== value) {
      return failure("FACILITY_INVESTMENT_DEFINITION_MISMATCH", {
        facilityId: record.facilityId,
        field: `${field}.${name}`,
        expected: value,
        actual: record[name],
      });
    }
  }
  return validationSuccess();
}

export function validateFacilityState(state) {
  if (!isPlainRecord(state) || !Array.isArray(state.definitions) ||
      !Array.isArray(state.purchasedFacilityIds) || !Array.isArray(state.investments)) {
    return failure("INVALID_FACILITY_STATE");
  }
  if (state.definitions.length !== FACILITY_KIND_ORDER.length) {
    return failure("MUST_FACILITY_CARDINALITY_INVALID", {
      expected: FACILITY_KIND_ORDER.length,
      actual: state.definitions.length,
    });
  }
  const definitionsById = new Map();
  const kindCounts = new Map(FACILITY_KIND_ORDER.map((kind) => [kind, 0]));
  for (let index = 0; index < state.definitions.length; index += 1) {
    const definition = state.definitions[index];
    const validation = validateFacilityDefinition(definition, `definitions[${index}]`);
    if (!validation.ok) return validation;
    if (definitionsById.has(definition.facilityId)) {
      return failure("DUPLICATE_FACILITY_ID", { facilityId: definition.facilityId });
    }
    if (index > 0 && compareDefinitions(state.definitions[index - 1], definition) >= 0) {
      return failure("FACILITY_DEFINITION_ORDER_INVALID", { index });
    }
    definitionsById.set(definition.facilityId, definition);
    kindCounts.set(definition.kind, kindCounts.get(definition.kind) + 1);
  }
  for (const [kind, count] of kindCounts) {
    if (count !== 1) return failure("FACILITY_KIND_CARDINALITY_INVALID", { kind, expected: 1, actual: count });
  }

  const purchased = new Set();
  for (let index = 0; index < state.purchasedFacilityIds.length; index += 1) {
    const facilityId = state.purchasedFacilityIds[index];
    if (!isStableIdentifier(facilityId) || !definitionsById.has(facilityId)) {
      return failure("PURCHASED_FACILITY_NOT_FOUND", { facilityId, index });
    }
    if (purchased.has(facilityId)) return failure("DUPLICATE_PURCHASED_FACILITY", { facilityId });
    if (index > 0 && compareIds(state.purchasedFacilityIds[index - 1], facilityId) >= 0) {
      return failure("PURCHASED_FACILITY_ORDER_INVALID", { index });
    }
    purchased.add(facilityId);
  }

  const investedFacilities = new Set();
  const transactionIds = new Set();
  const causeIds = new Set();
  for (let index = 0; index < state.investments.length; index += 1) {
    const record = state.investments[index];
    const validation = validateInvestmentRecord(record, definitionsById, `investments[${index}]`);
    if (!validation.ok) return validation;
    if (investedFacilities.has(record.facilityId)) {
      return failure("DUPLICATE_FACILITY_INVESTMENT", { facilityId: record.facilityId });
    }
    if (transactionIds.has(record.transactionId)) {
      return failure("DUPLICATE_FACILITY_TRANSACTION_ID", { transactionId: record.transactionId });
    }
    if (causeIds.has(record.causeId)) {
      return failure("DUPLICATE_FACILITY_CAUSE_ID", { causeId: record.causeId });
    }
    investedFacilities.add(record.facilityId);
    transactionIds.add(record.transactionId);
    causeIds.add(record.causeId);
  }
  const expectedPurchased = [...investedFacilities].sort(compareIds);
  if (!equivalent(state.purchasedFacilityIds, expectedPurchased)) {
    return failure("FACILITY_PURCHASE_INVESTMENT_INDEX_MISMATCH", {
      purchasedFacilityIds: state.purchasedFacilityIds,
      investmentFacilityIds: expectedPurchased,
    });
  }
  return validationSuccess({
    definitionCount: state.definitions.length,
    purchasedCount: state.purchasedFacilityIds.length,
    investmentCount: state.investments.length,
  });
}

export function createFacilityState({ facilities, purchasedFacilityIds = [], investments = [] } = {}) {
  const state = {
    definitions: cloneValue(createFacilityCatalog(facilities)),
    purchasedFacilityIds: [...purchasedFacilityIds].sort(compareIds),
    investments: cloneValue(investments),
  };
  const validation = validateFacilityState(state);
  if (!validation.ok) {
    throw Object.assign(new TypeError(`FacilityState가 유효하지 않습니다: ${validation.code}`), {
      code: validation.code,
      details: validation.details,
    });
  }
  return freezeDeep(state);
}

export function validateFacilityLedgerLinks(facilities, economy) {
  const facilityValidation = validateFacilityState(facilities);
  if (!facilityValidation.ok) return facilityValidation;
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  const facilityLedgerEntries = economy.ledger.filter(
    (entry) => entry.category === LEDGER_CATEGORY.FACILITY_INVESTMENT,
  );
  if (facilityLedgerEntries.length !== facilities.investments.length) {
    return failure("FACILITY_LEDGER_CARDINALITY_MISMATCH", {
      ledgerCount: facilityLedgerEntries.length,
      investmentCount: facilities.investments.length,
    });
  }
  const ledgerByTransaction = new Map(facilityLedgerEntries.map((entry) => [entry.transactionId, entry]));
  for (const investment of facilities.investments) {
    const entry = ledgerByTransaction.get(investment.transactionId);
    if (!entry || entry.day !== investment.day || entry.causeId !== investment.causeId ||
        entry.amountG !== investment.costG || entry.type !== LEDGER_TYPE.FACILITY_INVESTMENT ||
        entry.direction !== LEDGER_DIRECTION.OUTFLOW) {
      return failure("FACILITY_LEDGER_LINK_MISMATCH", {
        facilityId: investment.facilityId,
        transactionId: investment.transactionId,
      });
    }
  }
  return validationSuccess({ linkedInvestments: facilities.investments.length });
}

function validateFacilityPurchasePayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_FACILITY_PURCHASE_PAYLOAD", { field: "$" });
  for (const field of ["day", "facilityId"]) {
    if (!own(payload, field)) return failure("MISSING_FACILITY_PURCHASE_FIELD", { field });
  }
  const day = requireDay(payload.day, "payload.day");
  if (!day.ok) return day;
  if (!isStableIdentifier(payload.facilityId)) {
    return failure("INVALID_FACILITY_ID", { field: "payload.facilityId", value: payload.facilityId });
  }
  return validationSuccess();
}

function validateProgressionFacilityCatalog(progression, facilities) {
  const descriptors = progression.unlockCatalog.filter((entry) => entry.kind === UNLOCK_KIND.FACILITY);
  if (descriptors.length !== facilities.definitions.length) {
    return failure("FACILITY_UNLOCK_CATALOG_CARDINALITY_MISMATCH", {
      expected: facilities.definitions.length,
      actual: descriptors.length,
    });
  }
  for (const definition of facilities.definitions) {
    const descriptor = descriptors.find((entry) => entry.targetId === definition.facilityId);
    if (!descriptor || descriptor.threshold !== definition.unlockReputation) {
      return failure("FACILITY_UNLOCK_CATALOG_MISMATCH", {
        facilityId: definition.facilityId,
        unlockReputation: definition.unlockReputation,
      });
    }
  }
  return validationSuccess();
}

function allocateFacilityPurchaseIds(idState, campaign, day, generationId) {
  let idService;
  try {
    idService = IdService.fromState(idState);
  } catch {
    return failure("INVALID_FACILITY_ID_STATE");
  }
  if (idService.campaignId !== campaign.campaignId) {
    return failure("FACILITY_ID_CAMPAIGN_MISMATCH", {
      expected: campaign.campaignId,
      actual: idService.campaignId,
    });
  }
  if (idService.day !== day) {
    return failure("FACILITY_ID_DAY_MISMATCH", { expected: day, actual: idService.day });
  }
  if (idService.generationId !== generationId) {
    return failure("FACILITY_ID_GENERATION_MISMATCH", {
      expected: generationId,
      actual: idService.generationId,
    });
  }
  try {
    const transactionId = idService.next("tx");
    const causeId = idService.next("cause");
    const eventId = `${transactionId}.facility-purchased`;
    if (![transactionId, causeId, eventId].every(isStableIdentifier)) {
      return failure("GENERATED_FACILITY_ID_INVALID");
    }
    return success({ transactionId, causeId, eventId, idCounters: idService.snapshot() });
  } catch {
    return failure("FACILITY_ID_ALLOCATION_FAILED");
  }
}

/**
 * Plans the complete facility purchase on detached candidates. Cash/ledger assignment remains
 * exclusively delegated to Task 13's CashTransactionAPI draft helper.
 */
export function planFacilityPurchase({
  economy,
  facilities,
  market,
  idCounters,
  campaign,
  progression,
  runtimePhase,
  generationId,
}, payload) {
  const payloadValidation = validateFacilityPurchasePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== "PLANNING") {
    return failure("FACILITY_PURCHASE_REQUIRES_PLANNING", { actual: runtimePhase });
  }
  if (!isPlainRecord(campaign) || !isStableIdentifier(campaign.campaignId)) {
    return failure("INVALID_CAMPAIGN_STATE");
  }
  const campaignDay = requireDay(campaign.day, "campaign.day");
  if (!campaignDay.ok) return campaignDay;
  if (campaign.day !== payload.day) {
    return failure("FACILITY_PURCHASE_DAY_MISMATCH", {
      campaignDay: campaign.day,
      payloadDay: payload.day,
    });
  }
  const facilityValidation = validateFacilityState(facilities);
  if (!facilityValidation.ok) return facilityValidation;
  const progressionValidation = validateProgressionState(progression);
  if (!progressionValidation.ok) return failure("PROGRESSION_STATE_INVALID", { cause: progressionValidation.code });
  const unlockCatalogValidation = validateProgressionFacilityCatalog(progression, facilities);
  if (!unlockCatalogValidation.ok) return unlockCatalogValidation;
  const marketValidation = validateMarketState(market);
  if (!marketValidation.ok) return failure("MARKET_STATE_INVALID", { cause: marketValidation.code });
  if (market.day !== campaign.day) {
    return failure("FACILITY_MARKET_DAY_MISMATCH", { marketDay: market.day, campaignDay: campaign.day });
  }
  const linksValidation = validateFacilityLedgerLinks(facilities, economy);
  if (!linksValidation.ok) return linksValidation;

  const definition = facilities.definitions.find((entry) => entry.facilityId === payload.facilityId);
  if (!definition) return failure("FACILITY_NOT_FOUND", { facilityId: payload.facilityId });
  if (!progression.unlockedFacilityIds.includes(definition.facilityId)) {
    return failure("FACILITY_STAGE_LOCKED", {
      facilityId: definition.facilityId,
      unlockReputation: definition.unlockReputation,
    });
  }
  if (facilities.purchasedFacilityIds.includes(definition.facilityId)) {
    return failure("FACILITY_ALREADY_PURCHASED", { facilityId: definition.facilityId });
  }

  const ids = allocateFacilityPurchaseIds(idCounters, campaign, payload.day, generationId);
  if (!ids.ok) return ids;
  const policy = CASH_TRANSACTION_POLICIES[LEDGER_CATEGORY.FACILITY_INVESTMENT];
  const cashRequest = {
    transactionId: ids.plan.transactionId,
    day: payload.day,
    category: LEDGER_CATEGORY.FACILITY_INVESTMENT,
    type: policy.type,
    direction: policy.direction,
    amountG: definition.costG,
    causeId: ids.plan.causeId,
  };
  const economyCandidate = cloneValue(economy);
  const cashResult = applyCashTransactionToDraft(economyCandidate, cashRequest, runtimePhase);
  if (!cashResult.ok) return cashResult;

  const facilitiesCandidate = cloneValue(facilities);
  facilitiesCandidate.purchasedFacilityIds.push(definition.facilityId);
  facilitiesCandidate.purchasedFacilityIds.sort(compareIds);
  const investment = {
    facilityId: definition.facilityId,
    kind: definition.kind,
    stage: definition.stage,
    day: payload.day,
    costG: definition.costG,
    transactionId: ids.plan.transactionId,
    causeId: ids.plan.causeId,
    effectiveTiming: definition.effectiveTiming,
  };
  facilitiesCandidate.investments.push(investment);

  let marketCandidate = cloneValue(market);
  if (definition.kind === FACILITY_KIND.STORAGE) {
    let purchaseLimitQuantity;
    try {
      purchaseLimitQuantity = checkedAddNonNegative(
        market.purchaseLimitQuantity,
        definition.effect.value,
        "facility storage purchase limit",
      );
      marketCandidate = createMarketState({ ...marketCandidate, purchaseLimitQuantity });
    } catch {
      return failure("FACILITY_MARKET_PURCHASE_LIMIT_OVERFLOW", {
        purchaseLimitQuantity: market.purchaseLimitQuantity,
        bonusQuantity: definition.effect.value,
      });
    }
  }

  const candidateValidation = validateFacilityState(facilitiesCandidate);
  if (!candidateValidation.ok) return candidateValidation;
  const candidateLinks = validateFacilityLedgerLinks(facilitiesCandidate, economyCandidate);
  if (!candidateLinks.ok) return candidateLinks;
  return success({
    economy: economyCandidate,
    facilities: facilitiesCandidate,
    market: marketCandidate,
    idCounters: ids.plan.idCounters,
    definition,
    investment,
    ledgerEntry: cashResult.plan.entry,
    transactionId: ids.plan.transactionId,
    causeId: ids.plan.causeId,
    eventId: ids.plan.eventId,
  });
}

function validateFacilityPurchasePostconditions(before, after, planned) {
  for (const slice of FACILITY_PURCHASE_WRITE_SET) {
    if (!equivalent(after[slice], planned[slice])) {
      return failure("FACILITY_PURCHASE_PLAN_MISMATCH", { slice });
    }
  }
  const economyTransition = validateEconomyTransition(before.economy, after.economy);
  if (!economyTransition.ok) return economyTransition;
  if (economyTransition.details?.appendedCount !== 1) {
    return failure("FACILITY_LEDGER_APPEND_CARDINALITY_MISMATCH", {
      appendedCount: economyTransition.details?.appendedCount,
    });
  }
  if (!equivalent(before.facilities.definitions, after.facilities.definitions)) {
    return failure("FACILITY_DEFINITION_MUTATED");
  }
  if (after.facilities.investments.length !== before.facilities.investments.length + 1) {
    return failure("FACILITY_INVESTMENT_APPEND_CARDINALITY_MISMATCH");
  }
  for (let index = 0; index < before.facilities.investments.length; index += 1) {
    if (!equivalent(before.facilities.investments[index], after.facilities.investments[index])) {
      return failure("FACILITY_INVESTMENT_HISTORY_MUTATED", { index });
    }
  }
  const links = validateFacilityLedgerLinks(after.facilities, after.economy);
  if (!links.ok) return links;
  const ledgerEntry = after.economy.ledger[after.economy.ledger.length - 1];
  const cashReconciliation = reconcileCashWithLedger(before.economy.cashG, after.economy.cashG, [ledgerEntry]);
  if (!cashReconciliation.ok) return failure(cashReconciliation.code, cashReconciliation);
  if (ledgerEntry.transactionId !== planned.transactionId ||
      ledgerEntry.category !== LEDGER_CATEGORY.FACILITY_INVESTMENT ||
      ledgerEntry.type !== LEDGER_TYPE.FACILITY_INVESTMENT ||
      ledgerEntry.direction !== LEDGER_DIRECTION.OUTFLOW ||
      ledgerEntry.amountG !== planned.definition.costG ||
      ledgerEntry.causeId !== planned.causeId) {
    return failure("FACILITY_LEDGER_ENTRY_MISMATCH");
  }
  if (planned.definition.kind === FACILITY_KIND.STORAGE) {
    if (after.market.purchaseLimitQuantity - before.market.purchaseLimitQuantity !== planned.definition.effect.value) {
      return failure("FACILITY_STORAGE_LIMIT_DELTA_MISMATCH");
    }
  } else if (!equivalent(before.market, after.market)) {
    return failure("NON_STORAGE_FACILITY_MARKET_MUTATED", { kind: planned.definition.kind });
  }
  for (const kind of Object.keys(before.idCounters.counters)) {
    const expectedDelta = kind === "tx" || kind === "cause" ? 1 : 0;
    if (after.idCounters.counters[kind] !== before.idCounters.counters[kind] + expectedDelta) {
      return failure("FACILITY_ID_COUNTER_MISMATCH", { kind, expectedDelta });
    }
  }
  return validationSuccess({
    facilityId: planned.definition.facilityId,
    investmentG: planned.definition.costG,
    effectiveTiming: planned.definition.effectiveTiming,
  });
}

export function createPurchaseFacilityAtomicTransaction() {
  return defineAtomicTransaction({
    name: FACILITY_COMMAND.PURCHASE,
    readSet: FACILITY_PURCHASE_READ_SET,
    writeSet: FACILITY_PURCHASE_WRITE_SET,
    allowedPhases: FACILITY_PHASES,
    validatePayload(ctx) {
      return validateFacilityPurchasePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planFacilityPurchase({
        economy: ctx.read("economy"),
        facilities: ctx.read("facilities"),
        market: ctx.read("market"),
        idCounters: ctx.read("idCounters"),
        campaign: ctx.read("campaign"),
        progression: ctx.read("progression"),
        runtimePhase: ctx.phase,
        generationId: ctx.generationId,
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planFacilityPurchase({
        economy: draft.read("economy"),
        facilities: draft.read("facilities"),
        market: draft.read("market"),
        idCounters: draft.read("idCounters"),
        campaign: draft.read("campaign"),
        progression: draft.read("progression"),
        runtimePhase: "PLANNING",
        generationId: draft.command.generationId,
      }, draft.command.payload);
      if (!planned.ok) return planned;
      for (const slice of FACILITY_PURCHASE_WRITE_SET) draft.replace(slice, planned.plan[slice]);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planFacilityPurchase({
        economy: before.economy,
        facilities: before.facilities,
        market: before.market,
        idCounters: before.idCounters,
        campaign: before.campaign,
        progression: before.progression,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
      }, ctx.command.payload);
      if (!planned.ok) return planned;
      return validateFacilityPurchasePostconditions(before, after, planned.plan);
    },
    events(before, _after, ctx) {
      const planned = planFacilityPurchase({
        economy: before.economy,
        facilities: before.facilities,
        market: before.market,
        idCounters: before.idCounters,
        campaign: before.campaign,
        progression: before.progression,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
      }, ctx.command.payload);
      if (!planned.ok) return [];
      return [{
        eventId: planned.plan.eventId,
        causeId: planned.plan.causeId,
        type: "facility.stage-purchased",
        payload: {
          day: ctx.command.payload.day,
          facilityId: planned.plan.definition.facilityId,
          kind: planned.plan.definition.kind,
          stage: planned.plan.definition.stage,
          costG: planned.plan.definition.costG,
          effect: cloneValue(planned.plan.definition.effect),
          effectiveTiming: planned.plan.definition.effectiveTiming,
          transactionId: planned.plan.transactionId,
        },
      }];
    },
  });
}

function normalizeProjectionConfiguration(configuration = {}) {
  const normalized = {
    basePatienceMs: configuration.basePatienceMs ?? 30_000,
    minimumPatienceMs: configuration.minimumPatienceMs ?? 20_000,
    maximumPatienceMs: configuration.maximumPatienceMs ?? 60_000,
  };
  for (const field of ["basePatienceMs", "minimumPatienceMs", "maximumPatienceMs"]) {
    if (!Number.isSafeInteger(normalized[field]) || normalized[field] < 0) {
      throw new TypeError(`${field}는 0 이상의 safe integer여야 합니다.`);
    }
  }
  if (normalized.minimumPatienceMs > normalized.basePatienceMs ||
      normalized.basePatienceMs > normalized.maximumPatienceMs) {
    throw new RangeError("patience projection 범위가 유효하지 않습니다.");
  }
  return freezeDeep(normalized);
}

function activeEventModifiers(snapshot) {
  if (snapshot.events === undefined) return ZERO_EVENT_MODIFIERS;
  const validation = validateEventState(snapshot.events);
  if (!validation.ok) throw new TypeError(`EventState가 유효하지 않습니다: ${validation.code}`);
  return snapshot.events.activeEvent?.generatedDay === snapshot.campaign?.day
    ? snapshot.events.activeModifiers
    : ZERO_EVENT_MODIFIERS;
}

function aggregatePurchasedEffects(facilities) {
  const purchased = new Set(facilities.purchasedFacilityIds);
  const aggregate = {
    timingWindowBonusMs: 0,
    patienceBonusMs: 0,
    marketPurchaseLimitBonusQuantity: 0,
  };
  for (const definition of facilities.definitions) {
    if (!purchased.has(definition.facilityId)) continue;
    if (definition.effect.type === FACILITY_EFFECT_TYPE.TIMING_WINDOW_BONUS_MS) {
      aggregate.timingWindowBonusMs = checkedAddNonNegative(
        aggregate.timingWindowBonusMs,
        definition.effect.value,
        "facility timing bonus",
      );
    } else if (definition.effect.type === FACILITY_EFFECT_TYPE.PATIENCE_BONUS_MS) {
      aggregate.patienceBonusMs = checkedAddNonNegative(
        aggregate.patienceBonusMs,
        definition.effect.value,
        "facility patience bonus",
      );
    } else {
      aggregate.marketPurchaseLimitBonusQuantity = checkedAddNonNegative(
        aggregate.marketPurchaseLimitBonusQuantity,
        definition.effect.value,
        "facility market limit bonus",
      );
    }
  }
  return aggregate;
}

function timingWindowProjection(recipes, bonusMs) {
  return recipes.definitions.map((recipe) => ({
    recipeId: recipe.recipeId,
    successWindowMs: checkedAddNonNegative(recipe.timing.successWindowMs, bonusMs, "success timing window"),
    normalWindowMs: checkedAddNonNegative(recipe.timing.normalWindowMs, bonusMs, "normal timing window"),
  }));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Read-only Planning projection: canonical cost/condition/before/after and current same-day effects. */
export function projectFacilities(snapshot, configuration = {}) {
  const facilityValidation = validateFacilityState(snapshot.facilities);
  if (!facilityValidation.ok) throw new TypeError(`FacilityState가 유효하지 않습니다: ${facilityValidation.code}`);
  const progressionValidation = validateProgressionState(snapshot.progression);
  if (!progressionValidation.ok) throw new TypeError(`ProgressionState가 유효하지 않습니다: ${progressionValidation.code}`);
  const recipeValidation = validateRecipeState(snapshot.recipes);
  if (!recipeValidation.ok) throw new TypeError(`RecipeState가 유효하지 않습니다: ${recipeValidation.code}`);
  const marketValidation = validateMarketState(snapshot.market);
  if (!marketValidation.ok) throw new TypeError(`MarketState가 유효하지 않습니다: ${marketValidation.code}`);
  const ledgerLinks = validateFacilityLedgerLinks(snapshot.facilities, snapshot.economy);
  if (!ledgerLinks.ok) throw new TypeError(`Facility ledger link가 유효하지 않습니다: ${ledgerLinks.code}`);
  const config = normalizeProjectionConfiguration(configuration);
  const eventModifiers = activeEventModifiers(snapshot);
  const facilityEffects = aggregatePurchasedEffects(snapshot.facilities);
  const totalTimingWindowBonusMs = checkedAddNonNegative(
    Math.max(0, eventModifiers.timingWindowBonusMs),
    facilityEffects.timingWindowBonusMs,
    "total timing window bonus",
  );
  const patienceBeforeClamp = checkedAddNonNegative(
    checkedAddNonNegative(
      config.basePatienceMs,
      Math.max(0, eventModifiers.patienceDeltaMs),
      "event patience",
    ),
    facilityEffects.patienceBonusMs,
    "facility patience",
  );
  const currentPatienceMs = clamp(
    patienceBeforeClamp,
    config.minimumPatienceMs,
    config.maximumPatienceMs,
  );
  const purchased = new Set(snapshot.facilities.purchasedFacilityIds);
  const unlocked = new Set(snapshot.progression.unlockedFacilityIds);
  const availableCashG = calculateAvailableCashG(snapshot.economy);

  const stages = snapshot.facilities.definitions.map((definition) => {
    const isPurchased = purchased.has(definition.facilityId);
    const isUnlocked = unlocked.has(definition.facilityId);
    let beforeValue;
    let afterValue;
    let currentValue;
    if (definition.kind === FACILITY_KIND.KITCHEN) {
      const bonusWithoutStage = isPurchased
        ? checkedSubtractNonNegative(totalTimingWindowBonusMs, definition.effect.value, "timing bonus without stage")
        : totalTimingWindowBonusMs;
      const bonusWithStage = checkedAddNonNegative(
        bonusWithoutStage,
        definition.effect.value,
        "timing bonus with stage",
      );
      beforeValue = {
        timingWindowBonusMs: bonusWithoutStage,
        recipes: timingWindowProjection(snapshot.recipes, bonusWithoutStage),
      };
      afterValue = {
        timingWindowBonusMs: bonusWithStage,
        recipes: timingWindowProjection(snapshot.recipes, bonusWithStage),
      };
      currentValue = isPurchased ? afterValue : beforeValue;
    } else if (definition.kind === FACILITY_KIND.HALL) {
      const currentWithoutStage = isPurchased
        ? checkedSubtractNonNegative(patienceBeforeClamp, definition.effect.value, "patience without stage")
        : patienceBeforeClamp;
      beforeValue = clamp(currentWithoutStage, config.minimumPatienceMs, config.maximumPatienceMs);
      afterValue = clamp(
        checkedAddNonNegative(currentWithoutStage, definition.effect.value, "patience with stage"),
        config.minimumPatienceMs,
        config.maximumPatienceMs,
      );
      currentValue = isPurchased ? afterValue : beforeValue;
    } else {
      const currentLimit = snapshot.market.purchaseLimitQuantity;
      beforeValue = isPurchased
        ? checkedSubtractNonNegative(currentLimit, definition.effect.value, "market limit without stage")
        : currentLimit;
      afterValue = checkedAddNonNegative(beforeValue, definition.effect.value, "market limit with stage");
      currentValue = currentLimit;
    }
    const disabledReason = snapshot.runtimePhase !== "PLANNING"
      ? "FACILITY_PURCHASE_REQUIRES_PLANNING"
      : isPurchased
        ? "FACILITY_ALREADY_PURCHASED"
        : !isUnlocked
          ? "FACILITY_STAGE_LOCKED"
          : availableCashG < definition.costG
            ? "INSUFFICIENT_AVAILABLE_CASH"
            : null;
    return {
      facilityId: definition.facilityId,
      displayName: definition.displayName,
      kind: definition.kind,
      stage: definition.stage,
      costG: definition.costG,
      condition: {
        type: "REPUTATION",
        threshold: definition.unlockReputation,
        current: snapshot.campaign?.reputation ?? null,
        met: Number.isInteger(snapshot.campaign?.reputation) &&
          snapshot.campaign.reputation >= definition.unlockReputation,
        published: isUnlocked,
      },
      effect: {
        ...cloneValue(definition.effect),
        beforeValue: cloneValue(beforeValue),
        afterValue: cloneValue(afterValue),
        currentValue: cloneValue(currentValue),
      },
      effectiveTiming: definition.effectiveTiming,
      purchased: isPurchased,
      unlocked: isUnlocked,
      purchaseEnabled: disabledReason === null,
      disabledReason,
    };
  });

  return freezeDeep({
    day: snapshot.campaign?.day ?? null,
    availableCashG,
    mustStageCount: stages.length,
    purchasedFacilityIds: [...snapshot.facilities.purchasedFacilityIds],
    effects: {
      facilityTimingWindowBonusMs: facilityEffects.timingWindowBonusMs,
      eventTimingWindowBonusMs: eventModifiers.timingWindowBonusMs,
      totalTimingWindowBonusMs,
      timingWindows: timingWindowProjection(snapshot.recipes, totalTimingWindowBonusMs),
      facilityPatienceBonusMs: facilityEffects.patienceBonusMs,
      eventPatienceDeltaMs: eventModifiers.patienceDeltaMs,
      currentPatienceMs,
      facilityMarketPurchaseLimitBonusQuantity: facilityEffects.marketPurchaseLimitBonusQuantity,
      eventMarketPurchaseLimitBonusQuantity: eventModifiers.marketPurchaseLimitBonusQuantity,
      currentMarketPurchaseLimitQuantity: snapshot.market.purchaseLimitQuantity,
    },
    stages,
    investments: cloneValue(snapshot.facilities.investments),
  });
}

function commandEnvelope(input) {
  return {
    commandId: input?.commandId,
    expectedRevision: input?.expectedRevision,
    generationId: input?.generationId,
    issuedAtSimulationMs: input?.issuedAtSimulationMs,
    type: FACILITY_COMMAND.PURCHASE,
    payload: input?.payload,
    readSet: [...FACILITY_PURCHASE_READ_SET],
    writeSet: [...FACILITY_PURCHASE_WRITE_SET],
  };
}

export class FacilitySystem {
  constructor(commandBus, { projectionConfiguration = {}, register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("FacilitySystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.projectionConfiguration = normalizeProjectionConfiguration(projectionConfiguration);
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(FACILITY_COMMAND.PURCHASE, createPurchaseFacilityAtomicTransaction());
    this.registered = true;
    return this;
  }

  purchase(input) {
    return this.commandBus.dispatch(commandEnvelope(input));
  }

  project(snapshot) {
    return projectFacilities(snapshot, this.projectionConfiguration);
  }
}

export function registerFacilitySystem(commandBus, projectionConfiguration = {}) {
  return new FacilitySystem(commandBus, { projectionConfiguration, register: true });
}
