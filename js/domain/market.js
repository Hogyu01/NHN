import { IdService } from "../core/ids.js";
import {
  multiplyDivideHalfUp,
  requireNonNegativeG,
  requirePositiveG,
} from "../core/money.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { RngRegistry } from "../core/rng.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import {
  applyCashTransactionToDraft,
  CASH_TRANSACTION_POLICIES,
  LEDGER_CATEGORY,
} from "./cash-transaction-api.js";
import {
  calculateAvailableCashG,
  validateEconomyState,
  validateEconomyTransition,
} from "./economy.js";
import { reconcileCashWithLedger } from "./economy-ledger.js";
import {
  applyLotAcquisitionToDraft,
  INVENTORY_ACQUISITION_SOURCE,
  reconcileInventoryAccounting,
  validateCostMovementAppendOnly,
  validateInventoryAccountingState,
} from "./inventory-accounting.js";
import { validateInventoryState } from "./inventory.js";

export const MARKET_RNG_STREAM = "market";
export const MARKET_PRICE_VARIANCE_PERCENT = 20;
export const MARKET_PURCHASE_COMMAND = "market.offer.purchase";
export const MARKET_PURCHASE_READ_SET = Object.freeze(["campaign"]);
export const MARKET_PURCHASE_WRITE_SET = Object.freeze([
  "economy",
  "market",
  "inventory",
  "inventoryAccounting",
  "idCounters",
]);

const QUALITY_WEIGHT_SCALE = 1_000_000;
const QUALITY_WEIGHT_TOLERANCE = 0.000_001;
const MARKET_PHASES = Object.freeze(["PLANNING"]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

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

function compareStableIdentifiers(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equivalent(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => equivalent(value, right[index]));
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
    : failure("INVALID_MARKET_DAY", { field, value: day });
}

function requireQuantity(quantity, field, { positive = false } = {}) {
  const minimum = positive ? 1 : 0;
  return Number.isSafeInteger(quantity) && quantity >= minimum
    ? validationSuccess()
    : failure("INVALID_MARKET_QUANTITY", { field, value: quantity, minimum });
}

function checkedMultiplyG(left, right, field) {
  requirePositiveG(left, `${field}.left`);
  requirePositiveG(right, `${field}.right`);
  const result = BigInt(left) * BigInt(right);
  if (result > MAX_SAFE_BIGINT) throw new RangeError(`${field} 결과가 safe integer 범위를 초과했습니다.`);
  return Number(result);
}

function expectedMarketUnitPriceG(basePriceG, deltaPercent) {
  const rounded = multiplyDivideHalfUp(basePriceG, 100 + deltaPercent, 100);
  return Math.max(1, rounded);
}

export function createMarketOfferId(day, ingredientId) {
  const dayValidation = requireDay(day);
  if (!dayValidation.ok) throw new TypeError(dayValidation.code);
  if (!isStableIdentifier(ingredientId)) throw new TypeError("ingredientId가 stable identifier가 아닙니다.");
  const offerId = `market:${day}:${ingredientId}`;
  if (!isStableIdentifier(offerId)) throw new TypeError("생성된 Market offer ID가 stable identifier가 아닙니다.");
  return offerId;
}

export function validateMarketOffer(offer, day) {
  if (!isPlainRecord(offer)) return failure("INVALID_MARKET_OFFER", { field: "$" });
  const required = [
    "offerId", "ingredientId", "generatedDay", "basePriceG", "priceDeltaPercent",
    "unitPriceG", "initialQuantity", "availableQuantity", "quality",
  ];
  for (const field of required) {
    if (!own(offer, field)) return failure("MISSING_MARKET_OFFER_FIELD", { field });
  }
  if (!isStableIdentifier(offer.offerId)) return failure("INVALID_MARKET_OFFER_ID", { offerId: offer.offerId });
  if (!isStableIdentifier(offer.ingredientId)) {
    return failure("INVALID_MARKET_INGREDIENT_ID", { ingredientId: offer.ingredientId });
  }
  const generatedDay = requireDay(offer.generatedDay, "generatedDay");
  if (!generatedDay.ok) return generatedDay;
  if (offer.generatedDay !== day) {
    return failure("MARKET_OFFER_DAY_MISMATCH", { offerDay: offer.generatedDay, marketDay: day });
  }
  let expectedOfferId;
  try {
    expectedOfferId = createMarketOfferId(day, offer.ingredientId);
    requirePositiveG(offer.basePriceG, "basePriceG");
    requirePositiveG(offer.unitPriceG, "unitPriceG");
  } catch {
    return failure("INVALID_MARKET_OFFER_MONEY_OR_ID", { offerId: offer.offerId });
  }
  if (offer.offerId !== expectedOfferId) {
    return failure("MARKET_OFFER_ID_MISMATCH", { expected: expectedOfferId, actual: offer.offerId });
  }
  if (!Number.isSafeInteger(offer.priceDeltaPercent) ||
      offer.priceDeltaPercent < -MARKET_PRICE_VARIANCE_PERCENT ||
      offer.priceDeltaPercent > MARKET_PRICE_VARIANCE_PERCENT) {
    return failure("MARKET_PRICE_DELTA_OUT_OF_RANGE", { deltaPercent: offer.priceDeltaPercent });
  }
  let expectedPriceG;
  try {
    expectedPriceG = expectedMarketUnitPriceG(offer.basePriceG, offer.priceDeltaPercent);
  } catch {
    return failure("MARKET_PRICE_OVERFLOW", { basePriceG: offer.basePriceG });
  }
  if (offer.unitPriceG !== expectedPriceG) {
    return failure("MARKET_UNIT_PRICE_MISMATCH", { expected: expectedPriceG, actual: offer.unitPriceG });
  }
  for (const field of ["initialQuantity", "availableQuantity"]) {
    const quantity = requireQuantity(offer[field], field);
    if (!quantity.ok) return quantity;
  }
  if (offer.availableQuantity > offer.initialQuantity) {
    return failure("MARKET_OFFER_STOCK_INCREASED", {
      initialQuantity: offer.initialQuantity,
      availableQuantity: offer.availableQuantity,
    });
  }
  if (!Number.isSafeInteger(offer.quality) || offer.quality < 0 || offer.quality > 100) {
    return failure("INVALID_MARKET_QUALITY", { quality: offer.quality });
  }
  return validationSuccess();
}

export function validateMarketState(market) {
  if (!isPlainRecord(market)) return failure("INVALID_MARKET_STATE", { field: "$" });
  const day = requireDay(market.day);
  if (!day.ok) return day;
  for (const field of ["purchaseLimitQuantity", "purchasedQuantity"]) {
    const result = requireQuantity(market[field], field);
    if (!result.ok) return result;
  }
  if (market.purchasedQuantity > market.purchaseLimitQuantity) {
    return failure("MARKET_PURCHASE_LIMIT_STATE_EXCEEDED", {
      purchasedQuantity: market.purchasedQuantity,
      purchaseLimitQuantity: market.purchaseLimitQuantity,
    });
  }
  if (!Array.isArray(market.offers)) return failure("INVALID_MARKET_OFFER_COLLECTION");

  const offerIds = new Set();
  const ingredientIds = new Set();
  let purchasedFromOffers = 0n;
  for (let index = 0; index < market.offers.length; index += 1) {
    const offer = market.offers[index];
    const offerValidation = validateMarketOffer(offer, market.day);
    if (!offerValidation.ok) return failure(offerValidation.code, { offerIndex: index, ...offerValidation.details });
    if (offerIds.has(offer.offerId)) return failure("DUPLICATE_MARKET_OFFER_ID", { offerId: offer.offerId });
    if (ingredientIds.has(offer.ingredientId)) {
      return failure("DUPLICATE_MARKET_INGREDIENT_ID", { ingredientId: offer.ingredientId });
    }
    offerIds.add(offer.offerId);
    ingredientIds.add(offer.ingredientId);
    if (index > 0 && compareStableIdentifiers(market.offers[index - 1].ingredientId, offer.ingredientId) >= 0) {
      return failure("MARKET_OFFER_ORDER_INVALID", { offerIndex: index });
    }
    purchasedFromOffers += BigInt(offer.initialQuantity - offer.availableQuantity);
    if (purchasedFromOffers > MAX_SAFE_BIGINT) return failure("MARKET_PURCHASED_QUANTITY_OVERFLOW");
  }
  if (Number(purchasedFromOffers) !== market.purchasedQuantity) {
    return failure("MARKET_PURCHASED_QUANTITY_MISMATCH", {
      expected: Number(purchasedFromOffers),
      actual: market.purchasedQuantity,
    });
  }
  return validationSuccess();
}

export function createMarketState({ day, purchaseLimitQuantity, purchasedQuantity = 0, offers = [] } = {}) {
  const state = {
    day,
    purchaseLimitQuantity,
    purchasedQuantity,
    offers: Array.isArray(offers) ? offers.map((offer) => ({ ...offer })) : offers,
  };
  const validation = validateMarketState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 MarketState입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(state);
}

function validateCanonicalIngredients(ingredients) {
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return failure("INVALID_CANONICAL_MARKET_INGREDIENTS");
  }
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < ingredients.length; index += 1) {
    const ingredient = ingredients[index];
    if (!isPlainRecord(ingredient)) return failure("INVALID_CANONICAL_MARKET_INGREDIENT", { ingredientIndex: index });
    if (!isStableIdentifier(ingredient.ingredientId) || seen.has(ingredient.ingredientId)) {
      return failure(seen.has(ingredient.ingredientId) ? "DUPLICATE_MARKET_INGREDIENT_ID" : "INVALID_MARKET_INGREDIENT_ID", {
        ingredientIndex: index,
        ingredientId: ingredient.ingredientId,
      });
    }
    seen.add(ingredient.ingredientId);
    try {
      requirePositiveG(ingredient.basePriceG, "basePriceG");
    } catch {
      return failure("INVALID_MARKET_BASE_PRICE", { ingredientId: ingredient.ingredientId, value: ingredient.basePriceG });
    }
    if (!Number.isInteger(ingredient.marketAvailabilityRate) ||
        ingredient.marketAvailabilityRate < 0 || ingredient.marketAvailabilityRate > 100) {
      return failure("INVALID_MARKET_AVAILABILITY_RATE", {
        ingredientId: ingredient.ingredientId,
        value: ingredient.marketAvailabilityRate,
      });
    }
    const stock = ingredient.marketStockRange;
    if (!isPlainRecord(stock) || !Number.isSafeInteger(stock.minimum) || !Number.isSafeInteger(stock.maximum) ||
        stock.minimum < 0 || stock.maximum < stock.minimum) {
      return failure("INVALID_MARKET_STOCK_RANGE", { ingredientId: ingredient.ingredientId, stock });
    }
    if (!Array.isArray(ingredient.qualityDistribution) || ingredient.qualityDistribution.length === 0) {
      return failure("INVALID_MARKET_QUALITY_DISTRIBUTION", { ingredientId: ingredient.ingredientId });
    }
    let weightTotal = 0;
    for (let bucketIndex = 0; bucketIndex < ingredient.qualityDistribution.length; bucketIndex += 1) {
      const bucket = ingredient.qualityDistribution[bucketIndex];
      if (!isPlainRecord(bucket) || !Number.isInteger(bucket.minQuality) || !Number.isInteger(bucket.maxQuality) ||
          bucket.minQuality < 0 || bucket.maxQuality > 100 || bucket.minQuality > bucket.maxQuality ||
          !Number.isFinite(bucket.weight) || bucket.weight <= 0) {
        return failure("INVALID_MARKET_QUALITY_BUCKET", {
          ingredientId: ingredient.ingredientId,
          bucketIndex,
        });
      }
      weightTotal += bucket.weight;
    }
    if (Math.abs(weightTotal - 1) > QUALITY_WEIGHT_TOLERANCE) {
      return failure("MARKET_QUALITY_WEIGHT_SUM_MISMATCH", {
        ingredientId: ingredient.ingredientId,
        weightTotal,
      });
    }
    normalized.push(ingredient);
  }
  normalized.sort((left, right) => compareStableIdentifiers(left.ingredientId, right.ingredientId));
  return Object.freeze({ ok: true, ingredients: Object.freeze(normalized) });
}

function chooseQualityBucket(distribution, roll) {
  let cumulativeWeight = 0;
  for (let index = 0; index < distribution.length; index += 1) {
    cumulativeWeight += distribution[index].weight;
    const threshold = index === distribution.length - 1
      ? QUALITY_WEIGHT_SCALE
      : Math.round(cumulativeWeight * QUALITY_WEIGHT_SCALE);
    if (roll < threshold) return distribution[index];
  }
  return distribution[distribution.length - 1];
}

/**
 * Pure deterministic day generator. The supplied registry snapshot is cloned by RngRegistry;
 * only the `market` stream is consumed and the caller receives the final checkpoint state.
 */
export function generateDailyMarket({ rngState, day, ingredients, purchaseLimitQuantity } = {}) {
  const dayValidation = requireDay(day);
  if (!dayValidation.ok) throw Object.assign(new TypeError(dayValidation.code), { code: dayValidation.code });
  const limitValidation = requireQuantity(purchaseLimitQuantity, "purchaseLimitQuantity");
  if (!limitValidation.ok) throw Object.assign(new TypeError(limitValidation.code), { code: limitValidation.code });
  const ingredientValidation = validateCanonicalIngredients(ingredients);
  if (!ingredientValidation.ok) {
    throw Object.assign(new TypeError(ingredientValidation.code), { code: ingredientValidation.code });
  }

  let registry;
  try {
    registry = RngRegistry.fromState(rngState);
  } catch (error) {
    throw Object.assign(new TypeError("INVALID_MARKET_RNG_STATE"), {
      code: "INVALID_MARKET_RNG_STATE",
      cause: error,
    });
  }
  if (!registry.hasStream(MARKET_RNG_STREAM)) {
    throw Object.assign(new TypeError("MARKET_RNG_STREAM_MISSING"), { code: "MARKET_RNG_STREAM_MISSING" });
  }
  const streamBefore = registry.getStreamState(MARKET_RNG_STREAM);
  const offers = ingredientValidation.ingredients.map((ingredient) => {
    // Five operations are requested for every ingredient in stable ID order. Rejection sampling
    // may consume additional raw draws, all of which remain visible in drawCount.
    const isAvailable = registry.percentage(MARKET_RNG_STREAM, ingredient.marketAvailabilityRate);
    const priceDeltaPercent = registry.nextInt(
      MARKET_RNG_STREAM,
      MARKET_PRICE_VARIANCE_PERCENT * 2 + 1,
    ) - MARKET_PRICE_VARIANCE_PERCENT;
    const stockRangeSize = ingredient.marketStockRange.maximum - ingredient.marketStockRange.minimum + 1;
    const drawnQuantity = ingredient.marketStockRange.minimum + registry.nextInt(MARKET_RNG_STREAM, stockRangeSize);
    const qualityRoll = registry.nextInt(MARKET_RNG_STREAM, QUALITY_WEIGHT_SCALE);
    const qualityBucket = chooseQualityBucket(ingredient.qualityDistribution, qualityRoll);
    const quality = qualityBucket.minQuality + registry.nextInt(
      MARKET_RNG_STREAM,
      qualityBucket.maxQuality - qualityBucket.minQuality + 1,
    );
    const availableQuantity = isAvailable ? drawnQuantity : 0;
    return {
      offerId: createMarketOfferId(day, ingredient.ingredientId),
      ingredientId: ingredient.ingredientId,
      generatedDay: day,
      basePriceG: ingredient.basePriceG,
      priceDeltaPercent,
      unitPriceG: expectedMarketUnitPriceG(ingredient.basePriceG, priceDeltaPercent),
      initialQuantity: availableQuantity,
      availableQuantity,
      quality,
    };
  });
  const market = createMarketState({ day, purchaseLimitQuantity, purchasedQuantity: 0, offers });
  const finalRngState = registry.snapshot();
  const streamAfter = registry.getStreamState(MARKET_RNG_STREAM);
  return freezeDeep({
    market,
    rngState: finalRngState,
    marketStreamBefore: streamBefore,
    marketStreamAfter: streamAfter,
    drawsConsumed: streamAfter.drawCount - streamBefore.drawCount,
  });
}

/** Read-only Planning projection; Available_Cash remains derived and is never persisted. */
export function projectMarket(market, economy = null) {
  const validation = validateMarketState(market);
  if (!validation.ok) throw new TypeError(`Market projection이 유효하지 않습니다: ${validation.code}`);
  let availableCashG = null;
  if (economy !== null) availableCashG = calculateAvailableCashG(economy);
  const remainingPurchaseLimitQuantity = market.purchaseLimitQuantity - market.purchasedQuantity;
  return freezeDeep({
    day: market.day,
    purchaseLimitQuantity: market.purchaseLimitQuantity,
    purchasedQuantity: market.purchasedQuantity,
    remainingPurchaseLimitQuantity,
    availableCashG,
    offers: market.offers.map((offer) => {
      const affordableQuantity = availableCashG === null
        ? offer.availableQuantity
        : Math.floor(availableCashG / offer.unitPriceG);
      const maximumPurchasableQuantity = Math.min(
        offer.availableQuantity,
        remainingPurchaseLimitQuantity,
        affordableQuantity,
      );
      return {
        ...offer,
        maximumPurchasableQuantity,
        purchaseEnabled: maximumPurchasableQuantity > 0,
      };
    }),
  });
}

export function validateMarketPurchasePayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_MARKET_PURCHASE_PAYLOAD", { field: "$" });
  for (const field of ["day", "offerId", "quantity"]) {
    if (!own(payload, field)) return failure("MISSING_MARKET_PURCHASE_FIELD", { field });
  }
  const day = requireDay(payload.day);
  if (!day.ok) return day;
  if (!isStableIdentifier(payload.offerId)) return failure("INVALID_MARKET_OFFER_ID", { offerId: payload.offerId });
  if (!Number.isSafeInteger(payload.quantity) || payload.quantity <= 0) {
    return failure("INVALID_MARKET_PURCHASE_QUANTITY", { quantity: payload.quantity });
  }
  return validationSuccess();
}

function validateCampaignForMarket(campaign, market, payloadDay) {
  if (!isPlainRecord(campaign)) return failure("INVALID_CAMPAIGN_STATE");
  if (!isStableIdentifier(campaign.campaignId)) return failure("INVALID_CAMPAIGN_ID");
  const day = requireDay(campaign.day, "campaign.day");
  if (!day.ok) return day;
  if (campaign.day !== market.day || payloadDay !== market.day) {
    return failure("MARKET_DAY_MISMATCH", {
      campaignDay: campaign.day,
      marketDay: market.day,
      payloadDay,
    });
  }
  return validationSuccess();
}

function allocatePurchaseIds(idState, campaign, day, generationId) {
  let idService;
  try {
    idService = IdService.fromState(idState);
  } catch {
    return failure("INVALID_MARKET_ID_STATE");
  }
  if (idService.campaignId !== campaign.campaignId) {
    return failure("MARKET_ID_CAMPAIGN_MISMATCH", {
      expected: campaign.campaignId,
      actual: idService.campaignId,
    });
  }
  if (idService.day !== day) return failure("MARKET_ID_DAY_MISMATCH", { expected: day, actual: idService.day });
  if (idService.generationId !== generationId) {
    return failure("MARKET_ID_GENERATION_MISMATCH", { expected: generationId, actual: idService.generationId });
  }
  let transactionId;
  let causeId;
  let lotId;
  try {
    transactionId = idService.next("tx");
    causeId = idService.next("cause");
    lotId = idService.next("lot");
  } catch {
    return failure("MARKET_ID_ALLOCATION_FAILED");
  }
  const movementId = `${transactionId}.inventory`;
  const eventId = `${transactionId}.committed`;
  if (![transactionId, causeId, lotId, movementId, eventId].every(isStableIdentifier)) {
    return failure("GENERATED_MARKET_ID_INVALID");
  }
  return success({
    transactionId,
    causeId,
    lotId,
    movementId,
    eventId,
    idCounters: idService.snapshot(),
  });
}

/**
 * Plans all touched slices on detached clones. Cash and lot/accounting writes are delegated to
 * the Task 13/14 draft helpers; this module never introduces a second cash or acquisition writer.
 */
export function planMarketPurchase({
  economy,
  market,
  inventory,
  inventoryAccounting,
  idCounters,
  campaign,
  runtimePhase,
  generationId,
}, payload) {
  const payloadValidation = validateMarketPurchasePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== "PLANNING") {
    return failure("MARKET_PURCHASE_REQUIRES_PLANNING", { actual: runtimePhase });
  }
  const marketValidation = validateMarketState(market);
  if (!marketValidation.ok) return failure("MARKET_STATE_INVALID", { cause: marketValidation.code });
  const campaignValidation = validateCampaignForMarket(campaign, market, payload.day);
  if (!campaignValidation.ok) return campaignValidation;
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  const accountingValidation = validateInventoryAccountingState(inventoryAccounting);
  if (!accountingValidation.ok) {
    return failure("INVENTORY_ACCOUNTING_STATE_INVALID", { cause: accountingValidation.code });
  }

  const offerIndex = market.offers.findIndex((offer) => offer.offerId === payload.offerId);
  if (offerIndex < 0) return failure("MARKET_OFFER_NOT_FOUND", { offerId: payload.offerId });
  const offer = market.offers[offerIndex];
  if (payload.quantity > offer.availableQuantity) {
    return failure("INSUFFICIENT_MARKET_STOCK", {
      requestedQuantity: payload.quantity,
      availableQuantity: offer.availableQuantity,
    });
  }
  const remainingPurchaseLimitQuantity = market.purchaseLimitQuantity - market.purchasedQuantity;
  if (payload.quantity > remainingPurchaseLimitQuantity) {
    return failure("MARKET_PURCHASE_LIMIT_EXCEEDED", {
      requestedQuantity: payload.quantity,
      remainingPurchaseLimitQuantity,
    });
  }

  let totalCostG;
  try {
    totalCostG = checkedMultiplyG(offer.unitPriceG, payload.quantity, "market purchase total");
  } catch {
    return failure("MARKET_PURCHASE_TOTAL_OVERFLOW", {
      unitPriceG: offer.unitPriceG,
      quantity: payload.quantity,
    });
  }
  const ids = allocatePurchaseIds(idCounters, campaign, market.day, generationId);
  if (!ids.ok) return ids;

  const cashPolicy = CASH_TRANSACTION_POLICIES[LEDGER_CATEGORY.MARKET];
  const cashRequest = {
    transactionId: ids.plan.transactionId,
    day: market.day,
    category: LEDGER_CATEGORY.MARKET,
    type: cashPolicy.type,
    direction: cashPolicy.direction,
    amountG: totalCostG,
    causeId: ids.plan.causeId,
  };
  const economyCandidate = cloneValue(economy);
  const cashResult = applyCashTransactionToDraft(economyCandidate, cashRequest, runtimePhase);
  if (!cashResult.ok) return cashResult;

  const inventoryCandidate = cloneValue(inventory);
  const accountingCandidate = cloneValue(inventoryAccounting);
  const acquisitionResult = applyLotAcquisitionToDraft(inventoryCandidate, accountingCandidate, {
    movementId: ids.plan.movementId,
    day: market.day,
    causeId: ids.plan.causeId,
    source: INVENTORY_ACQUISITION_SOURCE.MARKET,
    lot: {
      lotId: ids.plan.lotId,
      ingredientId: offer.ingredientId,
      quantity: payload.quantity,
      quality: offer.quality,
      bookCostG: totalCostG,
      acquiredDay: market.day,
    },
  });
  if (!acquisitionResult.ok) return acquisitionResult;

  const marketCandidate = cloneValue(market);
  marketCandidate.offers[offerIndex].availableQuantity -= payload.quantity;
  marketCandidate.purchasedQuantity += payload.quantity;
  let normalizedMarket;
  try {
    normalizedMarket = createMarketState(marketCandidate);
  } catch (error) {
    return failure(error?.code ?? "MARKET_STATE_INVALID_AFTER_PURCHASE");
  }
  const inventoryReconciliation = reconcileInventoryAccounting(inventoryCandidate, accountingCandidate);
  if (!inventoryReconciliation.ok) return failure(inventoryReconciliation.code, inventoryReconciliation);

  const lot = inventoryCandidate.lots.find((candidate) => candidate.lotId === ids.plan.lotId);
  const movement = accountingCandidate.costMovements.find(
    (candidate) => candidate.movementId === ids.plan.movementId,
  );
  return success({
    economy: economyCandidate,
    market: normalizedMarket,
    inventory: inventoryCandidate,
    inventoryAccounting: accountingCandidate,
    idCounters: ids.plan.idCounters,
    transactionId: ids.plan.transactionId,
    causeId: ids.plan.causeId,
    lotId: ids.plan.lotId,
    movementId: ids.plan.movementId,
    eventId: ids.plan.eventId,
    totalCostG,
    quantity: payload.quantity,
    offerBefore: offer,
    offerAfter: normalizedMarket.offers[offerIndex],
    ledgerEntry: cashResult.plan.entry,
    lot,
    movement,
  });
}

function validateMarketPurchasePostconditions(before, after, planned) {
  for (const slice of MARKET_PURCHASE_WRITE_SET) {
    const expected = planned[slice];
    if (!equivalent(after[slice], expected)) {
      return failure("MARKET_PURCHASE_PLAN_MISMATCH", { slice });
    }
  }
  const economyTransition = validateEconomyTransition(before.economy, after.economy);
  if (!economyTransition.ok) return economyTransition;
  if (economyTransition.details?.appendedCount !== 1) {
    return failure("MARKET_LEDGER_CARDINALITY_MISMATCH", {
      appendedCount: economyTransition.details?.appendedCount,
    });
  }
  const costTransition = validateCostMovementAppendOnly(
    before.inventoryAccounting,
    after.inventoryAccounting,
  );
  if (!costTransition.ok) return costTransition;
  if (costTransition.details?.appendedCount !== 1) {
    return failure("MARKET_COST_MOVEMENT_CARDINALITY_MISMATCH", {
      appendedCount: costTransition.details?.appendedCount,
    });
  }
  const marketValidation = validateMarketState(after.market);
  if (!marketValidation.ok) return marketValidation;
  const inventoryReconciliation = reconcileInventoryAccounting(
    after.inventory,
    after.inventoryAccounting,
  );
  if (!inventoryReconciliation.ok) return failure(inventoryReconciliation.code, inventoryReconciliation);

  const ledgerEntry = after.economy.ledger[after.economy.ledger.length - 1];
  const cashReconciliation = reconcileCashWithLedger(
    before.economy.cashG,
    after.economy.cashG,
    [ledgerEntry],
  );
  if (!cashReconciliation.ok) return failure(cashReconciliation.code, cashReconciliation);
  if (ledgerEntry.transactionId !== planned.transactionId ||
      ledgerEntry.category !== LEDGER_CATEGORY.MARKET ||
      ledgerEntry.amountG !== planned.totalCostG) {
    return failure("MARKET_LEDGER_ENTRY_MISMATCH");
  }
  if (!planned.lot || planned.lot.bookCostG !== ledgerEntry.amountG ||
      planned.lot.quantity !== planned.quantity) {
    return failure("MARKET_LOT_BOOK_COST_MISMATCH");
  }
  if (!planned.movement || planned.movement.amountG !== ledgerEntry.amountG ||
      planned.movement.references.lotId !== planned.lotId) {
    return failure("MARKET_COST_MOVEMENT_MISMATCH");
  }
  if (planned.offerBefore.availableQuantity - planned.offerAfter.availableQuantity !== planned.quantity ||
      after.market.purchasedQuantity - before.market.purchasedQuantity !== planned.quantity) {
    return failure("MARKET_OFFER_DECREMENT_MISMATCH");
  }
  for (const kind of ["tx", "cause", "lot"]) {
    if (after.idCounters.counters[kind] !== before.idCounters.counters[kind] + 1) {
      return failure("MARKET_ID_COUNTER_MISMATCH", { kind });
    }
  }
  return validationSuccess({
    cash: cashReconciliation.code,
    inventory: inventoryReconciliation.code,
    ledgerOutflowG: ledgerEntry.amountG,
    lotBookCostG: planned.lot.bookCostG,
  });
}

export function createPurchaseMarketOfferAtomicTransaction() {
  return defineAtomicTransaction({
    name: MARKET_PURCHASE_COMMAND,
    readSet: MARKET_PURCHASE_READ_SET,
    writeSet: MARKET_PURCHASE_WRITE_SET,
    allowedPhases: MARKET_PHASES,
    // Quantity type/range is rejected here, before read/write-set inspection, preflight, or draft creation.
    validatePayload(ctx) {
      return validateMarketPurchasePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planMarketPurchase({
        economy: ctx.read("economy"),
        market: ctx.read("market"),
        inventory: ctx.read("inventory"),
        inventoryAccounting: ctx.read("inventoryAccounting"),
        idCounters: ctx.read("idCounters"),
        campaign: ctx.read("campaign"),
        runtimePhase: ctx.phase,
        generationId: ctx.generationId,
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planMarketPurchase({
        economy: draft.read("economy"),
        market: draft.read("market"),
        inventory: draft.read("inventory"),
        inventoryAccounting: draft.read("inventoryAccounting"),
        idCounters: draft.read("idCounters"),
        campaign: draft.read("campaign"),
        runtimePhase: "PLANNING",
        generationId: draft.command.generationId,
      }, draft.command.payload);
      if (!planned.ok) return planned;
      for (const slice of MARKET_PURCHASE_WRITE_SET) draft.replace(slice, planned.plan[slice]);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planMarketPurchase({
        economy: before.economy,
        market: before.market,
        inventory: before.inventory,
        inventoryAccounting: before.inventoryAccounting,
        idCounters: before.idCounters,
        campaign: before.campaign,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
      }, ctx.command.payload);
      if (!planned.ok) return planned;
      return validateMarketPurchasePostconditions(before, after, planned.plan);
    },
    events(before, _after, ctx) {
      const planned = planMarketPurchase({
        economy: before.economy,
        market: before.market,
        inventory: before.inventory,
        inventoryAccounting: before.inventoryAccounting,
        idCounters: before.idCounters,
        campaign: before.campaign,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
      }, ctx.command.payload);
      if (!planned.ok) return [];
      return [{
        eventId: planned.plan.eventId,
        causeId: planned.plan.causeId,
        type: "market.offer-purchased",
        payload: {
          day: before.market.day,
          offerId: ctx.command.payload.offerId,
          ingredientId: planned.plan.lot.ingredientId,
          quantity: planned.plan.quantity,
          unitPriceG: planned.plan.offerBefore.unitPriceG,
          totalCostG: planned.plan.totalCostG,
          remainingOfferQuantity: planned.plan.offerAfter.availableQuantity,
          remainingPurchaseLimitQuantity:
            planned.plan.market.purchaseLimitQuantity - planned.plan.market.purchasedQuantity,
          transactionId: planned.plan.transactionId,
          movementId: planned.plan.movementId,
          lotId: planned.plan.lotId,
        },
      }];
    },
  });
}

function commandEnvelope(input) {
  return {
    commandId: input?.commandId,
    expectedRevision: input?.expectedRevision,
    generationId: input?.generationId,
    issuedAtSimulationMs: input?.issuedAtSimulationMs,
    type: MARKET_PURCHASE_COMMAND,
    payload: input?.payload,
    readSet: [...MARKET_PURCHASE_READ_SET],
    writeSet: [...MARKET_PURCHASE_WRITE_SET],
  };
}

/** Production facade for deterministic market projection and PurchaseMarketOffer dispatch. */
export class MarketSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("MarketSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(MARKET_PURCHASE_COMMAND, createPurchaseMarketOfferAtomicTransaction());
    this.registered = true;
    return this;
  }

  purchaseOffer(input) {
    return this.commandBus.dispatch(commandEnvelope(input));
  }

  project(snapshot) {
    return projectMarket(snapshot.market, snapshot.economy);
  }
}

export function registerMarketSystem(commandBus) {
  return new MarketSystem(commandBus, { register: true });
}
