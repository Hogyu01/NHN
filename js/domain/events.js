import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { RngRegistry } from "../core/rng.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";

export const EVENT_RNG_STREAM = "event";
export const EVENT_SELECTION = Object.freeze({
  FIXED_DAY_1: "FIXED_DAY_1",
  RANDOM_DAY_2_14: "RANDOM_DAY_2_14",
});
export const EVENT_COMMAND = Object.freeze({
  INITIALIZE_DAY: "event.day.initialize",
});
export const EVENT_INITIALIZE_READ_SET = Object.freeze(["campaign"]);
export const EVENT_INITIALIZE_WRITE_SET = Object.freeze(["events", "rng"]);
export const EVENT_MODIFIER_FIELDS = Object.freeze([
  "guestCountDelta",
  "patienceDeltaMs",
  "timingWindowBonusMs",
  "marketPurchaseLimitBonusQuantity",
]);
export const ZERO_EVENT_MODIFIERS = freezeDeep(Object.fromEntries(
  EVENT_MODIFIER_FIELDS.map((field) => [field, 0]),
));

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
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

function requireDay(day, field = "day") {
  return Number.isSafeInteger(day) && day >= 1 && day <= 14
    ? validationSuccess()
    : failure("INVALID_EVENT_DAY", { field, value: day });
}

function validateModifiers(modifiers, field = "modifiers") {
  if (!isPlainRecord(modifiers)) return failure("INVALID_EVENT_MODIFIERS", { field });
  const keys = Object.keys(modifiers).sort();
  const expected = [...EVENT_MODIFIER_FIELDS].sort();
  if (!equivalent(keys, expected)) {
    return failure("EVENT_MODIFIER_FIELDS_MISMATCH", { field, expected, actual: keys });
  }
  for (const name of EVENT_MODIFIER_FIELDS) {
    if (!Number.isSafeInteger(modifiers[name])) {
      return failure("INVALID_EVENT_MODIFIER_VALUE", { field: `${field}.${name}`, value: modifiers[name] });
    }
  }
  return validationSuccess();
}

export function validateEventDefinition(definition, field = "event") {
  if (!isPlainRecord(definition)) return failure("INVALID_EVENT_DEFINITION", { field });
  if (!isStableIdentifier(definition.eventId)) {
    return failure("INVALID_EVENT_ID", { field: `${field}.eventId`, value: definition.eventId });
  }
  for (const name of ["displayName", "description"]) {
    if (typeof definition[name] !== "string" || definition[name].trim() === "") {
      return failure("INVALID_EVENT_TEXT", { field: `${field}.${name}` });
    }
  }
  if (!Object.values(EVENT_SELECTION).includes(definition.selection)) {
    return failure("INVALID_EVENT_SELECTION", { field: `${field}.selection`, value: definition.selection });
  }
  if (definition.durationDays !== 1) {
    return failure("INVALID_MUST_EVENT_DURATION", { field: `${field}.durationDays`, value: definition.durationDays });
  }
  return validateModifiers(definition.modifiers, `${field}.modifiers`);
}

/** Canonical order prevents source-file order from affecting deterministic random selection. */
export function createEventCatalog(eventDefinitions) {
  if (!Array.isArray(eventDefinitions) || eventDefinitions.length === 0) {
    throw Object.assign(new TypeError("eventDefinitions 배열이 필요합니다."), {
      code: "INVALID_EVENT_CATALOG",
    });
  }
  const catalog = eventDefinitions.map((definition, index) => {
    const validation = validateEventDefinition(definition, `events[${index}]`);
    if (!validation.ok) {
      throw Object.assign(new TypeError(validation.code), { code: validation.code, details: validation.details });
    }
    return cloneValue(definition);
  }).sort((left, right) => compareIds(left.eventId, right.eventId));
  const ids = new Set();
  for (const definition of catalog) {
    if (ids.has(definition.eventId)) {
      throw Object.assign(new TypeError("event ID가 중복되었습니다."), { code: "DUPLICATE_EVENT_ID" });
    }
    ids.add(definition.eventId);
  }
  const fixedCount = catalog.filter((definition) => definition.selection === EVENT_SELECTION.FIXED_DAY_1).length;
  const randomCount = catalog.filter((definition) => definition.selection === EVENT_SELECTION.RANDOM_DAY_2_14).length;
  if (fixedCount !== 1) {
    throw Object.assign(new TypeError("Day 1 고정 사건은 정확히 하나여야 합니다."), {
      code: "FIXED_DAY_1_EVENT_CARDINALITY_INVALID",
    });
  }
  if (randomCount < 1) {
    throw Object.assign(new TypeError("Day 2..14 사건 pool이 비어 있습니다."), {
      code: "RANDOM_EVENT_POOL_EMPTY",
    });
  }
  return freezeDeep(catalog);
}

function validateActiveEvent(activeEvent, field = "activeEvent") {
  if (!isPlainRecord(activeEvent) || !isStableIdentifier(activeEvent.eventId)) {
    return failure("INVALID_ACTIVE_EVENT", { field });
  }
  const day = requireDay(activeEvent.generatedDay, `${field}.generatedDay`);
  if (!day.ok) return day;
  if (typeof activeEvent.displayName !== "string" || activeEvent.displayName.trim() === "" ||
      typeof activeEvent.description !== "string" || activeEvent.description.trim() === "" ||
      activeEvent.durationDays !== 1) {
    return failure("INVALID_ACTIVE_EVENT_METADATA", { field });
  }
  return validateModifiers(activeEvent.modifiers, `${field}.modifiers`);
}

export function validateEventState(state) {
  if (!isPlainRecord(state) || !Array.isArray(state.history)) {
    return failure("INVALID_EVENT_STATE");
  }
  const activeIsNull = state.activeEvent === null;
  if (!activeIsNull) {
    const activeValidation = validateActiveEvent(state.activeEvent);
    if (!activeValidation.ok) return activeValidation;
  }
  const modifierValidation = validateModifiers(state.activeModifiers, "activeModifiers");
  if (!modifierValidation.ok) return modifierValidation;
  const expectedModifiers = activeIsNull ? ZERO_EVENT_MODIFIERS : state.activeEvent.modifiers;
  if (!equivalent(state.activeModifiers, expectedModifiers)) {
    return failure("ACTIVE_EVENT_MODIFIER_MISMATCH");
  }
  if (activeIsNull && state.history.length !== 0) {
    return failure("EVENT_HISTORY_WITHOUT_ACTIVE_EVENT");
  }
  for (let index = 0; index < state.history.length; index += 1) {
    const entry = state.history[index];
    if (!isPlainRecord(entry) || !isStableIdentifier(entry.eventId)) {
      return failure("INVALID_EVENT_HISTORY_ENTRY", { index });
    }
    const dayValidation = requireDay(entry.day, `history[${index}].day`);
    if (!dayValidation.ok) return dayValidation;
    if (entry.day !== index + 1) {
      return failure("EVENT_HISTORY_DAY_SEQUENCE_INVALID", { index, day: entry.day });
    }
  }
  if (!activeIsNull) {
    const latest = state.history[state.history.length - 1];
    if (!latest || latest.day !== state.activeEvent.generatedDay || latest.eventId !== state.activeEvent.eventId) {
      return failure("ACTIVE_EVENT_HISTORY_MISMATCH");
    }
  }
  return validationSuccess({ activeEventCount: activeIsNull ? 0 : 1, historyCount: state.history.length });
}

export function createEventState({ activeEvent = null, history = null } = {}) {
  const normalizedActive = activeEvent === null ? null : cloneValue(activeEvent);
  const normalizedHistory = history === null
    ? (normalizedActive === null ? [] : [{ day: normalizedActive.generatedDay, eventId: normalizedActive.eventId }])
    : cloneValue(history);
  const state = {
    activeEvent: normalizedActive,
    activeModifiers: normalizedActive === null ? cloneValue(ZERO_EVENT_MODIFIERS) : cloneValue(normalizedActive.modifiers),
    history: normalizedHistory,
  };
  const validation = validateEventState(state);
  if (!validation.ok) {
    throw Object.assign(new TypeError(`EventState가 유효하지 않습니다: ${validation.code}`), {
      code: validation.code,
      details: validation.details,
    });
  }
  return freezeDeep(state);
}

function eventSnapshot(definition, generatedDay) {
  return {
    eventId: definition.eventId,
    displayName: definition.displayName,
    description: definition.description,
    generatedDay,
    durationDays: definition.durationDays,
    modifiers: cloneValue(definition.modifiers),
  };
}

/**
 * Pure deterministic Must event selection. Day 1 performs no RNG draw; Day 2..14 consume only
 * the named `event` stream and return the final registry checkpoint.
 */
export function generateDailyEvent({ rngState, day, eventDefinitions } = {}) {
  const dayValidation = requireDay(day);
  if (!dayValidation.ok) throw Object.assign(new TypeError(dayValidation.code), { code: dayValidation.code });
  const catalog = createEventCatalog(eventDefinitions);
  let registry;
  try {
    registry = RngRegistry.fromState(rngState);
  } catch (error) {
    throw Object.assign(new TypeError("INVALID_EVENT_RNG_STATE"), { code: "INVALID_EVENT_RNG_STATE", cause: error });
  }
  if (!registry.hasStream(EVENT_RNG_STREAM)) {
    throw Object.assign(new TypeError("EVENT_RNG_STREAM_MISSING"), { code: "EVENT_RNG_STREAM_MISSING" });
  }
  const streamBefore = registry.getStreamState(EVENT_RNG_STREAM);
  let selected;
  if (day === 1) {
    selected = catalog.find((definition) => definition.selection === EVENT_SELECTION.FIXED_DAY_1);
  } else {
    const candidates = catalog
      .filter((definition) => definition.selection === EVENT_SELECTION.RANDOM_DAY_2_14)
      .sort((left, right) => compareIds(left.eventId, right.eventId));
    selected = candidates[registry.nextInt(EVENT_RNG_STREAM, candidates.length)];
  }
  const event = freezeDeep(eventSnapshot(selected, day));
  const streamAfter = registry.getStreamState(EVENT_RNG_STREAM);
  return freezeDeep({
    event,
    historyRecord: { day, eventId: event.eventId },
    rngState: registry.snapshot(),
    eventStreamBefore: streamBefore,
    eventStreamAfter: streamAfter,
    drawsConsumed: streamAfter.drawCount - streamBefore.drawCount,
  });
}

function unchangedNonEventStreams(before, after) {
  const beforeNames = Object.keys(before?.streams ?? {}).sort();
  const afterNames = Object.keys(after?.streams ?? {}).sort();
  if (!equivalent(beforeNames, afterNames)) return false;
  return beforeNames.every((name) => name === EVENT_RNG_STREAM || equivalent(before.streams[name], after.streams[name]));
}

export function planDailyEventInitialization({ campaign, events, rng }, payload, eventDefinitions) {
  if (!isPlainRecord(payload)) return failure("INVALID_EVENT_INITIALIZE_PAYLOAD");
  const payloadDay = requireDay(payload.day, "payload.day");
  if (!payloadDay.ok) return payloadDay;
  if (!isPlainRecord(campaign) || !Number.isSafeInteger(campaign.day) || campaign.day !== payload.day) {
    return failure("EVENT_DAY_MISMATCH", { campaignDay: campaign?.day, payloadDay: payload.day });
  }
  const stateValidation = validateEventState(events);
  if (!stateValidation.ok) return stateValidation;
  if (events.activeEvent?.generatedDay === payload.day) {
    return failure("EVENT_ALREADY_ACTIVE_FOR_DAY", { day: payload.day, eventId: events.activeEvent.eventId });
  }
  const expectedDay = events.history.length + 1;
  if (payload.day !== expectedDay) {
    return failure("EVENT_DAY_SEQUENCE_INVALID", { expectedDay, actualDay: payload.day });
  }
  let generated;
  try {
    generated = generateDailyEvent({ rngState: rng, day: payload.day, eventDefinitions });
  } catch (error) {
    return failure(error?.code ?? "EVENT_GENERATION_FAILED");
  }
  let eventState;
  try {
    eventState = createEventState({
      activeEvent: generated.event,
      history: [...events.history, generated.historyRecord],
    });
  } catch (error) {
    return failure(error?.code ?? "EVENT_STATE_CREATION_FAILED");
  }
  if (!unchangedNonEventStreams(rng, generated.rngState)) {
    return failure("EVENT_RNG_STREAM_ISOLATION_VIOLATION");
  }
  return success({
    events: eventState,
    rng: generated.rngState,
    previousEventId: events.activeEvent?.eventId ?? null,
    event: generated.event,
    drawsConsumed: generated.drawsConsumed,
  });
}

export function createInitializeDailyEventAtomicTransaction(eventDefinitions) {
  const catalog = createEventCatalog(eventDefinitions);
  return defineAtomicTransaction({
    name: EVENT_COMMAND.INITIALIZE_DAY,
    readSet: EVENT_INITIALIZE_READ_SET,
    writeSet: EVENT_INITIALIZE_WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      if (!isPlainRecord(ctx.command.payload)) return failure("INVALID_EVENT_INITIALIZE_PAYLOAD");
      return requireDay(ctx.command.payload.day, "payload.day");
    },
    preflight(ctx) {
      return planDailyEventInitialization({
        campaign: ctx.read("campaign"),
        events: ctx.read("events"),
        rng: ctx.read("rng"),
      }, ctx.command.payload, catalog);
    },
    mutate(draft) {
      const planned = planDailyEventInitialization({
        campaign: draft.read("campaign"),
        events: draft.read("events"),
        rng: draft.read("rng"),
      }, draft.command.payload, catalog);
      if (!planned.ok) return planned;
      draft.replace("events", planned.plan.events);
      draft.replace("rng", planned.plan.rng);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planDailyEventInitialization({
        campaign: before.campaign,
        events: before.events,
        rng: before.rng,
      }, ctx.command.payload, catalog);
      if (!planned.ok) return planned;
      if (!equivalent(after.events, planned.plan.events) || !equivalent(after.rng, planned.plan.rng)) {
        return failure("EVENT_INITIALIZATION_PLAN_MISMATCH");
      }
      if (!unchangedNonEventStreams(before.rng, after.rng)) {
        return failure("EVENT_RNG_STREAM_ISOLATION_VIOLATION");
      }
      return validationSuccess({ activeEventCount: 1, drawsConsumed: planned.plan.drawsConsumed });
    },
    events(before, _after, ctx) {
      const planned = planDailyEventInitialization({
        campaign: before.campaign,
        events: before.events,
        rng: before.rng,
      }, ctx.command.payload, catalog);
      if (!planned.ok) return [];
      return [{
        type: "event.daily-initialized",
        payload: {
          day: planned.plan.event.generatedDay,
          eventId: planned.plan.event.eventId,
          previousEventId: planned.plan.previousEventId,
          modifiers: planned.plan.event.modifiers,
          drawsConsumed: planned.plan.drawsConsumed,
        },
      }];
    },
  });
}

function commandEnvelope(input) {
  return {
    commandId: input?.commandId,
    expectedRevision: input?.expectedRevision,
    generationId: input?.generationId,
    issuedAtSimulationMs: input?.issuedAtSimulationMs,
    type: EVENT_COMMAND.INITIALIZE_DAY,
    payload: input?.payload,
    readSet: [...EVENT_INITIALIZE_READ_SET],
    writeSet: [...EVENT_INITIALIZE_WRITE_SET],
  };
}

/** Stale prior-day modifiers never project into a newly advanced campaign day. */
export function projectEvents(snapshot) {
  const validation = validateEventState(snapshot.events);
  if (!validation.ok) throw new TypeError(`Event projection이 유효하지 않습니다: ${validation.code}`);
  const activeForDay = snapshot.events.activeEvent?.generatedDay === snapshot.campaign?.day;
  return freezeDeep({
    day: snapshot.campaign?.day ?? null,
    activeEventCount: activeForDay ? 1 : 0,
    activeEvent: activeForDay ? cloneValue(snapshot.events.activeEvent) : null,
    modifiers: activeForDay ? cloneValue(snapshot.events.activeModifiers) : cloneValue(ZERO_EVENT_MODIFIERS),
    history: cloneValue(snapshot.events.history),
  });
}

export class EventSystem {
  constructor(commandBus, { eventDefinitions, register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("EventSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.eventDefinitions = createEventCatalog(eventDefinitions);
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(
      EVENT_COMMAND.INITIALIZE_DAY,
      createInitializeDailyEventAtomicTransaction(this.eventDefinitions),
    );
    this.registered = true;
    return this;
  }

  initializeDay(input) {
    return this.commandBus.dispatch(commandEnvelope(input));
  }

  project(snapshot) {
    return projectEvents(snapshot);
  }
}

export function registerEventSystem(commandBus, eventDefinitions) {
  return new EventSystem(commandBus, { eventDefinitions, register: true });
}
