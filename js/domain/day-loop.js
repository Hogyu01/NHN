import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { planScheduledGuestGeneration } from "./demand.js";
import { validateEventState } from "./events.js";
import { validateFacilityState } from "./facility.js";
import { COMPLETED_DISH_STATE, validateInventoryState } from "./inventory.js";
import {
  prepareMenuForServiceDraft,
  validateMenuPlanReconciliation,
  validateMenuState,
} from "./menu.js";
import { validateRecipeState } from "./recipe.js";
import { countSaleSlots, SALE_SLOT_STATE, validateSaleSlotsState } from "./sale-slots.js";
import {
  closeServiceResultsState,
  createServiceTimerState,
  issueSettlementTransitionState,
  pauseServiceTimerState,
  projectServiceTimer,
  resetServiceTimerState,
  resumeServiceTimerState,
  RUNTIME_PHASE,
  RUNTIME_PHASES,
  SERVICE_END_REASON,
  SERVICE_LIFECYCLE,
  startServiceTimerState,
  validateServiceTimerState,
} from "./timer-state.js";

export const DAY_LOOP_COMMAND = Object.freeze({
  TRANSITION: "day-loop.transition",
  CONFIRM_SERVICE_START: "day-loop.service-start.confirm",
});

export const DAY_LOOP_TRIGGER = Object.freeze({
  NEW_CAMPAIGN_READY: "NEW_CAMPAIGN_READY",
  CONTINUE_READY: "CONTINUE_READY",
  RECOVERY_READY: "RECOVERY_READY",
  CONFIRM_SERVICE_START: "CONFIRM_SERVICE_START",
  PAUSE_REQUESTED: "PAUSE_REQUESTED",
  VISIBILITY_AUTO_PAUSE: "VISIBILITY_AUTO_PAUSE",
  RESUME_REQUESTED: "RESUME_REQUESTED",
  TIMER_ZERO: "TIMER_ZERO",
  EARLY_COMPLETION: "EARLY_COMPLETION",
  CLEANUP_VISUALS_COMPLETE: "CLEANUP_VISUALS_COMPLETE",
  CLEANUP_OVERTIME_CAP: "CLEANUP_OVERTIME_CAP",
  NEXT_DAY_READY: "NEXT_DAY_READY",
  CAMPAIGN_TERMINAL_READY: "CAMPAIGN_TERMINAL_READY",
  NEW_CAMPAIGN_CONFIRMED: "NEW_CAMPAIGN_CONFIRMED",
});

export const DAY_LOOP_TRANSITION_READ_SET = Object.freeze([]);
export const DAY_LOOP_TRANSITION_WRITE_SET = Object.freeze([
  "runtimePhase",
  "checkpointPhase",
  "service",
]);
export const SERVICE_START_READ_SET = Object.freeze([
  "campaign",
  "recipes",
  "saleSlots",
  "inventory",
  "events",
  "facilities",
]);
export const SERVICE_START_WRITE_SET = Object.freeze([
  "runtimePhase",
  "checkpointPhase",
  "menu",
  "service",
  "inventory",
  "rng",
  "idCounters",
]);

const TITLE_READY_TRIGGERS = new Set([
  DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY,
  DAY_LOOP_TRIGGER.CONTINUE_READY,
  DAY_LOOP_TRIGGER.RECOVERY_READY,
]);
const PAUSE_TRIGGERS = new Set([
  DAY_LOOP_TRIGGER.PAUSE_REQUESTED,
  DAY_LOOP_TRIGGER.VISIBILITY_AUTO_PAUSE,
]);
const SERVICE_END_TRIGGERS = new Set([
  DAY_LOOP_TRIGGER.TIMER_ZERO,
  DAY_LOOP_TRIGGER.EARLY_COMPLETION,
]);
const CLEANUP_COMPLETE_TRIGGERS = new Set([
  DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE,
  DAY_LOOP_TRIGGER.CLEANUP_OVERTIME_CAP,
]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_DAY_LOOP_TRANSITION_PAYLOAD: "하루 단계 전이 요청 형식이 올바르지 않습니다.",
  INVALID_DAY_LOOP_TRIGGER: "알 수 없는 하루 단계 전이 trigger입니다.",
  INVALID_EARLY_END_PREDICATE: "Service 조기 종료 조건 값이 올바르지 않습니다.",
  EARLY_END_CONDITIONS_NOT_MET: "Service 조기 종료 조건이 아직 모두 충족되지 않았습니다.",
  ILLEGAL_PHASE_TRANSITION: "현재 단계에서는 요청한 전이를 수행할 수 없습니다.",
  SERVICE_START_REQUIRES_EXPLICIT_CONFIRM_COMMAND: "Service 시작은 명시적 ConfirmServiceStart command로만 요청할 수 있습니다.",
  INVALID_SERVICE_START_PAYLOAD: "Service 시작 확정 요청 형식이 올바르지 않습니다.",
  SERVICE_START_CAMPAIGN_INVALID: "Service 시작에 필요한 캠페인 상태가 올바르지 않습니다.",
  SERVICE_START_DAY_MISMATCH: "캠페인·메뉴·SaleSlot의 일자가 서로 다릅니다.",
  SERVICE_START_CHECKPOINT_NOT_READY: "Planning-ready 경계에서만 Service를 시작할 수 있습니다.",
  SERVICE_START_RECIPE_STATE_INVALID: "Recipe 상태가 유효하지 않아 Service를 시작할 수 없습니다.",
  SERVICE_START_MENU_STATE_INVALID: "메뉴 상태가 유효하지 않아 Service를 시작할 수 없습니다.",
  SERVICE_START_PLAN_REQUIRED: "확정된 메뉴 계획이 필요합니다.",
  SERVICE_START_UNCONFIRMED_MENU_EDITS: "확정 뒤 변경된 메뉴 편집을 먼저 다시 확정해야 합니다.",
  SERVICE_START_ENABLED_RECIPE_REQUIRED: "판매 수량이 있는 활성 Recipe가 하나 이상 필요합니다.",
  SERVICE_START_SALE_SLOT_STATE_INVALID: "SaleSlot 상태가 유효하지 않아 Service를 시작할 수 없습니다.",
  SERVICE_START_AVAILABLE_SLOT_REQUIRED: "AVAILABLE SaleSlot이 하나 이상 필요합니다.",
  SERVICE_START_REQUIRES_ALL_SLOTS_AVAILABLE: "Service 시작 전 모든 SaleSlot은 AVAILABLE이어야 합니다.",
  SERVICE_START_PLAN_RECONCILIATION_FAILED: "메뉴·SaleSlot·재료 reservation 대사가 일치하지 않습니다.",
  SERVICE_START_INVENTORY_STATE_INVALID: "재고 상태가 유효하지 않아 Service를 시작할 수 없습니다.",
  SERVICE_START_EVENT_STATE_INVALID: "활성 사건 projection이 유효하지 않습니다.",
  SERVICE_START_FACILITY_STATE_INVALID: "시설 projection이 유효하지 않습니다.",
  SERVICE_START_TRANSIENTS_NOT_EMPTY: "이전 Service transient가 남아 있어 새 Service를 시작할 수 없습니다.",
  SERVICE_START_STATE_INVALID: "Service lifecycle이 시작 가능한 상태가 아닙니다.",
  SERVICE_START_MENU_LOCK_FAILED: "Service 시작 시 메뉴 잠금에 실패했습니다.",
  SERVICE_START_DEMAND_GENERATION_FAILED: "Service 시작 시 손님 계획 생성에 실패했습니다.",
  DAY_LOOP_POSTCONDITION_FAILED: "하루 단계 전이 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "하루 단계 명령 검증에 실패했습니다.",
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

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Pure early-end query. No Service state is changed by evaluating it. */
export function evaluateServiceEarlyEnd(input) {
  if (!isPlainRecord(input) || typeof input.scheduledPlansComplete !== "boolean" ||
      !validCount(input.activeOrderCount) ||
      (input.carriedDishId !== null && !isStableIdentifier(input.carriedDishId)) ||
      !validCount(input.nonExitedGuestCount)) {
    return freezeDeep({
      ok: false,
      code: "INVALID_EARLY_END_PREDICATE",
      eligible: false,
      message: MESSAGE_BY_CODE.INVALID_EARLY_END_PREDICATE,
    });
  }
  const conditions = {
    scheduledPlansComplete: input.scheduledPlansComplete,
    activeOrdersEmpty: input.activeOrderCount === 0,
    carriedDishEmpty: input.carriedDishId === null,
    allGuestsExited: input.nonExitedGuestCount === 0,
  };
  return freezeDeep({
    ok: true,
    eligible: Object.values(conditions).every(Boolean),
    conditions,
  });
}

export function isServiceEarlyEndEligible(input) {
  const result = evaluateServiceEarlyEnd(input);
  return result.ok && result.eligible;
}

function validateTransitionPayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_DAY_LOOP_TRANSITION_PAYLOAD");
  if (!Object.values(DAY_LOOP_TRIGGER).includes(payload.trigger)) {
    return failure("INVALID_DAY_LOOP_TRIGGER", { trigger: payload.trigger });
  }
  if (payload.trigger === DAY_LOOP_TRIGGER.EARLY_COMPLETION) {
    const predicate = evaluateServiceEarlyEnd(payload.earlyEnd);
    if (!predicate.ok) return failure(predicate.code);
  }
  if (CLEANUP_COMPLETE_TRIGGERS.has(payload.trigger) &&
      !isStableIdentifier(payload.transitionToken)) {
    return failure("INVALID_DAY_LOOP_TRANSITION_PAYLOAD", {
      field: "transitionToken",
      trigger: payload.trigger,
    });
  }
  return validationSuccess();
}

function validateServiceStartPayload(payload) {
  return isPlainRecord(payload) && Number.isSafeInteger(payload.day) && payload.day >= 1 && payload.day <= 14
    ? validationSuccess()
    : failure("INVALID_SERVICE_START_PAYLOAD");
}

function transitionTokenFor(planId, planRevision) {
  const token = `${planId}:settlement:${planRevision}`;
  if (!isStableIdentifier(token)) {
    const error = new TypeError("Service plan에서 안정적인 Settlement token을 만들 수 없습니다.");
    error.code = "INVALID_SERVICE_TRANSITION_TOKEN";
    throw error;
  }
  return token;
}

function validateCampaignForService(campaign) {
  return isPlainRecord(campaign) && isStableIdentifier(campaign.campaignId) &&
    Number.isSafeInteger(campaign.day) && campaign.day >= 1 && campaign.day <= 14
    ? validationSuccess()
    : failure("SERVICE_START_CAMPAIGN_INVALID");
}

function validateServiceStartContext(ctx) {
  const campaign = ctx.read("campaign");
  const recipes = ctx.read("recipes");
  const menu = ctx.read("menu");
  const saleSlots = ctx.read("saleSlots");
  const inventory = ctx.read("inventory");
  const events = ctx.read("events");
  const facilities = ctx.read("facilities");
  const service = ctx.read("service");
  const checkpointPhase = ctx.read("checkpointPhase");
  const payload = ctx.command.payload;

  if (ctx.phase !== RUNTIME_PHASE.PLANNING) {
    return failure("ILLEGAL_PHASE_TRANSITION", {
      from: ctx.phase,
      trigger: DAY_LOOP_TRIGGER.CONFIRM_SERVICE_START,
      allowedFrom: RUNTIME_PHASE.PLANNING,
    });
  }
  const campaignValidation = validateCampaignForService(campaign);
  if (!campaignValidation.ok) return campaignValidation;
  if (checkpointPhase !== "PLANNING_READY") {
    return failure("SERVICE_START_CHECKPOINT_NOT_READY", { checkpointPhase });
  }
  if (payload.day !== campaign.day || payload.day !== menu?.day || payload.day !== saleSlots?.day) {
    return failure("SERVICE_START_DAY_MISMATCH", {
      payloadDay: payload.day,
      campaignDay: campaign.day,
      menuDay: menu?.day,
      saleSlotDay: saleSlots?.day,
    });
  }
  const recipeValidation = validateRecipeState(recipes);
  if (!recipeValidation.ok) {
    return failure("SERVICE_START_RECIPE_STATE_INVALID", { cause: recipeValidation.code });
  }
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) {
    return failure("SERVICE_START_MENU_STATE_INVALID", { cause: menuValidation.code });
  }
  if (menu.locked || menu.cleanupComplete || menu.activePlanId === null || menu.planRevision < 1) {
    return failure("SERVICE_START_PLAN_REQUIRED", {
      menuLocked: menu.locked,
      cleanupComplete: menu.cleanupComplete,
      activePlanId: menu.activePlanId,
      planRevision: menu.planRevision,
    });
  }
  if (!equivalent(menu.draftEntries, menu.confirmedEntries)) {
    return failure("SERVICE_START_UNCONFIRMED_MENU_EDITS");
  }
  const activeEntries = menu.confirmedEntries.filter((entry) =>
    entry.enabled && entry.plannedQuantity > 0 && recipes.unlockedRecipeIds.includes(entry.recipeId));
  if (activeEntries.length === 0) {
    return failure("SERVICE_START_ENABLED_RECIPE_REQUIRED");
  }
  const slotValidation = validateSaleSlotsState(saleSlots);
  if (!slotValidation.ok) {
    return failure("SERVICE_START_SALE_SLOT_STATE_INVALID", { cause: slotValidation.code });
  }
  const counts = countSaleSlots(saleSlots);
  if (counts.byState[SALE_SLOT_STATE.AVAILABLE] < 1) {
    return failure("SERVICE_START_AVAILABLE_SLOT_REQUIRED", { counts });
  }
  if (saleSlots.slots.some((slot) => slot.state !== SALE_SLOT_STATE.AVAILABLE)) {
    return failure("SERVICE_START_REQUIRES_ALL_SLOTS_AVAILABLE", { counts });
  }
  const inventoryValidation = validateInventoryState(inventory);
  if (!inventoryValidation.ok) {
    return failure("SERVICE_START_INVENTORY_STATE_INVALID", { cause: inventoryValidation.code });
  }
  const reconciliation = validateMenuPlanReconciliation(
    menu,
    recipes,
    saleSlots,
    inventory,
    { requireFullReservations: true },
  );
  if (!reconciliation.ok) {
    return failure("SERVICE_START_PLAN_RECONCILIATION_FAILED", {
      cause: reconciliation.code,
      reconciliation: reconciliation.details,
    });
  }
  const eventValidation = validateEventState(events);
  if (!eventValidation.ok) {
    return failure("SERVICE_START_EVENT_STATE_INVALID", { cause: eventValidation.code });
  }
  const facilityValidation = validateFacilityState(facilities);
  if (!facilityValidation.ok) {
    return failure("SERVICE_START_FACILITY_STATE_INVALID", { cause: facilityValidation.code });
  }
  const serviceValidation = validateServiceTimerState(service, { runtimePhase: RUNTIME_PHASE.PLANNING });
  if (!serviceValidation.ok || service.lifecycle !== SERVICE_LIFECYCLE.INACTIVE) {
    return failure("SERVICE_START_STATE_INVALID", { cause: serviceValidation.code, lifecycle: service.lifecycle });
  }
  const carriedDishCount = inventory.completedDishes.filter(
    (dish) => dish.state === COMPLETED_DISH_STATE.CARRIED,
  ).length;
  if (inventory.cookEscrows.length > 0 || carriedDishCount > 0) {
    return failure("SERVICE_START_TRANSIENTS_NOT_EMPTY", {
      cookEscrowCount: inventory.cookEscrows.length,
      carriedDishCount,
    });
  }

  let transitionToken;
  try {
    transitionToken = transitionTokenFor(menu.activePlanId, menu.planRevision);
  } catch (error) {
    return failure(error?.code ?? "INVALID_SERVICE_TRANSITION_TOKEN");
  }
  return validationSuccess({
    activeRecipeCount: activeEntries.length,
    availableSlotCount: counts.byState[SALE_SLOT_STATE.AVAILABLE],
    plannedQuantity: reconciliation.details.plannedQuantity,
    transitionToken,
  });
}

function illegalTransition(state, payload) {
  return failure("ILLEGAL_PHASE_TRANSITION", {
    from: state.runtimePhase,
    lifecycle: state.service.lifecycle,
    trigger: payload.trigger,
  });
}

/** Pure phase-table planner used by the production transition transaction and QA. */
export function planDayLoopTransition(state, payload) {
  const payloadValidation = validateTransitionPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (!isPlainRecord(state) || !RUNTIME_PHASES.includes(state.runtimePhase)) {
    return failure("ILLEGAL_PHASE_TRANSITION", { from: state?.runtimePhase, trigger: payload.trigger });
  }
  const serviceValidation = validateServiceTimerState(state.service, { runtimePhase: state.runtimePhase });
  if (!serviceValidation.ok) {
    return failure("ILLEGAL_PHASE_TRANSITION", {
      from: state.runtimePhase,
      trigger: payload.trigger,
      cause: serviceValidation.code,
    });
  }
  if (payload.trigger === DAY_LOOP_TRIGGER.CONFIRM_SERVICE_START) {
    return failure("SERVICE_START_REQUIRES_EXPLICIT_CONFIRM_COMMAND", {
      from: state.runtimePhase,
      commandType: DAY_LOOP_COMMAND.CONFIRM_SERVICE_START,
    });
  }

  let runtimePhase = state.runtimePhase;
  let checkpointPhase = state.checkpointPhase;
  let service = state.service;

  if (state.runtimePhase === RUNTIME_PHASE.TITLE && TITLE_READY_TRIGGERS.has(payload.trigger)) {
    const reset = resetServiceTimerState(service);
    if (!reset.ok) return reset;
    runtimePhase = RUNTIME_PHASE.PLANNING;
    checkpointPhase = "PLANNING_READY";
    service = reset.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.SERVICE &&
      state.service.lifecycle === SERVICE_LIFECYCLE.RUNNING && PAUSE_TRIGGERS.has(payload.trigger)) {
    const paused = pauseServiceTimerState(service);
    if (!paused.ok) return paused;
    runtimePhase = RUNTIME_PHASE.PAUSED;
    checkpointPhase = null;
    service = paused.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.SERVICE &&
      state.service.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP &&
      PAUSE_TRIGGERS.has(payload.trigger)) {
    const paused = pauseServiceTimerState(service);
    if (!paused.ok) return paused;
    runtimePhase = RUNTIME_PHASE.PAUSED;
    checkpointPhase = null;
    service = paused.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.PAUSED &&
      payload.trigger === DAY_LOOP_TRIGGER.RESUME_REQUESTED) {
    const resumed = resumeServiceTimerState(service);
    if (!resumed.ok) return resumed;
    runtimePhase = RUNTIME_PHASE.SERVICE;
    checkpointPhase = null;
    service = resumed.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.SERVICE &&
      state.service.lifecycle === SERVICE_LIFECYCLE.RUNNING && SERVICE_END_TRIGGERS.has(payload.trigger)) {
    if (payload.trigger === DAY_LOOP_TRIGGER.EARLY_COMPLETION) {
      const predicate = evaluateServiceEarlyEnd(payload.earlyEnd);
      if (!predicate.ok) return failure(predicate.code);
      if (!predicate.eligible) return failure("EARLY_END_CONDITIONS_NOT_MET", { conditions: predicate.conditions });
    }
    const closed = closeServiceResultsState(
      service,
      payload.trigger === DAY_LOOP_TRIGGER.TIMER_ZERO
        ? SERVICE_END_REASON.TIMER_ZERO
        : SERVICE_END_REASON.EARLY_COMPLETION,
    );
    if (!closed.ok) return closed;
    runtimePhase = RUNTIME_PHASE.SERVICE;
    checkpointPhase = null;
    service = closed.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.SERVICE &&
      state.service.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP &&
      CLEANUP_COMPLETE_TRIGGERS.has(payload.trigger)) {
    const issued = issueSettlementTransitionState(service, payload.transitionToken);
    if (!issued.ok) return issued;
    runtimePhase = RUNTIME_PHASE.SETTLEMENT;
    checkpointPhase = null;
    service = issued.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.SETTLEMENT &&
      payload.trigger === DAY_LOOP_TRIGGER.NEXT_DAY_READY) {
    const reset = resetServiceTimerState(service);
    if (!reset.ok) return reset;
    runtimePhase = RUNTIME_PHASE.PLANNING;
    checkpointPhase = "PLANNING_READY";
    service = reset.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.SETTLEMENT &&
      payload.trigger === DAY_LOOP_TRIGGER.CAMPAIGN_TERMINAL_READY) {
    const reset = resetServiceTimerState(service);
    if (!reset.ok) return reset;
    runtimePhase = RUNTIME_PHASE.TERMINAL;
    checkpointPhase = "TERMINAL";
    service = reset.state;
  } else if (state.runtimePhase === RUNTIME_PHASE.TERMINAL &&
      payload.trigger === DAY_LOOP_TRIGGER.NEW_CAMPAIGN_CONFIRMED) {
    const reset = resetServiceTimerState(service);
    if (!reset.ok) return reset;
    runtimePhase = RUNTIME_PHASE.PLANNING;
    checkpointPhase = "PLANNING_READY";
    service = reset.state;
  } else {
    return illegalTransition(state, payload);
  }

  const nextValidation = validateServiceTimerState(service, { runtimePhase });
  if (!nextValidation.ok) return failure("DAY_LOOP_POSTCONDITION_FAILED", { cause: nextValidation.code });
  return success({
    runtimePhase,
    checkpointPhase,
    service,
    fromPhase: state.runtimePhase,
    fromLifecycle: state.service.lifecycle,
    trigger: payload.trigger,
  });
}

function transitionInputFromContext(ctx) {
  return {
    runtimePhase: ctx.phase,
    checkpointPhase: ctx.read("checkpointPhase"),
    service: ctx.read("service"),
  };
}

function transitionEvent(before, after, payload) {
  if (before.runtimePhase === RUNTIME_PHASE.SERVICE &&
      before.service.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP &&
      after.runtimePhase === RUNTIME_PHASE.SETTLEMENT) {
    return {
      type: "day-loop.settlement-transition-issued",
      payload: {
        transitionToken: before.service.settlementTransitionToken,
        trigger: payload.trigger,
        from: before.runtimePhase,
        to: after.runtimePhase,
      },
    };
  }
  if (before.runtimePhase === RUNTIME_PHASE.SERVICE &&
      before.service.lifecycle === SERVICE_LIFECYCLE.RUNNING &&
      after.service.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP) {
    return {
      type: "day-loop.service-results-closed",
      payload: {
        transitionToken: after.service.settlementTransitionToken,
        endReason: after.service.endReason,
        trigger: payload.trigger,
      },
    };
  }
  return {
    type: "day-loop.phase-transitioned",
    payload: {
      from: before.runtimePhase,
      to: after.runtimePhase,
      fromLifecycle: before.service.lifecycle,
      toLifecycle: after.service.lifecycle,
      trigger: payload.trigger,
    },
  };
}

export function createDayLoopTransitionAtomicTransaction() {
  return defineAtomicTransaction({
    name: DAY_LOOP_COMMAND.TRANSITION,
    readSet: DAY_LOOP_TRANSITION_READ_SET,
    writeSet: DAY_LOOP_TRANSITION_WRITE_SET,
    allowedPhases: RUNTIME_PHASES,
    validatePayload(ctx) {
      return validateTransitionPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planDayLoopTransition(transitionInputFromContext(ctx), ctx.command.payload);
    },
    mutate(draft) {
      const planned = planDayLoopTransition({
        runtimePhase: draft.read("runtimePhase"),
        checkpointPhase: draft.read("checkpointPhase"),
        service: draft.read("service"),
      }, draft.command.payload);
      if (!planned.ok) return planned;
      draft.replace("runtimePhase", planned.plan.runtimePhase);
      draft.replace("checkpointPhase", planned.plan.checkpointPhase);
      draft.replace("service", planned.plan.service);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planDayLoopTransition(before, ctx.command.payload);
      if (!planned.ok) return planned;
      if (after.runtimePhase !== planned.plan.runtimePhase ||
          after.checkpointPhase !== planned.plan.checkpointPhase ||
          !equivalent(after.service, planned.plan.service)) {
        return failure("DAY_LOOP_POSTCONDITION_FAILED");
      }
      return validateServiceTimerState(after.service, { runtimePhase: after.runtimePhase });
    },
    events(before, after, ctx) {
      return [transitionEvent(before, after, ctx.command.payload)];
    },
  });
}

function generateServicePlans(context, { guestArchetypes, demandConfiguration }) {
  const service = context.read("service");
  return planScheduledGuestGeneration({
    rngState: context.read("rng"),
    idCounters: context.read("idCounters"),
    campaign: context.read("campaign"),
    generationId: context.generationId,
    serviceDurationMs: service.durationMs,
    menu: context.read("menu"),
    recipes: context.read("recipes"),
    saleSlots: context.read("saleSlots"),
    events: context.read("events"),
    guestArchetypes,
    configuration: demandConfiguration,
  });
}

export function createConfirmServiceStartAtomicTransaction({
  onValidationAttempt = null,
  guestArchetypes,
  demandConfiguration = {},
} = {}) {
  if (onValidationAttempt !== null && typeof onValidationAttempt !== "function") {
    throw new TypeError("onValidationAttempt는 함수 또는 null이어야 합니다.");
  }
  if (!Array.isArray(guestArchetypes) || guestArchetypes.length === 0) {
    throw new TypeError("createConfirmServiceStartAtomicTransaction에는 guestArchetypes 배열이 필요합니다.");
  }
  return defineAtomicTransaction({
    name: DAY_LOOP_COMMAND.CONFIRM_SERVICE_START,
    readSet: SERVICE_START_READ_SET,
    writeSet: SERVICE_START_WRITE_SET,
    allowedPhases: RUNTIME_PHASES,
    validatePayload(ctx) {
      return validateServiceStartPayload(ctx.command.payload);
    },
    preflight(ctx) {
      onValidationAttempt?.(ctx.command.commandId);
      const validation = validateServiceStartContext(ctx);
      if (!validation.ok) return validation;
      const generation = generateServicePlans(ctx, { guestArchetypes, demandConfiguration });
      if (!generation.ok) {
        return failure("SERVICE_START_DEMAND_GENERATION_FAILED", { cause: generation.code });
      }
      return validation;
    },
    mutate(draft) {
      const context = {
        command: draft.command,
        phase: draft.read("runtimePhase"),
        generationId: draft.command.generationId,
        read: (slice) => draft.read(slice),
      };
      const validation = validateServiceStartContext(context);
      if (!validation.ok) return validation;
      const generation = generateServicePlans(context, { guestArchetypes, demandConfiguration });
      if (!generation.ok) {
        return failure("SERVICE_START_DEMAND_GENERATION_FAILED", { cause: generation.code });
      }
      const menuDraft = draft.write("menu");
      const locked = prepareMenuForServiceDraft(menuDraft, draft.read("recipes"));
      if (!locked.ok) return failure("SERVICE_START_MENU_LOCK_FAILED", { cause: locked.code });
      const started = startServiceTimerState(draft.read("service"), {
        day: draft.command.payload.day,
        planId: menuDraft.activePlanId,
        planRevision: menuDraft.planRevision,
        transitionToken: validation.details.transitionToken,
        plans: generation.plan.plans,
      });
      if (!started.ok) return started;
      draft.replace("runtimePhase", RUNTIME_PHASE.SERVICE);
      draft.replace("checkpointPhase", null);
      draft.replace("service", started.state);
      // service.completedDishes는 매일 startServiceTimerState가 []로 새로 만드는데,
      // inventory.completedDishes는 SOLD/WASTED 기록이 하루가 지나도 배열에 그대로 남아있어
      // 서로 어긋나면 validateDirectServiceState의 CARRIED_DISH_REFERENCE_MISMATCH(DISH_MIRROR_MISMATCH)로
      // 이어졌다. validateServiceStartContext가 이미 carried/escrow가 0임을 검증했으니 여기서 함께 비운다.
      draft.write("inventory").completedDishes = [];
      draft.replace("rng", generation.plan.rngState);
      draft.replace("idCounters", generation.plan.idCounters);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const beforeContext = {
        command: ctx.command,
        phase: before.runtimePhase,
        read: (slice) => before[slice],
      };
      const validation = validateServiceStartContext(beforeContext);
      if (!validation.ok) return validation;
      if (after.runtimePhase !== RUNTIME_PHASE.SERVICE || after.checkpointPhase !== null ||
          !after.menu.locked || after.menu.cleanupComplete ||
          !equivalent(after.menu.draftEntries, before.menu.draftEntries) ||
          !equivalent(after.menu.confirmedEntries, before.menu.confirmedEntries) ||
          after.menu.activePlanId !== before.menu.activePlanId ||
          after.menu.planRevision !== before.menu.planRevision) {
        return failure("DAY_LOOP_POSTCONDITION_FAILED");
      }
      const serviceValidation = validateServiceTimerState(after.service, {
        runtimePhase: RUNTIME_PHASE.SERVICE,
      });
      if (!serviceValidation.ok || after.service.lifecycle !== SERVICE_LIFECYCLE.RUNNING ||
          after.service.startedPlanId !== before.menu.activePlanId ||
          after.service.startedPlanRevision !== before.menu.planRevision ||
          after.service.settlementTransitionToken !== validation.details.transitionToken) {
        return failure("DAY_LOOP_POSTCONDITION_FAILED", { cause: serviceValidation.code });
      }
      return validateMenuPlanReconciliation(
        after.menu,
        after.recipes,
        after.saleSlots,
        after.inventory,
        { requireFullReservations: true },
      );
    },
    events(before, after) {
      const counts = countSaleSlots(after.saleSlots);
      return [{
        type: "day-loop.service-started",
        payload: {
          day: after.campaign.day,
          planId: after.menu.activePlanId,
          planRevision: after.menu.planRevision,
          enabledRecipeCount: after.menu.confirmedEntries.filter(
            (entry) => entry.enabled && entry.plannedQuantity > 0,
          ).length,
          availableSlotCount: counts.byState[SALE_SLOT_STATE.AVAILABLE],
          durationMs: after.service.durationMs,
          transitionToken: after.service.settlementTransitionToken,
          previousPhase: before.runtimePhase,
        },
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
    readSet: [...readSet],
    writeSet: [...writeSet],
  };
}

export function projectDayLoop(snapshot) {
  if (!snapshot || !RUNTIME_PHASES.includes(snapshot.runtimePhase)) {
    throw new TypeError("DayLoop projection에 유효한 runtime snapshot이 필요합니다.");
  }
  return freezeDeep({
    runtimePhase: snapshot.runtimePhase,
    checkpointPhase: snapshot.checkpointPhase,
    planningUnlimited: snapshot.runtimePhase === RUNTIME_PHASE.PLANNING,
    serviceStartExplicitOnly: true,
    timer: projectServiceTimer(snapshot.service, snapshot.runtimePhase),
  });
}

export class DayLoopController {
  constructor(commandBus, { register = true, guestArchetypes, demandConfiguration = {} } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("DayLoopController에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.guestArchetypes = guestArchetypes;
    this.demandConfiguration = demandConfiguration;
    this.registered = false;
    this._audit = {
      serviceStartValidationAttempts: 0,
      lastServiceStartValidationCommandId: null,
    };
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(DAY_LOOP_COMMAND.TRANSITION, createDayLoopTransitionAtomicTransaction());
    this.commandBus.register(DAY_LOOP_COMMAND.CONFIRM_SERVICE_START,
      createConfirmServiceStartAtomicTransaction({
        guestArchetypes: this.guestArchetypes,
        demandConfiguration: this.demandConfiguration,
        onValidationAttempt: (commandId) => {
          this._audit.serviceStartValidationAttempts += 1;
          this._audit.lastServiceStartValidationCommandId = commandId;
        },
      }));
    this.registered = true;
    return this;
  }

  transition(input) {
    return this.commandBus.dispatch(commandEnvelope(
      DAY_LOOP_COMMAND.TRANSITION,
      DAY_LOOP_TRANSITION_READ_SET,
      DAY_LOOP_TRANSITION_WRITE_SET,
      input,
    ));
  }

  confirmServiceStart(input) {
    return this.commandBus.dispatch(commandEnvelope(
      DAY_LOOP_COMMAND.CONFIRM_SERVICE_START,
      SERVICE_START_READ_SET,
      SERVICE_START_WRITE_SET,
      input,
    ));
  }

  project(snapshot) {
    return projectDayLoop(snapshot);
  }

  getAuditSnapshot() {
    return freezeDeep(cloneValue(this._audit));
  }
}

export function registerDayLoopController(commandBus, { guestArchetypes, demandConfiguration = {} } = {}) {
  return new DayLoopController(commandBus, { register: true, guestArchetypes, demandConfiguration });
}

export { createServiceTimerState, RUNTIME_PHASE, SERVICE_END_REASON, SERVICE_LIFECYCLE };
