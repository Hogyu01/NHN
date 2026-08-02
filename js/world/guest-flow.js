import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { ORDER_GUEST_STATE, validateOrderGuest } from "../domain/orders.js";
import { RUNTIME_PHASE } from "../domain/timer-state.js";
import { GUEST_CLEANUP_TIER, GUEST_TERMINATION_CAUSE, terminateGuestInDraft } from "./guest-cleanup.js";
import { findShortestPath } from "./pathfinder.js";

/**
 * Task 30 — design.md 10.1/10.2. Seat는 GameStore에 별도 registry로 저장하지 않고
 * `service.guests[].seatId`(SEATED/ORDERING/MEAL_REACTION/MOVING_TO_EXIT 상태)로부터
 * 파생한다. 이동 자체(연속 위치)는 도메인 state가 아니라 render 전용 계산이라
 * GameStore에 매 tick commit하지 않는다 — travelTimeMs를 한 번 계산해 TimerSystem이
 * ARRIVAL class로 SEATED 전이를 미리 예약한다(design 10.2의 1,920 milli-px/20ms 규칙).
 */

export const GUEST_MOVEMENT_SPEED_MILLI_PX_PER_MS = 96; // 96,000 milli-px/s = 96 logical px/s
export const GUEST_STEP_MILLI_PX = 1_920; // 20ms tick당 최대 이동량
export const SIMULATION_STEP_MS = 20;

export const GUEST_FLOW_COMMAND = Object.freeze({
  PROCESS_ARRIVAL: "guest-flow.arrival.process",
  SEAT_ARRIVAL: "guest-flow.seat-arrival.commit",
});

export const PROCESS_ARRIVAL_READ_SET = Object.freeze(["campaign"]);
export const PROCESS_ARRIVAL_WRITE_SET = Object.freeze(["service"]);
export const SEAT_ARRIVAL_READ_SET = Object.freeze([]);
export const SEAT_ARRIVAL_WRITE_SET = Object.freeze(["service"]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_GUEST_FLOW_PAYLOAD: "GuestFlow 요청 형식이 올바르지 않습니다.",
  GUEST_FLOW_REQUIRES_SERVICE: "실행 중인 Service에서만 GuestFlow를 처리할 수 있습니다.",
  GUEST_FLOW_PLAN_NOT_FOUND: "ScheduledGuestPlan을 찾을 수 없습니다.",
  GUEST_FLOW_ALREADY_PROCESSED: "이미 처리된 도착입니다.",
  GUEST_FLOW_PATH_UNREACHABLE: "Spawn에서 좌석까지 경로를 찾을 수 없습니다.",
  GUEST_FLOW_GUEST_NOT_FOUND: "이동 중인 손님을 찾을 수 없습니다.",
  GUEST_FLOW_NOT_MOVING_TO_SEAT: "MOVING_TO_SEAT 상태의 손님만 좌석에 도착할 수 있습니다.",
  GUEST_FLOW_POSTCONDITION_FAILED: "GuestFlow 원자 변경 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "GuestFlow 검증에 실패했습니다.",
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

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const SEATED_LIKE_STATES = new Set([
  ORDER_GUEST_STATE.MOVING_TO_SEAT,
  ORDER_GUEST_STATE.SEATED,
  ORDER_GUEST_STATE.ORDERING,
  ORDER_GUEST_STATE.MEAL_REACTION,
  ORDER_GUEST_STATE.MOVING_TO_EXIT,
]);

/** 현재 점유된 seatId 집합. seat registry를 따로 두지 않고 guests에서 파생한다. */
export function occupiedSeatIds(guests) {
  return new Set(guests.filter((guest) => SEATED_LIKE_STATES.has(guest.state)).map((guest) => guest.seatId));
}

/** seatId lexical ascending으로 정렬한 첫 vacant seat(design 10.1). */
export function firstVacantSeatPoint(seatPoints, guests) {
  const occupied = occupiedSeatIds(guests);
  const vacant = seatPoints.filter((seat) => !occupied.has(seat.seatId));
  vacant.sort((a, b) => compareIds(a.seatId, b.seatId));
  return vacant[0] ?? null;
}

/** path(tile 좌표 배열)의 총 이동 거리를 20ms/1,920milli-px 규칙으로 travelTimeMs로 변환한다. */
export function computeTravelTimeMs(path, tileSize) {
  const distanceMilliPx = (path.length - 1) * tileSize * 1000;
  if (distanceMilliPx <= 0) return 0;
  const steps = Math.ceil(distanceMilliPx / GUEST_STEP_MILLI_PX);
  return steps * SIMULATION_STEP_MS;
}

function validatePayload(payload) {
  return isPlainRecord(payload) && isStableIdentifier(payload.guestId)
    ? validationSuccess()
    : failure("INVALID_GUEST_FLOW_PAYLOAD");
}

/**
 * ScheduledGuestPlan 하나의 도착을 처리한다: vacant seat가 있으면 spawn→seat 경로를 계산해
 * MOVING_TO_SEAT 상태로 guest entity를 만들고, 없으면 pendingSeatQueue에 추가한다
 * (design 10.1 — order·unmet demand·patience·reputation을 만들지 않는다).
 */
export function planProcessArrival({ runtimePhase, service, campaign }, payload, config) {
  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE) {
    return failure("GUEST_FLOW_REQUIRES_SERVICE", { runtimePhase });
  }
  const plan = service.plans.find((candidate) => candidate.guestId === payload.guestId);
  if (!plan) return failure("GUEST_FLOW_PLAN_NOT_FOUND", { guestId: payload.guestId });
  const queued = service.pendingSeatQueue.includes(payload.guestId);
  if (service.guests.some((candidate) => candidate.guestId === payload.guestId) ||
      (queued && payload.promotePending !== true)) {
    return failure("GUEST_FLOW_ALREADY_PROCESSED", { guestId: payload.guestId });
  }

  const seat = firstVacantSeatPoint(config.seatPoints, service.guests);
  const serviceCandidate = cloneValue(service);
  if (!seat) {
    serviceCandidate.pendingSeatQueue = [...service.pendingSeatQueue, payload.guestId];
    return success({ service: serviceCandidate, queued: true, terminated: false, seatId: null, travelTimeMs: null });
  }

  const path = findShortestPath(
    config.guestPassabilityGrid,
    { x: config.spawnPoint.tileX, y: config.spawnPoint.tileY },
    { x: seat.tileX, y: seat.tileY },
  );
  if (!path.ok) {
    // design 10.4 "order 전" tier — entity를 만들지 않았으므로 tombstone만 기록한다
    // (Requirement 34 AC10, 정상 canonical content에서는 발생하지 않아야 하는 방어 경로).
    const terminated = terminateGuestInDraft(serviceCandidate, null, {
      guestId: payload.guestId,
      entityId: plan.entityId,
      cause: GUEST_TERMINATION_CAUSE.PATH_FAULT,
      tier: GUEST_CLEANUP_TIER.PRE_ORDER,
      day: campaign.day,
      atMs: null,
    });
    if (!terminated.ok) return terminated;
    return success({
      service: terminated.plan.service, queued: false, terminated: true, seatId: null, travelTimeMs: null,
    });
  }
  const travelTimeMs = computeTravelTimeMs(path.path, config.guestPassabilityGrid.tileSize);
  if (queued) {
    serviceCandidate.pendingSeatQueue = serviceCandidate.pendingSeatQueue.filter(
      (guestId) => guestId !== payload.guestId,
    );
  }

  const guest = {
    guestId: payload.guestId,
    entityId: plan.entityId,
    state: ORDER_GUEST_STATE.MOVING_TO_SEAT,
    seatId: seat.seatId,
    reaction: null,
  };
  const guestValidation = validateOrderGuest(guest, "guest");
  if (!guestValidation.ok) return guestValidation;
  serviceCandidate.guests = [...service.guests, guest];
  return success({ service: serviceCandidate, queued: false, terminated: false, seatId: seat.seatId, travelTimeMs });
}

export function createProcessArrivalAtomicTransaction(config) {
  return defineAtomicTransaction({
    name: GUEST_FLOW_COMMAND.PROCESS_ARRIVAL,
    readSet: PROCESS_ARRIVAL_READ_SET,
    writeSet: PROCESS_ARRIVAL_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planProcessArrival(
        { runtimePhase: ctx.phase, service: ctx.read("service"), campaign: ctx.read("campaign") },
        ctx.command.payload,
        config,
      );
    },
    mutate(draft) {
      const planned = planProcessArrival(
        { runtimePhase: RUNTIME_PHASE.SERVICE, service: draft.read("service"), campaign: draft.read("campaign") },
        draft.command.payload,
        config,
      );
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planProcessArrival(
        { runtimePhase: before.runtimePhase, service: before.service, campaign: before.campaign },
        ctx.command.payload,
        config,
      );
      if (!planned.ok) return planned;
      return equivalent(after.service, planned.plan.service)
        ? validationSuccess()
        : failure("GUEST_FLOW_POSTCONDITION_FAILED");
    },
    events(before, _after, ctx) {
      const planned = planProcessArrival(
        { runtimePhase: before.runtimePhase, service: before.service, campaign: before.campaign },
        ctx.command.payload,
        config,
      );
      if (!planned.ok) return [];
      if (planned.plan.terminated) {
        return [{ type: "guest-flow.arrival-path-fault", payload: { guestId: ctx.command.payload.guestId } }];
      }
      return [{
        type: planned.plan.queued ? "guest-flow.arrival-queued" : "guest-flow.moving-to-seat",
        payload: {
          guestId: ctx.command.payload.guestId,
          seatId: planned.plan.seatId,
          travelTimeMs: planned.plan.travelTimeMs,
        },
      }];
    },
  });
}

/** MOVING_TO_SEAT→SEATED. travelTimeMs 뒤 예약된 scheduler 이벤트로만 dispatch된다. */
export function planSeatArrival({ runtimePhase, service }, payload) {
  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE) {
    return failure("GUEST_FLOW_REQUIRES_SERVICE", { runtimePhase });
  }
  const guest = service.guests.find((candidate) => candidate.guestId === payload.guestId);
  if (!guest) return failure("GUEST_FLOW_GUEST_NOT_FOUND", { guestId: payload.guestId });
  if (guest.state !== ORDER_GUEST_STATE.MOVING_TO_SEAT) {
    return failure("GUEST_FLOW_NOT_MOVING_TO_SEAT", { guestId: payload.guestId, state: guest.state });
  }
  const serviceCandidate = cloneValue(service);
  const guestCandidate = serviceCandidate.guests.find((candidate) => candidate.guestId === payload.guestId);
  guestCandidate.state = ORDER_GUEST_STATE.SEATED;
  const validation = validateOrderGuest(guestCandidate, "guest");
  if (!validation.ok) return validation;
  return success({ service: serviceCandidate });
}

export function createSeatArrivalAtomicTransaction() {
  return defineAtomicTransaction({
    name: GUEST_FLOW_COMMAND.SEAT_ARRIVAL,
    readSet: SEAT_ARRIVAL_READ_SET,
    writeSet: SEAT_ARRIVAL_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planSeatArrival({ runtimePhase: ctx.phase, service: ctx.read("service") }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planSeatArrival(
        { runtimePhase: RUNTIME_PHASE.SERVICE, service: draft.read("service") },
        draft.command.payload,
      );
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planSeatArrival({ runtimePhase: before.runtimePhase, service: before.service }, ctx.command.payload);
      if (!planned.ok) return planned;
      return equivalent(after.service, planned.plan.service)
        ? validationSuccess()
        : failure("GUEST_FLOW_POSTCONDITION_FAILED");
    },
    events(_before, _after, ctx) {
      return [{ type: "guest-flow.seated", payload: { guestId: ctx.command.payload.guestId } }];
    },
  });
}

export class GuestFlowSystem {
  constructor(commandBus, { seatPoints, spawnPoint, guestPassabilityGrid, register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("GuestFlowSystem에는 CommandBus가 필요합니다.");
    }
    if (!Array.isArray(seatPoints) || seatPoints.length === 0) {
      throw new TypeError("GuestFlowSystem에는 seatPoints 배열이 필요합니다.");
    }
    if (!spawnPoint || !guestPassabilityGrid) {
      throw new TypeError("GuestFlowSystem에는 spawnPoint/guestPassabilityGrid가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.config = { seatPoints, spawnPoint, guestPassabilityGrid };
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(GUEST_FLOW_COMMAND.PROCESS_ARRIVAL, createProcessArrivalAtomicTransaction(this.config));
    this.commandBus.register(GUEST_FLOW_COMMAND.SEAT_ARRIVAL, createSeatArrivalAtomicTransaction());
    this.registered = true;
    return this;
  }

  processArrival(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: GUEST_FLOW_COMMAND.PROCESS_ARRIVAL,
      payload: input?.payload,
      readSet: [...PROCESS_ARRIVAL_READ_SET],
      writeSet: [...PROCESS_ARRIVAL_WRITE_SET],
    });
  }

  seatArrival(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: GUEST_FLOW_COMMAND.SEAT_ARRIVAL,
      payload: input?.payload,
      readSet: [...SEAT_ARRIVAL_READ_SET],
      writeSet: [...SEAT_ARRIVAL_WRITE_SET],
    });
  }
}

export function registerGuestFlowSystem(commandBus, config) {
  return new GuestFlowSystem(commandBus, { ...config, register: true });
}
