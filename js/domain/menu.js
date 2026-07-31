import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import {
  applyReservationCreationToDraft,
  applyReservationReleaseToDraft,
} from "./inventory-accounting.js";
import { validateInventoryState } from "./inventory.js";
import { planCookAllocation } from "./reservation-planner.js";
import {
  calculateRecipePriceRange,
  getRecipeDefinition,
  isRecipeUnlocked,
  projectRecipes,
  validateRecipeState,
} from "./recipe.js";
import {
  applySaleSlotAssignmentToDraft,
  applySaleSlotCleanupToDraft,
  applySaleSlotReleaseToDraft,
  countSaleSlots,
  createSaleSlot,
  createSaleSlotsState,
  deriveAssignedSlots,
  planSaleSlotAssignment,
  planSaleSlotCleanup,
  planSaleSlotRelease,
  projectSaleSlots,
  SALE_SLOT_RELEASE_REASON,
  SALE_SLOT_STATE,
  validateSaleSlotsState,
} from "./sale-slots.js";

export const MENU_COMMAND = Object.freeze({
  EDIT_ENTRY: "menu.entry.edit",
  CONFIRM_PLAN: "menu.plan.confirm",
  ASSIGN_SLOT: "menu.slot.assign",
  RELEASE_SLOT: "menu.slot.release",
  CLEANUP: "menu.service.cleanup",
});

export const MENU_EDIT_READ_SET = Object.freeze(["recipes"]);
export const MENU_EDIT_WRITE_SET = Object.freeze(["menu"]);
export const MENU_CONFIRM_READ_SET = Object.freeze(["recipes", "campaign"]);
export const MENU_CONFIRM_WRITE_SET = Object.freeze(["menu", "saleSlots", "inventory", "idCounters"]);
export const MENU_SLOT_READ_SET = Object.freeze(["menu"]);
export const MENU_SLOT_WRITE_SET = Object.freeze(["saleSlots"]);
export const MENU_CLEANUP_READ_SET = Object.freeze([]);
export const MENU_CLEANUP_WRITE_SET = Object.freeze(["menu", "saleSlots", "inventory"]);

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

function compareIds(left, right) {
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

function assignDraft(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, cloneValue(source));
}

function validateDay(day, field = "day") {
  return Number.isSafeInteger(day) && day >= 1 && day <= 14
    ? validationSuccess()
    : failure("INVALID_MENU_DAY", { field, value: day });
}

export function validateMenuEntry(entry, recipes, field = "entry") {
  if (!isPlainRecord(entry)) return failure("INVALID_MENU_ENTRY", { field });
  if (!isStableIdentifier(entry.recipeId)) return failure("INVALID_MENU_RECIPE_ID", { field: `${field}.recipeId` });
  const recipe = getRecipeDefinition(recipes, entry.recipeId);
  if (!recipe) return failure("MENU_RECIPE_NOT_FOUND", { recipeId: entry.recipeId });
  if (!isRecipeUnlocked(recipes, entry.recipeId)) return failure("RECIPE_LOCKED", { recipeId: entry.recipeId });
  if (typeof entry.enabled !== "boolean") return failure("INVALID_MENU_ENABLED", { recipeId: entry.recipeId });
  const range = calculateRecipePriceRange(recipe);
  if (!Number.isSafeInteger(entry.priceG) || entry.priceG < range.minimumPriceG || entry.priceG > range.maximumPriceG) {
    return failure("MENU_PRICE_OUT_OF_RANGE", { recipeId: entry.recipeId, priceG: entry.priceG, ...range });
  }
  if (!Number.isSafeInteger(entry.plannedQuantity) || entry.plannedQuantity < 0) {
    return failure("INVALID_PLANNED_QUANTITY", { recipeId: entry.recipeId, plannedQuantity: entry.plannedQuantity });
  }
  if (!entry.enabled && entry.plannedQuantity !== 0) {
    return failure("DISABLED_RECIPE_HAS_PLANNED_QUANTITY", {
      recipeId: entry.recipeId,
      plannedQuantity: entry.plannedQuantity,
    });
  }
  return validationSuccess();
}

function validateMenuEntries(entries, recipes, field) {
  if (!Array.isArray(entries)) return failure("INVALID_MENU_ENTRY_COLLECTION", { field });
  const expected = [...recipes.unlockedRecipeIds].sort(compareIds);
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const validation = validateMenuEntry(entries[index], recipes, `${field}[${index}]`);
    if (!validation.ok) return validation;
    if (seen.has(entries[index].recipeId)) return failure("DUPLICATE_MENU_RECIPE", { recipeId: entries[index].recipeId });
    if (index > 0 && compareIds(entries[index - 1].recipeId, entries[index].recipeId) >= 0) {
      return failure("MENU_ENTRY_ORDER_INVALID", { field, index });
    }
    seen.add(entries[index].recipeId);
  }
  const actual = [...seen].sort(compareIds);
  if (!equivalent(actual, expected)) return failure("MENU_UNLOCKED_RECIPE_SET_MISMATCH", { field, expected, actual });
  return validationSuccess();
}

export function validateMenuState(menu, recipes) {
  const recipeValidation = validateRecipeState(recipes);
  if (!recipeValidation.ok) return failure("RECIPE_STATE_INVALID", { cause: recipeValidation.code });
  if (!isPlainRecord(menu)) return failure("INVALID_MENU_STATE");
  const day = validateDay(menu.day);
  if (!day.ok) return day;
  if (typeof menu.locked !== "boolean" || typeof menu.cleanupComplete !== "boolean") {
    return failure("INVALID_MENU_LOCK_STATE");
  }
  if (!Number.isSafeInteger(menu.planRevision) || menu.planRevision < 0) {
    return failure("INVALID_MENU_PLAN_REVISION", { planRevision: menu.planRevision });
  }
  if (menu.activePlanId !== null && !isStableIdentifier(menu.activePlanId)) {
    return failure("INVALID_MENU_PLAN_ID", { activePlanId: menu.activePlanId });
  }
  const draft = validateMenuEntries(menu.draftEntries, recipes, "draftEntries");
  if (!draft.ok) return draft;
  return validateMenuEntries(menu.confirmedEntries, recipes, "confirmedEntries");
}

function defaultMenuEntries(recipes) {
  return recipes.unlockedRecipeIds.map((recipeId) => {
    const recipe = getRecipeDefinition(recipes, recipeId);
    return {
      recipeId,
      enabled: true,
      priceG: recipe.basePriceG,
      plannedQuantity: 0,
    };
  });
}

export function createMenuState({
  day,
  recipes,
  draftEntries = null,
  confirmedEntries = null,
  activePlanId = null,
  planRevision = 0,
  locked = false,
  cleanupComplete = false,
} = {}) {
  const defaults = defaultMenuEntries(recipes);
  const state = {
    day,
    locked,
    cleanupComplete,
    planRevision,
    activePlanId,
    draftEntries: cloneValue(draftEntries ?? defaults).sort((left, right) => compareIds(left.recipeId, right.recipeId)),
    confirmedEntries: cloneValue(confirmedEntries ?? defaults).sort((left, right) => compareIds(left.recipeId, right.recipeId)),
  };
  const validation = validateMenuState(state, recipes);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 MenuState입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(state);
}

export function synchronizeMenuForPlanning(menu, recipes) {
  const recipeValidation = validateRecipeState(recipes);
  if (!recipeValidation.ok) return failure("RECIPE_STATE_INVALID", { cause: recipeValidation.code });
  const existingDraft = new Map((menu?.draftEntries ?? []).map((entry) => [entry.recipeId, entry]));
  const existingConfirmed = new Map((menu?.confirmedEntries ?? []).map((entry) => [entry.recipeId, entry]));
  const defaults = new Map(defaultMenuEntries(recipes).map((entry) => [entry.recipeId, entry]));
  try {
    return success({
      menu: createMenuState({
        day: menu.day,
        recipes,
        draftEntries: recipes.unlockedRecipeIds.map((recipeId) => existingDraft.get(recipeId) ?? defaults.get(recipeId)),
        confirmedEntries: recipes.unlockedRecipeIds.map(
          (recipeId) => existingConfirmed.get(recipeId) ?? defaults.get(recipeId),
        ),
        activePlanId: menu.activePlanId,
        planRevision: menu.planRevision,
        locked: false,
        cleanupComplete: false,
      }),
    });
  } catch (error) {
    return failure(error?.code ?? "MENU_SYNCHRONIZATION_FAILED");
  }
}

export function planMenuEntryEdit(menu, recipes, payload, runtimePhase = "PLANNING") {
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) return menuValidation;
  if (runtimePhase !== "PLANNING" || menu.locked) {
    return failure("MENU_EDIT_LOCKED", { runtimePhase, menuLocked: menu.locked });
  }
  const entryValidation = validateMenuEntry(payload, recipes, "payload");
  if (!entryValidation.ok) return entryValidation;
  const entryIndex = menu.draftEntries.findIndex((entry) => entry.recipeId === payload.recipeId);
  if (entryIndex < 0) return failure("MENU_DRAFT_ENTRY_NOT_FOUND", { recipeId: payload.recipeId });
  const candidate = cloneValue(menu);
  candidate.draftEntries[entryIndex] = {
    recipeId: payload.recipeId,
    enabled: payload.enabled,
    priceG: payload.priceG,
    plannedQuantity: payload.plannedQuantity,
  };
  try {
    return success({ menu: createMenuState({ ...candidate, recipes }), editedEntry: candidate.draftEntries[entryIndex] });
  } catch (error) {
    return failure(error?.code ?? "MENU_EDIT_INVALID");
  }
}

function activePlannedEntries(menu) {
  return menu.draftEntries.filter((entry) => entry.enabled && entry.plannedQuantity > 0);
}

function totalPlannedQuantity(entries) {
  const total = entries.reduce((sum, entry) => sum + BigInt(entry.plannedQuantity), 0n);
  if (total > MAX_SAFE_BIGINT) throw new RangeError("Planned_Quantity 합계가 safe integer를 초과했습니다.");
  return Number(total);
}

function allocatePlanIds(idCounters, campaign, day, generationId, entries) {
  if (!isPlainRecord(campaign) || !isStableIdentifier(campaign.campaignId) || campaign.day !== day) {
    return failure("MENU_CAMPAIGN_DAY_MISMATCH", { campaignDay: campaign?.day, menuDay: day });
  }
  let idService;
  try {
    idService = IdService.fromState(idCounters);
  } catch {
    return failure("INVALID_MENU_ID_STATE");
  }
  if (idService.campaignId !== campaign.campaignId || idService.day !== day || idService.generationId !== generationId) {
    return failure("MENU_ID_STATE_MISMATCH", {
      campaignId: idService.campaignId,
      day: idService.day,
      generationId: idService.generationId,
    });
  }
  const plannedTotal = totalPlannedQuantity(entries);
  if (plannedTotal === 0) return success({ reservationPlanId: null, slots: [], idCounters: idService.snapshot() });
  let reservationPlanId;
  const slots = [];
  try {
    reservationPlanId = idService.next("reservation");
    for (const entry of entries) {
      for (let ordinal = 0; ordinal < entry.plannedQuantity; ordinal += 1) {
        slots.push(createSaleSlot({
          saleSlotId: idService.next("slot"),
          recipeId: entry.recipeId,
          ordinal,
        }));
      }
    }
  } catch (error) {
    return failure(error?.code ?? "MENU_ID_ALLOCATION_FAILED");
  }
  return success({ reservationPlanId, slots, idCounters: idService.snapshot() });
}

function releasePriorPlanReservations(inventoryDraft, saleSlots) {
  const priorSlotIds = new Set(saleSlots.slots.map((slot) => slot.saleSlotId));
  const selectors = [...new Set(inventoryDraft.reservations
    .filter((reservation) => priorSlotIds.has(reservation.saleSlotId))
    .map((reservation) => reservation.saleSlotId))];
  if (selectors.length === 0) return validationSuccess({ releasedCount: 0 });
  const released = applyReservationReleaseToDraft(inventoryDraft, { saleSlotIds: selectors });
  return released.ok
    ? validationSuccess({ releasedCount: released.plan.released.length })
    : released;
}

export function validateMenuPlanReconciliation(menu, recipes, saleSlots, inventory, {
  requireFullReservations = false,
} = {}) {
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) return failure("MENU_STATE_INVALID", { cause: menuValidation.code });
  const slotValidation = validateSaleSlotsState(saleSlots);
  if (!slotValidation.ok) return failure("SALE_SLOTS_STATE_INVALID", { cause: slotValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  if (menu.day !== saleSlots.day) return failure("MENU_SLOT_DAY_MISMATCH", { menuDay: menu.day, slotDay: saleSlots.day });

  const entryByRecipe = new Map(menu.confirmedEntries.map((entry) => [entry.recipeId, entry]));
  let plannedTotal = 0n;
  for (const entry of menu.confirmedEntries) plannedTotal += BigInt(entry.plannedQuantity);
  if (plannedTotal > MAX_SAFE_BIGINT) return failure("MENU_PLANNED_TOTAL_OVERFLOW");
  if (Number(plannedTotal) !== saleSlots.slots.length) {
    return failure("MENU_SLOT_COUNT_MISMATCH", { planned: Number(plannedTotal), slots: saleSlots.slots.length });
  }

  const slotsByRecipe = new Map();
  const slotById = new Map();
  for (const slot of saleSlots.slots) {
    const entry = entryByRecipe.get(slot.recipeId);
    if (!entry || !entry.enabled) return failure("SALE_SLOT_RECIPE_NOT_ACTIVE", { saleSlotId: slot.saleSlotId });
    const list = slotsByRecipe.get(slot.recipeId) ?? [];
    list.push(slot);
    slotsByRecipe.set(slot.recipeId, list);
    slotById.set(slot.saleSlotId, slot);
  }
  for (const entry of menu.confirmedEntries) {
    const slots = (slotsByRecipe.get(entry.recipeId) ?? []).sort((left, right) => left.ordinal - right.ordinal);
    if (slots.length !== entry.plannedQuantity) {
      return failure("RECIPE_SLOT_COUNT_MISMATCH", {
        recipeId: entry.recipeId,
        planned: entry.plannedQuantity,
        actual: slots.length,
      });
    }
    for (let ordinal = 0; ordinal < slots.length; ordinal += 1) {
      if (slots[ordinal].ordinal !== ordinal) {
        return failure("RECIPE_SLOT_ORDINAL_GAP", { recipeId: entry.recipeId, ordinal });
      }
    }
  }

  const reservationBySlotIngredient = new Map();
  let reservationQuantity = 0n;
  for (const reservation of inventory.reservations) {
    const slot = slotById.get(reservation.saleSlotId);
    if (!slot) return failure("ORPHAN_MENU_RESERVATION", { reservationId: reservation.reservationId });
    if (slot.state === SALE_SLOT_STATE.SOLD) {
      return failure("SOLD_SLOT_RETAINS_RESERVATION", { saleSlotId: slot.saleSlotId });
    }
    const key = `${slot.saleSlotId}|${reservation.ingredientId}`;
    const next = BigInt(reservationBySlotIngredient.get(key) ?? 0) + BigInt(reservation.quantity);
    if (next > MAX_SAFE_BIGINT) return failure("MENU_RESERVATION_QUANTITY_OVERFLOW", { key });
    reservationBySlotIngredient.set(key, Number(next));
    reservationQuantity += BigInt(reservation.quantity);
  }

  let promisedIngredientQuantity = 0n;
  for (const slot of saleSlots.slots) {
    const recipe = getRecipeDefinition(recipes, slot.recipeId);
    for (const requirement of recipe.ingredientRequirements) {
      promisedIngredientQuantity += BigInt(requirement.quantity);
      const actual = reservationBySlotIngredient.get(`${slot.saleSlotId}|${requirement.ingredientId}`) ?? 0;
      if (actual > requirement.quantity || (requireFullReservations && actual !== requirement.quantity)) {
        return failure("MENU_RESERVATION_PROMISE_MISMATCH", {
          saleSlotId: slot.saleSlotId,
          ingredientId: requirement.ingredientId,
          expected: requirement.quantity,
          actual,
          requireFullReservations,
        });
      }
    }
  }
  if (promisedIngredientQuantity > MAX_SAFE_BIGINT || reservationQuantity > MAX_SAFE_BIGINT) {
    return failure("MENU_PROMISE_TOTAL_OVERFLOW");
  }
  const counts = countSaleSlots(saleSlots);
  return validationSuccess({
    plannedQuantity: Number(plannedTotal),
    saleSlotCount: saleSlots.slots.length,
    availableCount: counts.byState.AVAILABLE,
    assignedCount: counts.byState.ASSIGNED,
    soldCount: counts.byState.SOLD,
    promisedIngredientQuantity: Number(promisedIngredientQuantity),
    reservationQuantity: Number(reservationQuantity),
  });
}

/**
 * Restores prior-plan reservations only on a detached draft, previews the entire new menu, then
 * delegates the all-or-nothing allocation to Task 14's hard-reservation planner.
 */
export function planMenuConfirmation({
  menu,
  recipes,
  saleSlots,
  inventory,
  idCounters,
  campaign,
  runtimePhase,
  generationId,
}, payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_MENU_CONFIRM_PAYLOAD");
  const dayValidation = validateDay(payload.day, "payload.day");
  if (!dayValidation.ok) return dayValidation;
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) return failure("MENU_STATE_INVALID", { cause: menuValidation.code });
  const slotValidation = validateSaleSlotsState(saleSlots);
  if (!slotValidation.ok) return failure("SALE_SLOTS_STATE_INVALID", { cause: slotValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  if (runtimePhase !== "PLANNING" || menu.locked) {
    return failure("MENU_CONFIRM_LOCKED", { runtimePhase, menuLocked: menu.locked });
  }
  if (payload.day !== menu.day || payload.day !== saleSlots.day) {
    return failure("MENU_CONFIRM_DAY_MISMATCH", { payloadDay: payload.day, menuDay: menu.day, slotDay: saleSlots.day });
  }
  if (saleSlots.slots.some((slot) => slot.state !== SALE_SLOT_STATE.AVAILABLE)) {
    return failure("MENU_REPLAN_REQUIRES_AVAILABLE_SLOTS");
  }

  const inventoryCandidate = cloneValue(inventory);
  const restored = releasePriorPlanReservations(inventoryCandidate, saleSlots);
  if (!restored.ok) return restored;

  const entries = activePlannedEntries(menu);
  let ids;
  try {
    ids = allocatePlanIds(idCounters, campaign, menu.day, generationId, entries);
  } catch {
    return failure("MENU_PLANNED_TOTAL_OVERFLOW");
  }
  if (!ids.ok) return ids;
  const slotsCandidate = createSaleSlotsState({ day: menu.day, slots: ids.plan.slots });
  if (ids.plan.slots.length > 0) {
    const requestBySlot = ids.plan.slots.map((slot) => ({
      saleSlotId: slot.saleSlotId,
      recipeId: slot.recipeId,
      requirements: getRecipeDefinition(recipes, slot.recipeId).ingredientRequirements,
    }));
    const reserved = applyReservationCreationToDraft(inventoryCandidate, {
      reservationPlanId: ids.plan.reservationPlanId,
      requests: requestBySlot,
    });
    if (!reserved.ok) return reserved;
  }

  let menuCandidate;
  try {
    menuCandidate = createMenuState({
      day: menu.day,
      recipes,
      draftEntries: menu.draftEntries,
      confirmedEntries: menu.draftEntries,
      activePlanId: ids.plan.reservationPlanId,
      planRevision: menu.planRevision + 1,
      locked: false,
      cleanupComplete: false,
    });
  } catch (error) {
    return failure(error?.code ?? "MENU_CONFIRM_STATE_INVALID");
  }
  const reconciliation = validateMenuPlanReconciliation(
    menuCandidate,
    recipes,
    slotsCandidate,
    inventoryCandidate,
    { requireFullReservations: true },
  );
  if (!reconciliation.ok) return reconciliation;
  return success({
    menu: menuCandidate,
    saleSlots: slotsCandidate,
    inventory: inventoryCandidate,
    idCounters: ids.plan.idCounters,
    reservationPlanId: ids.plan.reservationPlanId,
    restoredReservationCount: restored.details?.releasedCount ?? 0,
    ...reconciliation.details,
  });
}

function validateMenuPlanPostconditions(before, after, planned) {
  for (const slice of MENU_CONFIRM_WRITE_SET) {
    if (!equivalent(after[slice], planned[slice])) return failure("MENU_CONFIRM_PLAN_MISMATCH", { slice });
  }
  const reconciliation = validateMenuPlanReconciliation(
    after.menu,
    after.recipes,
    after.saleSlots,
    after.inventory,
    { requireFullReservations: true },
  );
  if (!reconciliation.ok) return reconciliation;
  const expectedSlotAdvance = planned.saleSlotCount;
  if (after.idCounters.counters.slot !== before.idCounters.counters.slot + expectedSlotAdvance) {
    return failure("MENU_SLOT_ID_COUNTER_MISMATCH", { expectedSlotAdvance });
  }
  const expectedReservationAdvance = planned.saleSlotCount > 0 ? 1 : 0;
  if (after.idCounters.counters.reservation !==
      before.idCounters.counters.reservation + expectedReservationAdvance) {
    return failure("MENU_RESERVATION_ID_COUNTER_MISMATCH", { expectedReservationAdvance });
  }
  for (const kind of Object.keys(before.idCounters.counters)) {
    if (["slot", "reservation"].includes(kind)) continue;
    if (after.idCounters.counters[kind] !== before.idCounters.counters[kind]) {
      return failure("MENU_UNRELATED_ID_COUNTER_CHANGED", { kind });
    }
  }
  return validationSuccess(reconciliation.details);
}

function requireLockedServiceMenu(menu) {
  return menu.locked && !menu.cleanupComplete
    ? validationSuccess()
    : failure(menu.cleanupComplete ? "MENU_SERVICE_CLEANUP_COMPLETE" : "MENU_SERVICE_NOT_LOCKED");
}

export function prepareMenuForServiceDraft(menuDraft, recipes) {
  const validation = validateMenuState(menuDraft, recipes);
  if (!validation.ok) return validation;
  menuDraft.locked = true;
  menuDraft.cleanupComplete = false;
  return validationSuccess();
}

export function planCookFailureRetryEligibility({ menu, recipes, saleSlots, inventory }, saleSlotId) {
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) return failure("MENU_STATE_INVALID", { cause: menuValidation.code });
  const slotValidation = validateSaleSlotsState(saleSlots);
  if (!slotValidation.ok) return failure("SALE_SLOTS_STATE_INVALID", { cause: slotValidation.code });
  const slot = saleSlots.slots.find((candidate) => candidate.saleSlotId === saleSlotId);
  if (!slot) return failure("SALE_SLOT_NOT_FOUND", { saleSlotId });
  if (slot.state !== SALE_SLOT_STATE.ASSIGNED) {
    return failure("COOK_RETRY_REQUIRES_ASSIGNED_SLOT", { saleSlotId, state: slot.state });
  }
  const recipe = getRecipeDefinition(recipes, slot.recipeId);
  const allocation = planCookAllocation(inventory, {
    requirements: recipe.ingredientRequirements,
    saleSlotId,
  });
  if (!allocation.ok) {
    return freezeDeep({
      ok: true,
      eligible: false,
      code: allocation.code,
      shortages: allocation.details?.shortages ?? [],
      saleSlotId,
      slotState: slot.state,
    });
  }
  return freezeDeep({
    ok: true,
    eligible: true,
    code: "COOK_RETRY_ELIGIBLE",
    shortages: [],
    saleSlotId,
    slotState: slot.state,
    allocationQuantity: allocation.plan.totalQuantity,
  });
}

export function createEditMenuEntryAtomicTransaction() {
  return defineAtomicTransaction({
    name: MENU_COMMAND.EDIT_ENTRY,
    readSet: MENU_EDIT_READ_SET,
    writeSet: MENU_EDIT_WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      return isPlainRecord(ctx.command.payload)
        ? validateMenuEntry(ctx.command.payload, ctx.read("recipes"), "payload")
        : failure("INVALID_MENU_EDIT_PAYLOAD");
    },
    preflight(ctx) {
      return planMenuEntryEdit(ctx.read("menu"), ctx.read("recipes"), ctx.command.payload, ctx.phase);
    },
    mutate(draft) {
      const planned = planMenuEntryEdit(
        draft.read("menu"),
        draft.read("recipes"),
        draft.command.payload,
        "PLANNING",
      );
      if (!planned.ok) return planned;
      draft.replace("menu", planned.plan.menu);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planMenuEntryEdit(before.menu, before.recipes, ctx.command.payload, before.runtimePhase);
      if (!planned.ok) return planned;
      return equivalent(after.menu, planned.plan.menu)
        ? validateMenuState(after.menu, after.recipes)
        : failure("MENU_EDIT_PLAN_MISMATCH");
    },
    events(_before, _after, ctx) {
      return [{
        type: "menu.draft-entry-edited",
        payload: cloneValue(ctx.command.payload),
      }];
    },
  });
}

export function createConfirmMenuPlanAtomicTransaction() {
  return defineAtomicTransaction({
    name: MENU_COMMAND.CONFIRM_PLAN,
    readSet: MENU_CONFIRM_READ_SET,
    writeSet: MENU_CONFIRM_WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      return isPlainRecord(ctx.command.payload) ? validateDay(ctx.command.payload.day, "payload.day") :
        failure("INVALID_MENU_CONFIRM_PAYLOAD");
    },
    preflight(ctx) {
      return planMenuConfirmation({
        menu: ctx.read("menu"),
        recipes: ctx.read("recipes"),
        saleSlots: ctx.read("saleSlots"),
        inventory: ctx.read("inventory"),
        idCounters: ctx.read("idCounters"),
        campaign: ctx.read("campaign"),
        runtimePhase: ctx.phase,
        generationId: ctx.generationId,
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planMenuConfirmation({
        menu: draft.read("menu"),
        recipes: draft.read("recipes"),
        saleSlots: draft.read("saleSlots"),
        inventory: draft.read("inventory"),
        idCounters: draft.read("idCounters"),
        campaign: draft.read("campaign"),
        runtimePhase: "PLANNING",
        generationId: draft.command.generationId,
      }, draft.command.payload);
      if (!planned.ok) return planned;
      for (const slice of MENU_CONFIRM_WRITE_SET) draft.replace(slice, planned.plan[slice]);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planMenuConfirmation({
        menu: before.menu,
        recipes: before.recipes,
        saleSlots: before.saleSlots,
        inventory: before.inventory,
        idCounters: before.idCounters,
        campaign: before.campaign,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
      }, ctx.command.payload);
      if (!planned.ok) return planned;
      return validateMenuPlanPostconditions(before, after, planned.plan);
    },
    events(before, _after, ctx) {
      const planned = planMenuConfirmation({
        menu: before.menu,
        recipes: before.recipes,
        saleSlots: before.saleSlots,
        inventory: before.inventory,
        idCounters: before.idCounters,
        campaign: before.campaign,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
      }, ctx.command.payload);
      if (!planned.ok) return [];
      return [{
        ...(planned.plan.reservationPlanId ? { eventId: `${planned.plan.reservationPlanId}.confirmed` } : {}),
        type: "menu.plan-confirmed",
        payload: {
          day: before.menu.day,
          reservationPlanId: planned.plan.reservationPlanId,
          plannedQuantity: planned.plan.plannedQuantity,
          saleSlotCount: planned.plan.saleSlotCount,
          reservationQuantity: planned.plan.reservationQuantity,
          planRevision: planned.plan.menu.planRevision,
        },
      }];
    },
  });
}

function createSlotAssignmentAtomicTransaction() {
  return defineAtomicTransaction({
    name: MENU_COMMAND.ASSIGN_SLOT,
    readSet: MENU_SLOT_READ_SET,
    writeSet: MENU_SLOT_WRITE_SET,
    allowedPhases: ["SERVICE"],
    validatePayload(ctx) {
      const payload = ctx.command.payload;
      return isPlainRecord(payload) && isStableIdentifier(payload.recipeId) && isStableIdentifier(payload.orderId)
        ? validationSuccess()
        : failure("INVALID_SLOT_ASSIGNMENT_PAYLOAD");
    },
    preflight(ctx) {
      const lock = requireLockedServiceMenu(ctx.read("menu"));
      if (!lock.ok) return lock;
      const entry = ctx.read("menu").confirmedEntries.find((candidate) => candidate.recipeId === ctx.command.payload.recipeId);
      if (!entry?.enabled || entry.plannedQuantity <= 0) return failure("RECIPE_NOT_ACTIVE_ON_MENU");
      return planSaleSlotAssignment(ctx.read("saleSlots"), ctx.command.payload);
    },
    mutate(draft) {
      const lock = requireLockedServiceMenu(draft.read("menu"));
      if (!lock.ok) return lock;
      return applySaleSlotAssignmentToDraft(draft.write("saleSlots"), draft.command.payload);
    },
    postconditions(before, after, ctx) {
      const planned = planSaleSlotAssignment(before.saleSlots, ctx.command.payload);
      if (!planned.ok) return planned;
      return equivalent(after.saleSlots, planned.plan.saleSlots)
        ? validateSaleSlotsState(after.saleSlots)
        : failure("SLOT_ASSIGNMENT_PLAN_MISMATCH");
    },
    events(_before, after, ctx) {
      const slot = after.saleSlots.slots.find((candidate) => candidate.activeOrderId === ctx.command.payload.orderId);
      return [{ type: "menu.sale-slot-assigned", payload: { ...ctx.command.payload, saleSlotId: slot?.saleSlotId ?? null } }];
    },
  });
}

function createSlotReleaseAtomicTransaction() {
  return defineAtomicTransaction({
    name: MENU_COMMAND.RELEASE_SLOT,
    readSet: MENU_SLOT_READ_SET,
    writeSet: MENU_SLOT_WRITE_SET,
    allowedPhases: ["SERVICE"],
    validatePayload(ctx) {
      const payload = ctx.command.payload;
      return isPlainRecord(payload) && isStableIdentifier(payload.saleSlotId) && isStableIdentifier(payload.orderId) &&
        [SALE_SLOT_RELEASE_REASON.TIMEOUT, SALE_SLOT_RELEASE_REASON.TECHNICAL_CANCEL].includes(payload.reason)
        ? validationSuccess()
        : failure("INVALID_SLOT_RELEASE_PAYLOAD");
    },
    preflight(ctx) {
      const lock = requireLockedServiceMenu(ctx.read("menu"));
      return lock.ok ? planSaleSlotRelease(ctx.read("saleSlots"), ctx.command.payload) : lock;
    },
    mutate(draft) {
      const lock = requireLockedServiceMenu(draft.read("menu"));
      return lock.ok ? applySaleSlotReleaseToDraft(draft.write("saleSlots"), draft.command.payload) : lock;
    },
    postconditions(before, after, ctx) {
      const planned = planSaleSlotRelease(before.saleSlots, ctx.command.payload);
      return planned.ok && equivalent(after.saleSlots, planned.plan.saleSlots)
        ? validateSaleSlotsState(after.saleSlots)
        : planned.ok ? failure("SLOT_RELEASE_PLAN_MISMATCH") : planned;
    },
    events(_before, _after, ctx) {
      return [{ type: "menu.sale-slot-released", payload: cloneValue(ctx.command.payload) }];
    },
  });
}

function createMenuCleanupAtomicTransaction() {
  return defineAtomicTransaction({
    name: MENU_COMMAND.CLEANUP,
    readSet: MENU_CLEANUP_READ_SET,
    writeSet: MENU_CLEANUP_WRITE_SET,
    allowedPhases: ["SERVICE"],
    validatePayload(ctx) {
      return isPlainRecord(ctx.command.payload) &&
        [SALE_SLOT_RELEASE_REASON.CLEANUP, SALE_SLOT_RELEASE_REASON.TECHNICAL_CANCEL].includes(ctx.command.payload.reason)
        ? validationSuccess()
        : failure("INVALID_MENU_CLEANUP_PAYLOAD");
    },
    preflight(ctx) {
      const lock = requireLockedServiceMenu(ctx.read("menu"));
      if (!lock.ok) return lock;
      const planned = planSaleSlotCleanup(ctx.read("saleSlots"), ctx.read("inventory"));
      if (!planned.ok) return planned;
      return planned.plan.changed ? planned : failure("MENU_CLEANUP_ALREADY_COMPLETE");
    },
    mutate(draft) {
      const lock = requireLockedServiceMenu(draft.read("menu"));
      if (!lock.ok) return lock;
      const planned = applySaleSlotCleanupToDraft(draft.write("saleSlots"), draft.write("inventory"));
      if (!planned.ok) return planned;
      draft.write("menu").cleanupComplete = true;
      return validationSuccess();
    },
    postconditions(before, after) {
      const planned = planSaleSlotCleanup(before.saleSlots, before.inventory);
      if (!planned.ok) return planned;
      if (!equivalent(after.saleSlots, planned.plan.saleSlots) || !equivalent(after.inventory, planned.plan.inventory)) {
        return failure("MENU_CLEANUP_PLAN_MISMATCH");
      }
      if (!after.menu.cleanupComplete || deriveAssignedSlots(after.saleSlots).length !== 0 ||
          after.inventory.reservations.some((reservation) =>
            after.saleSlots.slots.some((slot) => slot.saleSlotId === reservation.saleSlotId))) {
        return failure("MENU_CLEANUP_LEAK");
      }
      const counts = countSaleSlots(after.saleSlots);
      const plannedTotal = after.menu.confirmedEntries.reduce((total, entry) => total + entry.plannedQuantity, 0);
      return counts.byState.SOLD <= plannedTotal ? validationSuccess() : failure("SOLD_EXCEEDS_PLANNED");
    },
    events(_before, after, ctx) {
      return [{
        type: "menu.service-cleaned",
        payload: {
          reason: ctx.command.payload.reason,
          assignedCount: deriveAssignedSlots(after.saleSlots).length,
          unusedReservationCount: after.inventory.reservations.length,
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

export function projectRecipeMenu(snapshot) {
  const menuValidation = validateMenuState(snapshot.menu, snapshot.recipes);
  if (!menuValidation.ok) throw new TypeError(`Recipe/Menu projection이 유효하지 않습니다: ${menuValidation.code}`);
  const slotProjection = projectSaleSlots(snapshot.saleSlots);
  const recipeProjection = projectRecipes(snapshot.recipes, {
    runtimePhase: snapshot.runtimePhase,
    menuLocked: snapshot.menu.locked,
  });
  const recipeById = new Map(recipeProjection.recipes.map((recipe) => [recipe.recipeId, recipe]));
  const decorate = (entry) => ({ ...entry, recipe: recipeById.get(entry.recipeId) });
  return freezeDeep({
    day: snapshot.menu.day,
    editable: snapshot.runtimePhase === "PLANNING" && !snapshot.menu.locked,
    locked: snapshot.menu.locked || snapshot.runtimePhase !== "PLANNING",
    cleanupComplete: snapshot.menu.cleanupComplete,
    planRevision: snapshot.menu.planRevision,
    activePlanId: snapshot.menu.activePlanId,
    recipes: recipeProjection.recipes,
    draftEntries: snapshot.menu.draftEntries.map(decorate),
    confirmedEntries: snapshot.menu.confirmedEntries.map(decorate),
    saleSlots: slotProjection.slots,
    assigned_slots: slotProjection.assigned_slots,
    slotCounts: slotProjection.counts,
  });
}

export class MenuSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("MenuSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(MENU_COMMAND.EDIT_ENTRY, createEditMenuEntryAtomicTransaction());
    this.commandBus.register(MENU_COMMAND.CONFIRM_PLAN, createConfirmMenuPlanAtomicTransaction());
    this.commandBus.register(MENU_COMMAND.ASSIGN_SLOT, createSlotAssignmentAtomicTransaction());
    this.commandBus.register(MENU_COMMAND.RELEASE_SLOT, createSlotReleaseAtomicTransaction());
    this.commandBus.register(MENU_COMMAND.CLEANUP, createMenuCleanupAtomicTransaction());
    this.registered = true;
    return this;
  }

  editEntry(input) {
    return this.commandBus.dispatch(commandEnvelope(
      MENU_COMMAND.EDIT_ENTRY,
      MENU_EDIT_READ_SET,
      MENU_EDIT_WRITE_SET,
      input,
    ));
  }

  confirmPlan(input) {
    return this.commandBus.dispatch(commandEnvelope(
      MENU_COMMAND.CONFIRM_PLAN,
      MENU_CONFIRM_READ_SET,
      MENU_CONFIRM_WRITE_SET,
      input,
    ));
  }

  assignSlot(input) {
    return this.commandBus.dispatch(commandEnvelope(
      MENU_COMMAND.ASSIGN_SLOT,
      MENU_SLOT_READ_SET,
      MENU_SLOT_WRITE_SET,
      input,
    ));
  }

  releaseSlot(input) {
    return this.commandBus.dispatch(commandEnvelope(
      MENU_COMMAND.RELEASE_SLOT,
      MENU_SLOT_READ_SET,
      MENU_SLOT_WRITE_SET,
      input,
    ));
  }

  cleanup(input) {
    return this.commandBus.dispatch(commandEnvelope(
      MENU_COMMAND.CLEANUP,
      MENU_CLEANUP_READ_SET,
      MENU_CLEANUP_WRITE_SET,
      input,
    ));
  }

  project(snapshot) {
    return projectRecipeMenu(snapshot);
  }

  retryEligibility(snapshot, saleSlotId) {
    return planCookFailureRetryEligibility(snapshot, saleSlotId);
  }
}

export function registerMenuSystem(commandBus) {
  return new MenuSystem(commandBus, { register: true });
}
