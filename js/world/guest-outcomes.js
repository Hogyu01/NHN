import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { ORDER_GUEST_STATE, validateOrderGuest } from "../domain/orders.js";
import { RUNTIME_PHASE } from "../domain/timer-state.js";
import { GUEST_CLEANUP_TIER, GUEST_TERMINATION_CAUSE, terminateGuestInDraft } from "./guest-cleanup.js";
import { computeTravelTimeMs } from "./guest-flow.js";
import { findShortestPath } from "./pathfinder.js";

/**
 * Task 31 — design.md 10.3. MEAL_REACTION(480ms, 4×120ms)이 끝나면 Seat→Exit BFS를 만들어
 * MOVING_TO_EXIT로 옮기고, Exit_Point에 도착하면 seat 해제·visual 제거·EXITED를 한 transaction
 * 으로 commit한다(우리 아키텍처에서는 guest를 service.guests에서 제거하는 것 자체가 그 셋을
 * 동시에 만족한다 — Task 30처럼 seat 점유는 guest.state 파생값이라 별도 registry가 없다).
 * exit path가 끊어져 있으면(runtime path fault) design 10.4의 "committed sale 후" tier로
 * 판매·회계를 그대로 두고 guest만 원자 종료한다.
 */

export const GUEST_OUTCOME_COMMAND = Object.freeze({
  REACTION_COMPLETE: "guest-flow.reaction.complete",
  EXIT_ARRIVAL: "guest-flow.exit.arrival",
});

export const REACTION_COMPLETE_READ_SET = Object.freeze(["campaign"]);
export const REACTION_COMPLETE_WRITE_SET = Object.freeze(["service", "saleSlots"]);
export const EXIT_ARRIVAL_READ_SET = Object.freeze([]);
export const EXIT_ARRIVAL_WRITE_SET = Object.freeze(["service"]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_GUEST_OUTCOME_PAYLOAD: "GuestFlow reaction/exit 요청 형식이 올바르지 않습니다.",
  GUEST_OUTCOME_REQUIRES_SERVICE: "실행 중인 Service에서만 reaction/exit을 처리할 수 있습니다.",
  GUEST_OUTCOME_GUEST_NOT_FOUND: "손님을 찾을 수 없습니다.",
  GUEST_OUTCOME_NOT_MEAL_REACTION: "MEAL_REACTION 상태의 손님만 퇴장을 시작할 수 있습니다.",
  GUEST_OUTCOME_NOT_MOVING_TO_EXIT: "MOVING_TO_EXIT 상태의 손님만 Exit에 도착할 수 있습니다.",
  GUEST_OUTCOME_SEAT_NOT_FOUND: "손님의 seat 정보를 찾을 수 없습니다.",
  GUEST_OUTCOME_POSTCONDITION_FAILED: "reaction/exit 원자 변경 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "GuestFlow reaction/exit 검증에 실패했습니다.",
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

function validatePayload(payload) {
  return isPlainRecord(payload) && isStableIdentifier(payload.guestId)
    ? validationSuccess()
    : failure("INVALID_GUEST_OUTCOME_PAYLOAD");
}

/**
 * MEAL_REACTION→MOVING_TO_EXIT(happy path) 또는 exit path fault 시 guest 원자 종료
 * (design 10.4 "committed sale 후" tier — 이 시점에는 항상 order가 이미 종결돼 있다).
 */
export function planReactionComplete({ runtimePhase, service, saleSlots, campaign }, payload, config) {
  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE) {
    return failure("GUEST_OUTCOME_REQUIRES_SERVICE", { runtimePhase });
  }
  const guest = service.guests.find((candidate) => candidate.guestId === payload.guestId);
  if (!guest) return failure("GUEST_OUTCOME_GUEST_NOT_FOUND", { guestId: payload.guestId });
  if (guest.state !== ORDER_GUEST_STATE.MEAL_REACTION) {
    return failure("GUEST_OUTCOME_NOT_MEAL_REACTION", { guestId: payload.guestId, state: guest.state });
  }
  const seat = config.seatPoints.find((point) => point.seatId === guest.seatId);
  if (!seat) return failure("GUEST_OUTCOME_SEAT_NOT_FOUND", { guestId: payload.guestId, seatId: guest.seatId });

  const path = findShortestPath(
    config.guestPassabilityGrid,
    { x: seat.tileX, y: seat.tileY },
    { x: config.exitPoint.tileX, y: config.exitPoint.tileY },
  );
  const serviceCandidate = cloneValue(service);
  if (!path.ok) {
    const terminated = terminateGuestInDraft(serviceCandidate, cloneValue(saleSlots), {
      guestId: payload.guestId,
      entityId: guest.entityId,
      cause: GUEST_TERMINATION_CAUSE.PATH_FAULT,
      tier: GUEST_CLEANUP_TIER.POST_SALE,
      day: campaign.day,
      atMs: null,
    });
    if (!terminated.ok) return terminated;
    return success({
      service: terminated.plan.service,
      saleSlots: terminated.plan.saleSlots,
      terminated: true,
      travelTimeMs: null,
    });
  }
  const travelTimeMs = computeTravelTimeMs(path.path, config.guestPassabilityGrid.tileSize);
  const guestCandidate = serviceCandidate.guests.find((candidate) => candidate.guestId === payload.guestId);
  guestCandidate.state = ORDER_GUEST_STATE.MOVING_TO_EXIT;
  guestCandidate.reaction = null;
  const guestValidation = validateOrderGuest(guestCandidate, "guest");
  if (!guestValidation.ok) return guestValidation;
  return success({ service: serviceCandidate, saleSlots, terminated: false, travelTimeMs });
}

export function createReactionCompleteAtomicTransaction(config) {
  return defineAtomicTransaction({
    name: GUEST_OUTCOME_COMMAND.REACTION_COMPLETE,
    readSet: REACTION_COMPLETE_READ_SET,
    writeSet: REACTION_COMPLETE_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planReactionComplete({
        runtimePhase: ctx.phase,
        service: ctx.read("service"),
        saleSlots: ctx.read("saleSlots"),
        campaign: ctx.read("campaign"),
      }, ctx.command.payload, config);
    },
    mutate(draft) {
      const planned = planReactionComplete({
        runtimePhase: RUNTIME_PHASE.SERVICE,
        service: draft.read("service"),
        saleSlots: draft.read("saleSlots"),
        campaign: draft.read("campaign"),
      }, draft.command.payload, config);
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      draft.replace("saleSlots", planned.plan.saleSlots);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planReactionComplete({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
        campaign: before.campaign,
      }, ctx.command.payload, config);
      if (!planned.ok) return planned;
      return equivalent(after.service, planned.plan.service) && equivalent(after.saleSlots, planned.plan.saleSlots)
        ? validationSuccess()
        : failure("GUEST_OUTCOME_POSTCONDITION_FAILED");
    },
    events(before, _after, ctx) {
      const planned = planReactionComplete({
        runtimePhase: before.runtimePhase,
        service: before.service,
        saleSlots: before.saleSlots,
        campaign: before.campaign,
      }, ctx.command.payload, config);
      if (!planned.ok) return [];
      if (planned.plan.terminated) {
        return [{
          type: "guest-flow.exit-path-fault",
          payload: { guestId: ctx.command.payload.guestId },
        }];
      }
      return [{
        type: "guest-flow.moving-to-exit",
        payload: { guestId: ctx.command.payload.guestId, travelTimeMs: planned.plan.travelTimeMs },
      }];
    },
  });
}

/** MOVING_TO_EXIT→EXITED. seat 해제·visual 제거·EXITED가 guest 제거 하나로 함께 커밋된다. */
export function planExitArrival({ runtimePhase, service }, payload) {
  const payloadValidation = validatePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE) {
    return failure("GUEST_OUTCOME_REQUIRES_SERVICE", { runtimePhase });
  }
  const guest = service.guests.find((candidate) => candidate.guestId === payload.guestId);
  if (!guest) return failure("GUEST_OUTCOME_GUEST_NOT_FOUND", { guestId: payload.guestId });
  if (guest.state !== ORDER_GUEST_STATE.MOVING_TO_EXIT) {
    return failure("GUEST_OUTCOME_NOT_MOVING_TO_EXIT", { guestId: payload.guestId, state: guest.state });
  }
  const serviceCandidate = cloneValue(service);
  serviceCandidate.guests = serviceCandidate.guests.filter((candidate) => candidate.guestId !== payload.guestId);
  return success({ service: serviceCandidate });
}

export function createExitArrivalAtomicTransaction() {
  return defineAtomicTransaction({
    name: GUEST_OUTCOME_COMMAND.EXIT_ARRIVAL,
    readSet: EXIT_ARRIVAL_READ_SET,
    writeSet: EXIT_ARRIVAL_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planExitArrival({ runtimePhase: ctx.phase, service: ctx.read("service") }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planExitArrival(
        { runtimePhase: RUNTIME_PHASE.SERVICE, service: draft.read("service") },
        draft.command.payload,
      );
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planExitArrival({ runtimePhase: before.runtimePhase, service: before.service }, ctx.command.payload);
      if (!planned.ok) return planned;
      return equivalent(after.service, planned.plan.service)
        ? validationSuccess()
        : failure("GUEST_OUTCOME_POSTCONDITION_FAILED");
    },
    events(_before, _after, ctx) {
      return [{ type: "guest-flow.exited", payload: { guestId: ctx.command.payload.guestId } }];
    },
  });
}

export class GuestOutcomeSystem {
  constructor(commandBus, { seatPoints, exitPoint, guestPassabilityGrid, register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("GuestOutcomeSystem에는 CommandBus가 필요합니다.");
    }
    if (!Array.isArray(seatPoints) || seatPoints.length === 0) {
      throw new TypeError("GuestOutcomeSystem에는 seatPoints 배열이 필요합니다.");
    }
    if (!exitPoint || !guestPassabilityGrid) {
      throw new TypeError("GuestOutcomeSystem에는 exitPoint/guestPassabilityGrid가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.config = { seatPoints, exitPoint, guestPassabilityGrid };
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(GUEST_OUTCOME_COMMAND.REACTION_COMPLETE, createReactionCompleteAtomicTransaction(this.config));
    this.commandBus.register(GUEST_OUTCOME_COMMAND.EXIT_ARRIVAL, createExitArrivalAtomicTransaction());
    this.registered = true;
    return this;
  }

  reactionComplete(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: GUEST_OUTCOME_COMMAND.REACTION_COMPLETE,
      payload: input?.payload,
      readSet: [...REACTION_COMPLETE_READ_SET],
      writeSet: [...REACTION_COMPLETE_WRITE_SET],
    });
  }

  exitArrival(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: GUEST_OUTCOME_COMMAND.EXIT_ARRIVAL,
      payload: input?.payload,
      readSet: [...EXIT_ARRIVAL_READ_SET],
      writeSet: [...EXIT_ARRIVAL_WRITE_SET],
    });
  }
}

export function registerGuestOutcomeSystem(commandBus, config) {
  return new GuestOutcomeSystem(commandBus, { ...config, register: true });
}
