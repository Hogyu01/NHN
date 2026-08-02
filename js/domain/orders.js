import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { validateEventState, ZERO_EVENT_MODIFIERS } from "./events.js";
import {
  FACILITY_EFFECT_TYPE,
  validateFacilityState,
} from "./facility.js";
import { validateMenuState } from "./menu.js";
import { validateRecipeState } from "./recipe.js";
import {
  planSaleSlotAssignment,
  planSaleSlotRelease,
  SALE_SLOT_RELEASE_REASON,
  SALE_SLOT_STATE,
  validateSaleSlotsState,
} from "./sale-slots.js";
import {
  RUNTIME_PHASE,
  SERVICE_LIFECYCLE,
  validateServiceTimerState,
} from "./timer-state.js";

export const ORDER_COMMAND = Object.freeze({
  CREATE: "order.create",
  TIMEOUT: "order.timeout",
});

export const ORDER_CREATE_READ_SET = Object.freeze([
  "menu",
  "campaign",
  "recipes",
  "events",
  "facilities",
]);
export const ORDER_CREATE_WRITE_SET = Object.freeze([
  "service",
  "saleSlots",
  "idCounters",
]);
export const ORDER_TIMEOUT_READ_SET = Object.freeze(["menu", "recipes"]);
export const ORDER_TIMEOUT_WRITE_SET = Object.freeze(["service", "saleSlots"]);

export const ACTIVE_ORDER_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  TIMED_OUT: "TIMED_OUT",
  TECHNICAL_CANCELLED: "TECHNICAL_CANCELLED",
});

export const ORDER_GUEST_STATE = Object.freeze({
  ENTERING: "ENTERING",
  MOVING_TO_SEAT: "MOVING_TO_SEAT",
  SEATED: "SEATED",
  ORDERING: "ORDERING",
  MEAL_REACTION: "MEAL_REACTION",
  MOVING_TO_EXIT: "MOVING_TO_EXIT",
  EXITED: "EXITED",
});

export const ORDER_REACTION_KIND = Object.freeze({
  SUCCESS: "SUCCESS",
  FAILURE_STOCKOUT: "FAILURE_STOCKOUT",
  FAILURE_TIMEOUT: "FAILURE_TIMEOUT",
});

export const ORDER_OUTCOME = Object.freeze({
  CREATED: "CREATED",
  STOCKOUT: "STOCKOUT",
  TIMED_OUT: "TIMED_OUT",
});

export const ORDER_PATIENCE_LIMITS = Object.freeze({
  minimumMs: 20_000,
  baseMs: 30_000,
  maximumMs: 60_000,
});

export const ORDER_REACTION_DURATION_MS = 480;

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_ORDER_CONFIGURATION: "주문 설정이 올바르지 않습니다.",
  INVALID_ORDER_CREATE_PAYLOAD: "주문 생성 요청 형식이 올바르지 않습니다.",
  INVALID_ORDER_TIMEOUT_PAYLOAD: "주문 timeout 요청 형식이 올바르지 않습니다.",
  ORDER_REQUIRES_RUNNING_SERVICE: "실행 중인 Service에서만 주문을 처리할 수 있습니다.",
  ORDER_MENU_NOT_LOCKED: "잠긴 Service 메뉴에서만 주문을 처리할 수 있습니다.",
  ORDER_RECIPE_STATE_INVALID: "주문 처리에 필요한 Recipe 상태가 올바르지 않습니다.",
  ORDER_MENU_STATE_INVALID: "주문 처리에 필요한 메뉴 상태가 올바르지 않습니다.",
  ORDER_SALE_SLOT_STATE_INVALID: "주문 처리에 필요한 SaleSlot 상태가 올바르지 않습니다.",
  ORDER_EVENT_STATE_INVALID: "주문 처리에 필요한 사건 상태가 올바르지 않습니다.",
  ORDER_FACILITY_STATE_INVALID: "주문 처리에 필요한 시설 상태가 올바르지 않습니다.",
  ORDER_SERVICE_STATE_INVALID: "주문 처리에 필요한 Service 상태가 올바르지 않습니다.",
  INVALID_ORDER_GUEST: "주문 손님 상태가 올바르지 않습니다.",
  ORDER_GUEST_NOT_FOUND: "주문할 손님을 찾을 수 없습니다.",
  ORDER_GUEST_NOT_SEATED: "Seat에 도달한 손님만 주문을 생성할 수 있습니다.",
  GUEST_ORDER_ALREADY_CREATED: "손님의 주문이 이미 생성되었습니다.",
  GUEST_ORDER_OUTCOME_ALREADY_RECORDED: "손님의 주문 실패 결과가 이미 기록되었습니다.",
  ORDER_GUEST_PLAN_NOT_FOUND: "손님의 ScheduledGuestPlan을 찾을 수 없습니다.",
  INVALID_ACTIVE_ORDER: "Active_Order 형식이 올바르지 않습니다.",
  DUPLICATE_ORDER_ID: "Order_ID가 중복되었습니다.",
  ORDER_COLLECTION_ORDER_INVALID: "주문 collection의 결정론적 순서가 올바르지 않습니다.",
  ORDER_ID_STATE_INVALID: "Order_ID 상태가 올바르지 않습니다.",
  ORDER_ID_STATE_MISMATCH: "Order_ID 상태가 캠페인과 일치하지 않습니다.",
  ORDER_ID_ALLOCATION_FAILED: "Order_ID를 할당할 수 없습니다.",
  ORDER_SLOT_ASSIGNMENT_FAILED: "주문과 SaleSlot을 함께 할당하지 못했습니다.",
  ORDER_UNMET_DEMAND_OVERFLOW: "unmet-demand 통계가 safe integer 범위를 초과했습니다.",
  ORDER_NOT_FOUND: "timeout할 주문을 찾을 수 없습니다.",
  ORDER_TIMEOUT_ALREADY_APPLIED: "주문 timeout과 SaleSlot 반환이 이미 처리되었습니다.",
  ORDER_NOT_ACTIVE: "ACTIVE 주문만 timeout할 수 있습니다.",
  ORDER_PATIENCE_REMAINS: "주문 인내 시간이 남아 있어 timeout할 수 없습니다.",
  ORDER_TIMEOUT_SLOT_RELEASE_FAILED: "주문 timeout과 SaleSlot 반환을 함께 처리하지 못했습니다.",
  ORDER_POSTCONDITION_FAILED: "주문 원자 변경 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "주문 검증에 실패했습니다.",
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

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeOrderConfiguration(configuration = {}) {
  const normalized = {
    basePatienceMs: configuration.basePatienceMs ?? ORDER_PATIENCE_LIMITS.baseMs,
    minimumPatienceMs: configuration.minimumPatienceMs ?? ORDER_PATIENCE_LIMITS.minimumMs,
    maximumPatienceMs: configuration.maximumPatienceMs ?? ORDER_PATIENCE_LIMITS.maximumMs,
    reactionDurationMs: configuration.reactionDurationMs ?? ORDER_REACTION_DURATION_MS,
  };
  const valid = Number.isSafeInteger(normalized.basePatienceMs) &&
    Number.isSafeInteger(normalized.minimumPatienceMs) &&
    Number.isSafeInteger(normalized.maximumPatienceMs) &&
    normalized.minimumPatienceMs === ORDER_PATIENCE_LIMITS.minimumMs &&
    normalized.basePatienceMs === ORDER_PATIENCE_LIMITS.baseMs &&
    normalized.maximumPatienceMs === ORDER_PATIENCE_LIMITS.maximumMs &&
    normalized.reactionDurationMs === ORDER_REACTION_DURATION_MS;
  if (!valid) {
    const error = new RangeError(MESSAGE_BY_CODE.INVALID_ORDER_CONFIGURATION);
    error.code = "INVALID_ORDER_CONFIGURATION";
    error.details = normalized;
    throw error;
  }
  return freezeDeep(normalized);
}

export function compareActiveOrders(left, right) {
  return left.createdAtMs - right.createdAtMs || compareIds(left.orderId, right.orderId);
}

function validateReaction(reaction, field) {
  if (!isPlainRecord(reaction) ||
      !Object.values(ORDER_REACTION_KIND).includes(reaction.kind) ||
      reaction.elapsedMs !== 0 || reaction.durationMs !== ORDER_REACTION_DURATION_MS) {
    return failure("INVALID_ORDER_GUEST", { field, reaction });
  }
  return validationSuccess();
}

export function validateOrderGuest(guest, field = "guest") {
  if (!isPlainRecord(guest) || !isStableIdentifier(guest.guestId) ||
      !isStableIdentifier(guest.entityId) ||
      !Object.values(ORDER_GUEST_STATE).includes(guest.state)) {
    return failure("INVALID_ORDER_GUEST", { field });
  }
  if ([ORDER_GUEST_STATE.SEATED, ORDER_GUEST_STATE.ORDERING, ORDER_GUEST_STATE.MEAL_REACTION]
    .includes(guest.state) && !isStableIdentifier(guest.seatId)) {
    return failure("INVALID_ORDER_GUEST", { field: `${field}.seatId`, value: guest.seatId });
  }
  if (guest.state === ORDER_GUEST_STATE.MEAL_REACTION) {
    return validateReaction(guest.reaction, `${field}.reaction`);
  }
  if ([ORDER_GUEST_STATE.SEATED, ORDER_GUEST_STATE.ORDERING].includes(guest.state) &&
      guest.reaction !== null) {
    return failure("INVALID_ORDER_GUEST", { field: `${field}.reaction` });
  }
  return validationSuccess();
}

export function validateActiveOrder(order, field = "order") {
  if (!isPlainRecord(order)) return failure("INVALID_ACTIVE_ORDER", { field });
  for (const name of ["orderId", "guestId", "recipeId", "saleSlotId"]) {
    if (!isStableIdentifier(order[name])) {
      return failure("INVALID_ACTIVE_ORDER", { field: `${field}.${name}`, value: order[name] });
    }
  }
  if (!Number.isSafeInteger(order.createdAtMs) || order.createdAtMs < 0 ||
      !Number.isSafeInteger(order.patienceRemainingMs) ||
      !Object.values(ACTIVE_ORDER_STATE).includes(order.state)) {
    return failure("INVALID_ACTIVE_ORDER", { field, order });
  }
  return validationSuccess();
}

function validateOrderServiceState(service, saleSlots) {
  const timerValidation = validateServiceTimerState(service, { runtimePhase: RUNTIME_PHASE.SERVICE });
  if (!timerValidation.ok || service.lifecycle !== SERVICE_LIFECYCLE.RUNNING || service.resultsClosed) {
    return failure("ORDER_SERVICE_STATE_INVALID", {
      cause: timerValidation.code,
      lifecycle: service?.lifecycle,
      resultsClosed: service?.resultsClosed,
    });
  }
  const slotValidation = validateSaleSlotsState(saleSlots);
  if (!slotValidation.ok) {
    return failure("ORDER_SALE_SLOT_STATE_INVALID", { cause: slotValidation.code });
  }
  const guestIds = new Set();
  for (let index = 0; index < service.guests.length; index += 1) {
    const guest = service.guests[index];
    const validation = validateOrderGuest(guest, `service.guests[${index}]`);
    if (!validation.ok) return validation;
    if (guestIds.has(guest.guestId)) {
      return failure("INVALID_ORDER_GUEST", { guestId: guest.guestId, reason: "DUPLICATE" });
    }
    guestIds.add(guest.guestId);
  }
  const orderIds = new Set();
  const activeGuestIds = new Set();
  for (let index = 0; index < service.orders.length; index += 1) {
    const order = service.orders[index];
    const validation = validateActiveOrder(order, `service.orders[${index}]`);
    if (!validation.ok) return validation;
    if (orderIds.has(order.orderId)) return failure("DUPLICATE_ORDER_ID", { orderId: order.orderId });
    if (index > 0 && compareActiveOrders(service.orders[index - 1], order) >= 0) {
      return failure("ORDER_COLLECTION_ORDER_INVALID", { index });
    }
    orderIds.add(order.orderId);
    if (order.state === ACTIVE_ORDER_STATE.ACTIVE) {
      if (activeGuestIds.has(order.guestId)) {
        return failure("INVALID_ACTIVE_ORDER", { guestId: order.guestId, reason: "MULTIPLE_ACTIVE" });
      }
      activeGuestIds.add(order.guestId);
      const slot = saleSlots.slots.find((candidate) => candidate.saleSlotId === order.saleSlotId);
      const guest = service.guests.find((candidate) => candidate.guestId === order.guestId);
      if (!slot || slot.state !== SALE_SLOT_STATE.ASSIGNED || slot.activeOrderId !== order.orderId ||
          slot.recipeId !== order.recipeId || guest?.state !== ORDER_GUEST_STATE.ORDERING) {
        return failure("INVALID_ACTIVE_ORDER", { orderId: order.orderId, reason: "LINK_MISMATCH" });
      }
    }
  }
  for (const slot of saleSlots.slots.filter((candidate) => candidate.state === SALE_SLOT_STATE.ASSIGNED)) {
    const order = service.orders.find((candidate) => candidate.orderId === slot.activeOrderId);
    if (!order || order.state !== ACTIVE_ORDER_STATE.ACTIVE || order.saleSlotId !== slot.saleSlotId) {
      return failure("INVALID_ACTIVE_ORDER", { saleSlotId: slot.saleSlotId, reason: "ORPHAN_ASSIGNED_SLOT" });
    }
  }
  return validationSuccess({ activeOrderCount: activeGuestIds.size });
}

function activeEventModifiers(events, campaignDay) {
  return events.activeEvent?.generatedDay === campaignDay
    ? events.activeModifiers
    : ZERO_EVENT_MODIFIERS;
}

export function calculateOrderPatienceMs({
  basePatienceMs = ORDER_PATIENCE_LIMITS.baseMs,
  minimumPatienceMs = ORDER_PATIENCE_LIMITS.minimumMs,
  maximumPatienceMs = ORDER_PATIENCE_LIMITS.maximumMs,
  campaignDay,
  events,
  facilities,
} = {}) {
  const config = normalizeOrderConfiguration({
    basePatienceMs,
    minimumPatienceMs,
    maximumPatienceMs,
    reactionDurationMs: ORDER_REACTION_DURATION_MS,
  });
  const eventValidation = validateEventState(events);
  if (!eventValidation.ok) {
    const error = new TypeError(MESSAGE_BY_CODE.ORDER_EVENT_STATE_INVALID);
    error.code = "ORDER_EVENT_STATE_INVALID";
    throw error;
  }
  const facilityValidation = validateFacilityState(facilities);
  if (!facilityValidation.ok) {
    const error = new TypeError(MESSAGE_BY_CODE.ORDER_FACILITY_STATE_INVALID);
    error.code = "ORDER_FACILITY_STATE_INVALID";
    throw error;
  }
  if (!Number.isSafeInteger(campaignDay) || campaignDay < 1 || campaignDay > 14) {
    const error = new TypeError(MESSAGE_BY_CODE.INVALID_ORDER_CONFIGURATION);
    error.code = "INVALID_ORDER_CONFIGURATION";
    throw error;
  }
  const modifiers = activeEventModifiers(events, campaignDay);
  let hallBonusMs = 0n;
  const purchased = new Set(facilities.purchasedFacilityIds);
  for (const definition of facilities.definitions) {
    if (purchased.has(definition.facilityId) &&
        definition.effect.type === FACILITY_EFFECT_TYPE.PATIENCE_BONUS_MS) {
      hallBonusMs += BigInt(definition.effect.value);
    }
  }
  const raw = BigInt(config.basePatienceMs) + BigInt(modifiers.patienceDeltaMs) + hallBonusMs;
  const bounded = raw < BigInt(config.minimumPatienceMs)
    ? BigInt(config.minimumPatienceMs)
    : raw > BigInt(config.maximumPatienceMs)
      ? BigInt(config.maximumPatienceMs)
      : raw;
  return Number(bounded);
}

function validateCreatePayload(payload) {
  return isPlainRecord(payload) && isStableIdentifier(payload.guestId)
    ? validationSuccess()
    : failure("INVALID_ORDER_CREATE_PAYLOAD");
}

function validateTimeoutPayload(payload) {
  return isPlainRecord(payload) && isStableIdentifier(payload.orderId)
    ? validationSuccess()
    : failure("INVALID_ORDER_TIMEOUT_PAYLOAD");
}

function validateCommonContext({ service, saleSlots, menu, recipes }) {
  const recipeValidation = validateRecipeState(recipes);
  if (!recipeValidation.ok) {
    return failure("ORDER_RECIPE_STATE_INVALID", { cause: recipeValidation.code });
  }
  const menuValidation = validateMenuState(menu, recipes);
  if (!menuValidation.ok) {
    return failure("ORDER_MENU_STATE_INVALID", { cause: menuValidation.code });
  }
  if (!menu.locked || menu.cleanupComplete) {
    return failure("ORDER_MENU_NOT_LOCKED", {
      menuLocked: menu.locked,
      cleanupComplete: menu.cleanupComplete,
    });
  }
  return validateOrderServiceState(service, saleSlots);
}

function allocateOrderId(idCounters, campaign, generationId) {
  try {
    const ids = IdService.fromState(idCounters);
    if (!isPlainRecord(campaign) || !isStableIdentifier(campaign.campaignId) ||
        !Number.isSafeInteger(campaign.day) || campaign.day < 1 || campaign.day > 14 ||
        ids.campaignId !== campaign.campaignId || ids.day !== campaign.day ||
        ids.generationId !== generationId) {
      return failure("ORDER_ID_STATE_MISMATCH");
    }
    const orderId = ids.next("order", { day: campaign.day });
    return success({ orderId, idCounters: ids.snapshot() });
  } catch {
    return failure("ORDER_ID_STATE_INVALID");
  }
}

function orderableRecipeId(plan, menu, saleSlots) {
  const activeRecipes = new Set(menu.confirmedEntries
    .filter((entry) => entry.enabled && entry.plannedQuantity > 0)
    .map((entry) => entry.recipeId));
  const availableRecipes = [...new Set(saleSlots.slots
    .filter((slot) => slot.state === SALE_SLOT_STATE.AVAILABLE && activeRecipes.has(slot.recipeId))
    .map((slot) => slot.recipeId))].sort(compareIds);
  for (const recipeId of plan.recipePreference) {
    if (availableRecipes.includes(recipeId)) return recipeId;
  }
  return availableRecipes[0] ?? null;
}

function reaction(kind, durationMs) {
  return { kind, elapsedMs: 0, durationMs };
}

/** Pure atomic plan for Seat-reached order creation or neutral stockout. */
export function planOrderCreation({
  service,
  saleSlots,
  idCounters,
  menu,
  recipes,
  campaign,
  events,
  facilities,
  runtimePhase,
  generationId,
  issuedAtSimulationMs,
}, payload, configuration = {}) {
  let config;
  try {
    config = normalizeOrderConfiguration(configuration);
  } catch (error) {
    return failure(error.code ?? "INVALID_ORDER_CONFIGURATION", error.details);
  }
  const payloadValidation = validateCreatePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE) {
    return failure("ORDER_REQUIRES_RUNNING_SERVICE", { runtimePhase });
  }
  if (!Number.isSafeInteger(issuedAtSimulationMs) || issuedAtSimulationMs < 0) {
    return failure("INVALID_ORDER_CREATE_PAYLOAD", { issuedAtSimulationMs });
  }
  const common = validateCommonContext({ service, saleSlots, menu, recipes });
  if (!common.ok) return common;
  const eventValidation = validateEventState(events);
  if (!eventValidation.ok) return failure("ORDER_EVENT_STATE_INVALID", { cause: eventValidation.code });
  const facilityValidation = validateFacilityState(facilities);
  if (!facilityValidation.ok) {
    return failure("ORDER_FACILITY_STATE_INVALID", { cause: facilityValidation.code });
  }
  if (!isPlainRecord(campaign) || !Number.isSafeInteger(campaign.day)) {
    return failure("INVALID_ORDER_CREATE_PAYLOAD", { field: "campaign" });
  }

  const guest = service.guests.find((candidate) => candidate.guestId === payload.guestId);
  if (!guest) return failure("ORDER_GUEST_NOT_FOUND", { guestId: payload.guestId });
  const existingOrder = service.orders.find((candidate) => candidate.guestId === payload.guestId);
  if (existingOrder || guest.state === ORDER_GUEST_STATE.ORDERING) {
    return failure("GUEST_ORDER_ALREADY_CREATED", {
      guestId: payload.guestId,
      orderId: existingOrder?.orderId ?? null,
    });
  }
  if (guest.state === ORDER_GUEST_STATE.MEAL_REACTION) {
    return failure("GUEST_ORDER_OUTCOME_ALREADY_RECORDED", { guestId: payload.guestId });
  }
  if (guest.state !== ORDER_GUEST_STATE.SEATED) {
    return failure("ORDER_GUEST_NOT_SEATED", { guestId: payload.guestId, state: guest.state });
  }
  const scheduledPlan = service.plans.find((plan) => plan.guestId === payload.guestId);
  if (!scheduledPlan || scheduledPlan.entityId !== guest.entityId) {
    return failure("ORDER_GUEST_PLAN_NOT_FOUND", { guestId: payload.guestId });
  }

  const recipeId = orderableRecipeId(scheduledPlan, menu, saleSlots);
  if (recipeId === null) {
    if (service.unmetDemandCount === Number.MAX_SAFE_INTEGER) {
      return failure("ORDER_UNMET_DEMAND_OVERFLOW");
    }
    const serviceCandidate = cloneValue(service);
    const guestCandidate = serviceCandidate.guests.find((candidate) => candidate.guestId === payload.guestId);
    guestCandidate.state = ORDER_GUEST_STATE.MEAL_REACTION;
    guestCandidate.reaction = reaction(ORDER_REACTION_KIND.FAILURE_STOCKOUT, config.reactionDurationMs);
    serviceCandidate.unmetDemandCount += 1;
    const nextValidation = validateOrderServiceState(serviceCandidate, saleSlots);
    if (!nextValidation.ok) return nextValidation;
    return success({
      outcome: ORDER_OUTCOME.STOCKOUT,
      service: serviceCandidate,
      saleSlots,
      idCounters,
      guestId: payload.guestId,
      order: null,
      unmetDemandDelta: 1,
      reaction: guestCandidate.reaction,
    });
  }

  const ids = allocateOrderId(idCounters, campaign, generationId);
  if (!ids.ok) return ids;
  const assigned = planSaleSlotAssignment(saleSlots, {
    recipeId,
    orderId: ids.plan.orderId,
  });
  if (!assigned.ok) {
    return failure("ORDER_SLOT_ASSIGNMENT_FAILED", { cause: assigned.code, recipeId });
  }
  let patienceRemainingMs;
  try {
    patienceRemainingMs = calculateOrderPatienceMs({
      basePatienceMs: config.basePatienceMs,
      minimumPatienceMs: config.minimumPatienceMs,
      maximumPatienceMs: config.maximumPatienceMs,
      campaignDay: campaign.day,
      events,
      facilities,
    });
  } catch (error) {
    return failure(error.code ?? "INVALID_ORDER_CONFIGURATION");
  }
  const order = {
    orderId: ids.plan.orderId,
    guestId: payload.guestId,
    recipeId,
    saleSlotId: assigned.plan.slot.saleSlotId,
    createdAtMs: issuedAtSimulationMs,
    patienceRemainingMs,
    state: ACTIVE_ORDER_STATE.ACTIVE,
  };
  const serviceCandidate = cloneValue(service);
  const guestCandidate = serviceCandidate.guests.find((candidate) => candidate.guestId === payload.guestId);
  guestCandidate.state = ORDER_GUEST_STATE.ORDERING;
  guestCandidate.reaction = null;
  serviceCandidate.orders.push(order);
  serviceCandidate.orders.sort(compareActiveOrders);
  const nextValidation = validateOrderServiceState(serviceCandidate, assigned.plan.saleSlots);
  if (!nextValidation.ok) return nextValidation;
  return success({
    outcome: ORDER_OUTCOME.CREATED,
    service: serviceCandidate,
    saleSlots: assigned.plan.saleSlots,
    idCounters: ids.plan.idCounters,
    guestId: payload.guestId,
    order,
    unmetDemandDelta: 0,
    reaction: null,
  });
}

/** Pure timeout plan: ACTIVE→TIMED_OUT, ASSIGNED→AVAILABLE, guest failure reaction. */
export function planOrderTimeout({
  service,
  saleSlots,
  menu,
  recipes,
  runtimePhase,
  issuedAtSimulationMs,
}, payload, configuration = {}) {
  let config;
  try {
    config = normalizeOrderConfiguration(configuration);
  } catch (error) {
    return failure(error.code ?? "INVALID_ORDER_CONFIGURATION", error.details);
  }
  const payloadValidation = validateTimeoutPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (runtimePhase !== RUNTIME_PHASE.SERVICE) {
    return failure("ORDER_REQUIRES_RUNNING_SERVICE", { runtimePhase });
  }
  const common = validateCommonContext({ service, saleSlots, menu, recipes });
  if (!common.ok) return common;
  const order = service.orders.find((candidate) => candidate.orderId === payload.orderId);
  if (!order) return failure("ORDER_NOT_FOUND", { orderId: payload.orderId });
  if (order.state === ACTIVE_ORDER_STATE.TIMED_OUT) {
    return failure("ORDER_TIMEOUT_ALREADY_APPLIED", { orderId: payload.orderId });
  }
  if (order.state !== ACTIVE_ORDER_STATE.ACTIVE) {
    return failure("ORDER_NOT_ACTIVE", { orderId: payload.orderId, state: order.state });
  }
  const elapsedMs = Number.isSafeInteger(issuedAtSimulationMs)
    ? Math.max(0, issuedAtSimulationMs - order.createdAtMs)
    : 0;
  const effectivePatienceRemainingMs = order.patienceRemainingMs - elapsedMs;
  if (effectivePatienceRemainingMs > 0) {
    return failure("ORDER_PATIENCE_REMAINS", {
      orderId: payload.orderId,
      patienceRemainingMs: effectivePatienceRemainingMs,
    });
  }
  const guest = service.guests.find((candidate) => candidate.guestId === order.guestId);
  if (!guest || guest.state !== ORDER_GUEST_STATE.ORDERING) {
    return failure("INVALID_ORDER_GUEST", { guestId: order.guestId, state: guest?.state });
  }
  const released = planSaleSlotRelease(saleSlots, {
    saleSlotId: order.saleSlotId,
    orderId: order.orderId,
    reason: SALE_SLOT_RELEASE_REASON.TIMEOUT,
  });
  if (!released.ok) {
    return failure("ORDER_TIMEOUT_SLOT_RELEASE_FAILED", { cause: released.code });
  }
  const serviceCandidate = cloneValue(service);
  const orderCandidate = serviceCandidate.orders.find((candidate) => candidate.orderId === payload.orderId);
  orderCandidate.state = ACTIVE_ORDER_STATE.TIMED_OUT;
  orderCandidate.patienceRemainingMs = Math.min(0, effectivePatienceRemainingMs);
  const guestCandidate = serviceCandidate.guests.find((candidate) => candidate.guestId === order.guestId);
  guestCandidate.state = ORDER_GUEST_STATE.MEAL_REACTION;
  guestCandidate.reaction = reaction(ORDER_REACTION_KIND.FAILURE_TIMEOUT, config.reactionDurationMs);
  const nextValidation = validateOrderServiceState(serviceCandidate, released.plan.saleSlots);
  if (!nextValidation.ok) return nextValidation;
  return success({
    outcome: ORDER_OUTCOME.TIMED_OUT,
    service: serviceCandidate,
    saleSlots: released.plan.saleSlots,
    order: orderCandidate,
    guestId: order.guestId,
    reaction: guestCandidate.reaction,
  });
}

function createOrderCreationAtomicTransaction(configuration) {
  const config = normalizeOrderConfiguration(configuration);
  return defineAtomicTransaction({
    name: ORDER_COMMAND.CREATE,
    readSet: ORDER_CREATE_READ_SET,
    writeSet: ORDER_CREATE_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateCreatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planOrderCreation({
        service: ctx.read("service"),
        saleSlots: ctx.read("saleSlots"),
        idCounters: ctx.read("idCounters"),
        menu: ctx.read("menu"),
        recipes: ctx.read("recipes"),
        campaign: ctx.read("campaign"),
        events: ctx.read("events"),
        facilities: ctx.read("facilities"),
        runtimePhase: ctx.phase,
        generationId: ctx.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload, config);
    },
    mutate(draft) {
      const planned = planOrderCreation({
        service: draft.read("service"),
        saleSlots: draft.read("saleSlots"),
        idCounters: draft.read("idCounters"),
        menu: draft.read("menu"),
        recipes: draft.read("recipes"),
        campaign: draft.read("campaign"),
        events: draft.read("events"),
        facilities: draft.read("facilities"),
        runtimePhase: RUNTIME_PHASE.SERVICE,
        generationId: draft.command.generationId,
        issuedAtSimulationMs: draft.command.issuedAtSimulationMs,
      }, draft.command.payload, config);
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      draft.replace("saleSlots", planned.plan.saleSlots);
      draft.replace("idCounters", planned.plan.idCounters);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planOrderCreation({
        service: before.service,
        saleSlots: before.saleSlots,
        idCounters: before.idCounters,
        menu: before.menu,
        recipes: before.recipes,
        campaign: before.campaign,
        events: before.events,
        facilities: before.facilities,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload, config);
      if (!planned.ok) return planned;
      for (const slice of ORDER_CREATE_WRITE_SET) {
        if (!equivalent(after[slice], planned.plan[slice])) {
          return failure("ORDER_POSTCONDITION_FAILED", { slice });
        }
      }
      return validateOrderServiceState(after.service, after.saleSlots);
    },
    events(before, _after, ctx) {
      const planned = planOrderCreation({
        service: before.service,
        saleSlots: before.saleSlots,
        idCounters: before.idCounters,
        menu: before.menu,
        recipes: before.recipes,
        campaign: before.campaign,
        events: before.events,
        facilities: before.facilities,
        runtimePhase: before.runtimePhase,
        generationId: before.generationId,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload, config);
      if (!planned.ok) return [];
      return planned.plan.outcome === ORDER_OUTCOME.CREATED
        ? [{
          type: "order.created",
          payload: {
            orderId: planned.plan.order.orderId,
            guestId: planned.plan.order.guestId,
            recipeId: planned.plan.order.recipeId,
            saleSlotId: planned.plan.order.saleSlotId,
            createdAtMs: planned.plan.order.createdAtMs,
            patienceRemainingMs: planned.plan.order.patienceRemainingMs,
          },
        }]
        : [{
          type: "order.stockout",
          payload: {
            guestId: planned.plan.guestId,
            unmetDemandDelta: 1,
            reactionDurationMs: config.reactionDurationMs,
            reputationDelta: 0,
          },
        }];
    },
  });
}

function createOrderTimeoutAtomicTransaction(configuration) {
  const config = normalizeOrderConfiguration(configuration);
  return defineAtomicTransaction({
    name: ORDER_COMMAND.TIMEOUT,
    readSet: ORDER_TIMEOUT_READ_SET,
    writeSet: ORDER_TIMEOUT_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SERVICE],
    validatePayload(ctx) {
      return validateTimeoutPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planOrderTimeout({
        service: ctx.read("service"),
        saleSlots: ctx.read("saleSlots"),
        menu: ctx.read("menu"),
        recipes: ctx.read("recipes"),
        runtimePhase: ctx.phase,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload, config);
    },
    mutate(draft) {
      const planned = planOrderTimeout({
        service: draft.read("service"),
        saleSlots: draft.read("saleSlots"),
        menu: draft.read("menu"),
        recipes: draft.read("recipes"),
        runtimePhase: RUNTIME_PHASE.SERVICE,
        issuedAtSimulationMs: draft.command.issuedAtSimulationMs,
      }, draft.command.payload, config);
      if (!planned.ok) return planned;
      draft.replace("service", planned.plan.service);
      draft.replace("saleSlots", planned.plan.saleSlots);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planOrderTimeout({
        service: before.service,
        saleSlots: before.saleSlots,
        menu: before.menu,
        recipes: before.recipes,
        runtimePhase: before.runtimePhase,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload, config);
      if (!planned.ok) return planned;
      if (!equivalent(after.service, planned.plan.service) ||
          !equivalent(after.saleSlots, planned.plan.saleSlots)) {
        return failure("ORDER_POSTCONDITION_FAILED");
      }
      return validateOrderServiceState(after.service, after.saleSlots);
    },
    events(before, _after, ctx) {
      const planned = planOrderTimeout({
        service: before.service,
        saleSlots: before.saleSlots,
        menu: before.menu,
        recipes: before.recipes,
        runtimePhase: before.runtimePhase,
        issuedAtSimulationMs: ctx.command.issuedAtSimulationMs,
      }, ctx.command.payload, config);
      if (!planned.ok) return [];
      return [{
        type: "order.timed-out",
        payload: {
          orderId: planned.plan.order.orderId,
          guestId: planned.plan.guestId,
          saleSlotId: planned.plan.order.saleSlotId,
          reactionDurationMs: config.reactionDurationMs,
          releaseReason: SALE_SLOT_RELEASE_REASON.TIMEOUT,
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

export function projectOrders(snapshot) {
  const validation = validateOrderServiceState(snapshot.service, snapshot.saleSlots);
  if (!validation.ok) {
    const error = new TypeError(`주문 projection이 유효하지 않습니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  const activeOrders = snapshot.service.orders
    .filter((order) => order.state === ACTIVE_ORDER_STATE.ACTIVE)
    .sort(compareActiveOrders)
    .map((order) => ({
      orderId: order.orderId,
      guestId: order.guestId,
      recipeId: order.recipeId,
      saleSlotId: order.saleSlotId,
      createdAtMs: order.createdAtMs,
      patienceRemainingMs: order.patienceRemainingMs,
    }));
  return freezeDeep({
    activeOrderCount: activeOrders.length,
    activeOrders,
    unmetDemandCount: snapshot.service.unmetDemandCount,
  });
}

export class OrderSystem {
  constructor(commandBus, { configuration = {}, register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" ||
        typeof commandBus.dispatch !== "function") {
      throw new TypeError("OrderSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.configuration = normalizeOrderConfiguration(configuration);
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(
      ORDER_COMMAND.CREATE,
      createOrderCreationAtomicTransaction(this.configuration),
    );
    this.commandBus.register(
      ORDER_COMMAND.TIMEOUT,
      createOrderTimeoutAtomicTransaction(this.configuration),
    );
    this.registered = true;
    return this;
  }

  createOrder(input) {
    return this.commandBus.dispatch(commandEnvelope(
      ORDER_COMMAND.CREATE,
      ORDER_CREATE_READ_SET,
      ORDER_CREATE_WRITE_SET,
      input,
    ));
  }

  timeoutOrder(input) {
    return this.commandBus.dispatch(commandEnvelope(
      ORDER_COMMAND.TIMEOUT,
      ORDER_TIMEOUT_READ_SET,
      ORDER_TIMEOUT_WRITE_SET,
      input,
    ));
  }

  project(snapshot) {
    return projectOrders(snapshot);
  }
}

export function registerOrderSystem(commandBus, configuration = {}) {
  return new OrderSystem(commandBus, { configuration, register: true });
}
