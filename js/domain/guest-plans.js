import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";

export const SCHEDULED_GUEST_LIMITS = Object.freeze({
  minimumCount: 4,
  defaultCount: 6,
  maximumCount: 12,
});

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_SCHEDULED_GUEST_PLAN: "예약 손님 계획 형식이 올바르지 않습니다.",
  INVALID_SCHEDULED_GUEST_PLAN_ID: "예약 손님 계획 ID가 올바르지 않습니다.",
  INVALID_SCHEDULED_GUEST_SEQUENCE: "예약 손님 계획 순번이 올바르지 않습니다.",
  INVALID_SCHEDULED_GUEST_ARRIVAL: "손님 도착 시각이 Service 범위를 벗어났습니다.",
  INVALID_SCHEDULED_GUEST_PREFERENCE: "손님 Recipe 선호 목록이 올바르지 않습니다.",
  DUPLICATE_SCHEDULED_GUEST_ID: "예약 손님 Guest_ID가 중복되었습니다.",
  DUPLICATE_SCHEDULED_ENTITY_ID: "예약 손님 Entity_ID가 중복되었습니다.",
  SCHEDULED_GUEST_COUNT_OUT_OF_RANGE: "예약 손님 수는 4명 이상 12명 이하여야 합니다.",
  SCHEDULED_GUEST_COUNT_MISMATCH: "생성된 예약 손님 수가 계획 수와 다릅니다.",
  SCHEDULED_GUEST_PLAN_ORDER_INVALID: "예약 손님 계획의 결정론적 순서가 올바르지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "예약 손님 계획 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Arrival is the scheduler key; ties are planSequence → Guest_ID → Entity_ID. */
export function compareScheduledGuestPlans(left, right) {
  return left.arrivalAtMs - right.arrivalAtMs ||
    left.planSequence - right.planSequence ||
    compareIds(left.guestId, right.guestId) ||
    compareIds(left.entityId, right.entityId);
}

export function validateScheduledGuestPlan(plan, {
  durationMs,
  expectedSequence = null,
  field = "plan",
} = {}) {
  if (!isPlainRecord(plan)) return failure("INVALID_SCHEDULED_GUEST_PLAN", { field });
  for (const name of ["guestId", "entityId", "archetypeId"]) {
    if (!isStableIdentifier(plan[name])) {
      return failure("INVALID_SCHEDULED_GUEST_PLAN_ID", {
        field: `${field}.${name}`,
        value: plan[name],
      });
    }
  }
  if (!Number.isSafeInteger(plan.planSequence) || plan.planSequence < 0 ||
      (expectedSequence !== null && plan.planSequence !== expectedSequence)) {
    return failure("INVALID_SCHEDULED_GUEST_SEQUENCE", {
      field: `${field}.planSequence`,
      expectedSequence,
      actual: plan.planSequence,
    });
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 ||
      !Number.isSafeInteger(plan.arrivalAtMs) ||
      plan.arrivalAtMs < 0 || plan.arrivalAtMs >= durationMs) {
    return failure("INVALID_SCHEDULED_GUEST_ARRIVAL", {
      field: `${field}.arrivalAtMs`,
      arrivalAtMs: plan.arrivalAtMs,
      durationMs,
    });
  }
  if (!Array.isArray(plan.recipePreference) || plan.recipePreference.length === 0) {
    return failure("INVALID_SCHEDULED_GUEST_PREFERENCE", { field: `${field}.recipePreference` });
  }
  const recipeIds = new Set();
  for (let index = 0; index < plan.recipePreference.length; index += 1) {
    const recipeId = plan.recipePreference[index];
    if (!isStableIdentifier(recipeId) || recipeIds.has(recipeId)) {
      return failure("INVALID_SCHEDULED_GUEST_PREFERENCE", {
        field: `${field}.recipePreference[${index}]`,
        recipeId,
      });
    }
    recipeIds.add(recipeId);
  }
  return validationSuccess();
}

export function validateScheduledGuestPlans(plans, {
  durationMs,
  expectedCount = null,
} = {}) {
  if (!Array.isArray(plans)) return failure("INVALID_SCHEDULED_GUEST_PLAN", { field: "plans" });
  if (plans.length < SCHEDULED_GUEST_LIMITS.minimumCount ||
      plans.length > SCHEDULED_GUEST_LIMITS.maximumCount) {
    return failure("SCHEDULED_GUEST_COUNT_OUT_OF_RANGE", { count: plans.length });
  }
  if (expectedCount !== null && plans.length !== expectedCount) {
    return failure("SCHEDULED_GUEST_COUNT_MISMATCH", { expectedCount, actualCount: plans.length });
  }
  const guestIds = new Set();
  const entityIds = new Set();
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const validation = validateScheduledGuestPlan(plan, {
      durationMs,
      expectedSequence: index,
      field: `plans[${index}]`,
    });
    if (!validation.ok) return validation;
    if (guestIds.has(plan.guestId)) {
      return failure("DUPLICATE_SCHEDULED_GUEST_ID", { guestId: plan.guestId });
    }
    if (entityIds.has(plan.entityId)) {
      return failure("DUPLICATE_SCHEDULED_ENTITY_ID", { entityId: plan.entityId });
    }
    guestIds.add(plan.guestId);
    entityIds.add(plan.entityId);
    if (index > 0 && compareScheduledGuestPlans(plans[index - 1], plan) > 0) {
      return failure("SCHEDULED_GUEST_PLAN_ORDER_INVALID", { index });
    }
  }
  return validationSuccess({ count: plans.length });
}

export function createScheduledGuestPlans(plans, { durationMs, expectedCount = null } = {}) {
  const candidate = cloneValue(plans);
  const validation = validateScheduledGuestPlans(candidate, { durationMs, expectedCount });
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 ScheduledGuestPlan입니다: ${validation.code}`);
    error.code = validation.code;
    error.details = validation.details;
    throw error;
  }
  return freezeDeep(candidate);
}
