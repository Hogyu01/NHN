import { IdService } from "../core/ids.js";
import {
  checkedAddG,
  checkedSubtractG,
  multiplyDivideHalfUp,
  requireNonNegativeG,
  requirePositiveG,
  sumG,
} from "../core/money.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { RngRegistry } from "../core/rng.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import {
  applyCashTransactionToDraft,
  applyContractReserveChangeToDraft,
  CASH_TRANSACTION_POLICIES,
  CONTRACT_RESERVE_OPERATION,
  LEDGER_CATEGORY,
} from "./cash-transaction-api.js";
import {
  calculateAvailableCashG,
  validateEconomyState,
  validateEconomyTransition,
} from "./economy.js";
import { reconcileCashWithLedger } from "./economy-ledger.js";
import {
  applyContractFailureLossToDraft,
  applyContractPrepaidApplicationToDraft,
  applyContractPrepaidCapitalizationToDraft,
  applyLotAcquisitionToDraft,
  INVENTORY_ACQUISITION_SOURCE,
  reconcileInventoryAccounting,
  validateCostMovementAppendOnly,
  validateInventoryAccountingState,
} from "./inventory-accounting.js";
import { validateInventoryState } from "./inventory.js";

export const CONTRACT_OFFER_RNG_STREAM = "contractOffer";
export const CONTRACT_RESOLUTION_RNG_STREAM = "contractResolution";
export const CONTRACT_PREPAID_PERCENT = 20;
export const CONTRACT_ARRIVAL_DAY_OFFSET = 1;
export const CONTRACT_MINIMUM_OFFER_COUNT = 2;

export const CONTRACT_RISK = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
});

export const CONTRACT_RISK_TABLE = freezeDeep({
  [CONTRACT_RISK.LOW]: { successRate: 90, discountPercent: 5 },
  [CONTRACT_RISK.MEDIUM]: { successRate: 70, discountPercent: 15 },
  [CONTRACT_RISK.HIGH]: { successRate: 50, discountPercent: 30 },
});

export const CONTRACT_RISK_ORDER = Object.freeze([
  CONTRACT_RISK.LOW,
  CONTRACT_RISK.MEDIUM,
  CONTRACT_RISK.HIGH,
]);

export const CONTRACT_STATUS = Object.freeze({
  ACCEPTED_PENDING: "ACCEPTED_PENDING",
  RESOLVED_SUCCESS: "RESOLVED_SUCCESS",
  RESOLVED_FAILURE: "RESOLVED_FAILURE",
  TERMINAL_CANCELLED: "TERMINAL_CANCELLED",
});

export const CONTRACT_RESOLUTION_OUTCOME = Object.freeze({
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
});

export const CONTRACT_COMMAND = Object.freeze({
  ACCEPT: "contract.accept",
  RESOLVE: "contract.resolve",
});

export const CONTRACT_ACCEPT_READ_SET = Object.freeze(["campaign", "inventory"]);
export const CONTRACT_ACCEPT_WRITE_SET = Object.freeze([
  "economy",
  "contracts",
  "inventoryAccounting",
  "idCounters",
]);
export const CONTRACT_RESOLVE_READ_SET = Object.freeze(["campaign"]);
export const CONTRACT_RESOLVE_WRITE_SET = Object.freeze([
  "economy",
  "contracts",
  "inventory",
  "inventoryAccounting",
  "idCounters",
  "rng",
]);

const CONTRACT_PHASES = Object.freeze(["PLANNING"]);
const QUALITY_WEIGHT_SCALE = 1_000_000;
const QUALITY_WEIGHT_TOLERANCE = 0.000_001;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function success(plan) {
  return Object.freeze({ ok: true, plan: freezeDeep(plan) });
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStableIdentifiers(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function requireDay(day, field = "day") {
  return Number.isSafeInteger(day) && day >= 1 && day <= 14
    ? validationSuccess()
    : failure("INVALID_CONTRACT_DAY", { field, value: day });
}

function requirePercentage(value, field) {
  return Number.isInteger(value) && value >= 0 && value <= 100
    ? validationSuccess()
    : failure("INVALID_CONTRACT_PERCENTAGE", { field, value });
}

function checkedMultiplyPositive(left, right, field) {
  requirePositiveG(left, `${field}.left`);
  if (!Number.isSafeInteger(right) || right <= 0) {
    throw new TypeError(`${field}.right는 positive safe integer여야 합니다.`);
  }
  const product = BigInt(left) * BigInt(right);
  if (product > MAX_SAFE_BIGINT) throw new RangeError(`${field} 결과가 safe integer 범위를 초과했습니다.`);
  return Number(product);
}

function riskRank(risk) {
  return CONTRACT_RISK_ORDER.indexOf(risk);
}

export function createContractOfferId(day, risk) {
  const dayValidation = requireDay(day);
  if (!dayValidation.ok) throw Object.assign(new TypeError(dayValidation.code), { code: dayValidation.code });
  if (riskRank(risk) < 0) throw Object.assign(new TypeError("INVALID_CONTRACT_RISK"), { code: "INVALID_CONTRACT_RISK" });
  const offerId = `contract.offer:${day}:${risk}`;
  if (!isStableIdentifier(offerId)) throw new TypeError("생성된 contract offer ID가 유효하지 않습니다.");
  return offerId;
}

export function createContractId(day, risk) {
  const dayValidation = requireDay(day);
  if (!dayValidation.ok) throw Object.assign(new TypeError(dayValidation.code), { code: dayValidation.code });
  if (riskRank(risk) < 0) throw Object.assign(new TypeError("INVALID_CONTRACT_RISK"), { code: "INVALID_CONTRACT_RISK" });
  const contractId = `contract:${day}:${risk}`;
  if (!isStableIdentifier(contractId)) throw new TypeError("생성된 contract ID가 유효하지 않습니다.");
  return contractId;
}

export function createContractResolutionId(contractId) {
  if (!isStableIdentifier(contractId)) throw new TypeError("contractId가 stable identifier가 아닙니다.");
  const resolutionId = `${contractId}.resolution`;
  if (!isStableIdentifier(resolutionId)) throw new TypeError("생성된 resolution ID가 유효하지 않습니다.");
  return resolutionId;
}

function validateQualityDistribution(distribution, ingredientId) {
  if (!Array.isArray(distribution) || distribution.length === 0) {
    return failure("INVALID_CONTRACT_QUALITY_DISTRIBUTION", { ingredientId });
  }
  let weightTotal = 0;
  for (let index = 0; index < distribution.length; index += 1) {
    const bucket = distribution[index];
    if (!isPlainRecord(bucket) || !Number.isInteger(bucket.minQuality) ||
        !Number.isInteger(bucket.maxQuality) || bucket.minQuality < 0 ||
        bucket.maxQuality > 100 || bucket.minQuality > bucket.maxQuality ||
        !Number.isFinite(bucket.weight) || bucket.weight <= 0) {
      return failure("INVALID_CONTRACT_QUALITY_BUCKET", { ingredientId, bucketIndex: index });
    }
    weightTotal += bucket.weight;
  }
  if (Math.abs(weightTotal - 1) > QUALITY_WEIGHT_TOLERANCE) {
    return failure("CONTRACT_QUALITY_WEIGHT_SUM_MISMATCH", { ingredientId, weightTotal });
  }
  return validationSuccess();
}

function expectedQuality(distribution) {
  let weightedQuality = 0;
  let totalWeight = 0;
  for (const bucket of distribution) {
    const weight = Math.round(bucket.weight * QUALITY_WEIGHT_SCALE);
    const midpoint = Math.floor((bucket.minQuality + bucket.maxQuality) / 2);
    weightedQuality += midpoint * weight;
    totalWeight += weight;
  }
  return Math.max(0, Math.min(100, Math.floor(weightedQuality / totalWeight)));
}

function validateCanonicalContractIngredients(ingredients) {
  if (!Array.isArray(ingredients) || ingredients.length < 2) {
    return failure("CONTRACT_REQUIRES_TWO_CANONICAL_INGREDIENTS");
  }
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < ingredients.length; index += 1) {
    const ingredient = ingredients[index];
    if (!isPlainRecord(ingredient)) {
      return failure("INVALID_CANONICAL_CONTRACT_INGREDIENT", { ingredientIndex: index });
    }
    if (!isStableIdentifier(ingredient.ingredientId) || seen.has(ingredient.ingredientId)) {
      return failure(seen.has(ingredient.ingredientId)
        ? "DUPLICATE_CONTRACT_INGREDIENT_ID"
        : "INVALID_CONTRACT_INGREDIENT_ID", {
        ingredientIndex: index,
        ingredientId: ingredient.ingredientId,
      });
    }
    seen.add(ingredient.ingredientId);
    try {
      requirePositiveG(ingredient.basePriceG, "basePriceG");
    } catch {
      return failure("INVALID_CONTRACT_BASE_PRICE", {
        ingredientId: ingredient.ingredientId,
        value: ingredient.basePriceG,
      });
    }
    const range = ingredient.marketStockRange;
    if (!isPlainRecord(range) || !Number.isSafeInteger(range.minimum) ||
        !Number.isSafeInteger(range.maximum) || range.minimum < 1 || range.maximum < range.minimum) {
      return failure("INVALID_CONTRACT_QUANTITY_RANGE", {
        ingredientId: ingredient.ingredientId,
        range,
      });
    }
    const quality = validateQualityDistribution(ingredient.qualityDistribution, ingredient.ingredientId);
    if (!quality.ok) return quality;
    normalized.push(ingredient);
  }
  normalized.sort((left, right) => compareStableIdentifiers(left.ingredientId, right.ingredientId));
  return Object.freeze({ ok: true, ingredients: Object.freeze(normalized) });
}

function validateCanonicalContractConfiguration(configuration) {
  if (!isPlainRecord(configuration)) return failure("INVALID_CONTRACT_CONFIGURATION");
  if (configuration.prepaidPercent !== CONTRACT_PREPAID_PERCENT) {
    return failure("CONTRACT_PREPAID_PERCENT_MISMATCH", {
      expected: CONTRACT_PREPAID_PERCENT,
      actual: configuration.prepaidPercent,
    });
  }
  if (configuration.arrivalDayOffset !== CONTRACT_ARRIVAL_DAY_OFFSET) {
    return failure("CONTRACT_ARRIVAL_OFFSET_MISMATCH", {
      expected: CONTRACT_ARRIVAL_DAY_OFFSET,
      actual: configuration.arrivalDayOffset,
    });
  }
  if (!Array.isArray(configuration.riskTiers) || configuration.riskTiers.length !== CONTRACT_RISK_ORDER.length) {
    return failure("INVALID_CONTRACT_RISK_TABLE");
  }
  const byRisk = new Map(configuration.riskTiers.map((tier) => [tier?.risk, tier]));
  for (const risk of CONTRACT_RISK_ORDER) {
    const tier = byRisk.get(risk);
    const expected = CONTRACT_RISK_TABLE[risk];
    if (!isPlainRecord(tier) || tier.successRate !== expected.successRate ||
        tier.discountPercent !== expected.discountPercent) {
      return failure("CONTRACT_RISK_TABLE_MISMATCH", { risk, expected, actual: tier ?? null });
    }
    for (const field of ["successRate", "discountPercent"]) {
      const percentage = requirePercentage(tier[field], `${risk}.${field}`);
      if (!percentage.ok) return percentage;
    }
  }
  return validationSuccess();
}

export function validateContractOfferLine(line) {
  if (!isPlainRecord(line)) return failure("INVALID_CONTRACT_OFFER_LINE");
  const required = [
    "ingredientId", "quantity", "basePriceG", "marketExpectedCostG",
    "expectedQuality", "qualityDistribution",
  ];
  for (const field of required) {
    if (!own(line, field)) return failure("MISSING_CONTRACT_LINE_FIELD", { field });
  }
  if (!isStableIdentifier(line.ingredientId)) return failure("INVALID_CONTRACT_INGREDIENT_ID");
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
    return failure("INVALID_CONTRACT_QUANTITY", { ingredientId: line.ingredientId, quantity: line.quantity });
  }
  let expectedCostG;
  try {
    requirePositiveG(line.basePriceG, "basePriceG");
    requirePositiveG(line.marketExpectedCostG, "marketExpectedCostG");
    expectedCostG = checkedMultiplyPositive(line.basePriceG, line.quantity, "contract line expected cost");
  } catch {
    return failure("INVALID_CONTRACT_LINE_COST", { ingredientId: line.ingredientId });
  }
  if (line.marketExpectedCostG !== expectedCostG) {
    return failure("CONTRACT_LINE_EXPECTED_COST_MISMATCH", {
      ingredientId: line.ingredientId,
      expected: expectedCostG,
      actual: line.marketExpectedCostG,
    });
  }
  if (!Number.isInteger(line.expectedQuality) || line.expectedQuality < 0 || line.expectedQuality > 100) {
    return failure("INVALID_CONTRACT_EXPECTED_QUALITY", { ingredientId: line.ingredientId });
  }
  const quality = validateQualityDistribution(line.qualityDistribution, line.ingredientId);
  if (!quality.ok) return quality;
  if (line.expectedQuality !== expectedQuality(line.qualityDistribution)) {
    return failure("CONTRACT_EXPECTED_QUALITY_MISMATCH", { ingredientId: line.ingredientId });
  }
  return validationSuccess();
}

export function validateContractOffer(offer, expectedDay = offer?.generatedDay) {
  if (!isPlainRecord(offer)) return failure("INVALID_CONTRACT_OFFER");
  const required = [
    "offerId", "contractId", "generatedDay", "arrivalDay", "risk", "successRate",
    "discountPercent", "marketExpectedCostG", "totalPriceG", "prepaidG", "balanceG",
    "lossExposureG", "lines",
  ];
  for (const field of required) {
    if (!own(offer, field)) return failure("MISSING_CONTRACT_OFFER_FIELD", { field });
  }
  const day = requireDay(offer.generatedDay, "generatedDay");
  if (!day.ok) return day;
  if (offer.generatedDay !== expectedDay) {
    return failure("CONTRACT_OFFER_DAY_MISMATCH", { expectedDay, actualDay: offer.generatedDay });
  }
  if (offer.arrivalDay !== offer.generatedDay + CONTRACT_ARRIVAL_DAY_OFFSET ||
      !Number.isSafeInteger(offer.arrivalDay) || offer.arrivalDay < 2 || offer.arrivalDay > 15) {
    return failure("CONTRACT_ARRIVAL_DAY_MISMATCH", {
      generatedDay: offer.generatedDay,
      arrivalDay: offer.arrivalDay,
    });
  }
  const policy = CONTRACT_RISK_TABLE[offer.risk];
  if (!policy) return failure("INVALID_CONTRACT_RISK", { risk: offer.risk });
  for (const field of ["successRate", "discountPercent"]) {
    const percentage = requirePercentage(offer[field], field);
    if (!percentage.ok) return percentage;
  }
  if (offer.successRate !== policy.successRate || offer.discountPercent !== policy.discountPercent) {
    return failure("CONTRACT_RISK_POLICY_MISMATCH", { risk: offer.risk });
  }
  let expectedOfferId;
  let expectedContractId;
  try {
    expectedOfferId = createContractOfferId(offer.generatedDay, offer.risk);
    expectedContractId = createContractId(offer.generatedDay, offer.risk);
  } catch (error) {
    return failure(error?.code ?? "INVALID_CONTRACT_ID");
  }
  if (offer.offerId !== expectedOfferId || offer.contractId !== expectedContractId) {
    return failure("CONTRACT_OFFER_ID_MISMATCH", {
      expectedOfferId,
      actualOfferId: offer.offerId,
      expectedContractId,
      actualContractId: offer.contractId,
    });
  }
  if (!Array.isArray(offer.lines) || offer.lines.length < 1) return failure("EMPTY_CONTRACT_LINES");
  const ingredientIds = new Set();
  for (let index = 0; index < offer.lines.length; index += 1) {
    const line = offer.lines[index];
    const validation = validateContractOfferLine(line);
    if (!validation.ok) return failure(validation.code, { lineIndex: index, ...validation.details });
    if (ingredientIds.has(line.ingredientId)) {
      return failure("DUPLICATE_CONTRACT_LINE_INGREDIENT", { ingredientId: line.ingredientId });
    }
    if (index > 0 && compareStableIdentifiers(offer.lines[index - 1].ingredientId, line.ingredientId) >= 0) {
      return failure("CONTRACT_LINE_ORDER_INVALID", { lineIndex: index });
    }
    ingredientIds.add(line.ingredientId);
  }
  let marketExpectedCostG;
  let totalPriceG;
  let prepaidG;
  try {
    marketExpectedCostG = sumG(offer.lines.map((line) => line.marketExpectedCostG), "contract expected cost");
    totalPriceG = multiplyDivideHalfUp(marketExpectedCostG, 100 - offer.discountPercent, 100);
    prepaidG = multiplyDivideHalfUp(totalPriceG, CONTRACT_PREPAID_PERCENT, 100);
    requirePositiveG(marketExpectedCostG, "marketExpectedCostG");
    requirePositiveG(totalPriceG, "totalPriceG");
    requirePositiveG(prepaidG, "prepaidG");
  } catch {
    return failure("INVALID_CONTRACT_OFFER_MONEY");
  }
  const balanceG = checkedSubtractG(totalPriceG, prepaidG, "contract balance");
  if (offer.marketExpectedCostG !== marketExpectedCostG || offer.totalPriceG !== totalPriceG ||
      offer.prepaidG !== prepaidG || offer.balanceG !== balanceG ||
      offer.lossExposureG !== prepaidG) {
    return failure("CONTRACT_OFFER_MONEY_MISMATCH", {
      expected: { marketExpectedCostG, totalPriceG, prepaidG, balanceG, lossExposureG: prepaidG },
      actual: {
        marketExpectedCostG: offer.marketExpectedCostG,
        totalPriceG: offer.totalPriceG,
        prepaidG: offer.prepaidG,
        balanceG: offer.balanceG,
        lossExposureG: offer.lossExposureG,
      },
    });
  }
  return validationSuccess();
}

function validateResolutionRecord(contract) {
  const resolution = contract.resolution;
  if (!isPlainRecord(resolution)) return failure("INVALID_CONTRACT_RESOLUTION_RECORD");
  const required = [
    "resolutionId", "contractId", "resolvedDay", "outcome", "roll", "successRate",
    "causeId", "balanceTransactionId", "prepaidDispositionMovementId", "lotMovementIds",
    "lineResults", "allocationG",
  ];
  for (const field of required) {
    if (!own(resolution, field)) return failure("MISSING_CONTRACT_RESOLUTION_FIELD", { field });
  }
  if (resolution.resolutionId !== createContractResolutionId(contract.contractId) ||
      resolution.contractId !== contract.contractId || resolution.resolvedDay !== contract.resolutionDay ||
      !isStableIdentifier(resolution.causeId) || !isStableIdentifier(resolution.prepaidDispositionMovementId)) {
    return failure("INVALID_CONTRACT_RESOLUTION_RECORD", { contractId: contract.contractId });
  }
  if (!Number.isSafeInteger(resolution.roll) || resolution.roll < 0 || resolution.roll >= QUALITY_WEIGHT_SCALE ||
      resolution.successRate !== contract.successRate) {
    return failure("INVALID_CONTRACT_RESOLUTION_ROLL", { contractId: contract.contractId });
  }
  const expectedOutcome = resolution.roll < contract.successRate * 10_000
    ? CONTRACT_RESOLUTION_OUTCOME.SUCCESS
    : CONTRACT_RESOLUTION_OUTCOME.FAILURE;
  if (resolution.outcome !== expectedOutcome) {
    return failure("CONTRACT_RESOLUTION_ROLL_MISMATCH", { contractId: contract.contractId });
  }
  if (!Array.isArray(resolution.lotMovementIds) || !Array.isArray(resolution.lineResults) ||
      resolution.lotMovementIds.some((movementId) => !isStableIdentifier(movementId))) {
    return failure("INVALID_CONTRACT_RESOLUTION_LINES", { contractId: contract.contractId });
  }
  if (resolution.outcome === CONTRACT_RESOLUTION_OUTCOME.FAILURE) {
    if (resolution.balanceTransactionId !== null || resolution.lotMovementIds.length !== 0 ||
        resolution.lineResults.length !== 0 || resolution.allocationG !== 0) {
      return failure("FAILED_CONTRACT_HAS_SUCCESS_EFFECTS", { contractId: contract.contractId });
    }
    return validationSuccess();
  }
  if (!isStableIdentifier(resolution.balanceTransactionId) ||
      resolution.lineResults.length !== contract.lines.length ||
      resolution.lotMovementIds.length !== contract.lines.length) {
    return failure("SUCCESS_CONTRACT_RESOLUTION_CARDINALITY", { contractId: contract.contractId });
  }
  const lineByIngredient = new Map(contract.lines.map((line) => [line.ingredientId, line]));
  let allocated;
  try {
    allocated = sumG(resolution.lineResults.map((line) => line.bookCostG), "contract resolution allocation");
  } catch {
    return failure("INVALID_CONTRACT_RESOLUTION_ALLOCATION");
  }
  for (let index = 0; index < resolution.lineResults.length; index += 1) {
    const line = resolution.lineResults[index];
    const source = lineByIngredient.get(line?.ingredientId);
    if (!source || !isStableIdentifier(line.lotId) ||
        line.movementId !== resolution.lotMovementIds[index] || !isStableIdentifier(line.movementId) ||
        line.quantity !== source.quantity || !Number.isInteger(line.quality) || line.quality < 0 || line.quality > 100) {
      return failure("INVALID_CONTRACT_RESOLUTION_LINE", { lineIndex: index });
    }
    try {
      requirePositiveG(line.bookCostG, "bookCostG");
    } catch {
      return failure("INVALID_CONTRACT_RESOLUTION_LINE_COST", { lineIndex: index });
    }
    if (index > 0 && compareStableIdentifiers(
      resolution.lineResults[index - 1].ingredientId,
      line.ingredientId,
    ) >= 0) {
      return failure("CONTRACT_RESOLUTION_LINE_ORDER_INVALID", { lineIndex: index });
    }
  }
  if (allocated !== contract.totalPriceG || resolution.allocationG !== contract.totalPriceG) {
    return failure("CONTRACT_RESOLUTION_ALLOCATION_MISMATCH", {
      expected: contract.totalPriceG,
      actual: allocated,
    });
  }
  return validationSuccess();
}

function validateAcceptedContract(contract) {
  const offer = validateContractOffer(contract, contract?.generatedDay);
  if (!offer.ok) return offer;
  const required = [
    "status", "acceptedDay", "resolutionDay", "acceptTransactionId", "acceptCauseId",
    "prepaidMovementId", "resolution",
  ];
  for (const field of required) {
    if (!own(contract, field)) return failure("MISSING_ACCEPTED_CONTRACT_FIELD", { field });
  }
  if (contract.acceptedDay !== contract.generatedDay || contract.resolutionDay !== contract.arrivalDay) {
    return failure("ACCEPTED_CONTRACT_DAY_MISMATCH", { contractId: contract.contractId });
  }
  for (const field of ["acceptTransactionId", "acceptCauseId", "prepaidMovementId"]) {
    if (!isStableIdentifier(contract[field])) return failure("INVALID_ACCEPTED_CONTRACT_ID", { field });
  }
  if (!Object.values(CONTRACT_STATUS).includes(contract.status)) {
    return failure("INVALID_CONTRACT_STATUS", { status: contract.status });
  }
  if (contract.status === CONTRACT_STATUS.ACCEPTED_PENDING ||
      contract.status === CONTRACT_STATUS.TERMINAL_CANCELLED) {
    if (contract.resolution !== null) return failure("PENDING_CONTRACT_HAS_RESOLUTION");
    return validationSuccess();
  }
  const record = validateResolutionRecord(contract);
  if (!record.ok) return record;
  const expectedStatus = contract.resolution.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS
    ? CONTRACT_STATUS.RESOLVED_SUCCESS
    : CONTRACT_STATUS.RESOLVED_FAILURE;
  if (contract.status !== expectedStatus) {
    return failure("CONTRACT_RESOLUTION_STATUS_MISMATCH", { contractId: contract.contractId });
  }
  return validationSuccess();
}

export function validateContractState(contracts) {
  if (!isPlainRecord(contracts)) return failure("INVALID_CONTRACT_STATE");
  const required = [
    "day", "fixedCostG", "offers", "contracts", "acceptedContractIdForDay",
    "processedResolutionIds",
  ];
  for (const field of required) {
    if (!own(contracts, field)) return failure("MISSING_CONTRACT_STATE_FIELD", { field });
  }
  const day = requireDay(contracts.day);
  if (!day.ok) return day;
  try {
    requireNonNegativeG(contracts.fixedCostG, "fixedCostG");
  } catch {
    return failure("INVALID_CONTRACT_FIXED_COST", { fixedCostG: contracts.fixedCostG });
  }
  if (!Array.isArray(contracts.offers) || contracts.offers.length < CONTRACT_MINIMUM_OFFER_COUNT) {
    return failure("CONTRACT_MINIMUM_OFFERS_NOT_MET", {
      minimum: CONTRACT_MINIMUM_OFFER_COUNT,
      actual: Array.isArray(contracts.offers) ? contracts.offers.length : null,
    });
  }
  const offerIds = new Set();
  const offerRisks = new Set();
  for (let index = 0; index < contracts.offers.length; index += 1) {
    const offer = contracts.offers[index];
    const validation = validateContractOffer(offer, contracts.day);
    if (!validation.ok) return failure(validation.code, { offerIndex: index, ...validation.details });
    if (offerIds.has(offer.offerId) || offerRisks.has(offer.risk)) {
      return failure("DUPLICATE_CONTRACT_OFFER", { offerId: offer.offerId, risk: offer.risk });
    }
    if (index > 0 && riskRank(contracts.offers[index - 1].risk) >= riskRank(offer.risk)) {
      return failure("CONTRACT_OFFER_ORDER_INVALID", { offerIndex: index });
    }
    offerIds.add(offer.offerId);
    offerRisks.add(offer.risk);
  }
  if (!Array.isArray(contracts.contracts)) return failure("INVALID_ACCEPTED_CONTRACT_COLLECTION");
  if (!Array.isArray(contracts.processedResolutionIds)) return failure("INVALID_RESOLUTION_ID_INDEX");
  const resolutionIds = new Set();
  for (const resolutionId of contracts.processedResolutionIds) {
    if (!isStableIdentifier(resolutionId) || resolutionIds.has(resolutionId)) {
      return failure("INVALID_OR_DUPLICATE_RESOLUTION_ID", { resolutionId });
    }
    resolutionIds.add(resolutionId);
  }
  const contractIds = new Set();
  const acceptedDays = new Set();
  const resolvedIds = new Set();
  let currentDayContractId = null;
  for (let index = 0; index < contracts.contracts.length; index += 1) {
    const contract = contracts.contracts[index];
    const validation = validateAcceptedContract(contract);
    if (!validation.ok) return failure(validation.code, { contractIndex: index, ...validation.details });
    if (contractIds.has(contract.contractId)) {
      return failure("DUPLICATE_CONTRACT_ID", { contractId: contract.contractId });
    }
    if (acceptedDays.has(contract.acceptedDay)) {
      return failure("MULTIPLE_CONTRACTS_ACCEPTED_FOR_DAY", { acceptedDay: contract.acceptedDay });
    }
    if (index > 0) {
      const previous = contracts.contracts[index - 1];
      if (previous.acceptedDay > contract.acceptedDay ||
          (previous.acceptedDay === contract.acceptedDay &&
            compareStableIdentifiers(previous.contractId, contract.contractId) >= 0)) {
        return failure("ACCEPTED_CONTRACT_ORDER_INVALID", { contractIndex: index });
      }
    }
    contractIds.add(contract.contractId);
    acceptedDays.add(contract.acceptedDay);
    if (contract.acceptedDay === contracts.day) currentDayContractId = contract.contractId;
    if (contract.status === CONTRACT_STATUS.RESOLVED_SUCCESS ||
        contract.status === CONTRACT_STATUS.RESOLVED_FAILURE) {
      const resolutionId = contract.resolution.resolutionId;
      resolvedIds.add(resolutionId);
      if (!resolutionIds.has(resolutionId)) {
        return failure("RESOLVED_CONTRACT_MISSING_INDEX", { resolutionId });
      }
    }
  }
  if (resolvedIds.size !== resolutionIds.size) {
    return failure("ORPHAN_PROCESSED_RESOLUTION_ID");
  }
  if (contracts.acceptedContractIdForDay !== currentDayContractId) {
    return failure("CURRENT_DAY_ACCEPTED_CONTRACT_INDEX_MISMATCH", {
      expected: currentDayContractId,
      actual: contracts.acceptedContractIdForDay,
    });
  }
  if (contracts.acceptedContractIdForDay !== null &&
      !isStableIdentifier(contracts.acceptedContractIdForDay)) {
    return failure("INVALID_CURRENT_DAY_CONTRACT_ID");
  }
  return validationSuccess();
}

export function createContractState({
  day,
  fixedCostG,
  offers,
  contracts = [],
  acceptedContractIdForDay = contracts.find((contract) => contract.acceptedDay === day)?.contractId ?? null,
  processedResolutionIds = contracts
    .filter((contract) => contract.status !== CONTRACT_STATUS.ACCEPTED_PENDING)
    .map((contract) => contract.resolution.resolutionId),
} = {}) {
  const state = {
    day,
    fixedCostG,
    offers: Array.isArray(offers) ? offers.map((offer) => cloneValue(offer)) : offers,
    contracts: Array.isArray(contracts) ? contracts.map((contract) => cloneValue(contract)) : contracts,
    acceptedContractIdForDay,
    processedResolutionIds: Array.isArray(processedResolutionIds)
      ? [...processedResolutionIds]
      : processedResolutionIds,
  };
  const validation = validateContractState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 ContractState입니다: ${validation.code}`);
    error.code = validation.code;
    error.details = validation.details;
    throw error;
  }
  return freezeDeep(state);
}

function buildOffer(day, risk, ingredients, registry) {
  const firstIndex = registry.nextInt(CONTRACT_OFFER_RNG_STREAM, ingredients.length);
  const secondOffset = 1 + registry.nextInt(CONTRACT_OFFER_RNG_STREAM, ingredients.length - 1);
  const selected = [
    ingredients[firstIndex],
    ingredients[(firstIndex + secondOffset) % ingredients.length],
  ].sort((left, right) => compareStableIdentifiers(left.ingredientId, right.ingredientId));
  const lines = selected.map((ingredient) => {
    const rangeSize = ingredient.marketStockRange.maximum - ingredient.marketStockRange.minimum + 1;
    const quantity = ingredient.marketStockRange.minimum +
      registry.nextInt(CONTRACT_OFFER_RNG_STREAM, rangeSize);
    return {
      ingredientId: ingredient.ingredientId,
      quantity,
      basePriceG: ingredient.basePriceG,
      marketExpectedCostG: checkedMultiplyPositive(
        ingredient.basePriceG,
        quantity,
        "contract offer expected cost",
      ),
      expectedQuality: expectedQuality(ingredient.qualityDistribution),
      qualityDistribution: cloneValue(ingredient.qualityDistribution),
    };
  });
  const policy = CONTRACT_RISK_TABLE[risk];
  const marketExpectedCostG = sumG(lines.map((line) => line.marketExpectedCostG), "contract expected cost");
  const totalPriceG = multiplyDivideHalfUp(marketExpectedCostG, 100 - policy.discountPercent, 100);
  const prepaidG = multiplyDivideHalfUp(totalPriceG, CONTRACT_PREPAID_PERCENT, 100);
  const balanceG = checkedSubtractG(totalPriceG, prepaidG, "contract balance");
  return {
    offerId: createContractOfferId(day, risk),
    contractId: createContractId(day, risk),
    generatedDay: day,
    arrivalDay: day + CONTRACT_ARRIVAL_DAY_OFFSET,
    risk,
    successRate: policy.successRate,
    discountPercent: policy.discountPercent,
    marketExpectedCostG,
    totalPriceG,
    prepaidG,
    balanceG,
    lossExposureG: prepaidG,
    lines,
  };
}

/**
 * Pure daily generator. It consumes only `contractOffer`, emits all three risk tiers in stable
 * order, and returns the final checkpoint state for composition with other named streams.
 */
export function generateDailyContractOffers({
  rngState,
  day,
  ingredients,
  configuration,
  fixedCostG,
} = {}) {
  const dayValidation = requireDay(day);
  if (!dayValidation.ok) throw Object.assign(new TypeError(dayValidation.code), { code: dayValidation.code });
  const ingredientValidation = validateCanonicalContractIngredients(ingredients);
  if (!ingredientValidation.ok) {
    throw Object.assign(new TypeError(ingredientValidation.code), { code: ingredientValidation.code });
  }
  const configurationValidation = validateCanonicalContractConfiguration(configuration);
  if (!configurationValidation.ok) {
    throw Object.assign(new TypeError(configurationValidation.code), { code: configurationValidation.code });
  }
  try {
    requireNonNegativeG(fixedCostG, "fixedCostG");
  } catch (error) {
    throw Object.assign(new TypeError("INVALID_CONTRACT_FIXED_COST"), {
      code: "INVALID_CONTRACT_FIXED_COST",
      cause: error,
    });
  }
  let registry;
  try {
    registry = RngRegistry.fromState(rngState);
  } catch (error) {
    throw Object.assign(new TypeError("INVALID_CONTRACT_OFFER_RNG_STATE"), {
      code: "INVALID_CONTRACT_OFFER_RNG_STATE",
      cause: error,
    });
  }
  if (!registry.hasStream(CONTRACT_OFFER_RNG_STREAM)) {
    throw Object.assign(new TypeError("CONTRACT_OFFER_RNG_STREAM_MISSING"), {
      code: "CONTRACT_OFFER_RNG_STREAM_MISSING",
    });
  }
  const streamBefore = registry.getStreamState(CONTRACT_OFFER_RNG_STREAM);
  const offers = CONTRACT_RISK_ORDER.map((risk) =>
    buildOffer(day, risk, ingredientValidation.ingredients, registry));
  const contracts = createContractState({ day, fixedCostG, offers });
  const finalRngState = registry.snapshot();
  const streamAfter = registry.getStreamState(CONTRACT_OFFER_RNG_STREAM);
  return freezeDeep({
    contracts,
    rngState: finalRngState,
    contractOfferStreamBefore: streamBefore,
    contractOfferStreamAfter: streamAfter,
    drawsConsumed: streamAfter.drawCount - streamBefore.drawCount,
  });
}

function chooseQuality(distribution, roll) {
  let cumulativeWeight = 0;
  let bucket = distribution[distribution.length - 1];
  for (let index = 0; index < distribution.length; index += 1) {
    cumulativeWeight += distribution[index].weight;
    const threshold = index === distribution.length - 1
      ? QUALITY_WEIGHT_SCALE
      : Math.round(cumulativeWeight * QUALITY_WEIGHT_SCALE);
    if (roll < threshold) {
      bucket = distribution[index];
      break;
    }
  }
  const width = bucket.maxQuality - bucket.minQuality + 1;
  return bucket.minQuality + (roll % width);
}

/**
 * Pure D+1 result generator. One logical `contractResolution` draw determines both the outcome
 * and deterministic per-line Quality; no offer, market, demand, or event stream is touched.
 */
export function generateContractResolution({ rngState, contract } = {}) {
  const contractValidation = validateAcceptedContract(contract);
  if (!contractValidation.ok || contract?.status !== CONTRACT_STATUS.ACCEPTED_PENDING) {
    throw Object.assign(new TypeError(contractValidation.ok ? "CONTRACT_NOT_PENDING" : contractValidation.code), {
      code: contractValidation.ok ? "CONTRACT_NOT_PENDING" : contractValidation.code,
    });
  }
  let registry;
  try {
    registry = RngRegistry.fromState(rngState);
  } catch (error) {
    throw Object.assign(new TypeError("INVALID_CONTRACT_RESOLUTION_RNG_STATE"), {
      code: "INVALID_CONTRACT_RESOLUTION_RNG_STATE",
      cause: error,
    });
  }
  if (!registry.hasStream(CONTRACT_RESOLUTION_RNG_STREAM)) {
    throw Object.assign(new TypeError("CONTRACT_RESOLUTION_RNG_STREAM_MISSING"), {
      code: "CONTRACT_RESOLUTION_RNG_STREAM_MISSING",
    });
  }
  const streamBefore = registry.getStreamState(CONTRACT_RESOLUTION_RNG_STREAM);
  const roll = registry.nextInt(CONTRACT_RESOLUTION_RNG_STREAM, QUALITY_WEIGHT_SCALE);
  const outcome = roll < contract.successRate * 10_000
    ? CONTRACT_RESOLUTION_OUTCOME.SUCCESS
    : CONTRACT_RESOLUTION_OUTCOME.FAILURE;
  const lineResults = outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS
    ? contract.lines.map((line, index) => {
      const mixedRoll = ((roll + Math.imul(index + 1, 0x9e3779b9)) >>> 0) % QUALITY_WEIGHT_SCALE;
      return {
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        quality: chooseQuality(line.qualityDistribution, mixedRoll),
      };
    })
    : [];
  const finalRngState = registry.snapshot();
  const streamAfter = registry.getStreamState(CONTRACT_RESOLUTION_RNG_STREAM);
  return freezeDeep({
    result: {
      resolutionId: createContractResolutionId(contract.contractId),
      contractId: contract.contractId,
      resolvedDay: contract.resolutionDay,
      outcome,
      roll,
      successRate: contract.successRate,
      lineResults,
    },
    rngState: finalRngState,
    contractResolutionStreamBefore: streamBefore,
    contractResolutionStreamAfter: streamAfter,
    drawsConsumed: streamAfter.drawCount - streamBefore.drawCount,
  });
}

/** Half-Up proportional allocation with stable ingredient-ID 1G remainder correction. */
export function allocateContractBookCost(contract) {
  const validation = validateContractOffer(contract, contract?.generatedDay);
  if (!validation.ok) {
    throw Object.assign(new TypeError(validation.code), { code: validation.code });
  }
  const allocations = contract.lines.map((line) => ({
    ingredientId: line.ingredientId,
    bookCostG: multiplyDivideHalfUp(
      contract.totalPriceG,
      line.marketExpectedCostG,
      contract.marketExpectedCostG,
    ),
  })).sort((left, right) => compareStableIdentifiers(left.ingredientId, right.ingredientId));
  let difference = checkedSubtractG(
    contract.totalPriceG,
    sumG(allocations.map((allocation) => allocation.bookCostG), "initial contract allocation"),
    "contract allocation remainder",
  );
  let cursor = 0;
  while (difference !== 0) {
    const allocation = allocations[cursor % allocations.length];
    if (difference > 0) {
      allocation.bookCostG = checkedAddG(allocation.bookCostG, 1, "contract allocation remainder add");
      difference -= 1;
    } else if (allocation.bookCostG > 1) {
      allocation.bookCostG = checkedSubtractG(allocation.bookCostG, 1, "contract allocation remainder subtract");
      difference += 1;
    }
    cursor += 1;
    if (cursor > allocations.length * 4 && difference !== 0) {
      throw new RangeError("contract allocation remainder를 안정적으로 배분할 수 없습니다.");
    }
  }
  return freezeDeep(allocations);
}

/** Read-only Planning projection including liquidity and Fixed Cost confirmation guards. */
export function projectContracts(contracts, economy) {
  const stateValidation = validateContractState(contracts);
  if (!stateValidation.ok) throw new TypeError(`Contract projection state가 유효하지 않습니다: ${stateValidation.code}`);
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) throw new TypeError(`Contract projection economy가 유효하지 않습니다: ${economyValidation.code}`);
  const availableCashG = calculateAvailableCashG(economy);
  const acceptedToday = contracts.acceptedContractIdForDay !== null;
  return freezeDeep({
    day: contracts.day,
    fixedCostG: contracts.fixedCostG,
    availableCashG,
    acceptedContractIdForDay: contracts.acceptedContractIdForDay,
    offers: contracts.offers.map((offer) => {
      const arrivalWithinCampaign = offer.arrivalDay <= 14;
      const liquiditySatisfied = availableCashG >= offer.totalPriceG;
      const availableAfterAcceptanceG = liquiditySatisfied
        ? checkedSubtractG(availableCashG, offer.totalPriceG, "contract projected available cash")
        : null;
      const fixedCostRiskConfirmationRequired = liquiditySatisfied &&
        availableAfterAcceptanceG < contracts.fixedCostG;
      const disabledReason = acceptedToday
        ? "CONTRACT_ALREADY_ACCEPTED_FOR_DAY"
        : !arrivalWithinCampaign
          ? "CONTRACT_ARRIVAL_AFTER_CAMPAIGN"
          : !liquiditySatisfied
            ? "INSUFFICIENT_AVAILABLE_CASH"
            : null;
      return {
        ...cloneValue(offer),
        acceptanceEnabled: disabledReason === null,
        disabledReason,
        availableAfterAcceptanceG,
        fixedCostRiskConfirmationRequired,
      };
    }),
    contracts: contracts.contracts.map((contract) => cloneValue(contract)),
    pendingContractIds: contracts.contracts
      .filter((contract) => contract.status === CONTRACT_STATUS.ACCEPTED_PENDING)
      .map((contract) => contract.contractId),
  });
}

export function validateAcceptContractPayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_CONTRACT_ACCEPT_PAYLOAD");
  for (const field of ["day", "offerId", "fixedCostRiskConfirmed"]) {
    if (!own(payload, field)) return failure("MISSING_CONTRACT_ACCEPT_FIELD", { field });
  }
  const day = requireDay(payload.day);
  if (!day.ok) return day;
  if (!isStableIdentifier(payload.offerId)) return failure("INVALID_CONTRACT_OFFER_ID");
  if (typeof payload.fixedCostRiskConfirmed !== "boolean") {
    return failure("INVALID_FIXED_COST_RISK_CONFIRMATION");
  }
  return validationSuccess();
}

export function validateResolveContractPayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_CONTRACT_RESOLVE_PAYLOAD");
  for (const field of ["day", "contractId"]) {
    if (!own(payload, field)) return failure("MISSING_CONTRACT_RESOLVE_FIELD", { field });
  }
  const day = requireDay(payload.day);
  if (!day.ok) return day;
  if (!isStableIdentifier(payload.contractId)) return failure("INVALID_CONTRACT_ID");
  return validationSuccess();
}

function validateCampaign(campaign, day) {
  if (!isPlainRecord(campaign) || !isStableIdentifier(campaign.campaignId)) {
    return failure("INVALID_CAMPAIGN_STATE");
  }
  const campaignDay = requireDay(campaign.day, "campaign.day");
  if (!campaignDay.ok) return campaignDay;
  if (campaign.day !== day) {
    return failure("CONTRACT_CAMPAIGN_DAY_MISMATCH", { campaignDay: campaign.day, requestedDay: day });
  }
  return validationSuccess();
}

function createIdService(idCounters, campaign, day, generationId, codePrefix) {
  let idService;
  try {
    idService = IdService.fromState(idCounters);
  } catch {
    return failure(`INVALID_${codePrefix}_ID_STATE`);
  }
  if (idService.campaignId !== campaign.campaignId) {
    return failure(`${codePrefix}_ID_CAMPAIGN_MISMATCH`);
  }
  if (idService.day !== day) return failure(`${codePrefix}_ID_DAY_MISMATCH`);
  if (idService.generationId !== generationId) return failure(`${codePrefix}_ID_GENERATION_MISMATCH`);
  return Object.freeze({ ok: true, idService });
}

function allocateAcceptIds(idCounters, campaign, day, generationId) {
  const service = createIdService(idCounters, campaign, day, generationId, "CONTRACT_ACCEPT");
  if (!service.ok) return service;
  try {
    const transactionId = service.idService.next("tx");
    const causeId = service.idService.next("cause");
    const prepaidMovementId = `${transactionId}.prepaid`;
    const eventId = `${transactionId}.committed`;
    if (![transactionId, causeId, prepaidMovementId, eventId].every(isStableIdentifier)) {
      return failure("GENERATED_CONTRACT_ACCEPT_ID_INVALID");
    }
    return success({
      transactionId,
      causeId,
      prepaidMovementId,
      eventId,
      idCounters: service.idService.snapshot(),
    });
  } catch {
    return failure("CONTRACT_ACCEPT_ID_ALLOCATION_FAILED");
  }
}

function allocateResolutionIds(idCounters, campaign, contract, generationId, outcome) {
  const service = createIdService(
    idCounters,
    campaign,
    contract.resolutionDay,
    generationId,
    "CONTRACT_RESOLUTION",
  );
  if (!service.ok) return service;
  try {
    const resolutionId = createContractResolutionId(contract.contractId);
    const causeId = service.idService.next("cause");
    const balanceTransactionId = outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS
      ? service.idService.next("tx")
      : null;
    const prepaidDispositionMovementId = `${resolutionId}.prepaid`;
    const lotIds = outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS
      ? contract.lines.map(() => service.idService.next("lot"))
      : [];
    const lotMovementIds = lotIds.map((_lotId, index) =>
      `${resolutionId}.lot.${String(index).padStart(3, "0")}`);
    const eventId = `${resolutionId}.committed`;
    if (![causeId, prepaidDispositionMovementId, eventId, ...lotIds, ...lotMovementIds]
      .every(isStableIdentifier) ||
      (balanceTransactionId !== null && !isStableIdentifier(balanceTransactionId))) {
      return failure("GENERATED_CONTRACT_RESOLUTION_ID_INVALID");
    }
    return success({
      resolutionId,
      causeId,
      balanceTransactionId,
      prepaidDispositionMovementId,
      lotIds,
      lotMovementIds,
      eventId,
      idCounters: service.idService.snapshot(),
    });
  } catch {
    return failure("CONTRACT_RESOLUTION_ID_ALLOCATION_FAILED");
  }
}

function contractCashRequest({ transactionId, day, category, amountG, causeId }) {
  const policy = CASH_TRANSACTION_POLICIES[category];
  return {
    transactionId,
    day,
    category,
    type: policy.type,
    direction: policy.direction,
    amountG,
    causeId,
  };
}

/** Detached full preview for AcceptContract; all Task 13/14 writes are delegated. */
export function planAcceptContract({
  economy,
  contracts,
  inventory,
  inventoryAccounting,
  idCounters,
  campaign,
  runtimePhase,
  generationId,
}, payload) {
  const payloadValidation = validateAcceptContractPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== "PLANNING") return failure("CONTRACT_ACCEPT_REQUIRES_PLANNING");
  const stateValidation = validateContractState(contracts);
  if (!stateValidation.ok) return failure("CONTRACT_STATE_INVALID", { cause: stateValidation.code });
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  const accountingValidation = validateInventoryAccountingState(inventoryAccounting);
  if (!accountingValidation.ok) {
    return failure("INVENTORY_ACCOUNTING_STATE_INVALID", { cause: accountingValidation.code });
  }
  const campaignValidation = validateCampaign(campaign, payload.day);
  if (!campaignValidation.ok) return campaignValidation;
  if (contracts.day !== payload.day) {
    return failure("CONTRACT_OFFER_DAY_MISMATCH", { contractDay: contracts.day, payloadDay: payload.day });
  }
  if (contracts.acceptedContractIdForDay !== null ||
      contracts.contracts.some((contract) => contract.acceptedDay === payload.day)) {
    return failure("CONTRACT_ALREADY_ACCEPTED_FOR_DAY", {
      contractId: contracts.acceptedContractIdForDay,
    });
  }
  const offer = contracts.offers.find((candidate) => candidate.offerId === payload.offerId);
  if (!offer) return failure("CONTRACT_OFFER_NOT_FOUND", { offerId: payload.offerId });
  if (offer.arrivalDay > 14) {
    return failure("CONTRACT_ARRIVAL_AFTER_CAMPAIGN", { arrivalDay: offer.arrivalDay });
  }
  const availableCashG = calculateAvailableCashG(economy);
  if (availableCashG < offer.totalPriceG) {
    return failure("INSUFFICIENT_AVAILABLE_CASH", { amountG: offer.totalPriceG, availableCashG });
  }
  const availableAfterAcceptanceG = checkedSubtractG(
    availableCashG,
    offer.totalPriceG,
    "contract available cash after acceptance",
  );
  if (availableAfterAcceptanceG < contracts.fixedCostG && payload.fixedCostRiskConfirmed !== true) {
    return failure("FIXED_COST_RISK_CONFIRMATION_REQUIRED", {
      availableAfterAcceptanceG,
      fixedCostG: contracts.fixedCostG,
    });
  }
  const ids = allocateAcceptIds(idCounters, campaign, payload.day, generationId);
  if (!ids.ok) return ids;

  const economyCandidate = cloneValue(economy);
  const accountingCandidate = cloneValue(inventoryAccounting);
  const prepaidCash = applyCashTransactionToDraft(economyCandidate, contractCashRequest({
    transactionId: ids.plan.transactionId,
    day: payload.day,
    category: LEDGER_CATEGORY.CONTRACT_PREPAID,
    amountG: offer.prepaidG,
    causeId: ids.plan.causeId,
  }), runtimePhase);
  if (!prepaidCash.ok) return prepaidCash;
  const prepaidAsset = applyContractPrepaidCapitalizationToDraft(economyCandidate, accountingCandidate, {
    movementId: ids.plan.prepaidMovementId,
    day: payload.day,
    causeId: ids.plan.causeId,
    contractId: offer.contractId,
    amountG: offer.prepaidG,
  });
  if (!prepaidAsset.ok) return prepaidAsset;
  const reserve = applyContractReserveChangeToDraft(economyCandidate, {
    operation: CONTRACT_RESERVE_OPERATION.RESERVE,
    amountG: offer.balanceG,
  });
  if (!reserve.ok) return reserve;

  const acceptedContract = {
    ...cloneValue(offer),
    status: CONTRACT_STATUS.ACCEPTED_PENDING,
    acceptedDay: payload.day,
    resolutionDay: offer.arrivalDay,
    acceptTransactionId: ids.plan.transactionId,
    acceptCauseId: ids.plan.causeId,
    prepaidMovementId: ids.plan.prepaidMovementId,
    resolution: null,
  };
  let contractsCandidate;
  try {
    contractsCandidate = createContractState({
      ...contracts,
      contracts: [...contracts.contracts, acceptedContract],
      acceptedContractIdForDay: acceptedContract.contractId,
    });
  } catch (error) {
    return failure(error?.code ?? "CONTRACT_STATE_INVALID_AFTER_ACCEPT");
  }
  const inventoryReconciliation = reconcileInventoryAccounting(
    inventory,
    accountingCandidate,
    { economy: economyCandidate },
  );
  if (!inventoryReconciliation.ok) return failure(inventoryReconciliation.code, inventoryReconciliation);
  const ledgerEntry = economyCandidate.ledger[economyCandidate.ledger.length - 1];
  const cashReconciliation = reconcileCashWithLedger(economy.cashG, economyCandidate.cashG, [ledgerEntry]);
  if (!cashReconciliation.ok) return failure(cashReconciliation.code, cashReconciliation);
  return success({
    economy: economyCandidate,
    contracts: contractsCandidate,
    inventoryAccounting: accountingCandidate,
    idCounters: ids.plan.idCounters,
    acceptedContract,
    transactionId: ids.plan.transactionId,
    causeId: ids.plan.causeId,
    prepaidMovementId: ids.plan.prepaidMovementId,
    eventId: ids.plan.eventId,
    ledgerEntry,
    availableCashBeforeG: availableCashG,
    availableCashAfterG: calculateAvailableCashG(economyCandidate),
    fixedCostRiskConfirmed: payload.fixedCostRiskConfirmed,
  });
}

/** Detached full preview for ResolveContract; exactly one success/failure branch is applied. */
export function planResolveContract({
  economy,
  contracts,
  inventory,
  inventoryAccounting,
  idCounters,
  rng,
  campaign,
  runtimePhase,
  generationId,
}, payload) {
  const payloadValidation = validateResolveContractPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== "PLANNING") return failure("CONTRACT_RESOLUTION_REQUIRES_PLANNING");
  const stateValidation = validateContractState(contracts);
  if (!stateValidation.ok) return failure("CONTRACT_STATE_INVALID", { cause: stateValidation.code });
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  const accountingValidation = validateInventoryAccountingState(inventoryAccounting);
  if (!accountingValidation.ok) {
    return failure("INVENTORY_ACCOUNTING_STATE_INVALID", { cause: accountingValidation.code });
  }
  const campaignValidation = validateCampaign(campaign, payload.day);
  if (!campaignValidation.ok) return campaignValidation;
  if (contracts.day !== payload.day) {
    return failure("CONTRACT_RESOLUTION_STATE_DAY_MISMATCH", {
      contractStateDay: contracts.day,
      payloadDay: payload.day,
    });
  }
  const contractIndex = contracts.contracts.findIndex((candidate) => candidate.contractId === payload.contractId);
  if (contractIndex < 0) return failure("CONTRACT_NOT_FOUND", { contractId: payload.contractId });
  const contract = contracts.contracts[contractIndex];
  const resolutionId = createContractResolutionId(contract.contractId);
  if (contracts.processedResolutionIds.includes(resolutionId) ||
      contract.status !== CONTRACT_STATUS.ACCEPTED_PENDING) {
    return failure(
      contracts.processedResolutionIds.includes(resolutionId)
        ? "DUPLICATE_CONTRACT_RESOLUTION"
        : "CONTRACT_NOT_PENDING",
      { contractId: contract.contractId, resolutionId },
    );
  }
  if (contract.resolutionDay !== payload.day) {
    return failure("CONTRACT_RESOLUTION_DAY_MISMATCH", {
      expectedDay: contract.resolutionDay,
      actualDay: payload.day,
    });
  }

  let generated;
  try {
    generated = generateContractResolution({ rngState: rng, contract });
  } catch (error) {
    return failure(error?.code ?? "CONTRACT_RESOLUTION_GENERATION_FAILED");
  }
  const ids = allocateResolutionIds(
    idCounters,
    campaign,
    contract,
    generationId,
    generated.result.outcome,
  );
  if (!ids.ok) return ids;
  const economyCandidate = cloneValue(economy);
  const inventoryCandidate = cloneValue(inventory);
  const accountingCandidate = cloneValue(inventoryAccounting);
  const lineResults = [];
  let ledgerEntry = null;

  if (generated.result.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS) {
    const balanceCash = applyCashTransactionToDraft(economyCandidate, contractCashRequest({
      transactionId: ids.plan.balanceTransactionId,
      day: payload.day,
      category: LEDGER_CATEGORY.CONTRACT_BALANCE,
      amountG: contract.balanceG,
      causeId: ids.plan.causeId,
    }), runtimePhase);
    if (!balanceCash.ok) return balanceCash;
    ledgerEntry = balanceCash.plan.entry;
    const prepaidApplication = applyContractPrepaidApplicationToDraft(economyCandidate, accountingCandidate, {
      movementId: ids.plan.prepaidDispositionMovementId,
      day: payload.day,
      causeId: ids.plan.causeId,
      contractId: contract.contractId,
      amountG: contract.prepaidG,
    });
    if (!prepaidApplication.ok) return prepaidApplication;
    let allocations;
    try {
      allocations = allocateContractBookCost(contract);
    } catch (error) {
      return failure(error?.code ?? "CONTRACT_ALLOCATION_FAILED");
    }
    const allocationByIngredient = new Map(
      allocations.map((allocation) => [allocation.ingredientId, allocation.bookCostG]),
    );
    const generatedByIngredient = new Map(
      generated.result.lineResults.map((line) => [line.ingredientId, line]),
    );
    for (let index = 0; index < contract.lines.length; index += 1) {
      const line = contract.lines[index];
      const qualityResult = generatedByIngredient.get(line.ingredientId);
      const lot = {
        lotId: ids.plan.lotIds[index],
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        quality: qualityResult.quality,
        bookCostG: allocationByIngredient.get(line.ingredientId),
        acquiredDay: payload.day,
      };
      const acquisition = applyLotAcquisitionToDraft(inventoryCandidate, accountingCandidate, {
        movementId: ids.plan.lotMovementIds[index],
        day: payload.day,
        causeId: ids.plan.causeId,
        source: INVENTORY_ACQUISITION_SOURCE.SUCCESSFUL_CONTRACT,
        lot,
      });
      if (!acquisition.ok) return acquisition;
      lineResults.push({
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        quality: lot.quality,
        bookCostG: lot.bookCostG,
        lotId: lot.lotId,
        movementId: ids.plan.lotMovementIds[index],
      });
    }
  } else {
    const released = applyContractReserveChangeToDraft(economyCandidate, {
      operation: CONTRACT_RESERVE_OPERATION.RELEASE,
      amountG: contract.balanceG,
    });
    if (!released.ok) return released;
    const loss = applyContractFailureLossToDraft(economyCandidate, accountingCandidate, {
      movementId: ids.plan.prepaidDispositionMovementId,
      day: payload.day,
      causeId: ids.plan.causeId,
      contractId: contract.contractId,
      amountG: contract.prepaidG,
    });
    if (!loss.ok) return loss;
  }

  const resolution = {
    ...cloneValue(generated.result),
    causeId: ids.plan.causeId,
    balanceTransactionId: ids.plan.balanceTransactionId,
    prepaidDispositionMovementId: ids.plan.prepaidDispositionMovementId,
    lotMovementIds: [...ids.plan.lotMovementIds],
    lineResults,
    allocationG: generated.result.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS
      ? contract.totalPriceG
      : 0,
  };
  const resolvedContract = {
    ...cloneValue(contract),
    status: generated.result.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS
      ? CONTRACT_STATUS.RESOLVED_SUCCESS
      : CONTRACT_STATUS.RESOLVED_FAILURE,
    resolution,
  };
  const acceptedContracts = contracts.contracts.map((candidate, index) =>
    index === contractIndex ? resolvedContract : cloneValue(candidate));
  let contractsCandidate;
  try {
    contractsCandidate = createContractState({
      ...contracts,
      contracts: acceptedContracts,
      processedResolutionIds: [...contracts.processedResolutionIds, resolution.resolutionId],
    });
  } catch (error) {
    return failure(error?.code ?? "CONTRACT_STATE_INVALID_AFTER_RESOLUTION");
  }
  const inventoryReconciliation = reconcileInventoryAccounting(
    inventoryCandidate,
    accountingCandidate,
    { economy: economyCandidate },
  );
  if (!inventoryReconciliation.ok) return failure(inventoryReconciliation.code, inventoryReconciliation);
  if (ledgerEntry !== null) {
    const cashReconciliation = reconcileCashWithLedger(economy.cashG, economyCandidate.cashG, [ledgerEntry]);
    if (!cashReconciliation.ok) return failure(cashReconciliation.code, cashReconciliation);
  } else if (economyCandidate.cashG !== economy.cashG ||
      economyCandidate.ledger.length !== economy.ledger.length) {
    return failure("FAILED_CONTRACT_CASH_CHANGED");
  }
  return success({
    economy: economyCandidate,
    contracts: contractsCandidate,
    inventory: inventoryCandidate,
    inventoryAccounting: accountingCandidate,
    idCounters: ids.plan.idCounters,
    rng: generated.rngState,
    contractBefore: contract,
    resolvedContract,
    resolution,
    ledgerEntry,
    eventId: ids.plan.eventId,
    resolutionDrawsConsumed: generated.drawsConsumed,
  });
}

function validateAcceptPostconditions(before, after, planned) {
  for (const slice of CONTRACT_ACCEPT_WRITE_SET) {
    if (!equivalent(after[slice], planned[slice])) {
      return failure("CONTRACT_ACCEPT_PLAN_MISMATCH", { slice });
    }
  }
  const economyTransition = validateEconomyTransition(before.economy, after.economy);
  if (!economyTransition.ok || economyTransition.details?.appendedCount !== 1) {
    return failure(economyTransition.ok ? "CONTRACT_ACCEPT_LEDGER_CARDINALITY" : economyTransition.code, {
      appendedCount: economyTransition.details?.appendedCount,
    });
  }
  const costTransition = validateCostMovementAppendOnly(
    before.inventoryAccounting,
    after.inventoryAccounting,
  );
  if (!costTransition.ok || costTransition.details?.appendedCount !== 1) {
    return failure(costTransition.ok ? "CONTRACT_ACCEPT_COST_CARDINALITY" : costTransition.code, {
      appendedCount: costTransition.details?.appendedCount,
    });
  }
  const stateValidation = validateContractState(after.contracts);
  if (!stateValidation.ok) return stateValidation;
  const cashReconciliation = reconcileCashWithLedger(
    before.economy.cashG,
    after.economy.cashG,
    [planned.ledgerEntry],
  );
  if (!cashReconciliation.ok) return failure(cashReconciliation.code, cashReconciliation);
  const inventoryReconciliation = reconcileInventoryAccounting(
    before.inventory,
    after.inventoryAccounting,
    { economy: after.economy },
  );
  if (!inventoryReconciliation.ok) return failure(inventoryReconciliation.code, inventoryReconciliation);
  if (planned.acceptedContract.prepaidG + planned.acceptedContract.balanceG !==
      planned.acceptedContract.totalPriceG ||
      after.economy.contractReserveG - before.economy.contractReserveG !==
        planned.acceptedContract.balanceG ||
      after.economy.contractPrepaidAssetG - before.economy.contractPrepaidAssetG !==
        planned.acceptedContract.prepaidG) {
    return failure("CONTRACT_ACCEPT_CONSIDERATION_MISMATCH");
  }
  return validationSuccess({
    cash: cashReconciliation.code,
    inventory: inventoryReconciliation.code,
    prepaidG: planned.acceptedContract.prepaidG,
    reservedBalanceG: planned.acceptedContract.balanceG,
  });
}

function validateResolvePostconditions(before, after, planned) {
  for (const slice of CONTRACT_RESOLVE_WRITE_SET) {
    if (!equivalent(after[slice], planned[slice])) {
      return failure("CONTRACT_RESOLUTION_PLAN_MISMATCH", { slice });
    }
  }
  const successOutcome = planned.resolution.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS;
  const economyTransition = validateEconomyTransition(before.economy, after.economy);
  if (!economyTransition.ok) return economyTransition;
  const expectedLedgerAppends = successOutcome ? 1 : 0;
  if (economyTransition.details?.appendedCount !== expectedLedgerAppends) {
    return failure("CONTRACT_RESOLUTION_LEDGER_CARDINALITY", {
      expected: expectedLedgerAppends,
      actual: economyTransition.details?.appendedCount,
    });
  }
  const costTransition = validateCostMovementAppendOnly(
    before.inventoryAccounting,
    after.inventoryAccounting,
  );
  if (!costTransition.ok) return costTransition;
  const expectedCostAppends = successOutcome
    ? 1 + planned.resolvedContract.lines.length
    : 1;
  if (costTransition.details?.appendedCount !== expectedCostAppends) {
    return failure("CONTRACT_RESOLUTION_COST_CARDINALITY", {
      expected: expectedCostAppends,
      actual: costTransition.details?.appendedCount,
    });
  }
  const stateValidation = validateContractState(after.contracts);
  if (!stateValidation.ok) return stateValidation;
  const inventoryValidation = validateInventoryState(after.inventory);
  if (!inventoryValidation.ok) return inventoryValidation;
  const reconciliation = reconcileInventoryAccounting(
    after.inventory,
    after.inventoryAccounting,
    { economy: after.economy },
  );
  if (!reconciliation.ok) return failure(reconciliation.code, reconciliation);
  if (before.economy.contractReserveG - after.economy.contractReserveG !==
      planned.contractBefore.balanceG ||
      before.economy.contractPrepaidAssetG - after.economy.contractPrepaidAssetG !==
        planned.contractBefore.prepaidG) {
    return failure("CONTRACT_RESOLUTION_ASSET_RELEASE_MISMATCH");
  }
  if (successOutcome) {
    const appendedLedger = after.economy.ledger.slice(before.economy.ledger.length);
    const cash = reconcileCashWithLedger(before.economy.cashG, after.economy.cashG, appendedLedger);
    if (!cash.ok || planned.ledgerEntry.amountG !== planned.contractBefore.balanceG) {
      return failure(cash.ok ? "CONTRACT_BALANCE_LEDGER_MISMATCH" : cash.code, cash);
    }
    const acquiredLots = after.inventory.lots.slice(before.inventory.lots.length);
    const allocatedG = sumG(acquiredLots.map((lot) => lot.bookCostG), "contract acquired lot costs");
    if (allocatedG !== planned.contractBefore.totalPriceG ||
        acquiredLots.length !== planned.contractBefore.lines.length) {
      return failure("CONTRACT_SUCCESS_LOT_ALLOCATION_MISMATCH", { allocatedG });
    }
  } else if (after.economy.cashG !== before.economy.cashG ||
      after.inventory.lots.length !== before.inventory.lots.length ||
      after.inventoryAccounting.contractFailureLossG -
        before.inventoryAccounting.contractFailureLossG !== planned.contractBefore.prepaidG) {
    return failure("CONTRACT_FAILURE_DISPOSITION_MISMATCH");
  }
  const resolutionBefore = before.rng.streams[CONTRACT_RESOLUTION_RNG_STREAM];
  const resolutionAfter = after.rng.streams[CONTRACT_RESOLUTION_RNG_STREAM];
  if (resolutionAfter.drawCount - resolutionBefore.drawCount !== planned.resolutionDrawsConsumed) {
    return failure("CONTRACT_RESOLUTION_CURSOR_MISMATCH");
  }
  for (const stream of Object.keys(before.rng.streams)) {
    if (stream === CONTRACT_RESOLUTION_RNG_STREAM) continue;
    if (!equivalent(before.rng.streams[stream], after.rng.streams[stream])) {
      return failure("CONTRACT_RESOLUTION_STREAM_ISOLATION_FAILURE", { stream });
    }
  }
  return validationSuccess({
    inventory: reconciliation.code,
    outcome: planned.resolution.outcome,
    ledgerAppends: expectedLedgerAppends,
    costMovementAppends: expectedCostAppends,
  });
}

function acceptPlanFromSnapshot(snapshot, ctx) {
  return planAcceptContract({
    economy: snapshot.economy,
    contracts: snapshot.contracts,
    inventory: snapshot.inventory,
    inventoryAccounting: snapshot.inventoryAccounting,
    idCounters: snapshot.idCounters,
    campaign: snapshot.campaign,
    runtimePhase: snapshot.runtimePhase,
    generationId: snapshot.generationId,
  }, ctx.command.payload);
}

function resolutionPlanFromSnapshot(snapshot, ctx) {
  return planResolveContract({
    economy: snapshot.economy,
    contracts: snapshot.contracts,
    inventory: snapshot.inventory,
    inventoryAccounting: snapshot.inventoryAccounting,
    idCounters: snapshot.idCounters,
    rng: snapshot.rng,
    campaign: snapshot.campaign,
    runtimePhase: snapshot.runtimePhase,
    generationId: snapshot.generationId,
  }, ctx.command.payload);
}

export function createAcceptContractAtomicTransaction() {
  return defineAtomicTransaction({
    name: CONTRACT_COMMAND.ACCEPT,
    readSet: CONTRACT_ACCEPT_READ_SET,
    writeSet: CONTRACT_ACCEPT_WRITE_SET,
    allowedPhases: CONTRACT_PHASES,
    validatePayload(ctx) {
      return validateAcceptContractPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planAcceptContract({
        economy: ctx.read("economy"),
        contracts: ctx.read("contracts"),
        inventory: ctx.read("inventory"),
        inventoryAccounting: ctx.read("inventoryAccounting"),
        idCounters: ctx.read("idCounters"),
        campaign: ctx.read("campaign"),
        runtimePhase: ctx.phase,
        generationId: ctx.generationId,
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planAcceptContract({
        economy: draft.read("economy"),
        contracts: draft.read("contracts"),
        inventory: draft.read("inventory"),
        inventoryAccounting: draft.read("inventoryAccounting"),
        idCounters: draft.read("idCounters"),
        campaign: draft.read("campaign"),
        runtimePhase: "PLANNING",
        generationId: draft.command.generationId,
      }, draft.command.payload);
      if (!planned.ok) return planned;
      for (const slice of CONTRACT_ACCEPT_WRITE_SET) draft.replace(slice, planned.plan[slice]);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = acceptPlanFromSnapshot(before, ctx);
      return planned.ok ? validateAcceptPostconditions(before, after, planned.plan) : planned;
    },
    events(before, _after, ctx) {
      const planned = acceptPlanFromSnapshot(before, ctx);
      if (!planned.ok) return [];
      return [{
        eventId: planned.plan.eventId,
        causeId: planned.plan.causeId,
        type: "contract.accepted",
        payload: {
          contractId: planned.plan.acceptedContract.contractId,
          offerId: ctx.command.payload.offerId,
          day: planned.plan.acceptedContract.acceptedDay,
          arrivalDay: planned.plan.acceptedContract.arrivalDay,
          risk: planned.plan.acceptedContract.risk,
          totalPriceG: planned.plan.acceptedContract.totalPriceG,
          prepaidG: planned.plan.acceptedContract.prepaidG,
          balanceG: planned.plan.acceptedContract.balanceG,
          transactionId: planned.plan.transactionId,
          prepaidMovementId: planned.plan.prepaidMovementId,
        },
      }];
    },
  });
}

export function createResolveContractAtomicTransaction() {
  return defineAtomicTransaction({
    name: CONTRACT_COMMAND.RESOLVE,
    readSet: CONTRACT_RESOLVE_READ_SET,
    writeSet: CONTRACT_RESOLVE_WRITE_SET,
    allowedPhases: CONTRACT_PHASES,
    validatePayload(ctx) {
      return validateResolveContractPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planResolveContract({
        economy: ctx.read("economy"),
        contracts: ctx.read("contracts"),
        inventory: ctx.read("inventory"),
        inventoryAccounting: ctx.read("inventoryAccounting"),
        idCounters: ctx.read("idCounters"),
        rng: ctx.read("rng"),
        campaign: ctx.read("campaign"),
        runtimePhase: ctx.phase,
        generationId: ctx.generationId,
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planResolveContract({
        economy: draft.read("economy"),
        contracts: draft.read("contracts"),
        inventory: draft.read("inventory"),
        inventoryAccounting: draft.read("inventoryAccounting"),
        idCounters: draft.read("idCounters"),
        rng: draft.read("rng"),
        campaign: draft.read("campaign"),
        runtimePhase: "PLANNING",
        generationId: draft.command.generationId,
      }, draft.command.payload);
      if (!planned.ok) return planned;
      for (const slice of CONTRACT_RESOLVE_WRITE_SET) draft.replace(slice, planned.plan[slice]);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = resolutionPlanFromSnapshot(before, ctx);
      return planned.ok ? validateResolvePostconditions(before, after, planned.plan) : planned;
    },
    events(before, _after, ctx) {
      const planned = resolutionPlanFromSnapshot(before, ctx);
      if (!planned.ok) return [];
      return [{
        eventId: planned.plan.eventId,
        causeId: planned.plan.resolution.causeId,
        type: "contract.resolved",
        payload: {
          contractId: planned.plan.resolvedContract.contractId,
          resolutionId: planned.plan.resolution.resolutionId,
          day: ctx.command.payload.day,
          outcome: planned.plan.resolution.outcome,
          balancePaidG: planned.plan.resolution.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS
            ? planned.plan.contractBefore.balanceG
            : 0,
          prepaidLossG: planned.plan.resolution.outcome === CONTRACT_RESOLUTION_OUTCOME.FAILURE
            ? planned.plan.contractBefore.prepaidG
            : 0,
          lotIds: planned.plan.resolution.lineResults.map((line) => line.lotId),
        },
      }];
    },
  });
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

/** Production facade for Contract projection, acceptance, and D+1 resolution. */
export class ContractSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("ContractSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(CONTRACT_COMMAND.ACCEPT, createAcceptContractAtomicTransaction());
    this.commandBus.register(CONTRACT_COMMAND.RESOLVE, createResolveContractAtomicTransaction());
    this.registered = true;
    return this;
  }

  acceptContract(input) {
    return this.commandBus.dispatch(commandEnvelope(
      CONTRACT_COMMAND.ACCEPT,
      CONTRACT_ACCEPT_READ_SET,
      CONTRACT_ACCEPT_WRITE_SET,
      input,
    ));
  }

  resolveContract(input) {
    return this.commandBus.dispatch(commandEnvelope(
      CONTRACT_COMMAND.RESOLVE,
      CONTRACT_RESOLVE_READ_SET,
      CONTRACT_RESOLVE_WRITE_SET,
      input,
    ));
  }

  project(snapshot) {
    return projectContracts(snapshot.contracts, snapshot.economy);
  }
}

export function registerContractSystem(commandBus) {
  return new ContractSystem(commandBus, { register: true });
}
