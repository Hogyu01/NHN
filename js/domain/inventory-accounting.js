import {
  checkedAddG,
  checkedSubtractG,
  requireNonNegativeG,
  requirePositiveG,
  sumG,
} from "../core/money.js";
import {
  cloneValue,
  freezeDeep,
  validationFailure,
  validationSuccess,
} from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { validateEconomyState } from "./economy.js";
import {
  COMPLETED_DISH_STATE,
  createCompletedDish,
  createCookEscrow,
  createIngredientLot,
  createIngredientReservation,
  createInventoryState,
  calculateInventoryBookCostG,
  validateInventoryState,
} from "./inventory.js";
import {
  applyHardReservationPlanToDraft,
  planCookAllocation,
  planHardReservations,
  planReservationRelease,
} from "./reservation-planner.js";

export const INVENTORY_ACQUISITION_SOURCE = Object.freeze({
  MARKET: "MARKET",
  SUCCESSFUL_CONTRACT: "SUCCESSFUL_CONTRACT",
});

export const COST_LOCATION = Object.freeze({
  EXTERNAL_MARKET: "EXTERNAL_MARKET",
  CONTRACT_CONSIDERATION: "CONTRACT_CONSIDERATION",
  CONTRACT_PREPAID: "CONTRACT_PREPAID",
  LOT: "LOT",
  COOK_ESCROW: "COOK_ESCROW",
  COMPLETED_DISH: "COMPLETED_DISH",
  COGS: "COGS",
  WASTE: "WASTE",
  CONTRACT_FAILURE_LOSS: "CONTRACT_FAILURE_LOSS",
});

export const COST_MOVEMENT_TYPE = Object.freeze({
  MARKET_ACQUISITION: "MARKET_ACQUISITION",
  CONTRACT_ACQUISITION: "CONTRACT_ACQUISITION",
  CONTRACT_PREPAID_CAPITALIZATION: "CONTRACT_PREPAID_CAPITALIZATION",
  CONTRACT_PREPAID_APPLICATION: "CONTRACT_PREPAID_APPLICATION",
  LOT_TO_ESCROW: "LOT_TO_ESCROW",
  ESCROW_TO_LOT: "ESCROW_TO_LOT",
  ESCROW_TO_DISH: "ESCROW_TO_DISH",
  ESCROW_TO_WASTE: "ESCROW_TO_WASTE",
  DISH_TO_COGS: "DISH_TO_COGS",
  DISH_TO_WASTE: "DISH_TO_WASTE",
  PREPAID_TO_LOSS: "PREPAID_TO_LOSS",
});

const MOVEMENT_POLICY = freezeDeep({
  [COST_MOVEMENT_TYPE.MARKET_ACQUISITION]: {
    source: COST_LOCATION.EXTERNAL_MARKET,
    destination: COST_LOCATION.LOT,
    totalField: "marketAcquisitionG",
  },
  [COST_MOVEMENT_TYPE.CONTRACT_ACQUISITION]: {
    source: COST_LOCATION.CONTRACT_CONSIDERATION,
    destination: COST_LOCATION.LOT,
    totalField: "successfulContractAcquisitionG",
  },
  [COST_MOVEMENT_TYPE.CONTRACT_PREPAID_CAPITALIZATION]: {
    source: COST_LOCATION.CONTRACT_CONSIDERATION,
    destination: COST_LOCATION.CONTRACT_PREPAID,
    totalField: "contractPrepaidAssetAdditionsG",
  },
  [COST_MOVEMENT_TYPE.CONTRACT_PREPAID_APPLICATION]: {
    source: COST_LOCATION.CONTRACT_PREPAID,
    destination: COST_LOCATION.CONTRACT_CONSIDERATION,
    totalField: "contractPrepaidAssetApplicationsG",
  },
  [COST_MOVEMENT_TYPE.LOT_TO_ESCROW]: {
    source: COST_LOCATION.LOT,
    destination: COST_LOCATION.COOK_ESCROW,
    totalField: null,
  },
  [COST_MOVEMENT_TYPE.ESCROW_TO_LOT]: {
    source: COST_LOCATION.COOK_ESCROW,
    destination: COST_LOCATION.LOT,
    totalField: null,
  },
  [COST_MOVEMENT_TYPE.ESCROW_TO_DISH]: {
    source: COST_LOCATION.COOK_ESCROW,
    destination: COST_LOCATION.COMPLETED_DISH,
    totalField: null,
  },
  [COST_MOVEMENT_TYPE.ESCROW_TO_WASTE]: {
    source: COST_LOCATION.COOK_ESCROW,
    destination: COST_LOCATION.WASTE,
    totalField: "cookingWasteExpenseG",
  },
  [COST_MOVEMENT_TYPE.DISH_TO_COGS]: {
    source: COST_LOCATION.COMPLETED_DISH,
    destination: COST_LOCATION.COGS,
    totalField: "cogsG",
  },
  [COST_MOVEMENT_TYPE.DISH_TO_WASTE]: {
    source: COST_LOCATION.COMPLETED_DISH,
    destination: COST_LOCATION.WASTE,
    totalField: "cookingWasteExpenseG",
  },
  [COST_MOVEMENT_TYPE.PREPAID_TO_LOSS]: {
    source: COST_LOCATION.CONTRACT_PREPAID,
    destination: COST_LOCATION.CONTRACT_FAILURE_LOSS,
    totalField: "contractFailureLossG",
  },
});

export const INVENTORY_COMMAND = Object.freeze({
  ACQUIRE_LOT: "inventory.lot.acquire",
  RESERVE: "inventory.reservation.create",
  RELEASE_RESERVATIONS: "inventory.reservation.release",
  START_COOK_ESCROW: "inventory.cook.start-escrow",
  RESTORE_COOK_ESCROW: "inventory.cook.restore-escrow",
  COMPLETE_COOK_TO_DISH: "inventory.cook.complete-dish",
  COMPLETE_COOK_TO_WASTE: "inventory.cook.complete-waste",
  RECOGNIZE_DISH_COGS: "inventory.dish.recognize-cogs",
  WASTE_DISH: "inventory.dish.waste",
  RECOGNIZE_CONTRACT_FAILURE_LOSS: "inventory.contract.recognize-loss",
});

const ACCOUNTING_FIELDS = Object.freeze([
  "openingInventoryBookCostG",
  "marketAcquisitionG",
  "successfulContractAcquisitionG",
  "cogsG",
  "cookingWasteExpenseG",
  "openingContractPrepaidAssetG",
  "contractPrepaidAssetAdditionsG",
  "contractPrepaidAssetApplicationsG",
  "contractFailureLossG",
]);

const INVENTORY_ACCOUNTING_WRITE_SET = Object.freeze(["inventory", "inventoryAccounting"]);
const INVENTORY_WRITE_SET = Object.freeze(["inventory"]);
const CONTRACT_LOSS_READ_SET = Object.freeze(["inventory"]);
const CONTRACT_LOSS_WRITE_SET = Object.freeze(["economy", "inventoryAccounting"]);
const NO_READ_SET = Object.freeze([]);

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

function validDay(day) {
  return Number.isSafeInteger(day) && day >= 1 && day <= 14;
}

function validQuantity(quantity, { positive = false } = {}) {
  return Number.isSafeInteger(quantity) && quantity >= (positive ? 1 : 0);
}

function movementEquals(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => movementEquals(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && movementEquals(left[key], right[key]));
  }
  return false;
}

function assignDraft(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, cloneValue(source));
}

function requireMovementMeta(input) {
  if (!isPlainRecord(input)) return failure("INVALID_COST_MOVEMENT_REQUEST");
  if (!isStableIdentifier(input.movementId)) {
    return failure("INVALID_COST_MOVEMENT_ID", { movementId: input.movementId });
  }
  if (!validDay(input.day)) return failure("INVALID_COST_MOVEMENT_DAY", { day: input.day });
  if (!isStableIdentifier(input.causeId)) return failure("INVALID_CAUSE_ID", { causeId: input.causeId });
  return validationSuccess();
}

export function validateCostMovement(movement) {
  if (!isPlainRecord(movement)) return failure("INVALID_COST_MOVEMENT", { field: "$" });
  const required = [
    "movementId", "day", "type", "source", "destination", "amountG",
    "quantity", "causeId", "references", "lines",
  ];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(movement, field)) {
      return failure("MISSING_COST_MOVEMENT_FIELD", { field });
    }
  }
  if (!isStableIdentifier(movement.movementId)) return failure("INVALID_COST_MOVEMENT_ID");
  if (!validDay(movement.day)) return failure("INVALID_COST_MOVEMENT_DAY", { day: movement.day });
  const policy = MOVEMENT_POLICY[movement.type];
  if (!policy) return failure("INVALID_COST_MOVEMENT_TYPE", { type: movement.type });
  if (movement.source !== policy.source || movement.destination !== policy.destination) {
    return failure("COST_MOVEMENT_ROUTE_MISMATCH", {
      type: movement.type,
      expectedSource: policy.source,
      actualSource: movement.source,
      expectedDestination: policy.destination,
      actualDestination: movement.destination,
    });
  }
  try {
    requireNonNegativeG(movement.amountG, "amountG");
  } catch {
    return failure("INVALID_COST_MOVEMENT_AMOUNT", { amountG: movement.amountG });
  }
  if (!validQuantity(movement.quantity)) {
    return failure("INVALID_COST_MOVEMENT_QUANTITY", { quantity: movement.quantity });
  }
  if (!isStableIdentifier(movement.causeId)) return failure("INVALID_CAUSE_ID");
  if (!isPlainRecord(movement.references)) return failure("INVALID_COST_MOVEMENT_REFERENCES");
  if (!Array.isArray(movement.lines)) return failure("INVALID_COST_MOVEMENT_LINES");
  return validationSuccess();
}

function createCostMovement(input) {
  const policy = MOVEMENT_POLICY[input.type];
  const movement = {
    movementId: input.movementId,
    day: input.day,
    type: input.type,
    source: policy?.source,
    destination: policy?.destination,
    amountG: input.amountG,
    quantity: input.quantity,
    causeId: input.causeId,
    references: cloneValue(input.references ?? {}),
    lines: cloneValue(input.lines ?? []),
  };
  const validation = validateCostMovement(movement);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 cost movement입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(movement);
}

export function validateInventoryAccountingState(accounting) {
  if (!isPlainRecord(accounting)) return failure("INVALID_INVENTORY_ACCOUNTING_STATE", { field: "$" });
  for (const field of ACCOUNTING_FIELDS) {
    try {
      requireNonNegativeG(accounting[field], field);
    } catch {
      return failure("INVALID_INVENTORY_ACCOUNTING_AMOUNT", { field, value: accounting[field] });
    }
  }
  if (!Array.isArray(accounting.costMovements)) {
    return failure("INVALID_COST_MOVEMENT_COLLECTION", { field: "costMovements" });
  }
  if (!Array.isArray(accounting.processedCostMovementIds)) {
    return failure("INVALID_COST_MOVEMENT_INDEX", { field: "processedCostMovementIds" });
  }
  if (accounting.costMovements.length !== accounting.processedCostMovementIds.length) {
    return failure("COST_MOVEMENT_INDEX_LENGTH_MISMATCH");
  }

  const seen = new Set();
  const sums = Object.fromEntries(ACCOUNTING_FIELDS.map((field) => [field, 0]));
  for (let index = 0; index < accounting.costMovements.length; index += 1) {
    const movement = accounting.costMovements[index];
    const validation = validateCostMovement(movement);
    if (!validation.ok) return failure(validation.code, { movementIndex: index, ...validation.details });
    if (seen.has(movement.movementId)) {
      return failure("DUPLICATE_COST_MOVEMENT_ID", { movementId: movement.movementId, movementIndex: index });
    }
    seen.add(movement.movementId);
    if (accounting.processedCostMovementIds[index] !== movement.movementId) {
      return failure("COST_MOVEMENT_INDEX_ORDER_MISMATCH", { movementIndex: index });
    }
    const field = MOVEMENT_POLICY[movement.type].totalField;
    if (field) {
      try {
        sums[field] = checkedAddG(sums[field], movement.amountG, `${field} movement total`);
      } catch {
        return failure("COST_MOVEMENT_TOTAL_OVERFLOW", { field });
      }
    }
  }

  for (const field of [
    "marketAcquisitionG", "successfulContractAcquisitionG", "cogsG",
    "cookingWasteExpenseG", "contractPrepaidAssetAdditionsG",
    "contractPrepaidAssetApplicationsG", "contractFailureLossG",
  ]) {
    if (accounting[field] !== sums[field]) {
      return failure("ACCOUNTING_MOVEMENT_TOTAL_MISMATCH", {
        field,
        expected: sums[field],
        actual: accounting[field],
      });
    }
  }
  return validationSuccess();
}

export function createInventoryAccountingState({
  openingInventoryBookCostG = 0,
  marketAcquisitionG = 0,
  successfulContractAcquisitionG = 0,
  cogsG = 0,
  cookingWasteExpenseG = 0,
  openingContractPrepaidAssetG = 0,
  contractPrepaidAssetAdditionsG = 0,
  contractPrepaidAssetApplicationsG = 0,
  contractFailureLossG = 0,
  costMovements = [],
  processedCostMovementIds = costMovements.map((movement) => movement.movementId),
} = {}) {
  const state = {
    openingInventoryBookCostG,
    marketAcquisitionG,
    successfulContractAcquisitionG,
    cogsG,
    cookingWasteExpenseG,
    openingContractPrepaidAssetG,
    contractPrepaidAssetAdditionsG,
    contractPrepaidAssetApplicationsG,
    contractFailureLossG,
    costMovements: costMovements.map((movement) => cloneValue(movement)),
    processedCostMovementIds: [...processedCostMovementIds],
  };
  const validation = validateInventoryAccountingState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 InventoryAccountingState입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(state);
}

function appendCostMovement(accounting, movementInput) {
  const validation = validateInventoryAccountingState(accounting);
  if (!validation.ok) return failure("INVENTORY_ACCOUNTING_STATE_INVALID", { cause: validation.code });
  let movement;
  try {
    movement = createCostMovement(movementInput);
  } catch (error) {
    return failure(error?.code ?? "INVALID_COST_MOVEMENT");
  }
  if (accounting.processedCostMovementIds.includes(movement.movementId)) {
    return failure("DUPLICATE_COST_MOVEMENT_ID", { movementId: movement.movementId });
  }
  const candidate = cloneValue(accounting);
  candidate.costMovements.push(movement);
  candidate.processedCostMovementIds.push(movement.movementId);
  const totalField = MOVEMENT_POLICY[movement.type].totalField;
  if (totalField) {
    try {
      candidate[totalField] = checkedAddG(candidate[totalField], movement.amountG, totalField);
    } catch {
      return failure("INVENTORY_ACCOUNTING_OVERFLOW", { field: totalField });
    }
  }
  const after = validateInventoryAccountingState(candidate);
  return after.ok ? success(candidate) : failure(after.code, after.details);
}

export function validateCostMovementAppendOnly(before, after) {
  const beforeValidation = validateInventoryAccountingState(before);
  if (!beforeValidation.ok) return failure("INVALID_ACCOUNTING_BEFORE", { cause: beforeValidation.code });
  const afterValidation = validateInventoryAccountingState(after);
  if (!afterValidation.ok) return failure("INVALID_ACCOUNTING_AFTER", { cause: afterValidation.code });
  if (after.costMovements.length < before.costMovements.length) return failure("COST_MOVEMENT_REMOVED");
  for (let index = 0; index < before.costMovements.length; index += 1) {
    if (!movementEquals(before.costMovements[index], after.costMovements[index])) {
      return failure("COST_MOVEMENT_HISTORY_MUTATED", { movementIndex: index });
    }
    if (before.processedCostMovementIds[index] !== after.processedCostMovementIds[index]) {
      return failure("COST_MOVEMENT_INDEX_HISTORY_MUTATED", { movementIndex: index });
    }
  }
  return validationSuccess({ appendedCount: after.costMovements.length - before.costMovements.length });
}

export function projectCostLocations(inventory, accounting, { contractPrepaidAssetG = null } = {}) {
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) throw new TypeError(`Cost location inventory가 유효하지 않습니다: ${inventoryValidation.code}`);
  const accountingValidation = validateInventoryAccountingState(accounting);
  if (!accountingValidation.ok) throw new TypeError(`Cost location accounting이 유효하지 않습니다: ${accountingValidation.code}`);
  if (contractPrepaidAssetG !== null) requireNonNegativeG(contractPrepaidAssetG, "contractPrepaidAssetG");
  return freezeDeep({
    lotG: sumG(inventory.lots.map((lot) => lot.bookCostG), "lot Book_Cost"),
    escrowG: sumG(inventory.cookEscrows.map((escrow) => escrow.totalBookCostG), "escrow Book_Cost"),
    dishG: sumG(
      inventory.completedDishes
        .filter((dish) => dish.state === COMPLETED_DISH_STATE.CARRIED)
        .map((dish) => dish.bookCostG),
      "dish Book_Cost",
    ),
    cogsG: accounting.cogsG,
    wasteG: accounting.cookingWasteExpenseG,
    prepaidG: contractPrepaidAssetG,
    lossG: accounting.contractFailureLossG,
  });
}

export function buildCostMovementGraph(accounting) {
  const validation = validateInventoryAccountingState(accounting);
  if (!validation.ok) throw new TypeError(`Cost movement graph가 유효하지 않습니다: ${validation.code}`);
  const byMovementId = Object.create(null);
  const byCauseId = Object.create(null);
  const byDestination = Object.create(null);
  accounting.costMovements.forEach((movement, movementIndex) => {
    const edge = freezeDeep({ movementIndex, ...movement });
    byMovementId[movement.movementId] = edge;
    (byCauseId[movement.causeId] ??= []).push(edge);
    (byDestination[movement.destination] ??= []).push(edge);
  });
  return freezeDeep({ edges: accounting.costMovements, byMovementId, byCauseId, byDestination });
}

export function reconcileInventoryAccounting(inventory, accounting, { economy = null } = {}) {
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  const accountingValidation = validateInventoryAccountingState(accounting);
  if (!accountingValidation.ok) return failure("INVENTORY_ACCOUNTING_STATE_INVALID", { cause: accountingValidation.code });
  if (economy !== null) {
    const economyValidation = validateEconomyState(economy);
    if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  }
  try {
    const acquisitionsG = checkedAddG(
      accounting.marketAcquisitionG,
      accounting.successfulContractAcquisitionG,
      "inventory acquisitions",
    );
    const recognizedG = checkedAddG(accounting.cogsG, accounting.cookingWasteExpenseG, "recognized inventory cost");
    const expectedEndingInventoryBookCostG = checkedSubtractG(
      checkedAddG(accounting.openingInventoryBookCostG, acquisitionsG, "inventory available cost"),
      recognizedG,
      "inventory expected ending cost",
    );
    const actualEndingInventoryBookCostG = calculateInventoryBookCostG(inventory);
    const inventoryDeltaG = checkedSubtractG(
      actualEndingInventoryBookCostG,
      expectedEndingInventoryBookCostG,
      "inventory reconciliation delta",
    );
    const inventoryPass = inventoryDeltaG === 0;

    let prepaid = null;
    let prepaidPass = true;
    if (economy !== null) {
      const expectedPrepaidDispositionG = checkedAddG(
        accounting.openingContractPrepaidAssetG,
        accounting.contractPrepaidAssetAdditionsG,
        "prepaid available cost",
      );
      const currentAssetAndLossG = checkedAddG(
        economy.contractPrepaidAssetG,
        accounting.contractFailureLossG,
        "prepaid current and loss",
      );
      const actualPrepaidDispositionG = checkedAddG(
        currentAssetAndLossG,
        accounting.contractPrepaidAssetApplicationsG,
        "prepaid current, loss, and successful application",
      );
      const deltaG = checkedSubtractG(
        actualPrepaidDispositionG,
        expectedPrepaidDispositionG,
        "prepaid reconciliation delta",
      );
      prepaidPass = deltaG === 0;
      prepaid = freezeDeep({
        status: prepaidPass ? "PASS" : "FAIL",
        openingG: accounting.openingContractPrepaidAssetG,
        additionsG: accounting.contractPrepaidAssetAdditionsG,
        applicationsG: accounting.contractPrepaidAssetApplicationsG,
        currentAssetG: economy.contractPrepaidAssetG,
        lossG: accounting.contractFailureLossG,
        expectedG: expectedPrepaidDispositionG,
        actualG: actualPrepaidDispositionG,
        deltaG,
      });
    }

    const ok = inventoryPass && prepaidPass;
    return freezeDeep({
      ok,
      code: ok ? "INVENTORY_RECONCILIATION_PASS" : "INVENTORY_RECONCILIATION_FAILED",
      inventory: {
        status: inventoryPass ? "PASS" : "FAIL",
        openingG: accounting.openingInventoryBookCostG,
        marketAcquisitionG: accounting.marketAcquisitionG,
        successfulContractAcquisitionG: accounting.successfulContractAcquisitionG,
        cogsG: accounting.cogsG,
        wasteG: accounting.cookingWasteExpenseG,
        expectedEndingInventoryBookCostG,
        actualEndingInventoryBookCostG,
        deltaG: inventoryDeltaG,
      },
      prepaid,
      locations: projectCostLocations(inventory, accounting, {
        contractPrepaidAssetG: economy?.contractPrepaidAssetG ?? null,
      }),
    });
  } catch (error) {
    return failure("INVENTORY_RECONCILIATION_OVERFLOW", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function inventoryCandidate(inventory, changes) {
  try {
    return createInventoryState({ ...inventory, ...changes });
  } catch (error) {
    return failure(error?.code ?? "INVALID_INVENTORY_STATE");
  }
}

function movementInput(input, type, amountG, quantity, references, lines = []) {
  return {
    movementId: input.movementId,
    day: input.day,
    type,
    amountG,
    quantity,
    causeId: input.causeId,
    references,
    lines,
  };
}

export function planLotAcquisition(inventory, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  const accountingValidation = validateInventoryAccountingState(accounting);
  if (!accountingValidation.ok) return failure("INVENTORY_ACCOUNTING_STATE_INVALID", { cause: accountingValidation.code });
  if (!Object.values(INVENTORY_ACQUISITION_SOURCE).includes(input.source)) {
    return failure("INVALID_INVENTORY_ACQUISITION_SOURCE", { source: input.source });
  }

  let lot;
  try {
    lot = createIngredientLot(input.lot);
  } catch (error) {
    return failure(error?.code ?? "INVALID_INGREDIENT_LOT");
  }
  if (lot.quantity <= 0) return failure("ACQUISITION_QUANTITY_MUST_BE_POSITIVE");
  if (lot.acquiredDay !== input.day) {
    return failure("ACQUISITION_DAY_MISMATCH", { acquiredDay: lot.acquiredDay, day: input.day });
  }
  if (inventory.lots.some((existing) => existing.lotId === lot.lotId)) {
    return failure("DUPLICATE_LOT_ID", { lotId: lot.lotId });
  }
  const nextInventory = inventoryCandidate(inventory, { lots: [...inventory.lots, lot] });
  if (!nextInventory.ok && nextInventory.code) return nextInventory;
  const inventoryState = nextInventory.ok === undefined ? nextInventory : nextInventory;
  const type = input.source === INVENTORY_ACQUISITION_SOURCE.MARKET
    ? COST_MOVEMENT_TYPE.MARKET_ACQUISITION
    : COST_MOVEMENT_TYPE.CONTRACT_ACQUISITION;
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    type,
    lot.bookCostG,
    lot.quantity,
    { lotId: lot.lotId, ingredientId: lot.ingredientId },
    [{ lotId: lot.lotId, ingredientId: lot.ingredientId, quantity: lot.quantity, bookCostG: lot.bookCostG }],
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ inventory: inventoryState, accounting: accountingPlan.plan });
}

export function applyLotAcquisitionToDraft(inventoryDraft, accountingDraft, input) {
  const planned = planLotAcquisition(inventoryDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

export function planReservationCreation(inventory, input) {
  const planned = planHardReservations(inventory, input);
  if (!planned.ok) return planned;
  const candidate = cloneValue(inventory);
  const applied = applyHardReservationPlanToDraft(candidate, planned.plan);
  if (!applied.ok) return applied;
  return success({ inventory: createInventoryState(candidate), reservationPlan: planned.plan });
}

export function applyReservationCreationToDraft(inventoryDraft, input) {
  const planned = planReservationCreation(inventoryDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  return planned;
}

export function planReservationReleaseFromInventory(inventory, input) {
  const planned = planReservationRelease(inventory, input);
  if (!planned.ok) return planned;
  const candidate = inventoryCandidate(inventory, { reservations: planned.plan.reservations });
  if (!candidate.ok && candidate.code) return candidate;
  return success({ inventory: candidate, released: planned.plan.released });
}

export function applyReservationReleaseToDraft(inventoryDraft, input) {
  const planned = planReservationReleaseFromInventory(inventoryDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  return planned;
}

export function planIngredientsToEscrow(inventory, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  if (!isStableIdentifier(input.escrowId)) return failure("INVALID_ESCROW_ID");
  if (!isStableIdentifier(input.recipeId)) return failure("INVALID_RECIPE_ID");
  if (inventory.cookEscrows.some((escrow) => escrow.escrowId === input.escrowId)) {
    return failure("DUPLICATE_ESCROW_ID", { escrowId: input.escrowId });
  }
  const allocation = planCookAllocation(inventory, {
    requirements: input.requirements,
    saleSlotId: input.saleSlotId ?? null,
  });
  if (!allocation.ok) return allocation;
  let escrow;
  try {
    escrow = createCookEscrow({
      escrowId: input.escrowId,
      recipeId: input.recipeId,
      sourceSaleSlotId: input.saleSlotId ?? null,
      lines: allocation.plan.lines,
      totalQuantity: allocation.plan.totalQuantity,
      totalBookCostG: allocation.plan.totalBookCostG,
      quality: allocation.plan.quality,
    });
  } catch (error) {
    return failure(error?.code ?? "INVALID_COOK_ESCROW");
  }
  const nextInventory = inventoryCandidate(inventory, {
    lots: allocation.plan.lots,
    reservations: allocation.plan.reservations,
    cookEscrows: [...inventory.cookEscrows, escrow],
  });
  if (!nextInventory.ok && nextInventory.code) return nextInventory;
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    COST_MOVEMENT_TYPE.LOT_TO_ESCROW,
    escrow.totalBookCostG,
    escrow.totalQuantity,
    { escrowId: escrow.escrowId, recipeId: escrow.recipeId, saleSlotId: escrow.sourceSaleSlotId },
    escrow.lines,
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ inventory: nextInventory, accounting: accountingPlan.plan, escrow });
}

export function applyIngredientsToEscrowDraft(inventoryDraft, accountingDraft, input) {
  const planned = planIngredientsToEscrow(inventoryDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

function escrowById(inventory, escrowId) {
  if (!isStableIdentifier(escrowId)) return failure("INVALID_ESCROW_ID");
  const escrow = inventory.cookEscrows.find((candidate) => candidate.escrowId === escrowId);
  return escrow ? Object.freeze({ ok: true, escrow }) : failure("COOK_ESCROW_NOT_FOUND", { escrowId });
}

export function planEscrowRestore(inventory, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  const found = escrowById(inventory, input.escrowId);
  if (!found.ok) return found;
  const escrow = found.escrow;
  const candidate = cloneValue(inventory);
  try {
    for (const line of escrow.lines) {
      const lot = candidate.lots.find((item) => item.lotId === line.lotId);
      if (!lot || lot.ingredientId !== line.ingredientId || lot.quality !== line.quality) {
        return failure("ESCROW_SOURCE_LOT_MISMATCH", { lotId: line.lotId });
      }
      lot.quantity += line.quantity;
      if (!Number.isSafeInteger(lot.quantity)) return failure("LOT_QUANTITY_OVERFLOW", { lotId: lot.lotId });
      lot.bookCostG = checkedAddG(lot.bookCostG, line.bookCostG, "restored lot Book_Cost");
      if (line.reservationId !== null) {
        const existing = candidate.reservations.find((reservation) => reservation.reservationId === line.reservationId);
        if (existing) {
          if (existing.saleSlotId !== line.saleSlotId || existing.lotId !== line.lotId ||
              existing.ingredientId !== line.ingredientId) {
            return failure("ESCROW_RESERVATION_RESTORE_MISMATCH", { reservationId: line.reservationId });
          }
          existing.quantity += line.quantity;
          if (!Number.isSafeInteger(existing.quantity)) {
            return failure("RESERVATION_QUANTITY_OVERFLOW", { reservationId: line.reservationId });
          }
        } else {
          candidate.reservations.push(createIngredientReservation({
            reservationId: line.reservationId,
            saleSlotId: line.saleSlotId,
            lotId: line.lotId,
            ingredientId: line.ingredientId,
            quantity: line.quantity,
          }));
        }
      }
    }
  } catch (error) {
    return failure(error?.code ?? "ESCROW_RESTORE_OVERFLOW");
  }
  // 전량 소비돼 배열에서 제거됐던 reservation을 다시 만들면 원래 위치가 아니라 배열 끝에
  // 붙어서 순서가 어긋난다. reservationId 오름차순으로 정렬해 원래 순서를 복원한다.
  candidate.reservations.sort((left, right) => (
    left.reservationId < right.reservationId ? -1 : left.reservationId > right.reservationId ? 1 : 0
  ));
  candidate.cookEscrows = candidate.cookEscrows.filter((item) => item.escrowId !== escrow.escrowId);
  const nextInventory = inventoryCandidate(candidate, {});
  if (!nextInventory.ok && nextInventory.code) return nextInventory;
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    COST_MOVEMENT_TYPE.ESCROW_TO_LOT,
    escrow.totalBookCostG,
    escrow.totalQuantity,
    { escrowId: escrow.escrowId, recipeId: escrow.recipeId, saleSlotId: escrow.sourceSaleSlotId },
    escrow.lines,
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ inventory: nextInventory, accounting: accountingPlan.plan, restoredEscrow: escrow });
}

export function applyEscrowRestoreToDraft(inventoryDraft, accountingDraft, input) {
  const planned = planEscrowRestore(inventoryDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

export function planEscrowToDish(inventory, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  const found = escrowById(inventory, input.escrowId);
  if (!found.ok) return found;
  const escrow = found.escrow;
  if (!isStableIdentifier(input.dishId)) return failure("INVALID_DISH_ID");
  if (inventory.completedDishes.some((dish) => dish.dishId === input.dishId)) {
    return failure("DUPLICATE_DISH_ID", { dishId: input.dishId });
  }
  let dish;
  try {
    dish = createCompletedDish({
      dishId: input.dishId,
      recipeId: escrow.recipeId,
      quality: input.quality ?? escrow.quality,
      bookCostG: escrow.totalBookCostG,
      createdOrderId: input.createdOrderId ?? null,
      sourceSaleSlotId: escrow.sourceSaleSlotId,
      state: COMPLETED_DISH_STATE.CARRIED,
    });
  } catch (error) {
    return failure(error?.code ?? "INVALID_COMPLETED_DISH");
  }
  const nextInventory = inventoryCandidate(inventory, {
    cookEscrows: inventory.cookEscrows.filter((item) => item.escrowId !== escrow.escrowId),
    completedDishes: [...inventory.completedDishes, dish],
  });
  if (!nextInventory.ok && nextInventory.code) return nextInventory;
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    COST_MOVEMENT_TYPE.ESCROW_TO_DISH,
    escrow.totalBookCostG,
    escrow.totalQuantity,
    { escrowId: escrow.escrowId, dishId: dish.dishId, recipeId: dish.recipeId },
    escrow.lines,
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ inventory: nextInventory, accounting: accountingPlan.plan, dish });
}

export function applyEscrowToDishDraft(inventoryDraft, accountingDraft, input) {
  const planned = planEscrowToDish(inventoryDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

export function planEscrowToWaste(inventory, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  const found = escrowById(inventory, input.escrowId);
  if (!found.ok) return found;
  const escrow = found.escrow;
  const nextInventory = inventoryCandidate(inventory, {
    cookEscrows: inventory.cookEscrows.filter((item) => item.escrowId !== escrow.escrowId),
  });
  if (!nextInventory.ok && nextInventory.code) return nextInventory;
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    COST_MOVEMENT_TYPE.ESCROW_TO_WASTE,
    escrow.totalBookCostG,
    escrow.totalQuantity,
    { escrowId: escrow.escrowId, recipeId: escrow.recipeId },
    escrow.lines,
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ inventory: nextInventory, accounting: accountingPlan.plan, wastedEscrow: escrow });
}

export function applyEscrowToWasteDraft(inventoryDraft, accountingDraft, input) {
  const planned = planEscrowToWaste(inventoryDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

function planDishRecognition(inventory, accounting, input, destination) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  if (!isStableIdentifier(input.dishId)) return failure("INVALID_DISH_ID");
  const dishIndex = inventory.completedDishes.findIndex((dish) => dish.dishId === input.dishId);
  if (dishIndex < 0) return failure("COMPLETED_DISH_NOT_FOUND", { dishId: input.dishId });
  const dish = inventory.completedDishes[dishIndex];
  if (dish.state !== COMPLETED_DISH_STATE.CARRIED) {
    return failure("DISH_COST_ALREADY_RECOGNIZED", { dishId: dish.dishId, state: dish.state });
  }
  const candidateDishes = inventory.completedDishes.map((item, index) => index === dishIndex ? {
    ...item,
    state: destination === COST_LOCATION.COGS ? COMPLETED_DISH_STATE.SOLD : COMPLETED_DISH_STATE.WASTED,
    bookCostG: 0,
    recognizedBookCostG: item.bookCostG,
  } : item);
  const nextInventory = inventoryCandidate(inventory, { completedDishes: candidateDishes });
  if (!nextInventory.ok && nextInventory.code) return nextInventory;
  const type = destination === COST_LOCATION.COGS
    ? COST_MOVEMENT_TYPE.DISH_TO_COGS
    : COST_MOVEMENT_TYPE.DISH_TO_WASTE;
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    type,
    dish.bookCostG,
    0,
    { dishId: dish.dishId, recipeId: dish.recipeId, createdOrderId: dish.createdOrderId },
    [{ dishId: dish.dishId, bookCostG: dish.bookCostG }],
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ inventory: nextInventory, accounting: accountingPlan.plan, recognizedDish: dish });
}

export function planDishToCogs(inventory, accounting, input) {
  return planDishRecognition(inventory, accounting, input, COST_LOCATION.COGS);
}

export function planDishToWaste(inventory, accounting, input) {
  return planDishRecognition(inventory, accounting, input, COST_LOCATION.WASTE);
}

export function applyDishToCogsDraft(inventoryDraft, accountingDraft, input) {
  const planned = planDishToCogs(inventoryDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

export function applyDishToWasteDraft(inventoryDraft, accountingDraft, input) {
  const planned = planDishToWaste(inventoryDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(inventoryDraft, planned.plan.inventory);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

export function planContractPrepaidCapitalization(economy, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  try {
    requirePositiveG(input.amountG, "amountG");
  } catch {
    return failure("INVALID_CONTRACT_PREPAID_AMOUNT", { amountG: input.amountG });
  }
  const nextEconomy = cloneValue(economy);
  try {
    nextEconomy.contractPrepaidAssetG = checkedAddG(
      nextEconomy.contractPrepaidAssetG,
      input.amountG,
      "contract prepaid asset",
    );
  } catch {
    return failure("CONTRACT_PREPAID_ASSET_OVERFLOW");
  }
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    COST_MOVEMENT_TYPE.CONTRACT_PREPAID_CAPITALIZATION,
    input.amountG,
    0,
    { contractId: input.contractId ?? null },
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ economy: nextEconomy, accounting: accountingPlan.plan });
}

export function applyContractPrepaidCapitalizationToDraft(economyDraft, accountingDraft, input) {
  const planned = planContractPrepaidCapitalization(economyDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(economyDraft, planned.plan.economy);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

/**
 * Reclassifies a successful contract's prepaid asset into contract consideration. ContractSystem
 * then delegates each resulting lot to applyLotAcquisitionToDraft, whose acquisition movements
 * capitalize the full contract consideration into inventory without introducing another writer.
 */
export function planContractPrepaidApplication(economy, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  try {
    requirePositiveG(input.amountG, "amountG");
  } catch {
    return failure("INVALID_CONTRACT_PREPAID_APPLICATION_AMOUNT", { amountG: input.amountG });
  }
  if (input.amountG > economy.contractPrepaidAssetG) {
    return failure("INSUFFICIENT_CONTRACT_PREPAID_ASSET", {
      amountG: input.amountG,
      contractPrepaidAssetG: economy.contractPrepaidAssetG,
    });
  }
  const nextEconomy = cloneValue(economy);
  nextEconomy.contractPrepaidAssetG = checkedSubtractG(
    nextEconomy.contractPrepaidAssetG,
    input.amountG,
    "successful contract prepaid application",
  );
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    COST_MOVEMENT_TYPE.CONTRACT_PREPAID_APPLICATION,
    input.amountG,
    0,
    { contractId: input.contractId ?? null },
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ economy: nextEconomy, accounting: accountingPlan.plan });
}

export function applyContractPrepaidApplicationToDraft(economyDraft, accountingDraft, input) {
  const planned = planContractPrepaidApplication(economyDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(economyDraft, planned.plan.economy);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

export function planContractFailureLoss(economy, accounting, input) {
  const metadata = requireMovementMeta(input);
  if (!metadata.ok) return metadata;
  const economyValidation = validateEconomyState(economy);
  if (!economyValidation.ok) return failure("ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  try {
    requirePositiveG(input.amountG, "amountG");
  } catch {
    return failure("INVALID_CONTRACT_FAILURE_LOSS_AMOUNT", { amountG: input.amountG });
  }
  if (input.amountG > economy.contractPrepaidAssetG) {
    return failure("INSUFFICIENT_CONTRACT_PREPAID_ASSET", {
      amountG: input.amountG,
      contractPrepaidAssetG: economy.contractPrepaidAssetG,
    });
  }
  const nextEconomy = cloneValue(economy);
  nextEconomy.contractPrepaidAssetG = checkedSubtractG(
    nextEconomy.contractPrepaidAssetG,
    input.amountG,
    "contract prepaid failure loss",
  );
  const accountingPlan = appendCostMovement(accounting, movementInput(
    input,
    COST_MOVEMENT_TYPE.PREPAID_TO_LOSS,
    input.amountG,
    0,
    { contractId: input.contractId ?? null },
  ));
  if (!accountingPlan.ok) return accountingPlan;
  return success({ economy: nextEconomy, accounting: accountingPlan.plan });
}

export function applyContractFailureLossToDraft(economyDraft, accountingDraft, input) {
  const planned = planContractFailureLoss(economyDraft, accountingDraft, input);
  if (!planned.ok) return planned;
  assignDraft(economyDraft, planned.plan.economy);
  assignDraft(accountingDraft, planned.plan.accounting);
  return planned;
}

function verifyInventoryAccountingPlan(before, after, planned, { includeEconomy = false } = {}) {
  if (!movementEquals(after.inventory, planned.inventory)) return failure("INVENTORY_PLAN_MISMATCH");
  if (!movementEquals(after.inventoryAccounting, planned.accounting)) return failure("ACCOUNTING_PLAN_MISMATCH");
  if (includeEconomy && !movementEquals(after.economy, planned.economy)) return failure("ECONOMY_PLAN_MISMATCH");
  const appendOnly = validateCostMovementAppendOnly(before.inventoryAccounting, after.inventoryAccounting);
  if (!appendOnly.ok) return appendOnly;
  const reconciliation = reconcileInventoryAccounting(after.inventory, after.inventoryAccounting, {
    economy: includeEconomy ? after.economy : null,
  });
  return reconciliation.ok ? validationSuccess(reconciliation) : failure(reconciliation.code, reconciliation);
}

function createInventoryAccountingTransaction({ name, phases, planner, applier, eventType }) {
  return defineAtomicTransaction({
    name,
    readSet: NO_READ_SET,
    writeSet: INVENTORY_ACCOUNTING_WRITE_SET,
    allowedPhases: phases,
    validatePayload(ctx) {
      return isPlainRecord(ctx.command.payload) ? validationSuccess() : failure("INVALID_INVENTORY_COMMAND_PAYLOAD");
    },
    preflight(ctx) {
      return planner(ctx.read("inventory"), ctx.read("inventoryAccounting"), ctx.command.payload);
    },
    mutate(draft) {
      return applier(draft.write("inventory"), draft.write("inventoryAccounting"), draft.command.payload);
    },
    postconditions(before, after, ctx) {
      const planned = planner(before.inventory, before.inventoryAccounting, ctx.command.payload);
      if (!planned.ok) return planned;
      return verifyInventoryAccountingPlan(before, after, planned.plan);
    },
    events(_before, _after, ctx) {
      return [{
        type: eventType,
        causeId: ctx.command.payload.causeId,
        payload: {
          movementId: ctx.command.payload.movementId,
          escrowId: ctx.command.payload.escrowId ?? null,
          dishId: ctx.command.payload.dishId ?? null,
        },
      }];
    },
  });
}

function createReservationTransaction({ release = false } = {}) {
  const planner = release ? planReservationReleaseFromInventory : planReservationCreation;
  const applier = release ? applyReservationReleaseToDraft : applyReservationCreationToDraft;
  return defineAtomicTransaction({
    name: release ? INVENTORY_COMMAND.RELEASE_RESERVATIONS : INVENTORY_COMMAND.RESERVE,
    readSet: NO_READ_SET,
    writeSet: INVENTORY_WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      return isPlainRecord(ctx.command.payload) ? validationSuccess() : failure("INVALID_INVENTORY_COMMAND_PAYLOAD");
    },
    preflight(ctx) {
      return planner(ctx.read("inventory"), ctx.command.payload);
    },
    mutate(draft) {
      return applier(draft.write("inventory"), draft.command.payload);
    },
    postconditions(before, after, ctx) {
      const planned = planner(before.inventory, ctx.command.payload);
      if (!planned.ok) return planned;
      if (!movementEquals(after.inventory, planned.plan.inventory)) return failure("INVENTORY_PLAN_MISMATCH");
      return validateInventoryState(after.inventory);
    },
    events(_before, _after, ctx) {
      return [{
        type: release ? "inventory.reservations-released" : "inventory.reservations-created",
        payload: {
          reservationPlanId: ctx.command.payload.reservationPlanId ?? null,
          saleSlotIds: ctx.command.payload.saleSlotIds ?? [],
        },
      }];
    },
  });
}

export function createLotAcquisitionAtomicTransaction() {
  return createInventoryAccountingTransaction({
    name: INVENTORY_COMMAND.ACQUIRE_LOT,
    phases: ["PLANNING"],
    planner: planLotAcquisition,
    applier: applyLotAcquisitionToDraft,
    eventType: "inventory.lot-acquired",
  });
}

export function createStartCookEscrowAtomicTransaction() {
  return createInventoryAccountingTransaction({
    name: INVENTORY_COMMAND.START_COOK_ESCROW,
    phases: ["SERVICE"],
    planner: planIngredientsToEscrow,
    applier: applyIngredientsToEscrowDraft,
    eventType: "inventory.cook-escrow-started",
  });
}

export function createRestoreCookEscrowAtomicTransaction() {
  return createInventoryAccountingTransaction({
    name: INVENTORY_COMMAND.RESTORE_COOK_ESCROW,
    phases: ["SERVICE"],
    planner: planEscrowRestore,
    applier: applyEscrowRestoreToDraft,
    eventType: "inventory.cook-escrow-restored",
  });
}

export function createCompleteCookToDishAtomicTransaction() {
  return createInventoryAccountingTransaction({
    name: INVENTORY_COMMAND.COMPLETE_COOK_TO_DISH,
    phases: ["SERVICE"],
    planner: planEscrowToDish,
    applier: applyEscrowToDishDraft,
    eventType: "inventory.completed-dish-created",
  });
}

export function createCompleteCookToWasteAtomicTransaction() {
  return createInventoryAccountingTransaction({
    name: INVENTORY_COMMAND.COMPLETE_COOK_TO_WASTE,
    phases: ["SERVICE"],
    planner: planEscrowToWaste,
    applier: applyEscrowToWasteDraft,
    eventType: "inventory.cooking-waste-recognized",
  });
}

export function createDishCogsAtomicTransaction() {
  return createInventoryAccountingTransaction({
    name: INVENTORY_COMMAND.RECOGNIZE_DISH_COGS,
    phases: ["SERVICE"],
    planner: planDishToCogs,
    applier: applyDishToCogsDraft,
    eventType: "inventory.cogs-recognized",
  });
}

export function createDishWasteAtomicTransaction() {
  return createInventoryAccountingTransaction({
    name: INVENTORY_COMMAND.WASTE_DISH,
    phases: ["SERVICE"],
    planner: planDishToWaste,
    applier: applyDishToWasteDraft,
    eventType: "inventory.dish-waste-recognized",
  });
}

export function createContractFailureLossAtomicTransaction() {
  return defineAtomicTransaction({
    name: INVENTORY_COMMAND.RECOGNIZE_CONTRACT_FAILURE_LOSS,
    readSet: CONTRACT_LOSS_READ_SET,
    writeSet: CONTRACT_LOSS_WRITE_SET,
    allowedPhases: ["PLANNING", "SETTLEMENT", "TERMINAL"],
    validatePayload(ctx) {
      return isPlainRecord(ctx.command.payload) ? validationSuccess() : failure("INVALID_INVENTORY_COMMAND_PAYLOAD");
    },
    preflight(ctx) {
      return planContractFailureLoss(ctx.read("economy"), ctx.read("inventoryAccounting"), ctx.command.payload);
    },
    mutate(draft) {
      return applyContractFailureLossToDraft(
        draft.write("economy"),
        draft.write("inventoryAccounting"),
        draft.command.payload,
      );
    },
    postconditions(before, after, ctx) {
      const planned = planContractFailureLoss(before.economy, before.inventoryAccounting, ctx.command.payload);
      if (!planned.ok) return planned;
      const combined = { inventory: before.inventory, accounting: planned.plan.accounting, economy: planned.plan.economy };
      return verifyInventoryAccountingPlan(before, {
        inventory: after.inventory,
        inventoryAccounting: combined.accounting,
        economy: after.economy,
      }, {
        inventory: before.inventory,
        accounting: combined.accounting,
        economy: combined.economy,
      }, { includeEconomy: true });
    },
    events(_before, _after, ctx) {
      return [{
        type: "inventory.contract-failure-loss-recognized",
        causeId: ctx.command.payload.causeId,
        payload: { movementId: ctx.command.payload.movementId, amountG: ctx.command.payload.amountG },
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
    causeId: input?.payload?.causeId,
    readSet: [...readSet],
    writeSet: [...writeSet],
  };
}

/** Production command facade for every Task 14 inventory/accounting mutation. */
export class InventoryAccountingAPI {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("InventoryAccountingAPI에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(INVENTORY_COMMAND.ACQUIRE_LOT, createLotAcquisitionAtomicTransaction());
    this.commandBus.register(INVENTORY_COMMAND.RESERVE, createReservationTransaction());
    this.commandBus.register(INVENTORY_COMMAND.RELEASE_RESERVATIONS, createReservationTransaction({ release: true }));
    this.commandBus.register(INVENTORY_COMMAND.START_COOK_ESCROW, createStartCookEscrowAtomicTransaction());
    this.commandBus.register(INVENTORY_COMMAND.RESTORE_COOK_ESCROW, createRestoreCookEscrowAtomicTransaction());
    this.commandBus.register(INVENTORY_COMMAND.COMPLETE_COOK_TO_DISH, createCompleteCookToDishAtomicTransaction());
    this.commandBus.register(INVENTORY_COMMAND.COMPLETE_COOK_TO_WASTE, createCompleteCookToWasteAtomicTransaction());
    this.commandBus.register(INVENTORY_COMMAND.RECOGNIZE_DISH_COGS, createDishCogsAtomicTransaction());
    this.commandBus.register(INVENTORY_COMMAND.WASTE_DISH, createDishWasteAtomicTransaction());
    this.commandBus.register(
      INVENTORY_COMMAND.RECOGNIZE_CONTRACT_FAILURE_LOSS,
      createContractFailureLossAtomicTransaction(),
    );
    this.registered = true;
    return this;
  }

  acquireLot(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.ACQUIRE_LOT,
      NO_READ_SET,
      INVENTORY_ACCOUNTING_WRITE_SET,
      input,
    ));
  }

  reserve(input) {
    return this.commandBus.dispatch(commandEnvelope(INVENTORY_COMMAND.RESERVE, NO_READ_SET, INVENTORY_WRITE_SET, input));
  }

  releaseReservations(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.RELEASE_RESERVATIONS,
      NO_READ_SET,
      INVENTORY_WRITE_SET,
      input,
    ));
  }

  startCookEscrow(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.START_COOK_ESCROW,
      NO_READ_SET,
      INVENTORY_ACCOUNTING_WRITE_SET,
      input,
    ));
  }

  restoreCookEscrow(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.RESTORE_COOK_ESCROW,
      NO_READ_SET,
      INVENTORY_ACCOUNTING_WRITE_SET,
      input,
    ));
  }

  completeCookToDish(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.COMPLETE_COOK_TO_DISH,
      NO_READ_SET,
      INVENTORY_ACCOUNTING_WRITE_SET,
      input,
    ));
  }

  completeCookToWaste(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.COMPLETE_COOK_TO_WASTE,
      NO_READ_SET,
      INVENTORY_ACCOUNTING_WRITE_SET,
      input,
    ));
  }

  recognizeDishCogs(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.RECOGNIZE_DISH_COGS,
      NO_READ_SET,
      INVENTORY_ACCOUNTING_WRITE_SET,
      input,
    ));
  }

  wasteDish(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.WASTE_DISH,
      NO_READ_SET,
      INVENTORY_ACCOUNTING_WRITE_SET,
      input,
    ));
  }

  recognizeContractFailureLoss(input) {
    return this.commandBus.dispatch(commandEnvelope(
      INVENTORY_COMMAND.RECOGNIZE_CONTRACT_FAILURE_LOSS,
      CONTRACT_LOSS_READ_SET,
      CONTRACT_LOSS_WRITE_SET,
      input,
    ));
  }
}

export function registerInventoryAccounting(commandBus) {
  return new InventoryAccountingAPI(commandBus, { register: true });
}
