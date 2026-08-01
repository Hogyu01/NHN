import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import { validateEventState, ZERO_EVENT_MODIFIERS } from "./events.js";
import { FACILITY_EFFECT_TYPE, validateFacilityState } from "./facility.js";
import { validateCookEscrowLine } from "./inventory.js";

export const COOK_TRIGGER = Object.freeze({
  PLAYER: "PLAYER",
  STAFF: "STAFF",
  DOMAIN: "DOMAIN",
});

export const TIMING_COOK_STATE = Object.freeze({
  RUNNING_ESCROW: "RUNNING_ESCROW",
  COMPLETED_DISH: "COMPLETED_DISH",
  FAILED_WASTE: "FAILED_WASTE",
  CANCELLED_RESTORED: "CANCELLED_RESTORED",
});

export const COOK_JUDGMENT = Object.freeze({
  SUCCESS: "SUCCESS",
  NORMAL: "NORMAL",
  FAILURE: "FAILURE",
});

const TERMINAL_STATES = new Set([
  TIMING_COOK_STATE.COMPLETED_DISH,
  TIMING_COOK_STATE.FAILED_WASTE,
  TIMING_COOK_STATE.CANCELLED_RESTORED,
]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_TIMING_COOK: "Timing_Cook 상태 형식이 올바르지 않습니다.",
  INVALID_TIMING_COOK_ID: "Timing_Cook ID가 올바르지 않습니다.",
  INVALID_TIMING_COOK_REFERENCE: "Timing_Cook 참조가 올바르지 않습니다.",
  INVALID_COOK_TRIGGER: "조리 요청 origin은 PLAYER, STAFF, DOMAIN 중 하나여야 합니다.",
  INVALID_TIMING_COOK_STATE: "Timing_Cook 상태 전이가 올바르지 않습니다.",
  INVALID_TIMING_COOK_ESCROW: "Timing_Cook CookEscrow가 올바르지 않습니다.",
  INVALID_TIMING_COOK_WINDOW: "Timing_Cook 판정 window가 올바르지 않습니다.",
  INVALID_TIMING_COOK_TIME: "Timing_Cook 시각이 올바르지 않습니다.",
  INVALID_TIMING_COOK_QUALITY: "Timing_Cook Quality가 올바르지 않습니다.",
  TIMING_COOK_NOT_RUNNING: "실행 중인 Timing_Cook만 완료할 수 있습니다.",
  COOK_FAILURE_DEADLINE_NOT_REACHED: "무입력 실패 deadline 전에는 조리를 실패 완료할 수 없습니다.",
  TIMING_WINDOW_BONUS_OVERFLOW: "조리 판정 window bonus가 safe integer 범위를 초과했습니다.",
  TIMING_COOK_TIME_OVERFLOW: "조리 시각 계산이 safe integer 범위를 초과했습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "Timing_Cook 검증에 실패했습니다.",
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

function nullableIdentifier(value) {
  return value === null || isStableIdentifier(value);
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function quality(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

function checkedAddInteger(left, right, code = "TIMING_COOK_TIME_OVERFLOW") {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    const error = new RangeError(MESSAGE_BY_CODE[code]);
    error.code = code;
    throw error;
  }
  return result;
}

function validateEscrowLines(lines, expectedBookCostG, expectedQuality) {
  if (!Array.isArray(lines) || lines.length === 0) return failure("INVALID_TIMING_COOK_ESCROW");
  let totalBookCostG = 0;
  let totalQuantity = 0n;
  let weightedQuality = 0n;
  for (let index = 0; index < lines.length; index += 1) {
    const validation = validateCookEscrowLine(lines[index]);
    if (!validation.ok) {
      return failure("INVALID_TIMING_COOK_ESCROW", { lineIndex: index, cause: validation.code });
    }
    totalBookCostG += lines[index].bookCostG;
    if (!Number.isSafeInteger(totalBookCostG)) return failure("INVALID_TIMING_COOK_ESCROW");
    totalQuantity += BigInt(lines[index].quantity);
    weightedQuality += BigInt(lines[index].quantity) * BigInt(lines[index].quality);
  }
  const calculatedQuality = Number(weightedQuality / totalQuantity);
  if (totalBookCostG !== expectedBookCostG || calculatedQuality !== expectedQuality) {
    return failure("INVALID_TIMING_COOK_ESCROW", {
      expectedBookCostG,
      actualBookCostG: totalBookCostG,
      expectedQuality,
      actualQuality: calculatedQuality,
    });
  }
  return validationSuccess();
}

export function validateTimingCook(timingCook) {
  if (!isPlainRecord(timingCook)) return failure("INVALID_TIMING_COOK");
  for (const field of ["cookId", "escrowId", "recipeId", "causeId"]) {
    if (!isStableIdentifier(timingCook[field])) {
      return failure("INVALID_TIMING_COOK_ID", { field, value: timingCook[field] });
    }
  }
  if (!nullableIdentifier(timingCook.sourceOrderId) ||
      !isStableIdentifier(timingCook.sourceSaleSlotId)) {
    return failure("INVALID_TIMING_COOK_REFERENCE", {
      sourceOrderId: timingCook.sourceOrderId,
      sourceSaleSlotId: timingCook.sourceSaleSlotId,
    });
  }
  if (!Object.values(COOK_TRIGGER).includes(timingCook.trigger)) {
    return failure("INVALID_COOK_TRIGGER", { trigger: timingCook.trigger });
  }
  if (!Object.values(TIMING_COOK_STATE).includes(timingCook.state)) {
    return failure("INVALID_TIMING_COOK_STATE", { state: timingCook.state });
  }
  if (!nonNegativeSafeInteger(timingCook.totalBookCostG) || !quality(timingCook.quality)) {
    return failure("INVALID_TIMING_COOK_QUALITY", {
      totalBookCostG: timingCook.totalBookCostG,
      quality: timingCook.quality,
    });
  }
  const escrowValidation = validateEscrowLines(
    timingCook.escrow,
    timingCook.totalBookCostG,
    timingCook.quality,
  );
  if (!escrowValidation.ok) return escrowValidation;

  const timeFields = [
    "startedAtMs", "targetAtMs", "failureAtMs", "successWindowMs", "normalWindowMs",
  ];
  for (const field of timeFields) {
    if (!nonNegativeSafeInteger(timingCook[field])) {
      return failure("INVALID_TIMING_COOK_TIME", { field, value: timingCook[field] });
    }
  }
  if (timingCook.targetAtMs < timingCook.startedAtMs ||
      timingCook.failureAtMs <= timingCook.targetAtMs ||
      timingCook.successWindowMs > timingCook.normalWindowMs ||
      timingCook.normalWindowMs >= timingCook.failureAtMs - timingCook.startedAtMs) {
    return failure("INVALID_TIMING_COOK_WINDOW", {
      startedAtMs: timingCook.startedAtMs,
      targetAtMs: timingCook.targetAtMs,
      failureAtMs: timingCook.failureAtMs,
      successWindowMs: timingCook.successWindowMs,
      normalWindowMs: timingCook.normalWindowMs,
    });
  }

  if (timingCook.state === TIMING_COOK_STATE.RUNNING_ESCROW) {
    if (timingCook.inputAtMs !== null || timingCook.completedAtMs !== null ||
        timingCook.judgment !== null || timingCook.outputQuality !== null ||
        timingCook.resultDishId !== null) {
      return failure("INVALID_TIMING_COOK_STATE", { state: timingCook.state });
    }
    return validationSuccess();
  }

  if (!TERMINAL_STATES.has(timingCook.state) ||
      !nonNegativeSafeInteger(timingCook.completedAtMs) ||
      timingCook.completedAtMs < timingCook.startedAtMs) {
    return failure("INVALID_TIMING_COOK_STATE", { state: timingCook.state });
  }
  if (timingCook.state === TIMING_COOK_STATE.CANCELLED_RESTORED) {
    return timingCook.inputAtMs === null && timingCook.judgment === null &&
      timingCook.outputQuality === null && timingCook.resultDishId === null
      ? validationSuccess()
      : failure("INVALID_TIMING_COOK_STATE", { state: timingCook.state });
  }
  if (!Object.values(COOK_JUDGMENT).includes(timingCook.judgment)) {
    return failure("INVALID_TIMING_COOK_STATE", { judgment: timingCook.judgment });
  }
  if (timingCook.inputAtMs !== null &&
      (!nonNegativeSafeInteger(timingCook.inputAtMs) || timingCook.inputAtMs < timingCook.startedAtMs)) {
    return failure("INVALID_TIMING_COOK_TIME", { inputAtMs: timingCook.inputAtMs });
  }
  if (timingCook.state === TIMING_COOK_STATE.FAILED_WASTE) {
    return timingCook.judgment === COOK_JUDGMENT.FAILURE &&
      timingCook.outputQuality === null && timingCook.resultDishId === null
      ? validationSuccess()
      : failure("INVALID_TIMING_COOK_STATE", { state: timingCook.state });
  }
  return [COOK_JUDGMENT.SUCCESS, COOK_JUDGMENT.NORMAL].includes(timingCook.judgment) &&
    quality(timingCook.outputQuality) && isStableIdentifier(timingCook.resultDishId)
    ? validationSuccess()
    : failure("INVALID_TIMING_COOK_STATE", { state: timingCook.state });
}

export function calculateTimingWindowBonusMs({ facilities, events, campaignDay } = {}) {
  const facilityValidation = validateFacilityState(facilities);
  if (!facilityValidation.ok) {
    const error = new TypeError(`FacilityState가 유효하지 않습니다: ${facilityValidation.code}`);
    error.code = facilityValidation.code;
    throw error;
  }
  const eventValidation = validateEventState(events);
  if (!eventValidation.ok) {
    const error = new TypeError(`EventState가 유효하지 않습니다: ${eventValidation.code}`);
    error.code = eventValidation.code;
    throw error;
  }
  if (!Number.isSafeInteger(campaignDay) || campaignDay < 1 || campaignDay > 14) {
    const error = new TypeError("campaignDay는 1..14 정수여야 합니다.");
    error.code = "INVALID_TIMING_COOK_DAY";
    throw error;
  }
  let bonusMs = 0;
  const purchased = new Set(facilities.purchasedFacilityIds);
  for (const definition of facilities.definitions) {
    if (purchased.has(definition.facilityId) &&
        definition.effect.type === FACILITY_EFFECT_TYPE.TIMING_WINDOW_BONUS_MS) {
      bonusMs = checkedAddInteger(bonusMs, definition.effect.value, "TIMING_WINDOW_BONUS_OVERFLOW");
    }
  }
  const modifiers = events.activeEvent?.generatedDay === campaignDay
    ? events.activeModifiers
    : ZERO_EVENT_MODIFIERS;
  bonusMs = checkedAddInteger(
    bonusMs,
    Math.max(0, modifiers.timingWindowBonusMs),
    "TIMING_WINDOW_BONUS_OVERFLOW",
  );
  return bonusMs;
}

export function createTimingCook({
  cookId,
  escrowId = cookId,
  sourceOrderId = null,
  sourceSaleSlotId,
  recipeId,
  causeId,
  trigger,
  escrow,
  totalBookCostG,
  quality: baseQuality,
  startedAtMs,
  timing,
  timingWindowBonusMs = 0,
} = {}) {
  if (!isPlainRecord(timing) || !nonNegativeSafeInteger(timing.targetOffsetMs) ||
      !nonNegativeSafeInteger(timing.successWindowMs) ||
      !nonNegativeSafeInteger(timing.normalWindowMs) ||
      !nonNegativeSafeInteger(timing.failureOffsetMs) ||
      timing.successWindowMs > timing.normalWindowMs ||
      timing.normalWindowMs >= timing.failureOffsetMs ||
      timing.targetOffsetMs >= timing.failureOffsetMs ||
      !nonNegativeSafeInteger(timingWindowBonusMs)) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_TIMING_COOK_WINDOW);
    error.code = "INVALID_TIMING_COOK_WINDOW";
    throw error;
  }
  let targetAtMs;
  let failureAtMs;
  let successWindowMs;
  let normalWindowMs;
  try {
    targetAtMs = checkedAddInteger(startedAtMs, timing.targetOffsetMs);
    failureAtMs = checkedAddInteger(startedAtMs, timing.failureOffsetMs);
    successWindowMs = checkedAddInteger(
      timing.successWindowMs,
      timingWindowBonusMs,
      "TIMING_WINDOW_BONUS_OVERFLOW",
    );
    normalWindowMs = checkedAddInteger(
      timing.normalWindowMs,
      timingWindowBonusMs,
      "TIMING_WINDOW_BONUS_OVERFLOW",
    );
  } catch (error) {
    throw error;
  }
  const state = {
    cookId,
    escrowId,
    sourceOrderId,
    sourceSaleSlotId,
    recipeId,
    causeId,
    trigger,
    state: TIMING_COOK_STATE.RUNNING_ESCROW,
    escrow: cloneValue(escrow),
    totalBookCostG,
    quality: baseQuality,
    startedAtMs,
    targetAtMs,
    failureAtMs,
    successWindowMs,
    normalWindowMs,
    inputAtMs: null,
    completedAtMs: null,
    judgment: null,
    outputQuality: null,
    resultDishId: null,
  };
  const validation = validateTimingCook(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 Timing_Cook입니다: ${validation.code}`);
    error.code = validation.code;
    error.details = validation.details;
    throw error;
  }
  return freezeDeep(state);
}

export function judgeTimingCook(timingCook, { inputAtMs, observedAtMs } = {}) {
  const validation = validateTimingCook(timingCook);
  if (!validation.ok) return validation;
  if (timingCook.state !== TIMING_COOK_STATE.RUNNING_ESCROW) {
    return failure("TIMING_COOK_NOT_RUNNING", { state: timingCook.state });
  }
  if (!nonNegativeSafeInteger(observedAtMs) || observedAtMs < timingCook.startedAtMs) {
    return failure("INVALID_TIMING_COOK_TIME", { observedAtMs });
  }
  if (inputAtMs === null) {
    if (observedAtMs < timingCook.failureAtMs) {
      return failure("COOK_FAILURE_DEADLINE_NOT_REACHED", {
        observedAtMs,
        failureAtMs: timingCook.failureAtMs,
      });
    }
    return success({
      judgment: COOK_JUDGMENT.FAILURE,
      inputAtMs: null,
      completedAtMs: observedAtMs,
      errorMs: null,
      outputQuality: null,
    });
  }
  if (!nonNegativeSafeInteger(inputAtMs) || inputAtMs < timingCook.startedAtMs ||
      inputAtMs !== observedAtMs) {
    return failure("INVALID_TIMING_COOK_TIME", { inputAtMs, observedAtMs });
  }
  const errorMs = Math.abs(inputAtMs - timingCook.targetAtMs);
  const judgment = errorMs <= timingCook.successWindowMs
    ? COOK_JUDGMENT.SUCCESS
    : errorMs <= timingCook.normalWindowMs
      ? COOK_JUDGMENT.NORMAL
      : COOK_JUDGMENT.FAILURE;
  return success({
    judgment,
    inputAtMs,
    completedAtMs: observedAtMs,
    errorMs,
    outputQuality: judgment === COOK_JUDGMENT.SUCCESS
      ? Math.min(100, timingCook.quality + 10)
      : judgment === COOK_JUDGMENT.NORMAL
        ? timingCook.quality
        : null,
  });
}

export function completeTimingCook(timingCook, {
  inputAtMs,
  observedAtMs,
  resultDishId = null,
} = {}) {
  const judged = judgeTimingCook(timingCook, { inputAtMs, observedAtMs });
  if (!judged.ok) return judged;
  const producesDish = judged.plan.judgment !== COOK_JUDGMENT.FAILURE;
  if (producesDish !== isStableIdentifier(resultDishId)) {
    return failure("INVALID_TIMING_COOK_REFERENCE", { resultDishId, judgment: judged.plan.judgment });
  }
  const candidate = cloneValue(timingCook);
  candidate.state = producesDish
    ? TIMING_COOK_STATE.COMPLETED_DISH
    : TIMING_COOK_STATE.FAILED_WASTE;
  candidate.inputAtMs = judged.plan.inputAtMs;
  candidate.completedAtMs = judged.plan.completedAtMs;
  candidate.judgment = judged.plan.judgment;
  candidate.outputQuality = judged.plan.outputQuality;
  candidate.resultDishId = producesDish ? resultDishId : null;
  const validation = validateTimingCook(candidate);
  return validation.ok
    ? success({ timingCook: candidate, ...judged.plan })
    : validation;
}

export function cancelTimingCookAtZero(timingCook, { cancelledAtMs } = {}) {
  const validation = validateTimingCook(timingCook);
  if (!validation.ok) return validation;
  if (timingCook.state !== TIMING_COOK_STATE.RUNNING_ESCROW) {
    return failure("TIMING_COOK_NOT_RUNNING", { state: timingCook.state });
  }
  if (!nonNegativeSafeInteger(cancelledAtMs) || cancelledAtMs < timingCook.startedAtMs) {
    return failure("INVALID_TIMING_COOK_TIME", { cancelledAtMs });
  }
  const candidate = cloneValue(timingCook);
  candidate.state = TIMING_COOK_STATE.CANCELLED_RESTORED;
  candidate.completedAtMs = cancelledAtMs;
  const after = validateTimingCook(candidate);
  return after.ok ? success({ timingCook: candidate }) : after;
}
