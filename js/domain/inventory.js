import {
  checkedAddG,
  requireNonNegativeG,
  sumG,
} from "../core/money.js";
import { freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";

export const COOK_ESCROW_STATE = Object.freeze({
  HELD: "HELD",
});

export const COMPLETED_DISH_STATE = Object.freeze({
  CARRIED: "CARRIED",
  SOLD: "SOLD",
  WASTED: "WASTED",
});

const DISH_STATES = new Set(Object.values(COMPLETED_DISH_STATE));

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireIdentifier(value, field) {
  return isStableIdentifier(value)
    ? validationSuccess()
    : failure("INVALID_INVENTORY_IDENTIFIER", { field, value });
}

function requireNullableIdentifier(value, field) {
  return value === null ? validationSuccess() : requireIdentifier(value, field);
}

function requireQuantity(value, field, { positive = false } = {}) {
  const minimum = positive ? 1 : 0;
  return Number.isSafeInteger(value) && value >= minimum
    ? validationSuccess()
    : failure("INVALID_INVENTORY_QUANTITY", { field, value, minimum });
}

function requireQuality(value, field) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? validationSuccess()
    : failure("INVALID_INGREDIENT_QUALITY", { field, value });
}

function requireDay(value, field = "acquiredDay") {
  return Number.isSafeInteger(value) && value >= 1 && value <= 14
    ? validationSuccess()
    : failure("INVALID_INVENTORY_DAY", { field, value });
}

function requireBookCost(value, field) {
  try {
    requireNonNegativeG(value, field);
    return validationSuccess();
  } catch {
    return failure("INVALID_BOOK_COST", { field, value });
  }
}

export function compareIngredientLotsFifo(left, right) {
  const dayDifference = left.acquiredDay - right.acquiredDay;
  return dayDifference !== 0 ? dayDifference : left.lotId.localeCompare(right.lotId, "en");
}

export function validateIngredientLot(lot) {
  if (!isPlainRecord(lot)) return failure("INVALID_INGREDIENT_LOT", { field: "$" });
  const required = ["lotId", "ingredientId", "quantity", "quality", "bookCostG", "acquiredDay"];
  for (const field of required) {
    if (!own(lot, field)) return failure("MISSING_INGREDIENT_LOT_FIELD", { field });
  }
  for (const field of ["lotId", "ingredientId"]) {
    const result = requireIdentifier(lot[field], field);
    if (!result.ok) return result;
  }
  const quantity = requireQuantity(lot.quantity, "quantity");
  if (!quantity.ok) return quantity;
  const quality = requireQuality(lot.quality, "quality");
  if (!quality.ok) return quality;
  const cost = requireBookCost(lot.bookCostG, "bookCostG");
  if (!cost.ok) return cost;
  const day = requireDay(lot.acquiredDay);
  if (!day.ok) return day;
  if (lot.quantity === 0 && lot.bookCostG !== 0) {
    return failure("EMPTY_LOT_HAS_BOOK_COST", { lotId: lot.lotId, bookCostG: lot.bookCostG });
  }
  return validationSuccess();
}

export function createIngredientLot(input) {
  const lot = {
    lotId: input?.lotId,
    ingredientId: input?.ingredientId,
    quantity: input?.quantity,
    quality: input?.quality,
    bookCostG: input?.bookCostG,
    acquiredDay: input?.acquiredDay,
  };
  const validation = validateIngredientLot(lot);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 Ingredient_Lot입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(lot);
}

export function validateIngredientReservation(reservation) {
  if (!isPlainRecord(reservation)) return failure("INVALID_INGREDIENT_RESERVATION", { field: "$" });
  const required = ["reservationId", "saleSlotId", "lotId", "ingredientId", "quantity"];
  for (const field of required) {
    if (!own(reservation, field)) return failure("MISSING_INGREDIENT_RESERVATION_FIELD", { field });
  }
  for (const field of ["reservationId", "saleSlotId", "lotId", "ingredientId"]) {
    const result = requireIdentifier(reservation[field], field);
    if (!result.ok) return result;
  }
  return requireQuantity(reservation.quantity, "quantity", { positive: true });
}

export function createIngredientReservation(input) {
  const reservation = {
    reservationId: input?.reservationId,
    saleSlotId: input?.saleSlotId,
    lotId: input?.lotId,
    ingredientId: input?.ingredientId,
    quantity: input?.quantity,
  };
  const validation = validateIngredientReservation(reservation);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 Ingredient_Reservation입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(reservation);
}

export function validateCookEscrowLine(line) {
  if (!isPlainRecord(line)) return failure("INVALID_COOK_ESCROW_LINE", { field: "$" });
  const required = [
    "lotId", "reservationId", "saleSlotId", "ingredientId",
    "quantity", "bookCostG", "quality",
  ];
  for (const field of required) {
    if (!own(line, field)) return failure("MISSING_COOK_ESCROW_LINE_FIELD", { field });
  }
  for (const field of ["lotId", "ingredientId"]) {
    const result = requireIdentifier(line[field], field);
    if (!result.ok) return result;
  }
  for (const [field, value] of [["reservationId", line.reservationId], ["saleSlotId", line.saleSlotId]]) {
    const result = requireNullableIdentifier(value, field);
    if (!result.ok) return result;
  }
  if ((line.reservationId === null) !== (line.saleSlotId === null)) {
    return failure("ESCROW_RESERVATION_SOURCE_INCOMPLETE", {
      reservationId: line.reservationId,
      saleSlotId: line.saleSlotId,
    });
  }
  const quantity = requireQuantity(line.quantity, "quantity", { positive: true });
  if (!quantity.ok) return quantity;
  const cost = requireBookCost(line.bookCostG, "bookCostG");
  if (!cost.ok) return cost;
  return requireQuality(line.quality, "quality");
}

export function validateCookEscrow(escrow) {
  if (!isPlainRecord(escrow)) return failure("INVALID_COOK_ESCROW", { field: "$" });
  const required = [
    "escrowId", "recipeId", "sourceSaleSlotId", "state", "lines",
    "totalQuantity", "totalBookCostG", "quality",
  ];
  for (const field of required) {
    if (!own(escrow, field)) return failure("MISSING_COOK_ESCROW_FIELD", { field });
  }
  for (const field of ["escrowId", "recipeId"]) {
    const result = requireIdentifier(escrow[field], field);
    if (!result.ok) return result;
  }
  const slot = requireNullableIdentifier(escrow.sourceSaleSlotId, "sourceSaleSlotId");
  if (!slot.ok) return slot;
  if (escrow.state !== COOK_ESCROW_STATE.HELD) {
    return failure("INVALID_COOK_ESCROW_STATE", { state: escrow.state });
  }
  if (!Array.isArray(escrow.lines) || escrow.lines.length === 0) {
    return failure("INVALID_COOK_ESCROW_LINES");
  }
  for (let index = 0; index < escrow.lines.length; index += 1) {
    const line = validateCookEscrowLine(escrow.lines[index]);
    if (!line.ok) return failure(line.code, { lineIndex: index, ...line.details });
  }
  const quantity = requireQuantity(escrow.totalQuantity, "totalQuantity", { positive: true });
  if (!quantity.ok) return quantity;
  const cost = requireBookCost(escrow.totalBookCostG, "totalBookCostG");
  if (!cost.ok) return cost;
  const quality = requireQuality(escrow.quality, "quality");
  if (!quality.ok) return quality;
  try {
    const lineQuantity = escrow.lines.reduce((total, line) => total + line.quantity, 0);
    const lineCost = sumG(escrow.lines.map((line) => line.bookCostG), "escrow line Book_Cost");
    if (!Number.isSafeInteger(lineQuantity) || lineQuantity !== escrow.totalQuantity) {
      return failure("ESCROW_QUANTITY_MISMATCH", { expected: lineQuantity, actual: escrow.totalQuantity });
    }
    if (lineCost !== escrow.totalBookCostG) {
      return failure("ESCROW_BOOK_COST_MISMATCH", { expected: lineCost, actual: escrow.totalBookCostG });
    }
  } catch {
    return failure("ESCROW_TOTAL_OVERFLOW");
  }
  return validationSuccess();
}

export function createCookEscrow(input) {
  const escrow = {
    escrowId: input?.escrowId,
    recipeId: input?.recipeId,
    sourceSaleSlotId: input?.sourceSaleSlotId ?? null,
    state: input?.state ?? COOK_ESCROW_STATE.HELD,
    lines: Array.isArray(input?.lines) ? input.lines.map((line) => ({ ...line })) : input?.lines,
    totalQuantity: input?.totalQuantity,
    totalBookCostG: input?.totalBookCostG,
    quality: input?.quality,
  };
  const validation = validateCookEscrow(escrow);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 CookEscrow입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(escrow);
}

export function validateCompletedDish(dish) {
  if (!isPlainRecord(dish)) return failure("INVALID_COMPLETED_DISH", { field: "$" });
  const required = [
    "dishId", "recipeId", "quality", "bookCostG", "recognizedBookCostG",
    "createdOrderId", "sourceSaleSlotId", "state",
  ];
  for (const field of required) {
    if (!own(dish, field)) return failure("MISSING_COMPLETED_DISH_FIELD", { field });
  }
  for (const field of ["dishId", "recipeId"]) {
    const result = requireIdentifier(dish[field], field);
    if (!result.ok) return result;
  }
  for (const [field, value] of [
    ["createdOrderId", dish.createdOrderId],
    ["sourceSaleSlotId", dish.sourceSaleSlotId],
  ]) {
    const result = requireNullableIdentifier(value, field);
    if (!result.ok) return result;
  }
  const quality = requireQuality(dish.quality, "quality");
  if (!quality.ok) return quality;
  for (const field of ["bookCostG", "recognizedBookCostG"]) {
    const result = requireBookCost(dish[field], field);
    if (!result.ok) return result;
  }
  if (!DISH_STATES.has(dish.state)) return failure("INVALID_COMPLETED_DISH_STATE", { state: dish.state });
  if (dish.state === COMPLETED_DISH_STATE.CARRIED && dish.recognizedBookCostG !== 0) {
    return failure("CARRIED_DISH_ALREADY_RECOGNIZED", { dishId: dish.dishId });
  }
  if (dish.state !== COMPLETED_DISH_STATE.CARRIED && dish.bookCostG !== 0) {
    return failure("TERMINAL_DISH_RETAINS_BOOK_COST", { dishId: dish.dishId, state: dish.state });
  }
  return validationSuccess();
}

export function createCompletedDish(input) {
  const dish = {
    dishId: input?.dishId,
    recipeId: input?.recipeId,
    quality: input?.quality,
    bookCostG: input?.bookCostG,
    recognizedBookCostG: input?.recognizedBookCostG ?? 0,
    createdOrderId: input?.createdOrderId ?? null,
    sourceSaleSlotId: input?.sourceSaleSlotId ?? null,
    state: input?.state ?? COMPLETED_DISH_STATE.CARRIED,
  };
  const validation = validateCompletedDish(dish);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 Completed_Dish입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(dish);
}

function validateUniqueIds(items, field, code) {
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const id = items[index]?.[field];
    if (seen.has(id)) return failure(code, { field, id, index });
    seen.add(id);
  }
  return validationSuccess();
}

export function reservationQuantityByLot(inventory) {
  const totals = new Map();
  for (const reservation of inventory.reservations) {
    const previous = totals.get(reservation.lotId) ?? 0;
    const next = previous + reservation.quantity;
    if (!Number.isSafeInteger(next)) throw new RangeError("reservation quantity 합계가 safe integer를 초과했습니다.");
    totals.set(reservation.lotId, next);
  }
  return totals;
}

export function validateInventoryState(inventory) {
  if (!isPlainRecord(inventory)) return failure("INVALID_INVENTORY_STATE", { field: "$" });
  for (const field of ["lots", "reservations", "cookEscrows", "completedDishes"]) {
    if (!Array.isArray(inventory[field])) return failure("INVALID_INVENTORY_COLLECTION", { field });
  }

  const validators = [
    ["lots", validateIngredientLot],
    ["reservations", validateIngredientReservation],
    ["cookEscrows", validateCookEscrow],
    ["completedDishes", validateCompletedDish],
  ];
  for (const [field, validator] of validators) {
    for (let index = 0; index < inventory[field].length; index += 1) {
      const result = validator(inventory[field][index]);
      if (!result.ok) return failure(result.code, { collection: field, index, ...result.details });
    }
  }

  for (const [items, field, code] of [
    [inventory.lots, "lotId", "DUPLICATE_LOT_ID"],
    [inventory.reservations, "reservationId", "DUPLICATE_RESERVATION_ID"],
    [inventory.cookEscrows, "escrowId", "DUPLICATE_ESCROW_ID"],
    [inventory.completedDishes, "dishId", "DUPLICATE_DISH_ID"],
  ]) {
    const result = validateUniqueIds(items, field, code);
    if (!result.ok) return result;
  }

  const lotsById = new Map(inventory.lots.map((lot) => [lot.lotId, lot]));
  let reservedByLot;
  try {
    reservedByLot = reservationQuantityByLot(inventory);
  } catch {
    return failure("RESERVATION_QUANTITY_OVERFLOW");
  }
  for (const reservation of inventory.reservations) {
    const lot = lotsById.get(reservation.lotId);
    if (!lot) return failure("RESERVATION_LOT_NOT_FOUND", { reservationId: reservation.reservationId, lotId: reservation.lotId });
    if (lot.ingredientId !== reservation.ingredientId) {
      return failure("RESERVATION_INGREDIENT_MISMATCH", {
        reservationId: reservation.reservationId,
        expected: lot.ingredientId,
        actual: reservation.ingredientId,
      });
    }
  }
  for (const lot of inventory.lots) {
    const reservedQuantity = reservedByLot.get(lot.lotId) ?? 0;
    if (reservedQuantity > lot.quantity) {
      return failure("LOT_OVER_RESERVED", { lotId: lot.lotId, quantity: lot.quantity, reservedQuantity });
    }
  }
  return validationSuccess();
}

export function createInventoryState({
  lots = [],
  reservations = [],
  cookEscrows = [],
  completedDishes = [],
} = {}) {
  const state = {
    lots: lots.map((lot) => ({ ...lot })),
    reservations: reservations.map((reservation) => ({ ...reservation })),
    cookEscrows: cookEscrows.map((escrow) => ({
      ...escrow,
      lines: Array.isArray(escrow.lines) ? escrow.lines.map((line) => ({ ...line })) : escrow.lines,
    })),
    completedDishes: completedDishes.map((dish) => ({ ...dish })),
  };
  const validation = validateInventoryState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 InventoryState입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(state);
}

export function calculateInventoryBookCostG(inventory) {
  const validation = validateInventoryState(inventory);
  if (!validation.ok) {
    const error = new TypeError(`Inventory Book_Cost를 계산할 수 없습니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return sumG([
    ...inventory.lots.map((lot) => lot.bookCostG),
    ...inventory.cookEscrows.map((escrow) => escrow.totalBookCostG),
    ...inventory.completedDishes
      .filter((dish) => dish.state === COMPLETED_DISH_STATE.CARRIED)
      .map((dish) => dish.bookCostG),
  ], "ending inventory Book_Cost");
}

export function projectInventory(inventory) {
  const validation = validateInventoryState(inventory);
  if (!validation.ok) throw new TypeError(`Inventory projection이 유효하지 않습니다: ${validation.code}`);
  const reservedByLot = reservationQuantityByLot(inventory);
  const lots = [...inventory.lots].sort(compareIngredientLotsFifo).map((lot) => {
    const reservedQuantity = reservedByLot.get(lot.lotId) ?? 0;
    return {
      ...lot,
      reservedQuantity,
      unreservedQuantity: lot.quantity - reservedQuantity,
    };
  });
  const byIngredient = Object.create(null);
  for (const lot of lots) {
    const projection = byIngredient[lot.ingredientId] ?? {
      ingredientId: lot.ingredientId,
      quantity: 0,
      reservedQuantity: 0,
      unreservedQuantity: 0,
      bookCostG: 0,
      lots: [],
    };
    projection.quantity += lot.quantity;
    projection.reservedQuantity += lot.reservedQuantity;
    projection.unreservedQuantity += lot.unreservedQuantity;
    projection.bookCostG = checkedAddG(projection.bookCostG, lot.bookCostG, "ingredient Book_Cost");
    projection.lots.push(lot);
    byIngredient[lot.ingredientId] = projection;
  }
  return freezeDeep({
    lots,
    reservations: inventory.reservations.map((reservation) => ({ ...reservation })),
    cookEscrows: inventory.cookEscrows.map((escrow) => ({ ...escrow })),
    completedDishes: inventory.completedDishes.map((dish) => ({ ...dish })),
    byIngredient,
    endingInventoryBookCostG: calculateInventoryBookCostG(inventory),
  });
}
