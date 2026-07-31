import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import { applyReservationReleaseToDraft } from "./inventory-accounting.js";
import { validateInventoryState } from "./inventory.js";

export const SALE_SLOT_STATE = Object.freeze({
  AVAILABLE: "AVAILABLE",
  ASSIGNED: "ASSIGNED",
  SOLD: "SOLD",
});

export const SALE_SLOT_RELEASE_REASON = Object.freeze({
  TIMEOUT: "TIMEOUT",
  TECHNICAL_CANCEL: "TECHNICAL_CANCEL",
  CLEANUP: "CLEANUP",
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

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSaleSlots(left, right) {
  return compareIds(left.recipeId, right.recipeId) || left.ordinal - right.ordinal ||
    compareIds(left.saleSlotId, right.saleSlotId);
}

function assignDraft(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, cloneValue(source));
}

export function validateSaleSlot(slot) {
  if (!isPlainRecord(slot)) return failure("INVALID_SALE_SLOT");
  for (const field of ["saleSlotId", "recipeId"]) {
    if (!isStableIdentifier(slot[field])) return failure("INVALID_SALE_SLOT_IDENTIFIER", { field, value: slot[field] });
  }
  if (!Number.isSafeInteger(slot.ordinal) || slot.ordinal < 0) {
    return failure("INVALID_SALE_SLOT_ORDINAL", { ordinal: slot.ordinal });
  }
  if (!Object.values(SALE_SLOT_STATE).includes(slot.state)) {
    return failure("INVALID_SALE_SLOT_STATE", { state: slot.state });
  }
  if (slot.state === SALE_SLOT_STATE.ASSIGNED) {
    if (!isStableIdentifier(slot.activeOrderId)) {
      return failure("ASSIGNED_SLOT_MISSING_ORDER", { saleSlotId: slot.saleSlotId });
    }
  } else if (slot.activeOrderId !== null) {
    return failure("NON_ASSIGNED_SLOT_HAS_ORDER", { saleSlotId: slot.saleSlotId, state: slot.state });
  }
  return validationSuccess();
}

export function createSaleSlot(input) {
  const slot = {
    saleSlotId: input?.saleSlotId,
    recipeId: input?.recipeId,
    ordinal: input?.ordinal,
    state: input?.state ?? SALE_SLOT_STATE.AVAILABLE,
    activeOrderId: input?.activeOrderId ?? null,
  };
  const validation = validateSaleSlot(slot);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 SaleSlot입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(slot);
}

export function validateSaleSlotsState(state) {
  if (!isPlainRecord(state) || !Number.isSafeInteger(state.day) || state.day < 1 || state.day > 14 ||
      !Array.isArray(state.slots)) {
    return failure("INVALID_SALE_SLOTS_STATE");
  }
  const ids = new Set();
  const activeOrderIds = new Set();
  const ordinals = new Set();
  for (let index = 0; index < state.slots.length; index += 1) {
    const slot = state.slots[index];
    const validation = validateSaleSlot(slot);
    if (!validation.ok) return failure(validation.code, { slotIndex: index, ...validation.details });
    if (ids.has(slot.saleSlotId)) return failure("DUPLICATE_SALE_SLOT_ID", { saleSlotId: slot.saleSlotId });
    ids.add(slot.saleSlotId);
    const recipeOrdinal = `${slot.recipeId}:${slot.ordinal}`;
    if (ordinals.has(recipeOrdinal)) return failure("DUPLICATE_RECIPE_SLOT_ORDINAL", { recipeOrdinal });
    ordinals.add(recipeOrdinal);
    if (slot.activeOrderId !== null) {
      if (activeOrderIds.has(slot.activeOrderId)) {
        return failure("ORDER_ASSIGNED_TO_MULTIPLE_SLOTS", { activeOrderId: slot.activeOrderId });
      }
      activeOrderIds.add(slot.activeOrderId);
    }
    if (index > 0 && compareSaleSlots(state.slots[index - 1], slot) >= 0) {
      return failure("SALE_SLOT_ORDER_INVALID", { slotIndex: index });
    }
  }
  return validationSuccess();
}

export function createSaleSlotsState({ day, slots = [] } = {}) {
  const state = {
    day,
    slots: Array.isArray(slots)
      ? slots.map((slot) => ({ ...slot })).sort(compareSaleSlots)
      : slots,
  };
  const validation = validateSaleSlotsState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 SaleSlotsState입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(state);
}

export function deriveAssignedSlots(state) {
  const validation = validateSaleSlotsState(state);
  if (!validation.ok) throw new TypeError(`assigned_slots를 계산할 수 없습니다: ${validation.code}`);
  return freezeDeep(state.slots.filter((slot) => slot.state === SALE_SLOT_STATE.ASSIGNED));
}

export function countSaleSlots(state) {
  const validation = validateSaleSlotsState(state);
  if (!validation.ok) throw new TypeError(`SaleSlot count를 계산할 수 없습니다: ${validation.code}`);
  const byState = Object.fromEntries(Object.values(SALE_SLOT_STATE).map((slotState) => [slotState, 0]));
  const byRecipe = Object.create(null);
  for (const slot of state.slots) {
    byState[slot.state] += 1;
    const counts = byRecipe[slot.recipeId] ?? {
      recipeId: slot.recipeId,
      total: 0,
      available: 0,
      assigned: 0,
      sold: 0,
    };
    counts.total += 1;
    counts[slot.state.toLowerCase()] += 1;
    byRecipe[slot.recipeId] = counts;
  }
  return freezeDeep({ total: state.slots.length, byState, byRecipe });
}

export function planSaleSlotAssignment(state, { recipeId, orderId } = {}) {
  const validation = validateSaleSlotsState(state);
  if (!validation.ok) return failure("SALE_SLOTS_STATE_INVALID", { cause: validation.code });
  if (!isStableIdentifier(recipeId)) return failure("INVALID_RECIPE_ID", { recipeId });
  if (!isStableIdentifier(orderId)) return failure("INVALID_ORDER_ID", { orderId });
  if (state.slots.some((slot) => slot.activeOrderId === orderId)) {
    return failure("ORDER_ALREADY_ASSIGNED", { orderId });
  }
  const slot = state.slots
    .filter((candidate) => candidate.recipeId === recipeId && candidate.state === SALE_SLOT_STATE.AVAILABLE)
    .sort(compareSaleSlots)[0];
  if (!slot) return failure("AVAILABLE_SALE_SLOT_NOT_FOUND", { recipeId });
  const candidate = cloneValue(state);
  const target = candidate.slots.find((item) => item.saleSlotId === slot.saleSlotId);
  target.state = SALE_SLOT_STATE.ASSIGNED;
  target.activeOrderId = orderId;
  const normalized = createSaleSlotsState(candidate);
  return success({ saleSlots: normalized, slot: normalized.slots.find((item) => item.saleSlotId === slot.saleSlotId) });
}

export function applySaleSlotAssignmentToDraft(stateDraft, input) {
  const planned = planSaleSlotAssignment(stateDraft, input);
  if (!planned.ok) return planned;
  assignDraft(stateDraft, planned.plan.saleSlots);
  return planned;
}

export function planSaleSlotRelease(state, { saleSlotId, orderId, reason } = {}) {
  const validation = validateSaleSlotsState(state);
  if (!validation.ok) return failure("SALE_SLOTS_STATE_INVALID", { cause: validation.code });
  if (!isStableIdentifier(saleSlotId)) return failure("INVALID_SALE_SLOT_ID", { saleSlotId });
  if (!isStableIdentifier(orderId)) return failure("INVALID_ORDER_ID", { orderId });
  if (![SALE_SLOT_RELEASE_REASON.TIMEOUT, SALE_SLOT_RELEASE_REASON.TECHNICAL_CANCEL].includes(reason)) {
    return failure("INVALID_SALE_SLOT_RELEASE_REASON", { reason });
  }
  const slot = state.slots.find((candidate) => candidate.saleSlotId === saleSlotId);
  if (!slot) return failure("SALE_SLOT_NOT_FOUND", { saleSlotId });
  if (slot.state === SALE_SLOT_STATE.SOLD) return failure("SOLD_SALE_SLOT_TERMINAL", { saleSlotId });
  if (slot.state !== SALE_SLOT_STATE.ASSIGNED) {
    return failure("SALE_SLOT_NOT_ASSIGNED", { saleSlotId, state: slot.state });
  }
  if (slot.activeOrderId !== orderId) {
    return failure("SALE_SLOT_ORDER_MISMATCH", { saleSlotId, expected: slot.activeOrderId, actual: orderId });
  }
  const candidate = cloneValue(state);
  const target = candidate.slots.find((item) => item.saleSlotId === saleSlotId);
  target.state = SALE_SLOT_STATE.AVAILABLE;
  target.activeOrderId = null;
  return success({ saleSlots: createSaleSlotsState(candidate), releasedSlotId: saleSlotId, reason });
}

export function applySaleSlotReleaseToDraft(stateDraft, input) {
  const planned = planSaleSlotRelease(stateDraft, input);
  if (!planned.ok) return planned;
  assignDraft(stateDraft, planned.plan.saleSlots);
  return planned;
}

/**
 * Pure sale-composition helper for Task 22. It deliberately is not exposed as a standalone
 * CommandBus command: cash/Revenue/COGS/order/dish must join this mutation in one sale transaction.
 */
export function planSaleSlotSold(state, inventory, { saleSlotId, orderId } = {}) {
  const slotValidation = validateSaleSlotsState(state);
  if (!slotValidation.ok) return failure("SALE_SLOTS_STATE_INVALID", { cause: slotValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  if (!isStableIdentifier(saleSlotId) || !isStableIdentifier(orderId)) {
    return failure("INVALID_SALE_SLOT_SALE_INPUT", { saleSlotId, orderId });
  }
  const slot = state.slots.find((candidate) => candidate.saleSlotId === saleSlotId);
  if (!slot) return failure("SALE_SLOT_NOT_FOUND", { saleSlotId });
  if (slot.state === SALE_SLOT_STATE.SOLD) return failure("SOLD_SALE_SLOT_TERMINAL", { saleSlotId });
  if (slot.state !== SALE_SLOT_STATE.ASSIGNED) return failure("SALE_SLOT_NOT_ASSIGNED", { saleSlotId, state: slot.state });
  if (slot.activeOrderId !== orderId) return failure("SALE_SLOT_ORDER_MISMATCH", { saleSlotId });

  const slotsCandidate = cloneValue(state);
  const target = slotsCandidate.slots.find((item) => item.saleSlotId === saleSlotId);
  target.state = SALE_SLOT_STATE.SOLD;
  target.activeOrderId = null;
  const inventoryCandidate = cloneValue(inventory);
  const remainingReservationCount = inventoryCandidate.reservations.filter(
    (reservation) => reservation.saleSlotId === saleSlotId,
  ).length;
  let released = [];
  if (remainingReservationCount > 0) {
    const release = applyReservationReleaseToDraft(inventoryCandidate, { saleSlotIds: [saleSlotId] });
    if (!release.ok) return release;
    released = release.plan.released;
  }
  return success({
    saleSlots: createSaleSlotsState(slotsCandidate),
    inventory: inventoryCandidate,
    soldSlotId: saleSlotId,
    releasedReservations: released,
  });
}

export function applySaleSlotSoldToDraft(stateDraft, inventoryDraft, input) {
  const planned = planSaleSlotSold(stateDraft, inventoryDraft, input);
  if (!planned.ok) return planned;
  assignDraft(stateDraft, planned.plan.saleSlots);
  assignDraft(inventoryDraft, planned.plan.inventory);
  return planned;
}

export function planSaleSlotCleanup(state, inventory) {
  const slotValidation = validateSaleSlotsState(state);
  if (!slotValidation.ok) return failure("SALE_SLOTS_STATE_INVALID", { cause: slotValidation.code });
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  const slotsCandidate = cloneValue(state);
  let releasedAssignedCount = 0;
  for (const slot of slotsCandidate.slots) {
    if (slot.state !== SALE_SLOT_STATE.ASSIGNED) continue;
    slot.state = SALE_SLOT_STATE.AVAILABLE;
    slot.activeOrderId = null;
    releasedAssignedCount += 1;
  }
  const inventoryCandidate = cloneValue(inventory);
  const slotIds = new Set(slotsCandidate.slots.map((slot) => slot.saleSlotId));
  const reservationSlotIds = [...new Set(inventoryCandidate.reservations
    .filter((reservation) => slotIds.has(reservation.saleSlotId))
    .map((reservation) => reservation.saleSlotId))];
  let releasedReservations = [];
  if (reservationSlotIds.length > 0) {
    const release = applyReservationReleaseToDraft(inventoryCandidate, { saleSlotIds: reservationSlotIds });
    if (!release.ok) return release;
    releasedReservations = release.plan.released;
  }
  return success({
    saleSlots: createSaleSlotsState(slotsCandidate),
    inventory: inventoryCandidate,
    releasedAssignedCount,
    releasedReservations,
    changed: releasedAssignedCount > 0 || releasedReservations.length > 0,
  });
}

export function applySaleSlotCleanupToDraft(stateDraft, inventoryDraft) {
  const planned = planSaleSlotCleanup(stateDraft, inventoryDraft);
  if (!planned.ok) return planned;
  assignDraft(stateDraft, planned.plan.saleSlots);
  assignDraft(inventoryDraft, planned.plan.inventory);
  return planned;
}

export function projectSaleSlots(state) {
  const counts = countSaleSlots(state);
  return freezeDeep({
    day: state.day,
    slots: state.slots.map((slot) => ({ ...slot })),
    assigned_slots: deriveAssignedSlots(state),
    counts,
  });
}
