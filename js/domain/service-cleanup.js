import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import {
  applyEscrowRestoreToDraft,
  validateCostMovementAppendOnly,
  validateInventoryAccountingState,
} from "./inventory-accounting.js";
import { validateInventoryState } from "./inventory.js";
import { ACTIVE_ORDER_STATE } from "./orders.js";
import {
  applySaleSlotCleanupToDraft,
  planSaleSlotCleanup,
  planSaleSlotRelease,
  SALE_SLOT_RELEASE_REASON,
  SALE_SLOT_STATE,
  validateSaleSlotsState,
} from "./sale-slots.js";
import { cancelTimingCookAtZero, TIMING_COOK_STATE } from "./timing-cook.js";
import {
  RUNTIME_PHASE,
  SERVICE_LIFECYCLE,
  SERVICE_TIMER_LIMITS,
  validateServiceTimerState,
} from "./timer-state.js";

/**
 * Task 26 — Requirement 2 AC 6~12, Requirement 9 AC 11, Requirement 11 AC 7~13.
 * CancelCookAtZero(RUNNING_ESCROW→CANCELLED_RESTORED, 정확한 escrow 복구)는 이미
 * direct-service.js의 DIRECT_SERVICE_COMMAND.CANCEL_COOK_AT_ZERO로 구현돼 있고, 미사용
 * reservation/ASSIGNED slot 해제는 menu.js의 MENU_COMMAND.CLEANUP(planSaleSlotCleanup)이
 * 이미 구현돼 있다. 이 파일은 그 사이에 빠져 있던 "ACTIVE order technical-cancel"과, 12초
 * cap에서 남은 전부를 한 transaction으로 강제 해제하는 ForceCleanupAtCap을 더한다.
 */

export const SERVICE_CLEANUP_COMMAND = Object.freeze({
  RELEASE_ORDERS: "service-cleanup.orders.release",
  FORCE_CLEANUP_AT_CAP: "service-cleanup.force-at-cap",
});

export const RELEASE_ORDERS_READ_SET = Object.freeze([]);
export const RELEASE_ORDERS_WRITE_SET = Object.freeze(["service", "saleSlots"]);
export const FORCE_CLEANUP_AT_CAP_READ_SET = Object.freeze(["campaign"]);
export const FORCE_CLEANUP_AT_CAP_WRITE_SET = Object.freeze([
  "service",
  "saleSlots",
  "inventory",
  "inventoryAccounting",
  "menu",
  "idCounters",
]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_SERVICE_CLEANUP_PAYLOAD: "결과 폐쇄 cleanup 요청 형식이 올바르지 않습니다.",
  SERVICE_CLEANUP_REQUIRES_RESULTS_CLOSED: "resultsClosed cleanup lifecycle에서만 결과 폐쇄 cleanup을 수행할 수 있습니다.",
  CLEANUP_NOTHING_TO_RELEASE: "해제할 ACTIVE order가 없습니다.",
  SERVICE_CLEANUP_ID_STATE_INVALID: "결정론적 ID 상태가 올바르지 않습니다.",
  SERVICE_CLEANUP_POSTCONDITION_FAILED: "결과 폐쇄 cleanup 원자 변경 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "결과 폐쇄 cleanup 검증에 실패했습니다.",
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

function requireResultsClosedCleanup(runtimePhase, service) {
  if (runtimePhase !== RUNTIME_PHASE.SERVICE || service.lifecycle !== SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP ||
      !service.resultsClosed) {
    return failure("SERVICE_CLEANUP_REQUIRES_RESULTS_CLOSED", {
      runtimePhase,
      lifecycle: service?.lifecycle,
      resultsClosed: service?.resultsClosed,
    });
  }
  return validationSuccess();
}

function validatePayload(payload) {
  return isPlainRecord(payload) ? validationSuccess() : failure("INVALID_SERVICE_CLEANUP_PAYLOAD");
}

/** ACTIVE order 전부를 TECHNICAL_CANCELLED로 바꾸고 연결된 ASSIGNED slot을 함께 푼다. */
export function planReleaseActiveOrders({ runtimePhase, service, saleSlots }) {
  const cleanupGate = requireResultsClosedCleanup(runtimePhase, service);
  if (!cleanupGate.ok) return cleanupGate;
  const activeOrders = service.orders.filter((order) => order.state === ACTIVE_ORDER_STATE.ACTIVE);
  if (activeOrders.length === 0) return failure("CLEANUP_NOTHING_TO_RELEASE");

  const serviceCandidate = cloneValue(service);
  let saleSlotsCandidate = saleSlots;
  const releasedOrderIds = [];
  for (const order of activeOrders) {
    const orderCandidate = serviceCandidate.orders.find((candidate) => candidate.orderId === order.orderId);
    orderCandidate.state = ACTIVE_ORDER_STATE.TECHNICAL_CANCELLED;
    const slot = saleSlotsCandidate.slots.find((candidate) => candidate.saleSlotId === order.saleSlotId);
    if (slot && slot.state === SALE_SLOT_STATE.ASSIGNED && slot.activeOrderId === order.orderId) {
      const released = planSaleSlotRelease(saleSlotsCandidate, {
        saleSlotId: order.saleSlotId,
        orderId: order.orderId,
        reason: SALE_SLOT_RELEASE_REASON.TECHNICAL_CANCEL,
      });
      if (!released.ok) return released;
      saleSlotsCandidate = released.plan.saleSlots;
    }
    releasedOrderIds.push(order.orderId);
  }
  return success({ service: serviceCandidate, saleSlots: saleSlotsCandidate, releasedOrderIds });
}

export function createReleaseActiveOrdersAtomicTransaction() {
  return defineAtomicTransaction({
    name: SERVICE_CLEANUP_COMMAND.RELEASE_ORDERS,
    readSet: RELEASE_ORDERS_READ_SET,
    writeSet: RELEASE_ORDERS_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planReleaseActiveOrders({
        runtimePhase: ctx.phase,
        service: ctx.read("service"),
        saleSlots: ctx.read("saleSlots"),
      });
    },
    mutate(draft) {
      const planned = planReleaseActiveOrders({
        runtimePhase: RUNTIME_PHASE.SERVICE,
        service: draft.read("service"),
        saleSlots: draft.read("saleSlots"),
      });
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      draft.replace("saleSlots", planned.plan.saleSlots);
      return validationSuccess();
    },
    postconditions(before, after) {
      const planned = planReleaseActiveOrders({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
      });
      if (!planned.ok) return planned;
      if (!equivalent(after.service, planned.plan.service) ||
          !equivalent(after.saleSlots, planned.plan.saleSlots)) {
        return failure("SERVICE_CLEANUP_POSTCONDITION_FAILED");
      }
      return validateServiceTimerState(after.service, { runtimePhase: after.runtimePhase });
    },
    events(before, _after, ctx) {
      const planned = planReleaseActiveOrders({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
      });
      if (!planned.ok) return [];
      return [{
        type: "service-cleanup.orders-released",
        payload: {
          releasedOrderIds: planned.plan.releasedOrderIds,
          cleanupAtMs: ctx.command.issuedAtSimulationMs,
        },
      }];
    },
  });
}

function allocateMovementId(idCounters, campaign, generationId) {
  try {
    const ids = IdService.fromState(idCounters);
    if (ids.campaignId !== campaign.campaignId || ids.day !== campaign.day || ids.generationId !== generationId) {
      return failure("SERVICE_CLEANUP_ID_STATE_INVALID");
    }
    const movementId = ids.next("movement", { day: campaign.day });
    return success({ movementId, idCounters: ids.snapshot() });
  } catch {
    return failure("SERVICE_CLEANUP_ID_STATE_INVALID");
  }
}

/**
 * 12초 cap에서 남아 있는 모든 것(RUNNING_ESCROW cook, ACTIVE order, ASSIGNED slot,
 * 미사용 reservation)을 단일 transaction으로 강제 해제한다. cash/inventory total
 * quantity·Book_Cost/Revenue/COGS/Waste/reputation/SOLD count는 바뀌지 않는다.
 */
export function planForceCleanupAtCap(context) {
  const { runtimePhase, service, saleSlots, inventory, inventoryAccounting, campaign, generationId, idCounters,
    issuedAtSimulationMs } = context;
  const cleanupGate = requireResultsClosedCleanup(runtimePhase, service);
  if (!cleanupGate.ok) return cleanupGate;
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) return failure("SERVICE_CLEANUP_REQUIRES_RESULTS_CLOSED", { cause: inventoryValidation.code });
  const accountingValidation = validateInventoryAccountingState(inventoryAccounting);
  if (!accountingValidation.ok) return failure("SERVICE_CLEANUP_REQUIRES_RESULTS_CLOSED", { cause: accountingValidation.code });
  const slotsValidation = validateSaleSlotsState(saleSlots);
  if (!slotsValidation.ok) return failure("SERVICE_CLEANUP_REQUIRES_RESULTS_CLOSED", { cause: slotsValidation.code });

  let serviceCandidate = cloneValue(service);
  let inventoryCandidate = cloneValue(inventory);
  let inventoryAccountingCandidate = cloneValue(inventoryAccounting);
  let idCountersCandidate = idCounters;
  let restoredEscrow = null;

  if (serviceCandidate.timingCook?.state === TIMING_COOK_STATE.RUNNING_ESCROW) {
    const allocated = allocateMovementId(idCountersCandidate, campaign, generationId);
    if (!allocated.ok) return allocated;
    idCountersCandidate = allocated.plan.idCounters;
    const restored = applyEscrowRestoreToDraft(inventoryCandidate, inventoryAccountingCandidate, {
      movementId: allocated.plan.movementId,
      day: campaign.day,
      causeId: serviceCandidate.timingCook.causeId,
      escrowId: serviceCandidate.timingCook.escrowId,
    });
    if (!restored.ok) return restored;
    restoredEscrow = restored.plan.restoredEscrow;
    const cancelled = cancelTimingCookAtZero(serviceCandidate.timingCook, { cancelledAtMs: issuedAtSimulationMs });
    if (!cancelled.ok) return cancelled;
    serviceCandidate.timingCook = cancelled.plan.timingCook;
    serviceCandidate.completedDishes = cloneValue(inventoryCandidate.completedDishes);
    serviceCandidate.carriedDishId = null;
  }

  const releasedOrderIds = [];
  for (const order of serviceCandidate.orders) {
    if (order.state !== ACTIVE_ORDER_STATE.ACTIVE) continue;
    order.state = ACTIVE_ORDER_STATE.TECHNICAL_CANCELLED;
    releasedOrderIds.push(order.orderId);
  }

  const slotCleanup = planSaleSlotCleanup(saleSlots, inventoryCandidate);
  if (!slotCleanup.ok) return slotCleanup;
  const saleSlotsCandidate = slotCleanup.plan.saleSlots;
  inventoryCandidate = slotCleanup.plan.inventory;

  serviceCandidate.cleanupElapsedMs = SERVICE_TIMER_LIMITS.maximumCleanupOvertimeMs;

  return success({
    service: serviceCandidate,
    saleSlots: saleSlotsCandidate,
    inventory: inventoryCandidate,
    inventoryAccounting: inventoryAccountingCandidate,
    idCounters: idCountersCandidate,
    restoredEscrow,
    releasedOrderIds,
    releasedAssignedCount: slotCleanup.plan.releasedAssignedCount,
    releasedReservations: slotCleanup.plan.releasedReservations,
  });
}

export function createForceCleanupAtCapAtomicTransaction() {
  return defineAtomicTransaction({
    name: SERVICE_CLEANUP_COMMAND.FORCE_CLEANUP_AT_CAP,
    readSet: FORCE_CLEANUP_AT_CAP_READ_SET,
    writeSet: FORCE_CLEANUP_AT_CAP_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planForceCleanupAtCap({
        runtimePhase: ctx.phase,
        service: ctx.read("service"),
        saleSlots: ctx.read("saleSlots"),
        inventory: ctx.read("inventory"),
        inventoryAccounting: ctx.read("inventoryAccounting"),
        campaign: ctx.read("campaign"),
        idCounters: ctx.read("idCounters"),
        generationId: ctx.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      });
    },
    mutate(draft) {
      const planned = planForceCleanupAtCap({
        runtimePhase: RUNTIME_PHASE.SERVICE,
        service: draft.read("service"),
        saleSlots: draft.read("saleSlots"),
        inventory: draft.read("inventory"),
        inventoryAccounting: draft.read("inventoryAccounting"),
        campaign: draft.read("campaign"),
        idCounters: draft.read("idCounters"),
        generationId: draft.command.generationId,
        issuedAtSimulationMs: draft.command.issuedAtSimulationMs,
      });
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      draft.replace("saleSlots", planned.plan.saleSlots);
      draft.replace("inventory", planned.plan.inventory);
      draft.replace("inventoryAccounting", planned.plan.inventoryAccounting);
      draft.write("menu").cleanupComplete = true;
      draft.replace("idCounters", planned.plan.idCounters);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planForceCleanupAtCap({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
        inventory: before.inventory,
        inventoryAccounting: before.inventoryAccounting,
        campaign: before.campaign,
        idCounters: before.idCounters,
        generationId: before.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      });
      if (!planned.ok) return planned;
      for (const slice of ["service", "saleSlots", "inventory", "inventoryAccounting", "idCounters"]) {
        if (!equivalent(after[slice], planned.plan[slice])) {
          return failure("SERVICE_CLEANUP_POSTCONDITION_FAILED", { slice });
        }
      }
      if (!after.menu.cleanupComplete) return failure("SERVICE_CLEANUP_POSTCONDITION_FAILED", { slice: "menu" });
      const appendOnly = validateCostMovementAppendOnly(before.inventoryAccounting, after.inventoryAccounting);
      if (!appendOnly.ok) return appendOnly;
      return validateServiceTimerState(after.service, { runtimePhase: after.runtimePhase });
    },
    events(before, _after, ctx) {
      const planned = planForceCleanupAtCap({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
        inventory: before.inventory,
        inventoryAccounting: before.inventoryAccounting,
        campaign: before.campaign,
        idCounters: before.idCounters,
        generationId: before.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      });
      if (!planned.ok) return [];
      return [{
        type: "service-cleanup.forced-at-cap",
        payload: {
          restoredEscrow: planned.plan.restoredEscrow,
          releasedOrderIds: planned.plan.releasedOrderIds,
          releasedAssignedCount: planned.plan.releasedAssignedCount,
          cleanupAtMs: ctx.command.issuedAtSimulationMs,
        },
      }];
    },
  });
}

export class ServiceCleanupSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("ServiceCleanupSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(SERVICE_CLEANUP_COMMAND.RELEASE_ORDERS, createReleaseActiveOrdersAtomicTransaction());
    this.commandBus.register(
      SERVICE_CLEANUP_COMMAND.FORCE_CLEANUP_AT_CAP,
      createForceCleanupAtCapAtomicTransaction(),
    );
    this.registered = true;
    return this;
  }

  releaseOrders(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: SERVICE_CLEANUP_COMMAND.RELEASE_ORDERS,
      payload: input?.payload ?? {},
      readSet: [...RELEASE_ORDERS_READ_SET],
      writeSet: [...RELEASE_ORDERS_WRITE_SET],
    });
  }

  forceCleanupAtCap(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: SERVICE_CLEANUP_COMMAND.FORCE_CLEANUP_AT_CAP,
      payload: input?.payload ?? {},
      readSet: [...FORCE_CLEANUP_AT_CAP_READ_SET],
      writeSet: [...FORCE_CLEANUP_AT_CAP_WRITE_SET],
    });
  }
}

export function registerServiceCleanupSystem(commandBus) {
  return new ServiceCleanupSystem(commandBus, { register: true });
}

/**
 * 지금 snapshot을 보고 다음에 필요한 cleanup 단계를 알려주는 순수 함수. TimerSystem이
 * 이 결과를 보고 real command를 하나씩 순서대로 dispatch한다.
 */
export function planNextCleanupStep(snapshot) {
  const { runtimePhase, service, saleSlots, inventory } = snapshot;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE || service.lifecycle !== SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP) {
    return { step: "NONE" };
  }
  if (service.timingCook?.state === TIMING_COOK_STATE.RUNNING_ESCROW) {
    return { step: "CANCEL_COOK" };
  }
  if (service.orders.some((order) => order.state === ACTIVE_ORDER_STATE.ACTIVE)) {
    return { step: "RELEASE_ORDERS" };
  }
  const slotCleanup = planSaleSlotCleanup(saleSlots, inventory);
  if (slotCleanup.ok && slotCleanup.plan.changed) {
    return { step: "MENU_CLEANUP" };
  }
  return { step: "COMPLETE" };
}
