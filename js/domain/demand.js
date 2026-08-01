import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { RngRegistry } from "../core/rng.js";
import { isStableIdentifier } from "../core/transaction.js";
import { validateEventState, ZERO_EVENT_MODIFIERS } from "./events.js";
import {
  createScheduledGuestPlans,
  SCHEDULED_GUEST_LIMITS,
} from "./guest-plans.js";
import { validateMenuState } from "./menu.js";
import { validateRecipeState } from "./recipe.js";
import { SALE_SLOT_STATE, validateSaleSlotsState } from "./sale-slots.js";

export const DEMAND_RNG_STREAM = "demand";
export const DEMAND_PRICE_FACTOR_LIMITS = Object.freeze({
  minimumBp: 2_500,
  maximumBp: 20_000,
});

const UINT32_RANGE = 0x1_0000_0000;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_DEMAND_CONFIGURATION: "손님 수요 설정이 올바르지 않습니다.",
  INVALID_GUEST_ARCHETYPE_CATALOG: "손님 archetype 목록이 올바르지 않습니다.",
  INVALID_GUEST_ARCHETYPE: "손님 archetype 형식이 올바르지 않습니다.",
  INVALID_GUEST_ARCHETYPE_ID: "손님 archetype ID가 올바르지 않습니다.",
  DUPLICATE_GUEST_ARCHETYPE_ID: "손님 archetype ID가 중복되었습니다.",
  INVALID_GUEST_SELECTION_WEIGHT: "손님 archetype 선택 가중치가 올바르지 않습니다.",
  INVALID_GUEST_RECIPE_WEIGHT: "손님 Recipe 선호 가중치가 올바르지 않습니다.",
  DUPLICATE_GUEST_RECIPE_WEIGHT: "손님 archetype의 Recipe 선호가 중복되었습니다.",
  GUEST_RECIPE_REFERENCE_NOT_FOUND: "손님 선호 Recipe가 canonical Recipe에 없습니다.",
  INVALID_DEMAND_PRICE: "수요 가격 계산 입력이 올바르지 않습니다.",
  INVALID_DEMAND_WEIGHT_INPUT: "수요 가중치 계산 입력이 올바르지 않습니다.",
  INVALID_ACTIVE_EVENT_GUEST_DELTA: "활성 사건의 손님 수 변화가 올바르지 않습니다.",
  INVALID_DEMAND_GENERATION_CONTEXT: "Service 수요 생성 입력이 올바르지 않습니다.",
  INVALID_DEMAND_RNG_STATE: "Demand RNG 상태가 올바르지 않습니다.",
  DEMAND_RNG_STREAM_MISSING: "Demand RNG stream이 없습니다.",
  INVALID_DEMAND_ID_STATE: "손님 계획 ID 상태가 올바르지 않습니다.",
  DEMAND_ID_STATE_MISMATCH: "손님 계획 ID 상태가 캠페인과 일치하지 않습니다.",
  DEMAND_RECIPE_STATE_INVALID: "수요 생성에 필요한 Recipe 상태가 올바르지 않습니다.",
  DEMAND_MENU_STATE_INVALID: "수요 생성에 필요한 메뉴 상태가 올바르지 않습니다.",
  DEMAND_SALE_SLOT_STATE_INVALID: "수요 생성에 필요한 SaleSlot 상태가 올바르지 않습니다.",
  DEMAND_EVENT_STATE_INVALID: "수요 생성에 필요한 사건 상태가 올바르지 않습니다.",
  DEMAND_AVAILABLE_RECIPE_REQUIRED: "수요 생성에는 AVAILABLE SaleSlot Recipe가 하나 이상 필요합니다.",
  DEMAND_MENU_RECIPE_NOT_ACTIVE: "AVAILABLE SaleSlot의 Recipe가 활성 메뉴에 없습니다.",
  DEMAND_WEIGHT_TOTAL_OVERFLOW: "수요 가중치 합계가 결정론적 추첨 범위를 초과했습니다.",
  DEMAND_ID_ALLOCATION_FAILED: "손님 계획 ID를 할당할 수 없습니다.",
  DEMAND_PLAN_CREATION_FAILED: "ScheduledGuestPlan 생성에 실패했습니다.",
  DEMAND_RNG_STREAM_ISOLATION_VIOLATION: "Demand 생성이 다른 RNG stream을 변경했습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "손님 수요 검증에 실패했습니다.",
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

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
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

function normalizeDemandConfiguration(configuration = {}) {
  const normalized = {
    minimumGuestCount: configuration.minimumGuestCount ?? SCHEDULED_GUEST_LIMITS.minimumCount,
    defaultGuestCount: configuration.defaultGuestCount ?? SCHEDULED_GUEST_LIMITS.defaultCount,
    maximumGuestCount: configuration.maximumGuestCount ?? SCHEDULED_GUEST_LIMITS.maximumCount,
  };
  const exact = normalized.minimumGuestCount === SCHEDULED_GUEST_LIMITS.minimumCount &&
    normalized.defaultGuestCount === SCHEDULED_GUEST_LIMITS.defaultCount &&
    normalized.maximumGuestCount === SCHEDULED_GUEST_LIMITS.maximumCount;
  if (!exact) {
    const error = new RangeError(MESSAGE_BY_CODE.INVALID_DEMAND_CONFIGURATION);
    error.code = "INVALID_DEMAND_CONFIGURATION";
    error.details = normalized;
    throw error;
  }
  return freezeDeep(normalized);
}

function validateRecipePreferenceWeight(entry, field) {
  if (!isPlainRecord(entry) || !isStableIdentifier(entry.recipeId) ||
      !Number.isSafeInteger(entry.weight) || entry.weight < 0) {
    return failure("INVALID_GUEST_RECIPE_WEIGHT", { field, entry });
  }
  return validationSuccess();
}

export function validateGuestArchetype(archetype, field = "guestArchetype") {
  if (!isPlainRecord(archetype)) return failure("INVALID_GUEST_ARCHETYPE", { field });
  if (!isStableIdentifier(archetype.guestArchetypeId)) {
    return failure("INVALID_GUEST_ARCHETYPE_ID", {
      field: `${field}.guestArchetypeId`,
      value: archetype.guestArchetypeId,
    });
  }
  if (!Number.isSafeInteger(archetype.selectionWeight) || archetype.selectionWeight <= 0 ||
      archetype.selectionWeight > UINT32_RANGE) {
    return failure("INVALID_GUEST_SELECTION_WEIGHT", {
      field: `${field}.selectionWeight`,
      value: archetype.selectionWeight,
    });
  }
  if (!Array.isArray(archetype.recipePreferenceWeights) ||
      archetype.recipePreferenceWeights.length === 0) {
    return failure("INVALID_GUEST_RECIPE_WEIGHT", {
      field: `${field}.recipePreferenceWeights`,
    });
  }
  const recipeIds = new Set();
  for (let index = 0; index < archetype.recipePreferenceWeights.length; index += 1) {
    const entry = archetype.recipePreferenceWeights[index];
    const validation = validateRecipePreferenceWeight(
      entry,
      `${field}.recipePreferenceWeights[${index}]`,
    );
    if (!validation.ok) return validation;
    if (recipeIds.has(entry.recipeId)) {
      return failure("DUPLICATE_GUEST_RECIPE_WEIGHT", {
        guestArchetypeId: archetype.guestArchetypeId,
        recipeId: entry.recipeId,
      });
    }
    recipeIds.add(entry.recipeId);
  }
  return validationSuccess();
}

export function validateGuestArchetypeCatalog(guestArchetypes) {
  if (!Array.isArray(guestArchetypes) || guestArchetypes.length === 0) {
    return failure("INVALID_GUEST_ARCHETYPE_CATALOG");
  }
  const ids = new Set();
  let totalSelectionWeight = 0n;
  for (let index = 0; index < guestArchetypes.length; index += 1) {
    const archetype = guestArchetypes[index];
    const validation = validateGuestArchetype(archetype, `guestArchetypes[${index}]`);
    if (!validation.ok) return validation;
    if (ids.has(archetype.guestArchetypeId)) {
      return failure("DUPLICATE_GUEST_ARCHETYPE_ID", {
        guestArchetypeId: archetype.guestArchetypeId,
      });
    }
    if (index > 0 && compareIds(
      guestArchetypes[index - 1].guestArchetypeId,
      archetype.guestArchetypeId,
    ) >= 0) {
      return failure("INVALID_GUEST_ARCHETYPE_CATALOG", { index, reason: "ORDER" });
    }
    ids.add(archetype.guestArchetypeId);
    totalSelectionWeight += BigInt(archetype.selectionWeight);
  }
  if (totalSelectionWeight < 1n || totalSelectionWeight > BigInt(UINT32_RANGE)) {
    return failure("INVALID_GUEST_SELECTION_WEIGHT", {
      totalSelectionWeight: totalSelectionWeight.toString(),
    });
  }
  return validationSuccess({
    archetypeCount: guestArchetypes.length,
    totalSelectionWeight: Number(totalSelectionWeight),
  });
}

export function createGuestArchetypeCatalog(guestArchetypes) {
  if (!Array.isArray(guestArchetypes)) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_GUEST_ARCHETYPE_CATALOG);
    error.code = "INVALID_GUEST_ARCHETYPE_CATALOG";
    throw error;
  }
  const catalog = cloneValue(guestArchetypes).sort((left, right) =>
    compareIds(left.guestArchetypeId, right.guestArchetypeId));
  const validation = validateGuestArchetypeCatalog(catalog);
  if (!validation.ok) {
    const error = new TypeError(`${MESSAGE_BY_CODE.INVALID_GUEST_ARCHETYPE_CATALOG}: ${validation.code}`);
    error.code = validation.code;
    error.details = validation.details;
    throw error;
  }
  return freezeDeep(catalog);
}

export function calculateScheduledGuestCount(activeEventGuestDelta = 0, configuration = {}) {
  const config = normalizeDemandConfiguration(configuration);
  if (!Number.isSafeInteger(activeEventGuestDelta)) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_ACTIVE_EVENT_GUEST_DELTA);
    error.code = "INVALID_ACTIVE_EVENT_GUEST_DELTA";
    throw error;
  }
  const candidate = BigInt(config.defaultGuestCount) + BigInt(activeEventGuestDelta);
  if (candidate < BigInt(config.minimumGuestCount)) return config.minimumGuestCount;
  if (candidate > BigInt(config.maximumGuestCount)) return config.maximumGuestCount;
  return Number(candidate);
}

export function calculatePriceFactorBp(basePriceG, menuPriceG) {
  if (!Number.isSafeInteger(basePriceG) || basePriceG <= 0 ||
      !Number.isSafeInteger(menuPriceG) || menuPriceG <= 0) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_DEMAND_PRICE);
    error.code = "INVALID_DEMAND_PRICE";
    throw error;
  }
  const raw = (BigInt(basePriceG) * 10_000n) / BigInt(menuPriceG);
  const bounded = raw < BigInt(DEMAND_PRICE_FACTOR_LIMITS.minimumBp)
    ? BigInt(DEMAND_PRICE_FACTOR_LIMITS.minimumBp)
    : raw > BigInt(DEMAND_PRICE_FACTOR_LIMITS.maximumBp)
      ? BigInt(DEMAND_PRICE_FACTOR_LIMITS.maximumBp)
      : raw;
  return Number(bounded);
}

export function calculateDemandWeight({
  basePreferenceWeight = 0,
  eventModifier = 0,
  archetypeModifier = 0,
  priceFactorBp,
} = {}) {
  const values = [basePreferenceWeight, eventModifier, archetypeModifier, priceFactorBp];
  if (values.some((value) => !Number.isSafeInteger(value)) || priceFactorBp < 0) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_DEMAND_WEIGHT_INPUT);
    error.code = "INVALID_DEMAND_WEIGHT_INPUT";
    throw error;
  }
  const combined = BigInt(basePreferenceWeight) + BigInt(eventModifier) + BigInt(archetypeModifier);
  if (combined <= 0n) return 0;
  const weighted = (combined * BigInt(priceFactorBp)) / 10_000n;
  if (weighted > MAX_SAFE_BIGINT) {
    const error = new RangeError(MESSAGE_BY_CODE.DEMAND_WEIGHT_TOTAL_OVERFLOW);
    error.code = "DEMAND_WEIGHT_TOTAL_OVERFLOW";
    throw error;
  }
  return Number(weighted);
}

function normalizeModifierMap(value, field) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainRecord(value)) {
    const error = new TypeError(`${field}는 Recipe_ID→정수 map이어야 합니다.`);
    error.code = "INVALID_DEMAND_WEIGHT_INPUT";
    throw error;
  }
  const normalized = {};
  for (const recipeId of Object.keys(value).sort(compareIds)) {
    if (!isStableIdentifier(recipeId) || !Number.isSafeInteger(value[recipeId])) {
      const error = new TypeError(`${field}.${recipeId} 값이 올바르지 않습니다.`);
      error.code = "INVALID_DEMAND_WEIGHT_INPUT";
      throw error;
    }
    normalized[recipeId] = value[recipeId];
  }
  return Object.freeze(normalized);
}

function weightedCandidateTotal(candidates, weightField = "weight") {
  const total = candidates.reduce((sum, candidate) => sum + BigInt(candidate[weightField]), 0n);
  if (total < 1n || total > BigInt(UINT32_RANGE)) {
    const error = new RangeError(MESSAGE_BY_CODE.DEMAND_WEIGHT_TOTAL_OVERFLOW);
    error.code = "DEMAND_WEIGHT_TOTAL_OVERFLOW";
    throw error;
  }
  return Number(total);
}

function weightedPickIndex(registry, candidates, weightField = "weight") {
  const total = weightedCandidateTotal(candidates, weightField);
  const roll = registry.nextInt(DEMAND_RNG_STREAM, total);
  let cursor = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    cursor += candidates[index][weightField];
    if (roll < cursor) return index;
  }
  throw new Error("결정론적 weighted draw 누적 범위를 벗어났습니다.");
}

/**
 * Positive-weight recipes are drawn without replacement. If every weight is zero, no preference
 * RNG draw is consumed and the currently AVAILABLE Recipe IDs are returned lexically.
 */
export function createDeterministicRecipePreference({
  registry,
  archetype,
  availableRecipeIds,
  menuEntries,
  recipeDefinitions,
  basePreferenceWeights = undefined,
  eventPreferenceModifiers = undefined,
} = {}) {
  if (!(registry instanceof RngRegistry)) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_DEMAND_RNG_STATE);
    error.code = "INVALID_DEMAND_RNG_STATE";
    throw error;
  }
  const archetypeValidation = validateGuestArchetype(archetype);
  if (!archetypeValidation.ok) {
    const error = new TypeError(archetypeValidation.details.message);
    error.code = archetypeValidation.code;
    throw error;
  }
  if (!Array.isArray(availableRecipeIds) || !Array.isArray(menuEntries) ||
      !Array.isArray(recipeDefinitions)) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_DEMAND_GENERATION_CONTEXT);
    error.code = "INVALID_DEMAND_GENERATION_CONTEXT";
    throw error;
  }
  const baseModifiers = normalizeModifierMap(basePreferenceWeights, "basePreferenceWeights");
  const eventModifiers = normalizeModifierMap(eventPreferenceModifiers, "eventPreferenceModifiers");
  const menuById = new Map(menuEntries.map((entry) => [entry.recipeId, entry]));
  const recipeById = new Map(recipeDefinitions.map((recipe) => [recipe.recipeId, recipe]));
  const archetypeWeights = new Map(
    archetype.recipePreferenceWeights.map((entry) => [entry.recipeId, entry.weight]),
  );
  const recipeIds = [...new Set(availableRecipeIds)].sort(compareIds);
  if (recipeIds.length === 0 || recipeIds.some((recipeId) => !isStableIdentifier(recipeId))) {
    const error = new TypeError(MESSAGE_BY_CODE.DEMAND_AVAILABLE_RECIPE_REQUIRED);
    error.code = "DEMAND_AVAILABLE_RECIPE_REQUIRED";
    throw error;
  }

  const weights = recipeIds.map((recipeId) => {
    const recipe = recipeById.get(recipeId);
    const menuEntry = menuById.get(recipeId);
    if (!recipe || !menuEntry || !menuEntry.enabled || menuEntry.plannedQuantity <= 0) {
      const error = new TypeError(MESSAGE_BY_CODE.DEMAND_MENU_RECIPE_NOT_ACTIVE);
      error.code = "DEMAND_MENU_RECIPE_NOT_ACTIVE";
      error.details = { recipeId };
      throw error;
    }
    const priceFactorBp = calculatePriceFactorBp(recipe.basePriceG, menuEntry.priceG);
    const weight = calculateDemandWeight({
      basePreferenceWeight: baseModifiers[recipeId] ?? 0,
      eventModifier: eventModifiers[recipeId] ?? 0,
      archetypeModifier: archetypeWeights.get(recipeId) ?? 0,
      priceFactorBp,
    });
    return { recipeId, priceFactorBp, weight };
  });

  const drawCountBefore = registry.getStreamState(DEMAND_RNG_STREAM).drawCount;
  const positive = weights.filter((entry) => entry.weight > 0).map((entry) => ({ ...entry }));
  const preference = [];
  if (positive.length === 0) {
    preference.push(...recipeIds);
  } else {
    while (positive.length > 0) {
      const selectedIndex = weightedPickIndex(registry, positive);
      preference.push(positive[selectedIndex].recipeId);
      positive.splice(selectedIndex, 1);
    }
  }
  const drawCountAfter = registry.getStreamState(DEMAND_RNG_STREAM).drawCount;
  return freezeDeep({
    preference,
    weights,
    drawsConsumed: drawCountAfter - drawCountBefore,
    allWeightsZero: weights.every((entry) => entry.weight === 0),
  });
}

function activeEventModifiers(events, campaignDay) {
  return events.activeEvent?.generatedDay === campaignDay
    ? events.activeModifiers
    : ZERO_EVENT_MODIFIERS;
}

function validateCampaign(campaign) {
  return isPlainRecord(campaign) && isStableIdentifier(campaign.campaignId) &&
    Number.isSafeInteger(campaign.day) && campaign.day >= 1 && campaign.day <= 14
    ? validationSuccess()
    : failure("INVALID_DEMAND_GENERATION_CONTEXT", { field: "campaign" });
}

function unchangedNonDemandStreams(before, after) {
  const beforeNames = Object.keys(before?.streams ?? {}).sort(compareIds);
  const afterNames = Object.keys(after?.streams ?? {}).sort(compareIds);
  return equivalent(beforeNames, afterNames) && beforeNames.every((name) =>
    name === DEMAND_RNG_STREAM || equivalent(before.streams[name], after.streams[name]));
}

function validateCatalogRecipeReferences(catalog, recipes) {
  const recipeIds = new Set(recipes.definitions.map((recipe) => recipe.recipeId));
  for (const archetype of catalog) {
    for (const preference of archetype.recipePreferenceWeights) {
      if (!recipeIds.has(preference.recipeId)) {
        return failure("GUEST_RECIPE_REFERENCE_NOT_FOUND", {
          guestArchetypeId: archetype.guestArchetypeId,
          recipeId: preference.recipeId,
        });
      }
    }
  }
  return validationSuccess();
}

function createRegistry(rngState) {
  try {
    const registry = RngRegistry.fromState(rngState);
    return registry.hasStream(DEMAND_RNG_STREAM)
      ? Object.freeze({ ok: true, registry })
      : failure("DEMAND_RNG_STREAM_MISSING");
  } catch {
    return failure("INVALID_DEMAND_RNG_STATE");
  }
}

function createIdAllocator(idCounters, campaign, generationId) {
  try {
    const ids = IdService.fromState(idCounters);
    if (ids.campaignId !== campaign.campaignId || ids.day !== campaign.day ||
        ids.generationId !== generationId) {
      return failure("DEMAND_ID_STATE_MISMATCH", {
        expected: {
          campaignId: campaign.campaignId,
          day: campaign.day,
          generationId,
        },
        actual: {
          campaignId: ids.campaignId,
          day: ids.day,
          generationId: ids.generationId,
        },
      });
    }
    return Object.freeze({ ok: true, ids });
  } catch {
    return failure("INVALID_DEMAND_ID_STATE");
  }
}

/** Pure Service-start generation plan. Only demand RNG and guest/entity ID counters advance. */
export function planScheduledGuestGeneration({
  rngState,
  idCounters,
  campaign,
  generationId,
  serviceDurationMs,
  menu,
  recipes,
  saleSlots,
  events,
  guestArchetypes,
  configuration = {},
} = {}) {
  let config;
  try {
    config = normalizeDemandConfiguration(configuration);
  } catch (error) {
    return failure(error.code ?? "INVALID_DEMAND_CONFIGURATION", error.details);
  }
  const campaignValidation = validateCampaign(campaign);
  if (!campaignValidation.ok) return campaignValidation;
  if (!Number.isSafeInteger(generationId) || generationId < 0 ||
      !Number.isSafeInteger(serviceDurationMs) || serviceDurationMs <= 0) {
    return failure("INVALID_DEMAND_GENERATION_CONTEXT", {
      generationId,
      serviceDurationMs,
    });
  }
  const recipeValidation = validateRecipeState(recipes);
  if (!recipeValidation.ok) {
    return failure("DEMAND_RECIPE_STATE_INVALID", { cause: recipeValidation.code });
  }
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) {
    return failure("DEMAND_MENU_STATE_INVALID", { cause: menuValidation.code });
  }
  const slotValidation = validateSaleSlotsState(saleSlots);
  if (!slotValidation.ok) {
    return failure("DEMAND_SALE_SLOT_STATE_INVALID", { cause: slotValidation.code });
  }
  const eventValidation = validateEventState(events);
  if (!eventValidation.ok) {
    return failure("DEMAND_EVENT_STATE_INVALID", { cause: eventValidation.code });
  }
  let catalog;
  try {
    catalog = createGuestArchetypeCatalog(guestArchetypes);
  } catch (error) {
    return failure(error.code ?? "INVALID_GUEST_ARCHETYPE_CATALOG", error.details);
  }
  const referenceValidation = validateCatalogRecipeReferences(catalog, recipes);
  if (!referenceValidation.ok) return referenceValidation;

  const availableRecipeIds = [...new Set(saleSlots.slots
    .filter((slot) => slot.state === SALE_SLOT_STATE.AVAILABLE)
    .map((slot) => slot.recipeId))].sort(compareIds);
  if (availableRecipeIds.length === 0) return failure("DEMAND_AVAILABLE_RECIPE_REQUIRED");
  const activeMenuById = new Map(menu.confirmedEntries
    .filter((entry) => entry.enabled && entry.plannedQuantity > 0)
    .map((entry) => [entry.recipeId, entry]));
  for (const recipeId of availableRecipeIds) {
    if (!activeMenuById.has(recipeId)) {
      return failure("DEMAND_MENU_RECIPE_NOT_ACTIVE", { recipeId });
    }
  }

  const registryResult = createRegistry(rngState);
  if (!registryResult.ok) return registryResult;
  const idsResult = createIdAllocator(idCounters, campaign, generationId);
  if (!idsResult.ok) return idsResult;
  const registry = registryResult.registry;
  const ids = idsResult.ids;
  const demandStreamBefore = registry.getStreamState(DEMAND_RNG_STREAM);
  const modifiers = activeEventModifiers(events, campaign.day);
  let guestCount;
  try {
    guestCount = calculateScheduledGuestCount(modifiers.guestCountDelta, config);
  } catch (error) {
    return failure(error.code ?? "INVALID_ACTIVE_EVENT_GUEST_DELTA");
  }

  const totalArchetypeWeight = catalog.reduce((sum, archetype) =>
    sum + archetype.selectionWeight, 0);
  if (!Number.isSafeInteger(totalArchetypeWeight) || totalArchetypeWeight < 1 ||
      totalArchetypeWeight > UINT32_RANGE) {
    return failure("INVALID_GUEST_SELECTION_WEIGHT", { totalArchetypeWeight });
  }

  const plans = [];
  const preferenceDetails = [];
  try {
    for (let planSequence = 0; planSequence < guestCount; planSequence += 1) {
      const bucketStart = Math.floor(planSequence * serviceDurationMs / guestCount);
      const bucketEndExclusive = Math.floor((planSequence + 1) * serviceDurationMs / guestCount);
      const bucketWidth = bucketEndExclusive - bucketStart;
      const arrivalAtMs = bucketStart + registry.nextInt(DEMAND_RNG_STREAM, bucketWidth);

      const archetypeIndex = weightedPickIndex(
        registry,
        catalog.map((archetype) => ({ archetype, weight: archetype.selectionWeight })),
      );
      const archetype = catalog[archetypeIndex];
      const guestId = ids.next("guest", { day: campaign.day });
      const entityId = ids.next("entity", { day: campaign.day });
      const preference = createDeterministicRecipePreference({
        registry,
        archetype,
        availableRecipeIds,
        menuEntries: menu.confirmedEntries,
        recipeDefinitions: recipes.definitions,
      });
      plans.push({
        guestId,
        entityId,
        planSequence,
        archetypeId: archetype.guestArchetypeId,
        arrivalAtMs,
        recipePreference: preference.preference,
      });
      preferenceDetails.push({
        guestId,
        archetypeId: archetype.guestArchetypeId,
        ...preference,
      });
    }
  } catch (error) {
    return failure(error.code ?? "DEMAND_PLAN_CREATION_FAILED", error.details);
  }

  let scheduledPlans;
  try {
    scheduledPlans = createScheduledGuestPlans(plans, {
      durationMs: serviceDurationMs,
      expectedCount: guestCount,
    });
  } catch (error) {
    return failure(error.code ?? "DEMAND_PLAN_CREATION_FAILED", error.details);
  }
  const nextRngState = registry.snapshot();
  if (!unchangedNonDemandStreams(rngState, nextRngState)) {
    return failure("DEMAND_RNG_STREAM_ISOLATION_VIOLATION");
  }
  const demandStreamAfter = registry.getStreamState(DEMAND_RNG_STREAM);
  return success({
    plans: scheduledPlans,
    guestCount,
    activeEventGuestDelta: modifiers.guestCountDelta,
    availableRecipeIds,
    preferenceDetails,
    rngState: nextRngState,
    idCounters: ids.snapshot(),
    demandStreamBefore,
    demandStreamAfter,
    drawsConsumed: demandStreamAfter.drawCount - demandStreamBefore.drawCount,
  });
}

export class DemandSystem {
  constructor({ guestArchetypes, configuration = {} } = {}) {
    this.guestArchetypes = createGuestArchetypeCatalog(guestArchetypes);
    this.configuration = normalizeDemandConfiguration(configuration);
    Object.freeze(this);
  }

  planServiceStart(input) {
    return planScheduledGuestGeneration({
      ...input,
      guestArchetypes: this.guestArchetypes,
      configuration: this.configuration,
    });
  }
}
