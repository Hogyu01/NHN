import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { applyCashTransactionToDraft } from "./cash-transaction-api.js";
import { validateEconomyState, validateEconomyTransition } from "./economy.js";
import {
  LEDGER_CATEGORY,
  LEDGER_DIRECTION,
  LEDGER_TYPE,
} from "./economy-ledger.js";
import { validateEventState } from "./events.js";
import { validateFacilityState } from "./facility.js";
import {
  applyDishToCogsDraft,
  applyDishToWasteDraft,
  applyEscrowRestoreToDraft,
  applyEscrowToDishDraft,
  applyEscrowToWasteDraft,
  applyIngredientsToEscrowDraft,
  reconcileInventoryAccounting,
  validateCostMovementAppendOnly,
  validateInventoryAccountingState,
} from "./inventory-accounting.js";
import {
  COMPLETED_DISH_STATE,
  validateInventoryState,
} from "./inventory.js";
import { validateMenuPlanReconciliation, validateMenuState } from "./menu.js";
import {
  ACTIVE_ORDER_STATE,
  ORDER_GUEST_STATE,
  ORDER_REACTION_DURATION_MS,
  ORDER_REACTION_KIND,
  planOrderTimeout,
  validateActiveOrder,
  validateOrderGuest,
} from "./orders.js";
import { getRecipeDefinition, validateRecipeState } from "./recipe.js";
import { applyReputationCauseToDraft, validateReputationCampaignState } from "./reputation.js";
import {
  applySaleSlotSoldToDraft,
  SALE_SLOT_STATE,
  validateSaleSlotsState,
} from "./sale-slots.js";
import {
  applySaleRecordToDraft,
  projectSales,
  validateSalesAppendOnly,
  validateSalesState,
} from "./sales.js";
import {
  calculateTimingWindowBonusMs,
  cancelTimingCookAtZero,
  completeTimingCook,
  COOK_JUDGMENT,
  COOK_TRIGGER,
  judgeTimingCook,
  TIMING_COOK_STATE,
  validateTimingCook,
  createTimingCook,
} from "./timing-cook.js";
import {
  RUNTIME_PHASE,
  SERVICE_LIFECYCLE,
  validateServiceTimerState,
} from "./timer-state.js";
import { validateProgressionState } from "./unlocks.js";

export const DIRECT_SERVICE_COMMAND = Object.freeze({
  START_COOK: "direct-service.cook.start",
  COMPLETE_COOK: "direct-service.cook.complete",
  CANCEL_COOK_AT_ZERO: "direct-service.cook.cancel-at-zero",
  SERVE: "direct-service.serve",
  WRONG_SERVE: "direct-service.serve.wrong",
  WASTE_CARRIED_DISH: "direct-service.dish.waste",
});

export const DIRECT_SERVICE_OUTCOME = Object.freeze({
  COOK_STARTED: "COOK_STARTED",
  DISH_COMPLETED: "DISH_COMPLETED",
  COOK_FAILED: "COOK_FAILED",
  COOK_CANCELLED_RESTORED: "COOK_CANCELLED_RESTORED",
  SALE_COMMITTED: "SALE_COMMITTED",
  WRONG_SERVE: "WRONG_SERVE",
  WRONG_SERVE_TIMEOUT: "WRONG_SERVE_TIMEOUT",
  DISH_WASTED: "DISH_WASTED",
});

export const DIRECT_SERVICE_DEFAULTS = Object.freeze({
  wrongServePenaltyMs: 3_000,
  reactionDurationMs: ORDER_REACTION_DURATION_MS,
  saleReputationDelta: 1,
});

export const START_COOK_READ_SET = Object.freeze([
  "campaign",
  "recipes",
  "menu",
  "saleSlots",
  "facilities",
  "events",
]);
export const START_COOK_WRITE_SET = Object.freeze([
  "inventory",
  "inventoryAccounting",
  "service",
  "idCounters",
]);
export const COMPLETE_COOK_READ_SET = Object.freeze(["campaign", "saleSlots"]);
export const COMPLETE_COOK_WRITE_SET = Object.freeze([
  "inventory",
  "inventoryAccounting",
  "service",
  "idCounters",
]);
export const CANCEL_COOK_READ_SET = Object.freeze(["campaign", "saleSlots"]);
export const CANCEL_COOK_WRITE_SET = Object.freeze([
  "inventory",
  "inventoryAccounting",
  "service",
  "idCounters",
]);
export const COMMIT_SALE_READ_SET = Object.freeze(["menu", "recipes"]);
export const COMMIT_SALE_WRITE_SET = Object.freeze([
  "service",
  "saleSlots",
  "inventory",
  "inventoryAccounting",
  "economy",
  "campaign",
  "progression",
  "sales",
  "idCounters",
]);
export const WRONG_SERVE_READ_SET = Object.freeze(["menu", "recipes", "inventory"]);
export const WRONG_SERVE_WRITE_SET = Object.freeze(["service", "saleSlots"]);
export const WASTE_DISH_READ_SET = Object.freeze(["campaign", "saleSlots"]);
export const WASTE_DISH_WRITE_SET = Object.freeze([
  "service",
  "inventory",
  "inventoryAccounting",
  "idCounters",
]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_DIRECT_SERVICE_CONFIGURATION: "직접 서비스 설정이 올바르지 않습니다.",
  INVALID_DIRECT_SERVICE_PAYLOAD: "직접 서비스 요청 형식이 올바르지 않습니다.",
  DIRECT_SERVICE_REQUIRES_RUNNING_SERVICE: "결과가 열려 있는 Service에서만 이 직접 서비스 요청을 처리할 수 있습니다.",
  DIRECT_SERVICE_REQUIRES_TIMER_ZERO_CLEANUP: "timer 0 결과 폐쇄 cleanup에서만 미완료 조리를 복구할 수 있습니다.",
  DIRECT_SERVICE_STATE_INVALID: "직접 서비스 상태 불변식이 올바르지 않습니다.",
  DIRECT_SERVICE_RECIPE_STATE_INVALID: "직접 서비스 Recipe 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_MENU_STATE_INVALID: "직접 서비스 메뉴 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_MENU_NOT_LOCKED: "잠긴 Service 메뉴에서만 직접 서비스를 처리할 수 있습니다.",
  DIRECT_SERVICE_SALE_SLOT_STATE_INVALID: "직접 서비스 SaleSlot 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_INVENTORY_STATE_INVALID: "직접 서비스 재고 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_ACCOUNTING_STATE_INVALID: "직접 서비스 재고 회계 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_ECONOMY_STATE_INVALID: "직접 서비스 경제 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_CAMPAIGN_STATE_INVALID: "직접 서비스 캠페인 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_PROGRESSION_STATE_INVALID: "직접 서비스 진행 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_SALES_STATE_INVALID: "직접 서비스 판매 집계 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_EVENT_STATE_INVALID: "직접 서비스 사건 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_FACILITY_STATE_INVALID: "직접 서비스 시설 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_ID_STATE_INVALID: "직접 서비스 결정론적 ID 상태가 올바르지 않습니다.",
  DIRECT_SERVICE_ID_STATE_MISMATCH: "직접 서비스 ID 상태가 현재 캠페인과 일치하지 않습니다.",
  RECIPE_NOT_FOUND: "조리할 Recipe를 찾을 수 없습니다.",
  RECIPE_NOT_ON_CONFIRMED_MENU: "확정 메뉴에 활성화된 Recipe만 조리·판매할 수 있습니다.",
  SALE_SLOT_NOT_FOUND: "조리에 사용할 SaleSlot을 찾을 수 없습니다.",
  SALE_SLOT_RECIPE_MISMATCH: "SaleSlot과 조리 Recipe가 일치하지 않습니다.",
  SALE_SLOT_NOT_COOKABLE: "AVAILABLE 또는 올바른 ACTIVE order의 ASSIGNED SaleSlot만 조리할 수 있습니다.",
  SOURCE_ORDER_REQUIRED_FOR_ASSIGNED_SLOT: "ASSIGNED SaleSlot 조리에는 source order가 필요합니다.",
  SOURCE_ORDER_NOT_FOUND: "조리 source order를 찾을 수 없습니다.",
  SOURCE_ORDER_NOT_ACTIVE: "ACTIVE source order만 조리할 수 있습니다.",
  SOURCE_ORDER_LINK_MISMATCH: "source order, Recipe, SaleSlot 연결이 일치하지 않습니다.",
  CARRIED_DISH_ALREADY_EXISTS: "carried dish가 있으면 새 조리를 시작할 수 없습니다.",
  COOK_ALREADY_RUNNING: "이미 실행 중인 Timing_Cook이 있습니다.",
  ORPHAN_COOK_ESCROW: "Timing_Cook과 연결되지 않은 CookEscrow가 있습니다.",
  TIMING_COOK_NOT_FOUND: "실행 중인 Timing_Cook을 찾을 수 없습니다.",
  CARRIED_DISH_NOT_FOUND: "carried dish를 찾을 수 없습니다.",
  CARRIED_DISH_REFERENCE_MISMATCH: "Carried_Dish_Overlay와 inventory dish가 일치하지 않습니다.",
  TARGET_ORDER_NOT_FOUND: "서빙 대상 order를 찾을 수 없습니다.",
  TARGET_ORDER_NOT_ACTIVE: "ACTIVE order에만 서빙할 수 있습니다.",
  TARGET_ORDER_GUEST_INVALID: "서빙 대상 guest가 ORDERING 상태가 아닙니다.",
  SERVE_RECIPE_MISMATCH: "Recipe가 다른 order는 원자 판매로 처리할 수 없습니다.",
  WRONG_SERVE_REQUIRES_MISMATCH: "Recipe가 일치하는 order는 오서빙으로 처리할 수 없습니다.",
  WRONG_SERVE_PENALTY_OVERFLOW: "오서빙 patience 계산이 safe integer 범위를 벗어났습니다.",
  SALE_PRICE_INVALID: "확정 메뉴 판매 가격이 올바르지 않습니다.",
  SALE_TIMING_RESULT_INVALID: "판매 dish의 Timing_Cook 결과를 찾을 수 없습니다.",
  DIRECT_SERVICE_COMPOSITION_FAILED: "직접 서비스 하위 원자 변경을 조합하지 못했습니다.",
  DIRECT_SERVICE_POSTCONDITION_FAILED: "직접 서비스 원자 변경 사후조건이 일치하지 않습니다.",
  DIRECT_SERVICE_RECONCILIATION_FAILED: "직접 서비스 뒤 재고 회계 대사가 실패했습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "직접 서비스 검증에 실패했습니다.",
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

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function normalizeConfiguration(configuration = {}) {
  const normalized = {
    wrongServePenaltyMs: configuration.wrongServePenaltyMs ?? DIRECT_SERVICE_DEFAULTS.wrongServePenaltyMs,
    reactionDurationMs: configuration.reactionDurationMs ?? DIRECT_SERVICE_DEFAULTS.reactionDurationMs,
    saleReputationDelta: configuration.saleReputationDelta ?? DIRECT_SERVICE_DEFAULTS.saleReputationDelta,
  };
  if (normalized.wrongServePenaltyMs !== DIRECT_SERVICE_DEFAULTS.wrongServePenaltyMs ||
      normalized.reactionDurationMs !== ORDER_REACTION_DURATION_MS ||
      !Number.isSafeInteger(normalized.saleReputationDelta)) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_DIRECT_SERVICE_CONFIGURATION);
    error.code = "INVALID_DIRECT_SERVICE_CONFIGURATION";
    error.details = normalized;
    throw error;
  }
  return freezeDeep(normalized);
}

function validateCampaignIdentity(campaign) {
  if (!isPlainRecord(campaign) || !isStableIdentifier(campaign.campaignId) ||
      !Number.isSafeInteger(campaign.day) || campaign.day < 1 || campaign.day > 14) {
    return failure("DIRECT_SERVICE_CAMPAIGN_STATE_INVALID");
  }
  return validationSuccess();
}

function validateMenuAndRecipes(menu, recipes) {
  const recipeValidation = validateRecipeState(recipes);
  if (!recipeValidation.ok) {
    return failure("DIRECT_SERVICE_RECIPE_STATE_INVALID", { cause: recipeValidation.code });
  }
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) {
    return failure("DIRECT_SERVICE_MENU_STATE_INVALID", { cause: menuValidation.code });
  }
  if (!menu.locked || menu.cleanupComplete) {
    return failure("DIRECT_SERVICE_MENU_NOT_LOCKED", {
      locked: menu.locked,
      cleanupComplete: menu.cleanupComplete,
    });
  }
  return validationSuccess();
}

function validateOrderLinks(service, saleSlots) {
  const slotValidation = validateSaleSlotsState(saleSlots);
  if (!slotValidation.ok) {
    return failure("DIRECT_SERVICE_SALE_SLOT_STATE_INVALID", { cause: slotValidation.code });
  }
  const guestIds = new Set();
  for (let index = 0; index < service.guests.length; index += 1) {
    const guest = service.guests[index];
    const validation = validateOrderGuest(guest, `service.guests[${index}]`);
    if (!validation.ok || guestIds.has(guest.guestId)) {
      return failure("DIRECT_SERVICE_STATE_INVALID", {
        cause: validation.code,
        guestId: guest.guestId,
        index,
      });
    }
    guestIds.add(guest.guestId);
  }
  const orderIds = new Set();
  for (let index = 0; index < service.orders.length; index += 1) {
    const order = service.orders[index];
    const validation = validateActiveOrder(order, `service.orders[${index}]`);
    if (!validation.ok || orderIds.has(order.orderId)) {
      return failure("DIRECT_SERVICE_STATE_INVALID", {
        cause: validation.code,
        orderId: order.orderId,
        index,
      });
    }
    orderIds.add(order.orderId);
    if (order.state !== ACTIVE_ORDER_STATE.ACTIVE) continue;
    const slot = saleSlots.slots.find((candidate) => candidate.saleSlotId === order.saleSlotId);
    const guest = service.guests.find((candidate) => candidate.guestId === order.guestId);
    if (!slot || slot.state !== SALE_SLOT_STATE.ASSIGNED || slot.activeOrderId !== order.orderId ||
        slot.recipeId !== order.recipeId || guest?.state !== ORDER_GUEST_STATE.ORDERING) {
      return failure("DIRECT_SERVICE_STATE_INVALID", {
        orderId: order.orderId,
        reason: "ACTIVE_ORDER_LINK_MISMATCH",
      });
    }
  }
  for (const slot of saleSlots.slots.filter((candidate) => candidate.state === SALE_SLOT_STATE.ASSIGNED)) {
    const order = service.orders.find((candidate) => candidate.orderId === slot.activeOrderId);
    if (!order || order.state !== ACTIVE_ORDER_STATE.ACTIVE || order.saleSlotId !== slot.saleSlotId) {
      return failure("DIRECT_SERVICE_STATE_INVALID", {
        saleSlotId: slot.saleSlotId,
        reason: "ORPHAN_ASSIGNED_SLOT",
      });
    }
  }
  return validationSuccess();
}

/**
 * Cross-slice service invariant. Inventory owns dish/escrow accounting; Service stores the exact
 * presentation mirror and the singular carried overlay reference.
 */
export function validateDirectServiceState({
  runtimePhase,
  service,
  saleSlots,
  inventory,
} = {}) {
  const timerValidation = validateServiceTimerState(service, { runtimePhase });
  if (!timerValidation.ok) {
    return failure("DIRECT_SERVICE_STATE_INVALID", { cause: timerValidation.code });
  }
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) {
    return failure("DIRECT_SERVICE_INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  }
  const links = validateOrderLinks(service, saleSlots);
  if (!links.ok) return links;
  if (!equivalent(service.completedDishes, inventory.completedDishes)) {
    return failure("CARRIED_DISH_REFERENCE_MISMATCH", { reason: "DISH_MIRROR_MISMATCH" });
  }
  const carried = inventory.completedDishes.filter(
    (dish) => dish.state === COMPLETED_DISH_STATE.CARRIED,
  );
  if (carried.length > 1 || (service.carriedDishId === null) !== (carried.length === 0) ||
      (carried.length === 1 && carried[0].dishId !== service.carriedDishId)) {
    return failure("CARRIED_DISH_REFERENCE_MISMATCH", {
      carriedDishId: service.carriedDishId,
      inventoryCarriedDishIds: carried.map((dish) => dish.dishId),
    });
  }
  if (service.timingCook === null) {
    return inventory.cookEscrows.length === 0
      ? validationSuccess()
      : failure("ORPHAN_COOK_ESCROW", { escrowCount: inventory.cookEscrows.length });
  }
  const timingValidation = validateTimingCook(service.timingCook);
  if (!timingValidation.ok) {
    return failure("DIRECT_SERVICE_STATE_INVALID", { cause: timingValidation.code });
  }
  if (service.timingCook.state === TIMING_COOK_STATE.RUNNING_ESCROW) {
    const matching = inventory.cookEscrows.filter(
      (escrow) => escrow.escrowId === service.timingCook.escrowId,
    );
    if (inventory.cookEscrows.length !== 1 || matching.length !== 1 ||
        !equivalent(matching[0].lines, service.timingCook.escrow)) {
      return failure("ORPHAN_COOK_ESCROW", {
        timingEscrowId: service.timingCook.escrowId,
        inventoryEscrowIds: inventory.cookEscrows.map((escrow) => escrow.escrowId),
      });
    }
  } else if (inventory.cookEscrows.length !== 0) {
    return failure("ORPHAN_COOK_ESCROW", { escrowCount: inventory.cookEscrows.length });
  }
  return validationSuccess();
}

function requireRunningService(context) {
  if (context.runtimePhase !== RUNTIME_PHASE.SERVICE ||
      context.service.lifecycle !== SERVICE_LIFECYCLE.RUNNING ||
      context.service.resultsClosed || context.service.remainingMs <= 0) {
    return failure("DIRECT_SERVICE_REQUIRES_RUNNING_SERVICE", {
      runtimePhase: context.runtimePhase,
      lifecycle: context.service?.lifecycle,
      resultsClosed: context.service?.resultsClosed,
      remainingMs: context.service?.remainingMs,
    });
  }
  return validationSuccess();
}

function requireTimerZeroCleanup(context) {
  if (context.runtimePhase !== RUNTIME_PHASE.SERVICE ||
      context.service.lifecycle !== SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP ||
      !context.service.resultsClosed || context.service.remainingMs !== 0) {
    return failure("DIRECT_SERVICE_REQUIRES_TIMER_ZERO_CLEANUP", {
      runtimePhase: context.runtimePhase,
      lifecycle: context.service?.lifecycle,
      resultsClosed: context.service?.resultsClosed,
      remainingMs: context.service?.remainingMs,
    });
  }
  return validationSuccess();
}

function validateInventoryAccounting(inventory, accounting) {
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) {
    return failure("DIRECT_SERVICE_INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  }
  const accountingValidation = validateInventoryAccountingState(accounting);
  if (!accountingValidation.ok) {
    return failure("DIRECT_SERVICE_ACCOUNTING_STATE_INVALID", { cause: accountingValidation.code });
  }
  const reconciliation = reconcileInventoryAccounting(inventory, accounting);
  if (!reconciliation.ok) {
    return failure("DIRECT_SERVICE_RECONCILIATION_FAILED", {
      cause: reconciliation.code,
      reconciliation,
    });
  }
  return validationSuccess();
}

function validateAppendOnlyAccounting(before, after) {
  const appendOnly = validateCostMovementAppendOnly(before.inventoryAccounting, after.inventoryAccounting);
  if (!appendOnly.ok) return appendOnly;
  return validateInventoryAccounting(after.inventory, after.inventoryAccounting);
}

function allocateIds({ idCounters, campaign, generationId }, kinds) {
  const campaignValidation = validateCampaignIdentity(campaign);
  if (!campaignValidation.ok) return campaignValidation;
  if (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== "string")) {
    return failure("DIRECT_SERVICE_ID_STATE_INVALID");
  }
  try {
    const ids = IdService.fromState(idCounters);
    if (ids.campaignId !== campaign.campaignId || ids.day !== campaign.day ||
        ids.generationId !== generationId) {
      return failure("DIRECT_SERVICE_ID_STATE_MISMATCH");
    }
    const allocated = {};
    for (const descriptor of kinds) {
      const [field, kind] = descriptor.split(":");
      allocated[field] = ids.next(kind, { day: campaign.day });
    }
    return success({ ...allocated, idCounters: ids.snapshot() });
  } catch (error) {
    return failure(error?.code ?? "DIRECT_SERVICE_ID_STATE_INVALID");
  }
}

function findCarriedDish(service, inventory) {
  if (!isStableIdentifier(service.carriedDishId)) {
    return failure("CARRIED_DISH_NOT_FOUND", { carriedDishId: service.carriedDishId });
  }
  const dish = inventory.completedDishes.find(
    (candidate) => candidate.dishId === service.carriedDishId,
  );
  if (!dish || dish.state !== COMPLETED_DISH_STATE.CARRIED) {
    return failure("CARRIED_DISH_REFERENCE_MISMATCH", {
      carriedDishId: service.carriedDishId,
      state: dish?.state,
    });
  }
  return success({ dish });
}

function findActiveTargetOrder(service, targetOrderId) {
  const order = service.orders.find((candidate) => candidate.orderId === targetOrderId);
  if (!order) return failure("TARGET_ORDER_NOT_FOUND", { targetOrderId });
  if (order.state !== ACTIVE_ORDER_STATE.ACTIVE) {
    return failure("TARGET_ORDER_NOT_ACTIVE", { targetOrderId, state: order.state });
  }
  const guest = service.guests.find((candidate) => candidate.guestId === order.guestId);
  if (!guest || guest.state !== ORDER_GUEST_STATE.ORDERING) {
    return failure("TARGET_ORDER_GUEST_INVALID", {
      targetOrderId,
      guestId: order.guestId,
      guestState: guest?.state,
    });
  }
  return success({ order, guest });
}

function configuredMenuEntry(menu, recipeId) {
  const entry = menu.confirmedEntries.find((candidate) => candidate.recipeId === recipeId);
  if (!entry || !entry.enabled || entry.plannedQuantity <= 0) {
    return failure("RECIPE_NOT_ON_CONFIRMED_MENU", { recipeId });
  }
  if (!Number.isSafeInteger(entry.priceG) || entry.priceG <= 0) {
    return failure("SALE_PRICE_INVALID", { recipeId, priceG: entry.priceG });
  }
  return success({ entry });
}

function validateStartPayload(payload) {
  if (!isPlainRecord(payload) || !isStableIdentifier(payload.recipeId) ||
      !isStableIdentifier(payload.saleSlotId) ||
      !(payload.sourceOrderId === null || isStableIdentifier(payload.sourceOrderId)) ||
      !Object.values(COOK_TRIGGER).includes(payload.trigger)) {
    return failure("INVALID_DIRECT_SERVICE_PAYLOAD", { command: DIRECT_SERVICE_COMMAND.START_COOK });
  }
  return validationSuccess();
}

function validateCompletePayload(payload) {
  if (!isPlainRecord(payload) || !own(payload, "inputAtMs") ||
      !(payload.inputAtMs === null ||
        (Number.isSafeInteger(payload.inputAtMs) && payload.inputAtMs >= 0))) {
    return failure("INVALID_DIRECT_SERVICE_PAYLOAD", { command: DIRECT_SERVICE_COMMAND.COMPLETE_COOK });
  }
  return validationSuccess();
}

function validateEmptyPayload(payload, command) {
  return isPlainRecord(payload) && Object.keys(payload).length === 0
    ? validationSuccess()
    : failure("INVALID_DIRECT_SERVICE_PAYLOAD", { command });
}

function validateTargetOrderPayload(payload) {
  return isPlainRecord(payload) && isStableIdentifier(payload.targetOrderId)
    ? validationSuccess()
    : failure("INVALID_DIRECT_SERVICE_PAYLOAD", { command: DIRECT_SERVICE_COMMAND.SERVE });
}

function validateWastePayload(payload) {
  return isPlainRecord(payload) && isStableIdentifier(payload.dishId)
    ? validationSuccess()
    : failure("INVALID_DIRECT_SERVICE_PAYLOAD", {
      command: DIRECT_SERVICE_COMMAND.WASTE_CARRIED_DISH,
    });
}

/** Pure StartCook planner: reservation-first, then unreserved `(acquiredDay, lotId)` FIFO. */
export function planCookStart(context, payload) {
  const payloadValidation = validateStartPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  const running = requireRunningService(context);
  if (!running.ok) return running;
  const menuValidation = validateMenuAndRecipes(context.menu, context.recipes);
  if (!menuValidation.ok) return menuValidation;
  const campaignValidation = validateCampaignIdentity(context.campaign);
  if (!campaignValidation.ok) return campaignValidation;
  const eventValidation = validateEventState(context.events);
  if (!eventValidation.ok) {
    return failure("DIRECT_SERVICE_EVENT_STATE_INVALID", { cause: eventValidation.code });
  }
  const facilityValidation = validateFacilityState(context.facilities);
  if (!facilityValidation.ok) {
    return failure("DIRECT_SERVICE_FACILITY_STATE_INVALID", { cause: facilityValidation.code });
  }
  const directValidation = validateDirectServiceState(context);
  if (!directValidation.ok) return directValidation;
  const accountingValidation = validateInventoryAccounting(
    context.inventory,
    context.inventoryAccounting,
  );
  if (!accountingValidation.ok) return accountingValidation;
  if (context.service.carriedDishId !== null) {
    return failure("CARRIED_DISH_ALREADY_EXISTS", {
      carriedDishId: context.service.carriedDishId,
    });
  }
  if (context.service.timingCook?.state === TIMING_COOK_STATE.RUNNING_ESCROW) {
    return failure("COOK_ALREADY_RUNNING", { cookId: context.service.timingCook.cookId });
  }
  const recipe = getRecipeDefinition(context.recipes, payload.recipeId);
  if (!recipe) return failure("RECIPE_NOT_FOUND", { recipeId: payload.recipeId });
  const menuEntry = configuredMenuEntry(context.menu, payload.recipeId);
  if (!menuEntry.ok) return menuEntry;
  const slot = context.saleSlots.slots.find(
    (candidate) => candidate.saleSlotId === payload.saleSlotId,
  );
  if (!slot) return failure("SALE_SLOT_NOT_FOUND", { saleSlotId: payload.saleSlotId });
  if (slot.recipeId !== payload.recipeId) {
    return failure("SALE_SLOT_RECIPE_MISMATCH", {
      saleSlotId: slot.saleSlotId,
      slotRecipeId: slot.recipeId,
      recipeId: payload.recipeId,
    });
  }
  if (slot.state === SALE_SLOT_STATE.SOLD) {
    return failure("SALE_SLOT_NOT_COOKABLE", { saleSlotId: slot.saleSlotId, state: slot.state });
  }
  if (slot.state === SALE_SLOT_STATE.ASSIGNED && payload.sourceOrderId === null) {
    return failure("SOURCE_ORDER_REQUIRED_FOR_ASSIGNED_SLOT", { saleSlotId: slot.saleSlotId });
  }
  if (slot.state === SALE_SLOT_STATE.AVAILABLE && payload.sourceOrderId !== null) {
    return failure("SOURCE_ORDER_LINK_MISMATCH", { saleSlotId: slot.saleSlotId });
  }
  if (payload.sourceOrderId !== null) {
    const sourceOrder = context.service.orders.find(
      (candidate) => candidate.orderId === payload.sourceOrderId,
    );
    if (!sourceOrder) return failure("SOURCE_ORDER_NOT_FOUND", { sourceOrderId: payload.sourceOrderId });
    if (sourceOrder.state !== ACTIVE_ORDER_STATE.ACTIVE) {
      return failure("SOURCE_ORDER_NOT_ACTIVE", {
        sourceOrderId: sourceOrder.orderId,
        state: sourceOrder.state,
      });
    }
    if (sourceOrder.saleSlotId !== slot.saleSlotId || sourceOrder.recipeId !== payload.recipeId ||
        slot.activeOrderId !== sourceOrder.orderId) {
      return failure("SOURCE_ORDER_LINK_MISMATCH", { sourceOrderId: sourceOrder.orderId });
    }
  }

  const ids = allocateIds(context, ["cookId:cook", "movementId:tx", "causeId:cause"]);
  if (!ids.ok) return ids;
  const inventory = cloneValue(context.inventory);
  const inventoryAccounting = cloneValue(context.inventoryAccounting);
  const escrowed = applyIngredientsToEscrowDraft(inventory, inventoryAccounting, {
    movementId: ids.plan.movementId,
    day: context.campaign.day,
    causeId: ids.plan.causeId,
    escrowId: ids.plan.cookId,
    recipeId: recipe.recipeId,
    saleSlotId: slot.saleSlotId,
    requirements: recipe.ingredientRequirements,
  });
  if (!escrowed.ok) return escrowed;
  let timingWindowBonusMs;
  let timingCook;
  try {
    timingWindowBonusMs = calculateTimingWindowBonusMs({
      facilities: context.facilities,
      events: context.events,
      campaignDay: context.campaign.day,
    });
    timingCook = createTimingCook({
      cookId: ids.plan.cookId,
      escrowId: escrowed.plan.escrow.escrowId,
      sourceOrderId: payload.sourceOrderId,
      sourceSaleSlotId: slot.saleSlotId,
      recipeId: recipe.recipeId,
      causeId: ids.plan.causeId,
      trigger: payload.trigger,
      escrow: escrowed.plan.escrow.lines,
      totalBookCostG: escrowed.plan.escrow.totalBookCostG,
      quality: escrowed.plan.escrow.quality,
      startedAtMs: context.issuedAtSimulationMs,
      timing: recipe.timing,
      timingWindowBonusMs,
    });
  } catch (error) {
    return failure(error?.code ?? "DIRECT_SERVICE_COMPOSITION_FAILED", error?.details);
  }
  const service = cloneValue(context.service);
  service.timingCook = timingCook;
  service.completedDishes = cloneValue(inventory.completedDishes);
  const after = {
    runtimePhase: context.runtimePhase,
    service,
    saleSlots: context.saleSlots,
    inventory,
  };
  const directAfter = validateDirectServiceState(after);
  if (!directAfter.ok) return directAfter;
  const appendOnly = validateCostMovementAppendOnly(
    context.inventoryAccounting,
    inventoryAccounting,
  );
  if (!appendOnly.ok) return appendOnly;
  const reconciliation = validateInventoryAccounting(inventory, inventoryAccounting);
  if (!reconciliation.ok) return reconciliation;
  const menuReconciliation = validateMenuPlanReconciliation(
    context.menu,
    context.recipes,
    context.saleSlots,
    inventory,
    { requireFullReservations: false },
  );
  if (!menuReconciliation.ok) return menuReconciliation;
  return success({
    outcome: DIRECT_SERVICE_OUTCOME.COOK_STARTED,
    inventory,
    inventoryAccounting,
    service,
    idCounters: ids.plan.idCounters,
    timingCook,
    escrow: escrowed.plan.escrow,
    movementId: ids.plan.movementId,
    event: {
      type: "direct-service.cook-started",
      payload: {
        cookId: timingCook.cookId,
        recipeId: timingCook.recipeId,
        sourceOrderId: timingCook.sourceOrderId,
        sourceSaleSlotId: timingCook.sourceSaleSlotId,
        trigger: timingCook.trigger,
        quality: timingCook.quality,
        totalBookCostG: timingCook.totalBookCostG,
        targetAtMs: timingCook.targetAtMs,
        failureAtMs: timingCook.failureAtMs,
      },
    },
  });
}

/** Pure completion planner for SUCCESS/NORMAL dish or normal FAILURE Waste. */
export function planCookCompletion(context, payload) {
  const payloadValidation = validateCompletePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  const running = requireRunningService(context);
  if (!running.ok) return running;
  const directValidation = validateDirectServiceState(context);
  if (!directValidation.ok) return directValidation;
  const accountingValidation = validateInventoryAccounting(
    context.inventory,
    context.inventoryAccounting,
  );
  if (!accountingValidation.ok) return accountingValidation;
  const timingCook = context.service.timingCook;
  if (!timingCook || timingCook.state !== TIMING_COOK_STATE.RUNNING_ESCROW) {
    return failure("TIMING_COOK_NOT_FOUND", { state: timingCook?.state });
  }
  const judged = judgeTimingCook(timingCook, {
    inputAtMs: payload.inputAtMs,
    observedAtMs: context.issuedAtSimulationMs,
  });
  if (!judged.ok) return judged;
  const producesDish = judged.plan.judgment !== COOK_JUDGMENT.FAILURE;
  const idDescriptors = producesDish
    ? ["movementId:tx", "dishId:dish"]
    : ["movementId:tx"];
  const ids = allocateIds(context, idDescriptors);
  if (!ids.ok) return ids;
  const inventory = cloneValue(context.inventory);
  const inventoryAccounting = cloneValue(context.inventoryAccounting);
  const movement = {
    movementId: ids.plan.movementId,
    day: context.campaign.day,
    causeId: timingCook.causeId,
    escrowId: timingCook.escrowId,
  };
  const destination = producesDish
    ? applyEscrowToDishDraft(inventory, inventoryAccounting, {
      ...movement,
      dishId: ids.plan.dishId,
      quality: judged.plan.outputQuality,
      createdOrderId: timingCook.sourceOrderId,
    })
    : applyEscrowToWasteDraft(inventory, inventoryAccounting, movement);
  if (!destination.ok) return destination;
  const completed = completeTimingCook(timingCook, {
    inputAtMs: payload.inputAtMs,
    observedAtMs: context.issuedAtSimulationMs,
    resultDishId: producesDish ? ids.plan.dishId : null,
  });
  if (!completed.ok) return completed;
  const service = cloneValue(context.service);
  service.timingCook = completed.plan.timingCook;
  service.completedDishes = cloneValue(inventory.completedDishes);
  service.carriedDishId = producesDish ? ids.plan.dishId : null;
  const directAfter = validateDirectServiceState({
    runtimePhase: context.runtimePhase,
    service,
    saleSlots: context.saleSlots,
    inventory,
  });
  if (!directAfter.ok) return directAfter;
  const appendOnly = validateCostMovementAppendOnly(
    context.inventoryAccounting,
    inventoryAccounting,
  );
  if (!appendOnly.ok) return appendOnly;
  const reconciliation = validateInventoryAccounting(inventory, inventoryAccounting);
  if (!reconciliation.ok) return reconciliation;
  const outcome = producesDish
    ? DIRECT_SERVICE_OUTCOME.DISH_COMPLETED
    : DIRECT_SERVICE_OUTCOME.COOK_FAILED;
  return success({
    outcome,
    inventory,
    inventoryAccounting,
    service,
    idCounters: ids.plan.idCounters,
    timingCook: completed.plan.timingCook,
    dish: producesDish ? destination.plan.dish : null,
    movementId: ids.plan.movementId,
    judgment: judged.plan.judgment,
    event: {
      type: producesDish ? "direct-service.cook-completed" : "direct-service.cook-failed",
      payload: {
        cookId: timingCook.cookId,
        recipeId: timingCook.recipeId,
        judgment: judged.plan.judgment,
        inputAtMs: judged.plan.inputAtMs,
        completedAtMs: judged.plan.completedAtMs,
        dishId: producesDish ? ids.plan.dishId : null,
        outputQuality: judged.plan.outputQuality,
        totalBookCostG: timingCook.totalBookCostG,
      },
    },
  });
}

/** Timer-zero rollback planner. It restores every source lot/reservation line and Book_Cost. */
export function planCookCancellationAtZero(context, payload = {}) {
  const payloadValidation = validateEmptyPayload(payload, DIRECT_SERVICE_COMMAND.CANCEL_COOK_AT_ZERO);
  if (!payloadValidation.ok) return payloadValidation;
  const cleanup = requireTimerZeroCleanup(context);
  if (!cleanup.ok) return cleanup;
  const directValidation = validateDirectServiceState(context);
  if (!directValidation.ok) return directValidation;
  const accountingValidation = validateInventoryAccounting(
    context.inventory,
    context.inventoryAccounting,
  );
  if (!accountingValidation.ok) return accountingValidation;
  const timingCook = context.service.timingCook;
  if (!timingCook || timingCook.state !== TIMING_COOK_STATE.RUNNING_ESCROW) {
    return failure("TIMING_COOK_NOT_FOUND", { state: timingCook?.state });
  }
  const ids = allocateIds(context, ["movementId:tx"]);
  if (!ids.ok) return ids;
  const inventory = cloneValue(context.inventory);
  const inventoryAccounting = cloneValue(context.inventoryAccounting);
  const restored = applyEscrowRestoreToDraft(inventory, inventoryAccounting, {
    movementId: ids.plan.movementId,
    day: context.campaign.day,
    causeId: timingCook.causeId,
    escrowId: timingCook.escrowId,
  });
  if (!restored.ok) return restored;
  const cancelled = cancelTimingCookAtZero(timingCook, {
    cancelledAtMs: context.issuedAtSimulationMs,
  });
  if (!cancelled.ok) return cancelled;
  const service = cloneValue(context.service);
  service.timingCook = cancelled.plan.timingCook;
  service.completedDishes = cloneValue(inventory.completedDishes);
  service.carriedDishId = null;
  const directAfter = validateDirectServiceState({
    runtimePhase: context.runtimePhase,
    service,
    saleSlots: context.saleSlots,
    inventory,
  });
  if (!directAfter.ok) return directAfter;
  const appendOnly = validateCostMovementAppendOnly(
    context.inventoryAccounting,
    inventoryAccounting,
  );
  if (!appendOnly.ok) return appendOnly;
  const reconciliation = validateInventoryAccounting(inventory, inventoryAccounting);
  if (!reconciliation.ok) return reconciliation;
  return success({
    outcome: DIRECT_SERVICE_OUTCOME.COOK_CANCELLED_RESTORED,
    inventory,
    inventoryAccounting,
    service,
    idCounters: ids.plan.idCounters,
    timingCook: cancelled.plan.timingCook,
    restoredEscrow: restored.plan.restoredEscrow,
    movementId: ids.plan.movementId,
    event: {
      type: "direct-service.cook-cancelled-restored",
      payload: {
        cookId: timingCook.cookId,
        escrowId: timingCook.escrowId,
        movementId: ids.plan.movementId,
        restoredBookCostG: timingCook.totalBookCostG,
        cancelledAtMs: context.issuedAtSimulationMs,
      },
    },
  });
}

/** Matching Recipe sale planner. Every result-affecting slice is returned for one commit. */
export function planMatchingSale(context, payload, configuration = {}) {
  let config;
  try {
    config = normalizeConfiguration(configuration);
  } catch (error) {
    return failure(error.code ?? "INVALID_DIRECT_SERVICE_CONFIGURATION", error.details);
  }
  const payloadValidation = validateTargetOrderPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  const running = requireRunningService(context);
  if (!running.ok) return running;
  const menuValidation = validateMenuAndRecipes(context.menu, context.recipes);
  if (!menuValidation.ok) return menuValidation;
  const directValidation = validateDirectServiceState(context);
  if (!directValidation.ok) return directValidation;
  const accountingValidation = validateInventoryAccounting(
    context.inventory,
    context.inventoryAccounting,
  );
  if (!accountingValidation.ok) return accountingValidation;
  const economyValidation = validateEconomyState(context.economy);
  if (!economyValidation.ok) {
    return failure("DIRECT_SERVICE_ECONOMY_STATE_INVALID", { cause: economyValidation.code });
  }
  const campaignValidation = validateReputationCampaignState(context.campaign);
  if (!campaignValidation.ok) {
    return failure("DIRECT_SERVICE_CAMPAIGN_STATE_INVALID", { cause: campaignValidation.code });
  }
  const progressionValidation = validateProgressionState(context.progression);
  if (!progressionValidation.ok) {
    return failure("DIRECT_SERVICE_PROGRESSION_STATE_INVALID", { cause: progressionValidation.code });
  }
  const salesValidation = validateSalesState(context.sales);
  if (!salesValidation.ok || context.sales.day !== context.campaign.day) {
    return failure("DIRECT_SERVICE_SALES_STATE_INVALID", {
      cause: salesValidation.code,
      salesDay: context.sales?.day,
      campaignDay: context.campaign?.day,
    });
  }
  const carried = findCarriedDish(context.service, context.inventory);
  if (!carried.ok) return carried;
  const target = findActiveTargetOrder(context.service, payload.targetOrderId);
  if (!target.ok) return target;
  if (carried.plan.dish.recipeId !== target.plan.order.recipeId) {
    return failure("SERVE_RECIPE_MISMATCH", {
      dishRecipeId: carried.plan.dish.recipeId,
      orderRecipeId: target.plan.order.recipeId,
    });
  }
  const menuEntry = configuredMenuEntry(context.menu, target.plan.order.recipeId);
  if (!menuEntry.ok) return menuEntry;
  const timingCook = context.service.timingCook;
  if (!timingCook || timingCook.state !== TIMING_COOK_STATE.COMPLETED_DISH ||
      timingCook.resultDishId !== carried.plan.dish.dishId ||
      ![COOK_JUDGMENT.SUCCESS, COOK_JUDGMENT.NORMAL].includes(timingCook.judgment)) {
    return failure("SALE_TIMING_RESULT_INVALID", {
      dishId: carried.plan.dish.dishId,
      timingCookState: timingCook?.state,
      timingDishId: timingCook?.resultDishId,
    });
  }
  const ids = allocateIds(context, ["saleId:tx", "cogsMovementId:tx", "causeId:cause"]);
  if (!ids.ok) return ids;

  const service = cloneValue(context.service);
  const saleSlots = cloneValue(context.saleSlots);
  const inventory = cloneValue(context.inventory);
  const inventoryAccounting = cloneValue(context.inventoryAccounting);
  const economy = cloneValue(context.economy);
  const campaign = cloneValue(context.campaign);
  const progression = cloneValue(context.progression);
  const sales = cloneValue(context.sales);

  const cash = applyCashTransactionToDraft(economy, {
    transactionId: ids.plan.saleId,
    day: campaign.day,
    category: LEDGER_CATEGORY.SALE,
    type: LEDGER_TYPE.SALE_REVENUE,
    direction: LEDGER_DIRECTION.INFLOW,
    amountG: menuEntry.plan.entry.priceG,
    causeId: ids.plan.causeId,
  }, RUNTIME_PHASE.SERVICE);
  if (!cash.ok) return cash;
  const cogs = applyDishToCogsDraft(inventory, inventoryAccounting, {
    movementId: ids.plan.cogsMovementId,
    day: campaign.day,
    causeId: ids.plan.causeId,
    dishId: carried.plan.dish.dishId,
  });
  if (!cogs.ok) return cogs;
  const soldSlot = applySaleSlotSoldToDraft(saleSlots, inventory, {
    saleSlotId: target.plan.order.saleSlotId,
    orderId: target.plan.order.orderId,
  });
  if (!soldSlot.ok) return soldSlot;

  const order = service.orders.find((candidate) => candidate.orderId === target.plan.order.orderId);
  const guest = service.guests.find((candidate) => candidate.guestId === target.plan.order.guestId);
  order.state = ACTIVE_ORDER_STATE.COMPLETED;
  guest.state = ORDER_GUEST_STATE.MEAL_REACTION;
  guest.reaction = {
    kind: ORDER_REACTION_KIND.SUCCESS,
    elapsedMs: 0,
    durationMs: config.reactionDurationMs,
  };
  const reputation = applyReputationCauseToDraft(campaign, progression, {
    causeId: ids.plan.causeId,
    delta: config.saleReputationDelta,
  });
  if (!reputation.ok) return reputation;
  const saleRecord = {
    saleId: ids.plan.saleId,
    transactionId: ids.plan.saleId,
    cogsMovementId: ids.plan.cogsMovementId,
    causeId: ids.plan.causeId,
    day: campaign.day,
    orderId: order.orderId,
    guestId: order.guestId,
    recipeId: order.recipeId,
    dishId: carried.plan.dish.dishId,
    saleSlotId: order.saleSlotId,
    priceG: menuEntry.plan.entry.priceG,
    bookCostG: carried.plan.dish.bookCostG,
    quality: carried.plan.dish.quality,
    cookJudgment: timingCook.judgment,
    reputationDelta: reputation.plan.appliedDelta,
    committedAtMs: context.issuedAtSimulationMs,
  };
  const recorded = applySaleRecordToDraft(sales, saleRecord);
  if (!recorded.ok) return recorded;
  service.completedDishes = cloneValue(inventory.completedDishes);
  service.carriedDishId = null;

  const directAfter = validateDirectServiceState({
    runtimePhase: context.runtimePhase,
    service,
    saleSlots,
    inventory,
  });
  if (!directAfter.ok) return directAfter;
  const economyAfter = validateEconomyTransition(context.economy, economy);
  if (!economyAfter.ok) return economyAfter;
  const accountingAfter = validateCostMovementAppendOnly(
    context.inventoryAccounting,
    inventoryAccounting,
  );
  if (!accountingAfter.ok) return accountingAfter;
  const inventoryAfter = validateInventoryAccounting(inventory, inventoryAccounting);
  if (!inventoryAfter.ok) return inventoryAfter;
  const salesAfter = validateSalesAppendOnly(context.sales, sales);
  if (!salesAfter.ok) return salesAfter;
  const menuReconciliation = validateMenuPlanReconciliation(
    context.menu,
    context.recipes,
    saleSlots,
    inventory,
    { requireFullReservations: false },
  );
  if (!menuReconciliation.ok) return menuReconciliation;

  return success({
    outcome: DIRECT_SERVICE_OUTCOME.SALE_COMMITTED,
    service,
    saleSlots,
    inventory,
    inventoryAccounting,
    economy,
    campaign,
    progression,
    sales,
    idCounters: ids.plan.idCounters,
    sale: saleRecord,
    releasedReservations: soldSlot.plan.releasedReservations,
    event: {
      type: "direct-service.sale-committed",
      payload: {
        saleId: saleRecord.saleId,
        orderId: saleRecord.orderId,
        guestId: saleRecord.guestId,
        recipeId: saleRecord.recipeId,
        dishId: saleRecord.dishId,
        saleSlotId: saleRecord.saleSlotId,
        priceG: saleRecord.priceG,
        bookCostG: saleRecord.bookCostG,
        quality: saleRecord.quality,
        cookJudgment: saleRecord.cookJudgment,
        causeId: saleRecord.causeId,
        reputationDelta: saleRecord.reputationDelta,
      },
    },
  });
}

/** WrongServe planner. Only Service/order patience and an optional timeout slot release can change. */
export function planWrongServe(context, payload, configuration = {}) {
  let config;
  try {
    config = normalizeConfiguration(configuration);
  } catch (error) {
    return failure(error.code ?? "INVALID_DIRECT_SERVICE_CONFIGURATION", error.details);
  }
  const payloadValidation = validateTargetOrderPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  const running = requireRunningService(context);
  if (!running.ok) return running;
  const menuValidation = validateMenuAndRecipes(context.menu, context.recipes);
  if (!menuValidation.ok) return menuValidation;
  const directValidation = validateDirectServiceState(context);
  if (!directValidation.ok) return directValidation;
  const carried = findCarriedDish(context.service, context.inventory);
  if (!carried.ok) return carried;
  const target = findActiveTargetOrder(context.service, payload.targetOrderId);
  if (!target.ok) return target;
  if (carried.plan.dish.recipeId === target.plan.order.recipeId) {
    return failure("WRONG_SERVE_REQUIRES_MISMATCH", {
      recipeId: carried.plan.dish.recipeId,
      targetOrderId: target.plan.order.orderId,
    });
  }
  const serviceWithPenalty = cloneValue(context.service);
  const orderWithPenalty = serviceWithPenalty.orders.find(
    (candidate) => candidate.orderId === target.plan.order.orderId,
  );
  const reduced = orderWithPenalty.patienceRemainingMs - config.wrongServePenaltyMs;
  if (!Number.isSafeInteger(reduced)) {
    return failure("WRONG_SERVE_PENALTY_OVERFLOW", {
      patienceRemainingMs: orderWithPenalty.patienceRemainingMs,
      penaltyMs: config.wrongServePenaltyMs,
    });
  }
  orderWithPenalty.patienceRemainingMs = reduced;
  let service = serviceWithPenalty;
  let saleSlots = cloneValue(context.saleSlots);
  let outcome = DIRECT_SERVICE_OUTCOME.WRONG_SERVE;
  if (reduced <= 0) {
    const timedOut = planOrderTimeout({
      service: serviceWithPenalty,
      saleSlots,
      menu: context.menu,
      recipes: context.recipes,
      runtimePhase: context.runtimePhase,
    }, { orderId: target.plan.order.orderId }, {
      reactionDurationMs: config.reactionDurationMs,
    });
    if (!timedOut.ok) return timedOut;
    service = cloneValue(timedOut.plan.service);
    saleSlots = cloneValue(timedOut.plan.saleSlots);
    outcome = DIRECT_SERVICE_OUTCOME.WRONG_SERVE_TIMEOUT;
  }
  const directAfter = validateDirectServiceState({
    runtimePhase: context.runtimePhase,
    service,
    saleSlots,
    inventory: context.inventory,
  });
  if (!directAfter.ok) return directAfter;
  return success({
    outcome,
    service,
    saleSlots,
    targetOrderId: target.plan.order.orderId,
    previousPatienceMs: target.plan.order.patienceRemainingMs,
    patienceRemainingMs: reduced,
    timedOut: outcome === DIRECT_SERVICE_OUTCOME.WRONG_SERVE_TIMEOUT,
    event: {
      type: outcome === DIRECT_SERVICE_OUTCOME.WRONG_SERVE_TIMEOUT
        ? "direct-service.wrong-serve-timeout"
        : "direct-service.wrong-served",
      payload: {
        targetOrderId: target.plan.order.orderId,
        dishId: carried.plan.dish.dishId,
        dishRecipeId: carried.plan.dish.recipeId,
        orderRecipeId: target.plan.order.recipeId,
        penaltyMs: config.wrongServePenaltyMs,
        previousPatienceMs: target.plan.order.patienceRemainingMs,
        patienceRemainingMs: reduced,
        timedOut: outcome === DIRECT_SERVICE_OUTCOME.WRONG_SERVE_TIMEOUT,
      },
    },
  });
}

/** Explicit unserved carried-dish Waste planner; it clears the overlay in the same commit. */
export function planCarriedDishWaste(context, payload) {
  const payloadValidation = validateWastePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (context.runtimePhase !== RUNTIME_PHASE.SERVICE ||
      context.service.lifecycle === SERVICE_LIFECYCLE.INACTIVE) {
    return failure("DIRECT_SERVICE_STATE_INVALID", {
      runtimePhase: context.runtimePhase,
      lifecycle: context.service?.lifecycle,
    });
  }
  const directValidation = validateDirectServiceState(context);
  if (!directValidation.ok) return directValidation;
  const accountingValidation = validateInventoryAccounting(
    context.inventory,
    context.inventoryAccounting,
  );
  if (!accountingValidation.ok) return accountingValidation;
  const carried = findCarriedDish(context.service, context.inventory);
  if (!carried.ok) return carried;
  if (carried.plan.dish.dishId !== payload.dishId) {
    return failure("CARRIED_DISH_REFERENCE_MISMATCH", {
      expected: carried.plan.dish.dishId,
      actual: payload.dishId,
    });
  }
  const ids = allocateIds(context, ["movementId:tx", "causeId:cause"]);
  if (!ids.ok) return ids;
  const inventory = cloneValue(context.inventory);
  const inventoryAccounting = cloneValue(context.inventoryAccounting);
  const wasted = applyDishToWasteDraft(inventory, inventoryAccounting, {
    movementId: ids.plan.movementId,
    day: context.campaign.day,
    causeId: ids.plan.causeId,
    dishId: payload.dishId,
  });
  if (!wasted.ok) return wasted;
  const service = cloneValue(context.service);
  service.completedDishes = cloneValue(inventory.completedDishes);
  service.carriedDishId = null;
  const directAfter = validateDirectServiceState({
    runtimePhase: context.runtimePhase,
    service,
    saleSlots: context.saleSlots,
    inventory,
  });
  if (!directAfter.ok) return directAfter;
  const accountingAfter = validateCostMovementAppendOnly(
    context.inventoryAccounting,
    inventoryAccounting,
  );
  if (!accountingAfter.ok) return accountingAfter;
  const reconciliation = validateInventoryAccounting(inventory, inventoryAccounting);
  if (!reconciliation.ok) return reconciliation;
  return success({
    outcome: DIRECT_SERVICE_OUTCOME.DISH_WASTED,
    service,
    inventory,
    inventoryAccounting,
    idCounters: ids.plan.idCounters,
    dishId: payload.dishId,
    movementId: ids.plan.movementId,
    causeId: ids.plan.causeId,
    event: {
      type: "direct-service.dish-wasted",
      payload: {
        dishId: payload.dishId,
        recipeId: carried.plan.dish.recipeId,
        bookCostG: carried.plan.dish.bookCostG,
        movementId: ids.plan.movementId,
        causeId: ids.plan.causeId,
      },
    },
  });
}

function contextFrom(read, command, phase, generationId) {
  return {
    runtimePhase: phase,
    generationId,
    issuedAtSimulationMs: command.issuedAtSimulationMs,
    campaign: read("campaign"),
    service: read("service"),
    saleSlots: read("saleSlots"),
    inventory: read("inventory"),
    inventoryAccounting: read("inventoryAccounting"),
    idCounters: read("idCounters"),
    ...(typeof read("menu") === "undefined" ? {} : { menu: read("menu") }),
  };
}

function replacePlannedSlices(draft, plan, writeSet) {
  for (const slice of writeSet) draft.replace(slice, plan[slice]);
  return validationSuccess();
}

function comparePlannedSlices(after, plan, writeSet) {
  for (const slice of writeSet) {
    if (!equivalent(after[slice], plan[slice])) {
      return failure("DIRECT_SERVICE_POSTCONDITION_FAILED", { slice });
    }
  }
  return validationSuccess();
}

function createStartCookAtomicTransaction() {
  return defineAtomicTransaction({
    name: DIRECT_SERVICE_COMMAND.START_COOK,
    readSet: START_COOK_READ_SET,
    writeSet: START_COOK_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateStartPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planCookStart({
        runtimePhase: ctx.phase,
        generationId: ctx.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
        campaign: ctx.read("campaign"),
        recipes: ctx.read("recipes"),
        menu: ctx.read("menu"),
        saleSlots: ctx.read("saleSlots"),
        facilities: ctx.read("facilities"),
        events: ctx.read("events"),
        inventory: ctx.read("inventory"),
        inventoryAccounting: ctx.read("inventoryAccounting"),
        service: ctx.read("service"),
        idCounters: ctx.read("idCounters"),
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planCookStart({
        runtimePhase: RUNTIME_PHASE.SERVICE,
        generationId: draft.command.generationId,
        issuedAtSimulationMs: draft.command.issuedAtSimulationMs,
        campaign: draft.read("campaign"),
        recipes: draft.read("recipes"),
        menu: draft.read("menu"),
        saleSlots: draft.read("saleSlots"),
        facilities: draft.read("facilities"),
        events: draft.read("events"),
        inventory: draft.read("inventory"),
        inventoryAccounting: draft.read("inventoryAccounting"),
        service: draft.read("service"),
        idCounters: draft.read("idCounters"),
      }, draft.command.payload);
      return planned.ok ? replacePlannedSlices(draft, planned.plan, START_COOK_WRITE_SET) : planned;
    },
    postconditions(before, after, ctx) {
      const planned = planCookStart({
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
        campaign: before.campaign,
        recipes: before.recipes,
        menu: before.menu,
        saleSlots: before.saleSlots,
        facilities: before.facilities,
        events: before.events,
        inventory: before.inventory,
        inventoryAccounting: before.inventoryAccounting,
        service: before.service,
        idCounters: before.idCounters,
      }, ctx.command.payload);
      return planned.ok ? comparePlannedSlices(after, planned.plan, START_COOK_WRITE_SET) : planned;
    },
    events(before, _after, ctx) {
      const planned = planCookStart({
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
        campaign: before.campaign,
        recipes: before.recipes,
        menu: before.menu,
        saleSlots: before.saleSlots,
        facilities: before.facilities,
        events: before.events,
        inventory: before.inventory,
        inventoryAccounting: before.inventoryAccounting,
        service: before.service,
        idCounters: before.idCounters,
      }, ctx.command.payload);
      return planned.ok ? [planned.plan.event] : [];
    },
  });
}

function completeContext(source, command, phase, generationId) {
  return {
    runtimePhase: phase,
    generationId,
    issuedAtSimulationMs: command.issuedAtSimulationMs,
    campaign: source("campaign"),
    service: source("service"),
    saleSlots: source("saleSlots"),
    inventory: source("inventory"),
    inventoryAccounting: source("inventoryAccounting"),
    idCounters: source("idCounters"),
  };
}

function createCompleteCookAtomicTransaction() {
  return defineAtomicTransaction({
    name: DIRECT_SERVICE_COMMAND.COMPLETE_COOK,
    readSet: COMPLETE_COOK_READ_SET,
    writeSet: COMPLETE_COOK_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateCompletePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planCookCompletion(completeContext(
        (slice) => ctx.read(slice), ctx.command, ctx.phase, ctx.generationId,
      ), ctx.command.payload);
    },
    mutate(draft) {
      const planned = planCookCompletion(completeContext(
        (slice) => draft.read(slice), draft.command, RUNTIME_PHASE.SERVICE,
        draft.command.generationId,
      ), draft.command.payload);
      return planned.ok ? replacePlannedSlices(draft, planned.plan, COMPLETE_COOK_WRITE_SET) : planned;
    },
    postconditions(before, after, ctx) {
      const planned = planCookCompletion(completeContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload);
      return planned.ok ? comparePlannedSlices(after, planned.plan, COMPLETE_COOK_WRITE_SET) : planned;
    },
    events(before, _after, ctx) {
      const planned = planCookCompletion(completeContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload);
      return planned.ok ? [planned.plan.event] : [];
    },
  });
}

function createCancelCookAtomicTransaction() {
  return defineAtomicTransaction({
    name: DIRECT_SERVICE_COMMAND.CANCEL_COOK_AT_ZERO,
    readSet: CANCEL_COOK_READ_SET,
    writeSet: CANCEL_COOK_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateEmptyPayload(ctx.command.payload, DIRECT_SERVICE_COMMAND.CANCEL_COOK_AT_ZERO);
    },
    preflight(ctx) {
      return planCookCancellationAtZero(completeContext(
        (slice) => ctx.read(slice), ctx.command, ctx.phase, ctx.generationId,
      ), ctx.command.payload);
    },
    mutate(draft) {
      const planned = planCookCancellationAtZero(completeContext(
        (slice) => draft.read(slice), draft.command, RUNTIME_PHASE.SERVICE,
        draft.command.generationId,
      ), draft.command.payload);
      return planned.ok ? replacePlannedSlices(draft, planned.plan, CANCEL_COOK_WRITE_SET) : planned;
    },
    postconditions(before, after, ctx) {
      const planned = planCookCancellationAtZero(completeContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload);
      return planned.ok ? comparePlannedSlices(after, planned.plan, CANCEL_COOK_WRITE_SET) : planned;
    },
    events(before, _after, ctx) {
      const planned = planCookCancellationAtZero(completeContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload);
      return planned.ok ? [planned.plan.event] : [];
    },
  });
}

function saleContext(source, command, phase, generationId) {
  return {
    runtimePhase: phase,
    generationId,
    issuedAtSimulationMs: command.issuedAtSimulationMs,
    menu: source("menu"),
    recipes: source("recipes"),
    service: source("service"),
    saleSlots: source("saleSlots"),
    inventory: source("inventory"),
    inventoryAccounting: source("inventoryAccounting"),
    economy: source("economy"),
    campaign: source("campaign"),
    progression: source("progression"),
    sales: source("sales"),
    idCounters: source("idCounters"),
  };
}

function createCommitSaleAtomicTransaction(configuration) {
  return defineAtomicTransaction({
    name: DIRECT_SERVICE_COMMAND.SERVE,
    readSet: COMMIT_SALE_READ_SET,
    writeSet: COMMIT_SALE_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateTargetOrderPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planMatchingSale(saleContext(
        (slice) => ctx.read(slice), ctx.command, ctx.phase, ctx.generationId,
      ), ctx.command.payload, configuration);
    },
    mutate(draft) {
      const planned = planMatchingSale(saleContext(
        (slice) => draft.read(slice), draft.command, RUNTIME_PHASE.SERVICE,
        draft.command.generationId,
      ), draft.command.payload, configuration);
      return planned.ok ? replacePlannedSlices(draft, planned.plan, COMMIT_SALE_WRITE_SET) : planned;
    },
    postconditions(before, after, ctx) {
      const planned = planMatchingSale(saleContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload, configuration);
      return planned.ok ? comparePlannedSlices(after, planned.plan, COMMIT_SALE_WRITE_SET) : planned;
    },
    events(before, _after, ctx) {
      const planned = planMatchingSale(saleContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload, configuration);
      return planned.ok ? [planned.plan.event] : [];
    },
  });
}

function wrongServeContext(source, command, phase, generationId) {
  return {
    runtimePhase: phase,
    generationId,
    issuedAtSimulationMs: command.issuedAtSimulationMs,
    menu: source("menu"),
    recipes: source("recipes"),
    service: source("service"),
    saleSlots: source("saleSlots"),
    inventory: source("inventory"),
  };
}

function createWrongServeAtomicTransaction(configuration) {
  return defineAtomicTransaction({
    name: DIRECT_SERVICE_COMMAND.WRONG_SERVE,
    readSet: WRONG_SERVE_READ_SET,
    writeSet: WRONG_SERVE_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateTargetOrderPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planWrongServe(wrongServeContext(
        (slice) => ctx.read(slice), ctx.command, ctx.phase, ctx.generationId,
      ), ctx.command.payload, configuration);
    },
    mutate(draft) {
      const planned = planWrongServe(wrongServeContext(
        (slice) => draft.read(slice), draft.command, RUNTIME_PHASE.SERVICE,
        draft.command.generationId,
      ), draft.command.payload, configuration);
      return planned.ok ? replacePlannedSlices(draft, planned.plan, WRONG_SERVE_WRITE_SET) : planned;
    },
    postconditions(before, after, ctx) {
      const planned = planWrongServe(wrongServeContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload, configuration);
      return planned.ok ? comparePlannedSlices(after, planned.plan, WRONG_SERVE_WRITE_SET) : planned;
    },
    events(before, _after, ctx) {
      const planned = planWrongServe(wrongServeContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload, configuration);
      return planned.ok ? [planned.plan.event] : [];
    },
  });
}

function wasteContext(source, command, phase, generationId) {
  return {
    runtimePhase: phase,
    generationId,
    issuedAtSimulationMs: command.issuedAtSimulationMs,
    campaign: source("campaign"),
    service: source("service"),
    saleSlots: source("saleSlots"),
    inventory: source("inventory"),
    inventoryAccounting: source("inventoryAccounting"),
    idCounters: source("idCounters"),
  };
}

function createWasteDishAtomicTransaction() {
  return defineAtomicTransaction({
    name: DIRECT_SERVICE_COMMAND.WASTE_CARRIED_DISH,
    readSet: WASTE_DISH_READ_SET,
    writeSet: WASTE_DISH_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateWastePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planCarriedDishWaste(wasteContext(
        (slice) => ctx.read(slice), ctx.command, ctx.phase, ctx.generationId,
      ), ctx.command.payload);
    },
    mutate(draft) {
      const planned = planCarriedDishWaste(wasteContext(
        (slice) => draft.read(slice), draft.command, RUNTIME_PHASE.SERVICE,
        draft.command.generationId,
      ), draft.command.payload);
      return planned.ok ? replacePlannedSlices(draft, planned.plan, WASTE_DISH_WRITE_SET) : planned;
    },
    postconditions(before, after, ctx) {
      const planned = planCarriedDishWaste(wasteContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload);
      return planned.ok ? comparePlannedSlices(after, planned.plan, WASTE_DISH_WRITE_SET) : planned;
    },
    events(before, _after, ctx) {
      const planned = planCarriedDishWaste(wasteContext(
        (slice) => before[slice], ctx.command, before.runtimePhase, before.generationId,
      ), ctx.command.payload);
      return planned.ok ? [planned.plan.event] : [];
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

export function projectDirectService(snapshot) {
  const direct = validateDirectServiceState({
    runtimePhase: snapshot.runtimePhase,
    service: snapshot.service,
    saleSlots: snapshot.saleSlots,
    inventory: snapshot.inventory,
  });
  if (!direct.ok) {
    const error = new TypeError(`DirectService projection이 유효하지 않습니다: ${direct.code}`);
    error.code = direct.code;
    error.details = direct.details;
    throw error;
  }
  const carriedDish = snapshot.service.carriedDishId === null
    ? null
    : snapshot.inventory.completedDishes.find(
      (dish) => dish.dishId === snapshot.service.carriedDishId,
    );
  return freezeDeep({
    timingCook: snapshot.service.timingCook === null
      ? null
      : cloneValue(snapshot.service.timingCook),
    carriedDish: carriedDish ? cloneValue(carriedDish) : null,
    carriedDishId: snapshot.service.carriedDishId,
    completedDishes: cloneValue(snapshot.service.completedDishes),
    sales: projectSales(snapshot.sales),
    rawIngredientCarry: false,
  });
}

export class DirectServiceSystem {
  constructor(commandBus, { configuration = {}, register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" ||
        typeof commandBus.dispatch !== "function" || !commandBus.store) {
      throw new TypeError("DirectServiceSystem에는 store가 연결된 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.configuration = normalizeConfiguration(configuration);
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(DIRECT_SERVICE_COMMAND.START_COOK, createStartCookAtomicTransaction());
    this.commandBus.register(DIRECT_SERVICE_COMMAND.COMPLETE_COOK, createCompleteCookAtomicTransaction());
    this.commandBus.register(
      DIRECT_SERVICE_COMMAND.CANCEL_COOK_AT_ZERO,
      createCancelCookAtomicTransaction(),
    );
    this.commandBus.register(
      DIRECT_SERVICE_COMMAND.SERVE,
      createCommitSaleAtomicTransaction(this.configuration),
    );
    this.commandBus.register(
      DIRECT_SERVICE_COMMAND.WRONG_SERVE,
      createWrongServeAtomicTransaction(this.configuration),
    );
    this.commandBus.register(
      DIRECT_SERVICE_COMMAND.WASTE_CARRIED_DISH,
      createWasteDishAtomicTransaction(),
    );
    this.registered = true;
    return this;
  }

  startCook(input) {
    return this.commandBus.dispatch(commandEnvelope(
      DIRECT_SERVICE_COMMAND.START_COOK,
      START_COOK_READ_SET,
      START_COOK_WRITE_SET,
      input,
    ));
  }

  completeCook(input) {
    return this.commandBus.dispatch(commandEnvelope(
      DIRECT_SERVICE_COMMAND.COMPLETE_COOK,
      COMPLETE_COOK_READ_SET,
      COMPLETE_COOK_WRITE_SET,
      input,
    ));
  }

  cancelCookAtZero(input) {
    return this.commandBus.dispatch(commandEnvelope(
      DIRECT_SERVICE_COMMAND.CANCEL_COOK_AT_ZERO,
      CANCEL_COOK_READ_SET,
      CANCEL_COOK_WRITE_SET,
      input,
    ));
  }

  serve(input) {
    const snapshot = this.commandBus.store.getSnapshot();
    const dish = snapshot.service?.carriedDishId === null
      ? null
      : snapshot.inventory?.completedDishes?.find(
        (candidate) => candidate.dishId === snapshot.service?.carriedDishId,
      );
    const order = snapshot.service?.orders?.find(
      (candidate) => candidate.orderId === input?.payload?.targetOrderId,
    );
    const wrong = dish && order && dish.recipeId !== order.recipeId;
    return this.commandBus.dispatch(commandEnvelope(
      wrong ? DIRECT_SERVICE_COMMAND.WRONG_SERVE : DIRECT_SERVICE_COMMAND.SERVE,
      wrong ? WRONG_SERVE_READ_SET : COMMIT_SALE_READ_SET,
      wrong ? WRONG_SERVE_WRITE_SET : COMMIT_SALE_WRITE_SET,
      input,
    ));
  }

  wasteCarriedDish(input) {
    return this.commandBus.dispatch(commandEnvelope(
      DIRECT_SERVICE_COMMAND.WASTE_CARRIED_DISH,
      WASTE_DISH_READ_SET,
      WASTE_DISH_WRITE_SET,
      input,
    ));
  }

  project(snapshot = this.commandBus.store.getSnapshot()) {
    return projectDirectService(snapshot);
  }
}

export function registerDirectServiceSystem(commandBus, configuration = {}) {
  return new DirectServiceSystem(commandBus, { configuration, register: true });
}
