import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { ACTIVE_ORDER_STATE, ORDER_GUEST_STATE } from "../domain/orders.js";
import { RUNTIME_PHASE } from "../domain/timer-state.js";
import { planSaleSlotRelease, SALE_SLOT_RELEASE_REASON, SALE_SLOT_STATE } from "../domain/sale-slots.js";

/**
 * Task 31 — design.md 10.4/Requirement 2 AC 9~11/Requirement 34 AC 10~13.
 * 정상 흐름 밖에서 guest entity를 제거해야 하는 두 경우(runtime path fault, timer-zero
 * 12초 cap)를 하나의 `GuestTerminationRecord` tombstone 기록으로 통일한다. 어느 보존 tier가
 * 적용되는지는 "언제" 발생했는지가 아니라 guest의 현재 state·연결된 ActiveOrder로 결정한다 —
 * Spawn→Seat 단계(Task 30)는 order가 있을 수 없어 항상 PRE_ORDER, Seat→Exit 단계(Task 31)는
 * order가 이미 종결된 뒤라 항상 POST_SALE이고, ACTIVE_ORDER는 timer-zero cap에서 아직
 * ORDERING인 guest를 잡을 때만 실제로 나타난다.
 */

export const GUEST_TERMINATION_CAUSE = Object.freeze({
  PATH_FAULT: "PATH_FAULT",
  TIMER_CAP: "TIMER_CAP",
});

export const GUEST_CLEANUP_TIER = Object.freeze({
  PRE_ORDER: "PRE_ORDER",
  ACTIVE_ORDER: "ACTIVE_ORDER",
  POST_SALE: "POST_SALE",
});

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_GUEST_CLEANUP_PAYLOAD: "GuestFlow 종료 요청 형식이 올바르지 않습니다.",
  GUEST_CLEANUP_REQUIRES_SERVICE: "실행 중인 Service에서만 guest를 종료할 수 있습니다.",
  GUEST_CLEANUP_GUEST_NOT_FOUND: "종료할 손님을 찾을 수 없습니다.",
  GUEST_CLEANUP_POSTCONDITION_FAILED: "guest 종료 원자 변경 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "guest 종료 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
}

function success(plan) {
  return Object.freeze({ ok: true, plan: freezeDeep(plan) });
}

/** guest의 현재 state와 연결된 ActiveOrder로 보존 tier를 결정한다(design 10.4). */
export function classifyGuestFaultTier(guest, order) {
  if (order && order.state === ACTIVE_ORDER_STATE.ACTIVE) return GUEST_CLEANUP_TIER.ACTIVE_ORDER;
  if (guest.state === ORDER_GUEST_STATE.MEAL_REACTION || guest.state === ORDER_GUEST_STATE.MOVING_TO_EXIT) {
    return GUEST_CLEANUP_TIER.POST_SALE;
  }
  return GUEST_CLEANUP_TIER.PRE_ORDER;
}

export function createTerminationRecord({ guestId, entityId, cause, tier, day, atMs, terminationSequence }) {
  return freezeDeep({
    guestId,
    entityId,
    cause,
    tier,
    day,
    atMs,
    terminationSequence,
  });
}

/**
 * service(+필요 시 saleSlots)에서 guest 하나를 tier 규칙에 따라 원자적으로 제거한다. 호출자가
 * 이미 clone한 draft를 그대로 변형해 돌려준다 — service.guests에 아직 없는(대기열만 있는)
 * guest도 지원한다. 여러 guest를 순서대로 처리하는 호출자(planGuestNeutralCleanup 등)가 같은
 * serviceDraft를 반복 변형할 수 있어야 하므로, 다른 planX 함수들과 달리 일부러 freezeDeep을
 * 쓰지 않는다 — freeze하면 다음 호출에서 같은 draft를 다시 변형할 수 없다.
 */
export function terminateGuestInDraft(serviceDraft, saleSlotsDraft, { guestId, entityId, cause, tier, day, atMs }) {
  let saleSlots = saleSlotsDraft;
  const orderIndex = serviceDraft.orders.findIndex((order) => order.guestId === guestId);
  if (tier === GUEST_CLEANUP_TIER.ACTIVE_ORDER && orderIndex >= 0) {
    const order = serviceDraft.orders[orderIndex];
    order.state = ACTIVE_ORDER_STATE.TECHNICAL_CANCELLED;
    const slot = saleSlots.slots.find((candidate) => candidate.saleSlotId === order.saleSlotId);
    if (slot && slot.state === SALE_SLOT_STATE.ASSIGNED && slot.activeOrderId === order.orderId) {
      const released = planSaleSlotRelease(saleSlots, {
        saleSlotId: order.saleSlotId,
        orderId: order.orderId,
        reason: SALE_SLOT_RELEASE_REASON.TECHNICAL_CANCEL,
      });
      if (!released.ok) return released;
      saleSlots = released.plan.saleSlots;
    }
  }
  serviceDraft.guests = serviceDraft.guests.filter((guest) => guest.guestId !== guestId);
  serviceDraft.pendingSeatQueue = serviceDraft.pendingSeatQueue.filter((id) => id !== guestId);
  const terminationSequence = serviceDraft.terminationRecords.length;
  serviceDraft.terminationRecords = [
    ...serviceDraft.terminationRecords,
    createTerminationRecord({ guestId, entityId, cause, tier, day, atMs, terminationSequence }),
  ];
  return { ok: true, plan: { service: serviceDraft, saleSlots } };
}

function validatePayload(payload) {
  return payload && typeof payload === "object" && isStableIdentifier(payload.guestId)
    ? validationSuccess()
    : failure("INVALID_GUEST_CLEANUP_PAYLOAD");
}

/**
 * QA fault-injection과 실제 runtime path fault 두 콜백이 함께 쓰는 단일 종료 planner.
 * guestId가 service.guests에 없으면(예: pendingSeatQueue만 있는 대기) entityId 없이도
 * tombstone만 기록한다.
 */
export function planTerminateGuestForFault({ runtimePhase, service, saleSlots, campaign, issuedAtSimulationMs }, payload) {
  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE) {
    return failure("GUEST_CLEANUP_REQUIRES_SERVICE", { runtimePhase });
  }
  const guest = service.guests.find((candidate) => candidate.guestId === payload.guestId);
  const queued = service.pendingSeatQueue.includes(payload.guestId);
  if (!guest && !queued) return failure("GUEST_CLEANUP_GUEST_NOT_FOUND", { guestId: payload.guestId });
  const order = service.orders.find((candidate) => candidate.guestId === payload.guestId);
  const tier = guest ? classifyGuestFaultTier(guest, order) : GUEST_CLEANUP_TIER.PRE_ORDER;
  const serviceDraft = cloneValue(service);
  const saleSlotsDraft = cloneValue(saleSlots);
  const terminated = terminateGuestInDraft(serviceDraft, saleSlotsDraft, {
    guestId: payload.guestId,
    entityId: guest?.entityId ?? null,
    cause: GUEST_TERMINATION_CAUSE.PATH_FAULT,
    tier,
    day: campaign.day,
    atMs: issuedAtSimulationMs,
  });
  if (!terminated.ok) return terminated;
  return success({ service: terminated.plan.service, saleSlots: terminated.plan.saleSlots, tier });
}

/**
 * timer-zero 12초 cleanup의 "정상" 단계(GUEST_CLEANUP step). RELEASE_ORDERS가 먼저
 * 실행되어 ACTIVE order가 이미 전부 정리됐다고 가정하고 service만 쓴다 — 그래도 방어적으로
 * tier를 다시 계산해, 혹시 남아 있는 ACTIVE order가 있으면 그 자리에서 함께 정리한다.
 */
export function planGuestNeutralCleanup({ runtimePhase, service, saleSlots, campaign, issuedAtSimulationMs }) {
  if (service.guests.length === 0 && service.pendingSeatQueue.length === 0) {
    return failure("GUEST_CLEANUP_GUEST_NOT_FOUND");
  }
  const serviceDraft = cloneValue(service);
  let saleSlotsDraft = cloneValue(saleSlots);
  const targets = [
    ...service.guests.map((guest) => ({ guestId: guest.guestId, entityId: guest.entityId })),
    ...service.pendingSeatQueue.map((guestId) => ({ guestId, entityId: null })),
  ];
  for (const target of targets) {
    const guest = serviceDraft.guests.find((candidate) => candidate.guestId === target.guestId);
    const order = serviceDraft.orders.find((candidate) => candidate.guestId === target.guestId);
    const tier = guest ? classifyGuestFaultTier(guest, order) : GUEST_CLEANUP_TIER.PRE_ORDER;
    const terminated = terminateGuestInDraft(serviceDraft, saleSlotsDraft, {
      guestId: target.guestId,
      entityId: target.entityId,
      cause: GUEST_TERMINATION_CAUSE.TIMER_CAP,
      tier,
      day: campaign.day,
      atMs: issuedAtSimulationMs,
    });
    if (!terminated.ok) return terminated;
    saleSlotsDraft = terminated.plan.saleSlots;
  }
  return success({ service: serviceDraft, saleSlots: saleSlotsDraft });
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

export const GUEST_CLEANUP_COMMAND = Object.freeze({
  TERMINATE_FOR_FAULT: "guest-cleanup.fault.terminate",
});

export const TERMINATE_FOR_FAULT_READ_SET = Object.freeze(["campaign"]);
export const TERMINATE_FOR_FAULT_WRITE_SET = Object.freeze(["service", "saleSlots"]);

/**
 * runtime path fault의 독립 dispatch 경로다(QA fault-injection과, 향후 GuestFlow 바깥에서
 * 발견된 fault를 위해). 실제 arrival/exit path 실패는 guest-flow.js/guest-outcomes.js가
 * 자기 own atomic transaction 안에서 terminateGuestInDraft를 직접 쓴다 — CommandBus가
 * 같은 dispatch 안에서 새 command 재진입을 금지하기 때문이다.
 */
export function createTerminateForFaultAtomicTransaction() {
  return defineAtomicTransaction({
    name: GUEST_CLEANUP_COMMAND.TERMINATE_FOR_FAULT,
    readSet: TERMINATE_FOR_FAULT_READ_SET,
    writeSet: TERMINATE_FOR_FAULT_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planTerminateGuestForFault({
        runtimePhase: ctx.phase,
        service: ctx.read("service"),
        saleSlots: ctx.read("saleSlots"),
        campaign: ctx.read("campaign"),
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planTerminateGuestForFault({
        runtimePhase: RUNTIME_PHASE.SERVICE,
        service: draft.read("service"),
        saleSlots: draft.read("saleSlots"),
        campaign: draft.read("campaign"),
        issuedAtSimulationMs: draft.command.issuedAtSimulationMs,
      }, draft.command.payload);
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      draft.replace("saleSlots", planned.plan.saleSlots);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planTerminateGuestForFault({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
        campaign: before.campaign,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload);
      if (!planned.ok) return planned;
      return equivalent(after.service, planned.plan.service) && equivalent(after.saleSlots, planned.plan.saleSlots)
        ? validationSuccess()
        : failure("GUEST_CLEANUP_POSTCONDITION_FAILED");
    },
    events(before, _after, ctx) {
      const planned = planTerminateGuestForFault({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
        campaign: before.campaign,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload);
      if (!planned.ok) return [];
      return [{
        type: "guest-cleanup.terminated",
        payload: { guestId: ctx.command.payload.guestId, cause: GUEST_TERMINATION_CAUSE.PATH_FAULT, tier: planned.plan.tier },
      }];
    },
  });
}

export class GuestCleanupSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("GuestCleanupSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(GUEST_CLEANUP_COMMAND.TERMINATE_FOR_FAULT, createTerminateForFaultAtomicTransaction());
    this.registered = true;
    return this;
  }

  terminateForFault(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: GUEST_CLEANUP_COMMAND.TERMINATE_FOR_FAULT,
      payload: input?.payload,
      readSet: [...TERMINATE_FOR_FAULT_READ_SET],
      writeSet: [...TERMINATE_FOR_FAULT_WRITE_SET],
    });
  }
}

export function registerGuestCleanupSystem(commandBus) {
  return new GuestCleanupSystem(commandBus, { register: true });
}
