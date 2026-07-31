import {
  checkedSubtractG,
  multiplyDivideHalfUp,
  requireNonNegativeG,
  sumG,
} from "../core/money.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import {
  compareIngredientLotsFifo,
  createIngredientReservation,
  reservationQuantityByLot,
  validateInventoryState,
} from "./inventory.js";

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkedAddQuantity(left, right, field = "quantity") {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new TypeError(`${field}는 0 이상의 safe integer여야 합니다.`);
  }
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${field} 합계가 safe integer를 초과했습니다.`);
  return result;
}

function validateRequirement(requirement, field) {
  if (!isPlainRecord(requirement)) return failure("INVALID_INGREDIENT_REQUIREMENT", { field });
  if (!isStableIdentifier(requirement.ingredientId)) {
    return failure("INVALID_INGREDIENT_ID", { field: `${field}.ingredientId`, value: requirement.ingredientId });
  }
  if (!Number.isSafeInteger(requirement.quantity) || requirement.quantity <= 0) {
    return failure("INVALID_REQUIREMENT_QUANTITY", { field: `${field}.quantity`, value: requirement.quantity });
  }
  return validationSuccess();
}

function aggregateRequirements(requirements, field = "requirements") {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return failure("INVALID_INGREDIENT_REQUIREMENTS", { field });
  }
  const totals = new Map();
  for (let index = 0; index < requirements.length; index += 1) {
    const validation = validateRequirement(requirements[index], `${field}[${index}]`);
    if (!validation.ok) return validation;
    try {
      totals.set(
        requirements[index].ingredientId,
        checkedAddQuantity(
          totals.get(requirements[index].ingredientId) ?? 0,
          requirements[index].quantity,
          `${field}.${requirements[index].ingredientId}`,
        ),
      );
    } catch {
      return failure("REQUIREMENT_QUANTITY_OVERFLOW", { ingredientId: requirements[index].ingredientId });
    }
  }
  return Object.freeze({
    ok: true,
    requirements: Object.freeze([...totals.entries()]
      .map(([ingredientId, quantity]) => Object.freeze({ ingredientId, quantity }))
      .sort((left, right) => left.ingredientId.localeCompare(right.ingredientId, "en"))),
  });
}

function availableUnreservedByIngredient(inventory) {
  const reserved = reservationQuantityByLot(inventory);
  const available = new Map();
  for (const lot of inventory.lots) {
    const unreserved = lot.quantity - (reserved.get(lot.lotId) ?? 0);
    available.set(
      lot.ingredientId,
      checkedAddQuantity(available.get(lot.ingredientId) ?? 0, unreserved, "available quantity"),
    );
  }
  return available;
}

function buildShortages(required, available) {
  return [...required.entries()]
    .filter(([ingredientId, requiredQuantity]) => requiredQuantity > (available.get(ingredientId) ?? 0))
    .map(([ingredientId, requiredQuantity]) => {
      const availableQuantity = available.get(ingredientId) ?? 0;
      return freezeDeep({
        ingredientId,
        requiredQuantity,
        availableQuantity,
        shortageQuantity: requiredQuantity - availableQuantity,
      });
    })
    .sort((left, right) => left.ingredientId.localeCompare(right.ingredientId, "en"));
}

function normalizeReservationRequests(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return failure("INVALID_RESERVATION_REQUESTS");
  }
  const saleSlotIds = new Set();
  const normalized = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    if (!isPlainRecord(request)) return failure("INVALID_RESERVATION_REQUEST", { index });
    if (!isStableIdentifier(request.saleSlotId)) {
      return failure("INVALID_SALE_SLOT_ID", { index, value: request.saleSlotId });
    }
    if (!isStableIdentifier(request.recipeId)) {
      return failure("INVALID_RECIPE_ID", { index, value: request.recipeId });
    }
    if (saleSlotIds.has(request.saleSlotId)) {
      return failure("DUPLICATE_RESERVATION_SALE_SLOT", { saleSlotId: request.saleSlotId });
    }
    saleSlotIds.add(request.saleSlotId);
    const requirements = aggregateRequirements(request.requirements, `requests[${index}].requirements`);
    if (!requirements.ok) return requirements;
    normalized.push(freezeDeep({
      saleSlotId: request.saleSlotId,
      recipeId: request.recipeId,
      requirements: requirements.requirements,
    }));
  }
  normalized.sort((left, right) =>
    left.saleSlotId.localeCompare(right.saleSlotId, "en") || left.recipeId.localeCompare(right.recipeId, "en"));
  return Object.freeze({ ok: true, requests: Object.freeze(normalized) });
}

function reservationIdFor(planId, ordinal) {
  const reservationId = `${planId}:r:${String(ordinal).padStart(10, "0")}`;
  return isStableIdentifier(reservationId) ? reservationId : null;
}

/**
 * Plans all hard reservations against unreserved stock. The source state is never mutated and a
 * shortage returns every missing ingredient after aggregating all shared Recipe demand.
 */
export function planHardReservations(inventory, { reservationPlanId, requests } = {}) {
  const stateValidation = validateInventoryState(inventory);
  if (!stateValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: stateValidation.code });
  if (!isStableIdentifier(reservationPlanId)) {
    return failure("INVALID_RESERVATION_PLAN_ID", { reservationPlanId });
  }
  if (reservationPlanId.length > 112) {
    return failure("RESERVATION_PLAN_ID_TOO_LONG", { length: reservationPlanId.length });
  }
  const normalized = normalizeReservationRequests(requests);
  if (!normalized.ok) return normalized;

  const required = new Map();
  try {
    for (const request of normalized.requests) {
      for (const requirement of request.requirements) {
        required.set(
          requirement.ingredientId,
          checkedAddQuantity(
            required.get(requirement.ingredientId) ?? 0,
            requirement.quantity,
            `required.${requirement.ingredientId}`,
          ),
        );
      }
    }
  } catch {
    return failure("RESERVATION_REQUIREMENT_OVERFLOW");
  }

  let available;
  try {
    available = availableUnreservedByIngredient(inventory);
  } catch {
    return failure("RESERVATION_AVAILABILITY_OVERFLOW");
  }
  const shortages = buildShortages(required, available);
  if (shortages.length > 0) {
    return failure("INVENTORY_SHORTAGE", { shortages });
  }

  const reservedByLot = reservationQuantityByLot(inventory);
  const remainingByLot = new Map(inventory.lots.map((lot) => [
    lot.lotId,
    lot.quantity - (reservedByLot.get(lot.lotId) ?? 0),
  ]));
  const lotsByIngredient = new Map();
  for (const lot of [...inventory.lots].sort(compareIngredientLotsFifo)) {
    const list = lotsByIngredient.get(lot.ingredientId) ?? [];
    list.push(lot);
    lotsByIngredient.set(lot.ingredientId, list);
  }

  const existingIds = new Set(inventory.reservations.map((reservation) => reservation.reservationId));
  const allocations = [];
  let ordinal = 0;
  for (const request of normalized.requests) {
    for (const requirement of request.requirements) {
      let needed = requirement.quantity;
      for (const lot of lotsByIngredient.get(requirement.ingredientId) ?? []) {
        if (needed === 0) break;
        const availableFromLot = remainingByLot.get(lot.lotId) ?? 0;
        if (availableFromLot <= 0) continue;
        const take = Math.min(needed, availableFromLot);
        const reservationId = reservationIdFor(reservationPlanId, ordinal);
        if (!reservationId) return failure("GENERATED_RESERVATION_ID_INVALID", { ordinal });
        if (existingIds.has(reservationId)) {
          return failure("DUPLICATE_RESERVATION_ID", { reservationId });
        }
        const reservation = createIngredientReservation({
          reservationId,
          saleSlotId: request.saleSlotId,
          lotId: lot.lotId,
          ingredientId: requirement.ingredientId,
          quantity: take,
        });
        allocations.push(reservation);
        existingIds.add(reservationId);
        remainingByLot.set(lot.lotId, availableFromLot - take);
        needed -= take;
        ordinal += 1;
      }
      if (needed !== 0) {
        return failure("RESERVATION_PLANNER_INTERNAL_SHORTAGE", {
          ingredientId: requirement.ingredientId,
          remaining: needed,
        });
      }
    }
  }

  return Object.freeze({
    ok: true,
    plan: freezeDeep({
      reservationPlanId,
      requests: normalized.requests,
      reservations: allocations,
      requiredByIngredient: [...required.entries()]
        .map(([ingredientId, quantity]) => ({ ingredientId, quantity }))
        .sort((left, right) => left.ingredientId.localeCompare(right.ingredientId, "en")),
      shortages: [],
    }),
  });
}

export function applyHardReservationPlanToDraft(inventoryDraft, plan) {
  const current = validateInventoryState(inventoryDraft);
  if (!current.ok) return failure("INVENTORY_STATE_INVALID", { cause: current.code });
  if (!isPlainRecord(plan) || !Array.isArray(plan.reservations)) {
    return failure("INVALID_RESERVATION_PLAN");
  }
  const candidate = {
    ...inventoryDraft,
    reservations: [...inventoryDraft.reservations, ...plan.reservations.map((reservation) => ({ ...reservation }))],
  };
  const validation = validateInventoryState(candidate);
  if (!validation.ok) return validation;
  inventoryDraft.reservations = candidate.reservations;
  return validationSuccess({ reservationCount: plan.reservations.length });
}

export function planReservationRelease(inventory, { saleSlotIds = [], reservationIds = [] } = {}) {
  const stateValidation = validateInventoryState(inventory);
  if (!stateValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: stateValidation.code });
  if (!Array.isArray(saleSlotIds) || !Array.isArray(reservationIds) ||
      saleSlotIds.some((id) => !isStableIdentifier(id)) || reservationIds.some((id) => !isStableIdentifier(id))) {
    return failure("INVALID_RESERVATION_RELEASE_SELECTOR");
  }
  const slots = new Set(saleSlotIds);
  const ids = new Set(reservationIds);
  if (slots.size === 0 && ids.size === 0) return failure("EMPTY_RESERVATION_RELEASE_SELECTOR");
  const released = inventory.reservations.filter((reservation) =>
    slots.has(reservation.saleSlotId) || ids.has(reservation.reservationId));
  if (released.length === 0) return failure("RESERVATION_NOT_FOUND");
  return Object.freeze({
    ok: true,
    plan: freezeDeep({
      released,
      reservations: inventory.reservations.filter((reservation) =>
        !slots.has(reservation.saleSlotId) && !ids.has(reservation.reservationId)),
    }),
  });
}

/** Pure partial-consumption rule: Half-Up for a partial take, full remainder for the last take. */
export function calculateBookCostTaken(bookCostBefore, quantityBefore, takeQuantity) {
  try {
    requireNonNegativeG(bookCostBefore, "bookCostBefore");
  } catch {
    throw new TypeError("bookCostBefore는 0 이상의 safe integer G여야 합니다.");
  }
  if (!Number.isSafeInteger(quantityBefore) || quantityBefore <= 0) {
    throw new TypeError("quantityBefore는 양의 safe integer여야 합니다.");
  }
  if (!Number.isSafeInteger(takeQuantity) || takeQuantity <= 0 || takeQuantity > quantityBefore) {
    throw new RangeError("takeQuantity는 1..quantityBefore 범위여야 합니다.");
  }
  return takeQuantity === quantityBefore
    ? bookCostBefore
    : multiplyDivideHalfUp(bookCostBefore, takeQuantity, quantityBefore);
}

function consumeFromLot(lot, takeQuantity) {
  const bookCostG = calculateBookCostTaken(lot.bookCostG, lot.quantity, takeQuantity);
  lot.quantity -= takeQuantity;
  lot.bookCostG = checkedSubtractG(lot.bookCostG, bookCostG, "lot partial Book_Cost");
  return bookCostG;
}

function eligibleCookAvailability(inventory, requirements, saleSlotId) {
  const reservedByLot = reservationQuantityByLot(inventory);
  const totals = new Map();
  for (const lot of inventory.lots) {
    const unreserved = lot.quantity - (reservedByLot.get(lot.lotId) ?? 0);
    totals.set(lot.ingredientId, checkedAddQuantity(totals.get(lot.ingredientId) ?? 0, unreserved));
  }
  if (saleSlotId !== null) {
    for (const reservation of inventory.reservations) {
      if (reservation.saleSlotId !== saleSlotId) continue;
      totals.set(
        reservation.ingredientId,
        checkedAddQuantity(totals.get(reservation.ingredientId) ?? 0, reservation.quantity),
      );
    }
  }
  const required = new Map(requirements.map((requirement) => [requirement.ingredientId, requirement.quantity]));
  return { totals, shortages: buildShortages(required, totals) };
}

function compareReservationsForCook(left, right, lotsById) {
  const lotOrder = compareIngredientLotsFifo(lotsById.get(left.lotId), lotsById.get(right.lotId));
  return lotOrder !== 0 ? lotOrder : left.reservationId.localeCompare(right.reservationId, "en");
}

/**
 * Plans reservation-first then unreserved FIFO movement into CookEscrow. Every mutation is made on
 * a detached clone and returned only after all Recipe requirements and inventory invariants pass.
 */
export function planCookAllocation(inventory, { requirements, saleSlotId = null } = {}) {
  const stateValidation = validateInventoryState(inventory);
  if (!stateValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: stateValidation.code });
  const normalized = aggregateRequirements(requirements);
  if (!normalized.ok) return normalized;
  if (saleSlotId !== null && !isStableIdentifier(saleSlotId)) {
    return failure("INVALID_SALE_SLOT_ID", { saleSlotId });
  }

  let availability;
  try {
    availability = eligibleCookAvailability(inventory, normalized.requirements, saleSlotId);
  } catch {
    return failure("COOK_AVAILABILITY_OVERFLOW");
  }
  if (availability.shortages.length > 0) {
    return failure("INVENTORY_SHORTAGE", { shortages: availability.shortages });
  }

  const working = cloneValue(inventory);
  const lotsById = new Map(working.lots.map((lot) => [lot.lotId, lot]));
  const lines = [];

  for (const requirement of normalized.requirements) {
    let needed = requirement.quantity;
    if (saleSlotId !== null) {
      const matching = working.reservations
        .filter((reservation) => reservation.saleSlotId === saleSlotId &&
          reservation.ingredientId === requirement.ingredientId && reservation.quantity > 0)
        .sort((left, right) => compareReservationsForCook(left, right, lotsById));
      for (const reservation of matching) {
        if (needed === 0) break;
        const lot = lotsById.get(reservation.lotId);
        const take = Math.min(needed, reservation.quantity);
        const bookCostG = consumeFromLot(lot, take);
        reservation.quantity -= take;
        lines.push({
          lotId: lot.lotId,
          reservationId: reservation.reservationId,
          saleSlotId: reservation.saleSlotId,
          ingredientId: lot.ingredientId,
          quantity: take,
          bookCostG,
          quality: lot.quality,
        });
        needed -= take;
      }
    }

    if (needed > 0) {
      const fifoLots = working.lots
        .filter((lot) => lot.ingredientId === requirement.ingredientId)
        .sort(compareIngredientLotsFifo);
      for (const lot of fifoLots) {
        if (needed === 0) break;
        const reservedQuantity = working.reservations
          .filter((reservation) => reservation.lotId === lot.lotId)
          .reduce((total, reservation) => total + reservation.quantity, 0);
        const unreservedQuantity = lot.quantity - reservedQuantity;
        if (unreservedQuantity <= 0) continue;
        const take = Math.min(needed, unreservedQuantity);
        const bookCostG = consumeFromLot(lot, take);
        lines.push({
          lotId: lot.lotId,
          reservationId: null,
          saleSlotId: null,
          ingredientId: lot.ingredientId,
          quantity: take,
          bookCostG,
          quality: lot.quality,
        });
        needed -= take;
      }
    }

    if (needed !== 0) {
      return failure("COOK_ALLOCATION_INTERNAL_SHORTAGE", {
        ingredientId: requirement.ingredientId,
        remaining: needed,
      });
    }
  }

  working.reservations = working.reservations.filter((reservation) => reservation.quantity > 0);
  const afterValidation = validateInventoryState(working);
  if (!afterValidation.ok) return failure("COOK_ALLOCATION_INVALID", { cause: afterValidation.code });

  let totalBookCostG;
  try {
    totalBookCostG = sumG(lines.map((line) => line.bookCostG), "CookEscrow Book_Cost");
  } catch {
    return failure("COOK_ESCROW_BOOK_COST_OVERFLOW");
  }
  const totalQuantityBigInt = lines.reduce((total, line) => total + BigInt(line.quantity), 0n);
  const weightedQuality = lines.reduce(
    (total, line) => total + BigInt(line.quantity) * BigInt(line.quality),
    0n,
  );
  const quality = Number(weightedQuality / totalQuantityBigInt);
  const totalQuantity = Number(totalQuantityBigInt);
  if (!Number.isSafeInteger(totalQuantity)) return failure("COOK_ESCROW_QUANTITY_OVERFLOW");

  return Object.freeze({
    ok: true,
    plan: freezeDeep({
      lots: working.lots,
      reservations: working.reservations,
      lines,
      totalQuantity,
      totalBookCostG,
      quality,
    }),
  });
}
