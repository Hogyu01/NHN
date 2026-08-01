import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import { validateScheduledGuestPlans } from "./guest-plans.js";

export const RUNTIME_PHASE = Object.freeze({
  TITLE: "TITLE",
  PLANNING: "PLANNING",
  SERVICE: "SERVICE",
  PAUSED: "PAUSED",
  SETTLEMENT: "SETTLEMENT",
  TERMINAL: "TERMINAL",
});

export const RUNTIME_PHASES = Object.freeze(Object.values(RUNTIME_PHASE));

export const SERVICE_LIFECYCLE = Object.freeze({
  INACTIVE: "INACTIVE",
  RUNNING: "RUNNING",
  RESULTS_CLOSED_CLEANUP: "RESULTS_CLOSED_CLEANUP",
});

export const SERVICE_END_REASON = Object.freeze({
  TIMER_ZERO: "TIMER_ZERO",
  EARLY_COMPLETION: "EARLY_COMPLETION",
});

export const SERVICE_TIMER_LIMITS = Object.freeze({
  minimumDurationMs: 90_000,
  maximumDurationMs: 105_000,
  defaultDurationMs: 105_000,
  maximumCleanupOvertimeMs: 12_000,
  defaultCleanupOvertimeMs: 12_000,
});

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_SERVICE_TIMER_STATE: "Service timer 상태 형식이 올바르지 않습니다.",
  INVALID_SERVICE_TIMER_CONFIGURATION: "Service timer 설정이 허용 범위를 벗어났습니다.",
  INVALID_SERVICE_TIMER_VALUE: "Service timer 값이 올바르지 않습니다.",
  INVALID_SERVICE_LIFECYCLE: "Service lifecycle 값이 올바르지 않습니다.",
  INVALID_SERVICE_TRANSIENT_COLLECTION: "Service transient collection이 올바르지 않습니다.",
  SERVICE_GUEST_PLAN_INVALID: "활성 Service의 예약 손님 계획이 올바르지 않습니다.",
  INVALID_SERVICE_START_REFERENCE: "Service 시작 계획 참조가 올바르지 않습니다.",
  INVALID_SERVICE_TRANSITION_TOKEN: "Settlement 전이 토큰이 올바르지 않습니다.",
  INVALID_SERVICE_END_REASON: "Service 종료 사유가 올바르지 않습니다.",
  INVALID_SERVICE_RESUME_LIFECYCLE: "Service resume lifecycle이 올바르지 않습니다.",
  INACTIVE_SERVICE_STATE_INVALID: "비활성 Service에 transient 또는 종료 상태가 남아 있습니다.",
  RUNNING_SERVICE_STATE_INVALID: "실행 중 Service 상태 불변식이 깨졌습니다.",
  CLEANUP_SERVICE_STATE_INVALID: "결과 폐쇄 cleanup 상태 불변식이 깨졌습니다.",
  SERVICE_PHASE_STATE_MISMATCH: "Runtime phase와 Service lifecycle이 일치하지 않습니다.",
  SERVICE_NOT_RUNNING: "실행 중 Service에서만 결과를 닫을 수 있습니다.",
  SERVICE_NOT_ACTIVE: "활성 Service에서만 pause할 수 있습니다.",
  SERVICE_NOT_PAUSED: "pause된 Service lifecycle만 resume할 수 있습니다.",
  SETTLEMENT_TRANSITION_TOKEN_MISMATCH: "Settlement 전이 토큰이 현재 Service 토큰과 다릅니다.",
  SETTLEMENT_TRANSITION_ALREADY_ISSUED: "Settlement 전이가 이미 한 번 발행됐습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "Service timer 상태 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasNoServiceTransients(state) {
  return state.plans.length === 0 && state.guests.length === 0 && state.orders.length === 0 &&
    state.timingCook === null && state.completedDishes.length === 0 &&
    state.carriedDishId === null && state.unmetDemandCount === 0;
}

/** Validates the serializable Service timer/lifecycle slice and, optionally, its top-level phase. */
export function validateServiceTimerState(state, { runtimePhase = null } = {}) {
  if (!isPlainRecord(state)) return failure("INVALID_SERVICE_TIMER_STATE");
  if (!Object.values(SERVICE_LIFECYCLE).includes(state.lifecycle)) {
    return failure("INVALID_SERVICE_LIFECYCLE", { lifecycle: state.lifecycle });
  }
  if (!Number.isSafeInteger(state.durationMs) ||
      state.durationMs < SERVICE_TIMER_LIMITS.minimumDurationMs ||
      state.durationMs > SERVICE_TIMER_LIMITS.maximumDurationMs ||
      !Number.isSafeInteger(state.cleanupOvertimeMs) ||
      state.cleanupOvertimeMs < 0 ||
      state.cleanupOvertimeMs > SERVICE_TIMER_LIMITS.maximumCleanupOvertimeMs) {
    return failure("INVALID_SERVICE_TIMER_CONFIGURATION", {
      durationMs: state.durationMs,
      cleanupOvertimeMs: state.cleanupOvertimeMs,
    });
  }
  if (!isNonNegativeSafeInteger(state.remainingMs) || state.remainingMs > state.durationMs ||
      !isNonNegativeSafeInteger(state.cleanupElapsedMs) ||
      state.cleanupElapsedMs > state.cleanupOvertimeMs ||
      !isNonNegativeSafeInteger(state.unmetDemandCount)) {
    return failure("INVALID_SERVICE_TIMER_VALUE", {
      remainingMs: state.remainingMs,
      cleanupElapsedMs: state.cleanupElapsedMs,
      unmetDemandCount: state.unmetDemandCount,
    });
  }
  if (typeof state.resultsClosed !== "boolean" ||
      typeof state.settlementTransitionIssued !== "boolean") {
    return failure("INVALID_SERVICE_TIMER_STATE", { field: "boolean flags" });
  }
  for (const field of ["plans", "guests", "orders", "completedDishes"]) {
    if (!Array.isArray(state[field])) {
      return failure("INVALID_SERVICE_TRANSIENT_COLLECTION", { field });
    }
  }
  if (state.lifecycle !== SERVICE_LIFECYCLE.INACTIVE) {
    const planValidation = validateScheduledGuestPlans(state.plans, {
      durationMs: state.durationMs,
    });
    if (!planValidation.ok) {
      return failure("SERVICE_GUEST_PLAN_INVALID", {
        cause: planValidation.code,
        planDetails: planValidation.details,
      });
    }
  }
  if (state.timingCook !== null && !isPlainRecord(state.timingCook)) {
    return failure("INVALID_SERVICE_TIMER_STATE", { field: "timingCook" });
  }
  if (state.carriedDishId !== null && !isStableIdentifier(state.carriedDishId)) {
    return failure("INVALID_SERVICE_TIMER_STATE", { field: "carriedDishId" });
  }
  if (state.startedDay !== null &&
      (!Number.isSafeInteger(state.startedDay) || state.startedDay < 1 || state.startedDay > 14)) {
    return failure("INVALID_SERVICE_START_REFERENCE", { field: "startedDay", value: state.startedDay });
  }
  if (state.startedPlanId !== null && !isStableIdentifier(state.startedPlanId)) {
    return failure("INVALID_SERVICE_START_REFERENCE", { field: "startedPlanId" });
  }
  if (!isNonNegativeSafeInteger(state.startedPlanRevision)) {
    return failure("INVALID_SERVICE_START_REFERENCE", {
      field: "startedPlanRevision",
      value: state.startedPlanRevision,
    });
  }
  if (state.settlementTransitionToken !== null &&
      !isStableIdentifier(state.settlementTransitionToken)) {
    return failure("INVALID_SERVICE_TRANSITION_TOKEN", {
      settlementTransitionToken: state.settlementTransitionToken,
    });
  }
  if (state.endReason !== null && !Object.values(SERVICE_END_REASON).includes(state.endReason)) {
    return failure("INVALID_SERVICE_END_REASON", { endReason: state.endReason });
  }
  if (state.resumeLifecycle !== null &&
      ![SERVICE_LIFECYCLE.RUNNING, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP].includes(state.resumeLifecycle)) {
    return failure("INVALID_SERVICE_RESUME_LIFECYCLE", { resumeLifecycle: state.resumeLifecycle });
  }
  if (state.resumeLifecycle !== null && state.resumeLifecycle !== state.lifecycle) {
    return failure("INVALID_SERVICE_RESUME_LIFECYCLE", {
      lifecycle: state.lifecycle,
      resumeLifecycle: state.resumeLifecycle,
    });
  }

  if (state.lifecycle === SERVICE_LIFECYCLE.INACTIVE) {
    const valid = state.remainingMs === state.durationMs && state.cleanupElapsedMs === 0 &&
      !state.resultsClosed && state.startedDay === null && state.startedPlanId === null &&
      state.startedPlanRevision === 0 && state.settlementTransitionToken === null &&
      !state.settlementTransitionIssued && state.endReason === null &&
      state.resumeLifecycle === null && hasNoServiceTransients(state);
    if (!valid) return failure("INACTIVE_SERVICE_STATE_INVALID");
  } else if (state.lifecycle === SERVICE_LIFECYCLE.RUNNING) {
    const valid = state.remainingMs > 0 && state.cleanupElapsedMs === 0 &&
      !state.resultsClosed && state.startedDay !== null && state.startedPlanId !== null &&
      state.startedPlanRevision > 0 && state.settlementTransitionToken !== null &&
      !state.settlementTransitionIssued && state.endReason === null;
    if (!valid) return failure("RUNNING_SERVICE_STATE_INVALID");
  } else {
    const valid = state.remainingMs === 0 && state.resultsClosed &&
      state.startedDay !== null && state.startedPlanId !== null &&
      state.startedPlanRevision > 0 && state.settlementTransitionToken !== null &&
      state.endReason !== null;
    if (!valid) return failure("CLEANUP_SERVICE_STATE_INVALID");
  }

  if (runtimePhase !== null) {
    if (!RUNTIME_PHASES.includes(runtimePhase)) {
      return failure("SERVICE_PHASE_STATE_MISMATCH", { runtimePhase });
    }
    const phaseMatches = (
      ([RUNTIME_PHASE.TITLE, RUNTIME_PHASE.PLANNING, RUNTIME_PHASE.TERMINAL].includes(runtimePhase) &&
        state.lifecycle === SERVICE_LIFECYCLE.INACTIVE) ||
      (runtimePhase === RUNTIME_PHASE.SERVICE &&
        state.lifecycle !== SERVICE_LIFECYCLE.INACTIVE && state.resumeLifecycle === null &&
        !(state.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP && state.settlementTransitionIssued)) ||
      (runtimePhase === RUNTIME_PHASE.PAUSED &&
        state.lifecycle !== SERVICE_LIFECYCLE.INACTIVE && state.resumeLifecycle === state.lifecycle &&
        !state.settlementTransitionIssued) ||
      (runtimePhase === RUNTIME_PHASE.SETTLEMENT &&
        state.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP &&
        state.settlementTransitionIssued && state.resumeLifecycle === null)
    );
    if (!phaseMatches) {
      return failure("SERVICE_PHASE_STATE_MISMATCH", {
        runtimePhase,
        lifecycle: state.lifecycle,
        resumeLifecycle: state.resumeLifecycle,
        settlementTransitionIssued: state.settlementTransitionIssued,
      });
    }
  }

  return validationSuccess({
    lifecycle: state.lifecycle,
    remainingMs: state.remainingMs,
    resultsClosed: state.resultsClosed,
  });
}

export function createServiceTimerState({
  durationMs = SERVICE_TIMER_LIMITS.defaultDurationMs,
  cleanupOvertimeMs = SERVICE_TIMER_LIMITS.defaultCleanupOvertimeMs,
  lifecycle = SERVICE_LIFECYCLE.INACTIVE,
  remainingMs = durationMs,
  cleanupElapsedMs = 0,
  resultsClosed = false,
  plans = [],
  guests = [],
  orders = [],
  timingCook = null,
  completedDishes = [],
  carriedDishId = null,
  unmetDemandCount = 0,
  startedDay = null,
  startedPlanId = null,
  startedPlanRevision = 0,
  settlementTransitionToken = null,
  settlementTransitionIssued = false,
  resumeLifecycle = null,
  endReason = null,
} = {}) {
  const state = {
    lifecycle,
    durationMs,
    remainingMs,
    cleanupElapsedMs,
    cleanupOvertimeMs,
    resultsClosed,
    plans: cloneValue(plans),
    guests: cloneValue(guests),
    orders: cloneValue(orders),
    timingCook: timingCook === null ? null : cloneValue(timingCook),
    completedDishes: cloneValue(completedDishes),
    carriedDishId,
    unmetDemandCount,
    startedDay,
    startedPlanId,
    startedPlanRevision,
    settlementTransitionToken,
    settlementTransitionIssued,
    resumeLifecycle,
    endReason,
  };
  const validation = validateServiceTimerState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 ServiceTimerState입니다: ${validation.code}`);
    error.code = validation.code;
    error.details = validation.details;
    throw error;
  }
  return freezeDeep(state);
}

export function resetServiceTimerState(state) {
  const validation = validateServiceTimerState(state);
  if (!validation.ok) return validation;
  return Object.freeze({
    ok: true,
    state: createServiceTimerState({
      durationMs: state.durationMs,
      cleanupOvertimeMs: state.cleanupOvertimeMs,
    }),
  });
}

export function startServiceTimerState(state, {
  day,
  planId,
  planRevision,
  transitionToken,
  plans,
} = {}) {
  const validation = validateServiceTimerState(state);
  if (!validation.ok) return validation;
  if (state.lifecycle !== SERVICE_LIFECYCLE.INACTIVE) {
    return failure("SERVICE_NOT_ACTIVE", { lifecycle: state.lifecycle });
  }
  try {
    return Object.freeze({
      ok: true,
      state: createServiceTimerState({
        durationMs: state.durationMs,
        cleanupOvertimeMs: state.cleanupOvertimeMs,
        lifecycle: SERVICE_LIFECYCLE.RUNNING,
        remainingMs: state.durationMs,
        startedDay: day,
        startedPlanId: planId,
        startedPlanRevision: planRevision,
        settlementTransitionToken: transitionToken,
        plans,
      }),
    });
  } catch (error) {
    return failure(error?.code ?? "INVALID_SERVICE_START_REFERENCE", error?.details);
  }
}

export function closeServiceResultsState(state, endReason) {
  const validation = validateServiceTimerState(state);
  if (!validation.ok) return validation;
  if (state.lifecycle !== SERVICE_LIFECYCLE.RUNNING || state.resultsClosed) {
    return failure("SERVICE_NOT_RUNNING", { lifecycle: state.lifecycle, resultsClosed: state.resultsClosed });
  }
  if (!Object.values(SERVICE_END_REASON).includes(endReason)) {
    return failure("INVALID_SERVICE_END_REASON", { endReason });
  }
  const candidate = cloneValue(state);
  candidate.lifecycle = SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP;
  candidate.remainingMs = 0;
  candidate.cleanupElapsedMs = 0;
  candidate.resultsClosed = true;
  candidate.endReason = endReason;
  candidate.resumeLifecycle = null;
  const nextValidation = validateServiceTimerState(candidate);
  return nextValidation.ok
    ? Object.freeze({ ok: true, state: freezeDeep(candidate) })
    : nextValidation;
}

export function pauseServiceTimerState(state) {
  const validation = validateServiceTimerState(state);
  if (!validation.ok) return validation;
  if (state.lifecycle === SERVICE_LIFECYCLE.INACTIVE || state.settlementTransitionIssued) {
    return failure("SERVICE_NOT_ACTIVE", {
      lifecycle: state.lifecycle,
      settlementTransitionIssued: state.settlementTransitionIssued,
    });
  }
  const candidate = cloneValue(state);
  candidate.resumeLifecycle = candidate.lifecycle;
  return Object.freeze({ ok: true, state: freezeDeep(candidate) });
}

export function resumeServiceTimerState(state) {
  const validation = validateServiceTimerState(state);
  if (!validation.ok) return validation;
  if (state.lifecycle === SERVICE_LIFECYCLE.INACTIVE || state.resumeLifecycle !== state.lifecycle) {
    return failure("SERVICE_NOT_PAUSED", {
      lifecycle: state.lifecycle,
      resumeLifecycle: state.resumeLifecycle,
    });
  }
  const candidate = cloneValue(state);
  candidate.resumeLifecycle = null;
  return Object.freeze({ ok: true, state: freezeDeep(candidate) });
}

export function issueSettlementTransitionState(state, transitionToken) {
  const validation = validateServiceTimerState(state);
  if (!validation.ok) return validation;
  if (state.lifecycle !== SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP || !state.resultsClosed) {
    return failure("CLEANUP_SERVICE_STATE_INVALID", { lifecycle: state.lifecycle });
  }
  if (state.settlementTransitionIssued) {
    return failure("SETTLEMENT_TRANSITION_ALREADY_ISSUED");
  }
  if (transitionToken !== state.settlementTransitionToken) {
    return failure("SETTLEMENT_TRANSITION_TOKEN_MISMATCH", {
      expected: state.settlementTransitionToken,
      actual: transitionToken,
    });
  }
  const candidate = cloneValue(state);
  candidate.settlementTransitionIssued = true;
  candidate.resumeLifecycle = null;
  return Object.freeze({ ok: true, state: freezeDeep(candidate) });
}

export function projectServiceTimer(state, runtimePhase) {
  const validation = validateServiceTimerState(state, { runtimePhase });
  if (!validation.ok) {
    const error = new TypeError(`Service timer projection이 유효하지 않습니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep({
    runtimePhase,
    lifecycle: state.lifecycle,
    durationMs: state.durationMs,
    remainingMs: state.remainingMs,
    cleanupElapsedMs: state.cleanupElapsedMs,
    cleanupOvertimeMs: state.cleanupOvertimeMs,
    resultsClosed: state.resultsClosed,
    paused: runtimePhase === RUNTIME_PHASE.PAUSED,
    startedDay: state.startedDay,
    startedPlanId: state.startedPlanId,
    startedPlanRevision: state.startedPlanRevision,
    endReason: state.endReason,
    settlementTransitionToken: state.settlementTransitionToken,
    settlementTransitionIssued: state.settlementTransitionIssued,
  });
}
