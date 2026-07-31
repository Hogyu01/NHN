import { cloneValue, freezeDeep } from "./result.js";

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const SCHEDULER_PRIORITY = Object.freeze({
  PAUSE: 0,
  TIMER_ZERO: 1,
  TIMEOUT: 2,
  PLAYER_INPUT: 3,
  COOK_COMPLETION: 4,
  ARRIVAL: 5,
});

export const SCHEDULER_EVENT_CLASS = Object.freeze({
  PAUSE: "PAUSE",
  TIMER_ZERO: "TIMER_ZERO",
  TIMEOUT: "TIMEOUT",
  PLAYER_INPUT: "PLAYER_INPUT",
  COOK_COMPLETION: "COOK_COMPLETION",
  ARRIVAL: "ARRIVAL",
});

export const SCHEDULER_CONTROL = Object.freeze({
  PAUSE_ACCEPTED: "PAUSE_ACCEPTED",
});

const PRIORITIES = new Set(Object.values(SCHEDULER_PRIORITY));
const EVENT_CLASSES = new Set(Object.values(SCHEDULER_EVENT_CLASS));

function requireSafeNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field}는 0 이상의 safe integer여야 합니다.`);
  }
  return value;
}

function requireStableId(value, field = "stableId") {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    throw new TypeError(`${field}가 stable identifier 형식이 아닙니다.`);
  }
  return value;
}

function requireEventClass(value) {
  if (!EVENT_CLASSES.has(value)) {
    throw new TypeError(`알 수 없는 scheduler event class입니다: ${value}`);
  }
  return value;
}

function requirePriority(value) {
  if (!Number.isInteger(value) || !PRIORITIES.has(value)) {
    throw new TypeError("scheduler priority는 canonical 0..5 중 하나여야 합니다.");
  }
  return value;
}

export function priorityForEventClass(eventClass) {
  return SCHEDULER_PRIORITY[requireEventClass(eventClass)];
}

function compareOrderedValue(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareScheduledItems(left, right) {
  return compareOrderedValue(left.simulationTimeMs, right.simulationTimeMs) ||
    compareOrderedValue(left.priority, right.priority) ||
    compareOrderedValue(left.insertionSequence, right.insertionSequence) ||
    compareOrderedValue(left.stableId, right.stableId);
}

function cloneSerializableData(value, path = "payload", ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path}에는 finite number만 허용됩니다.`);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path}에는 JSON 가능한 plain data만 허용됩니다.`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path}에는 순환 참조를 허용하지 않습니다.`);

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path}에는 plain object 또는 array만 허용됩니다.`);
  }
  ancestors.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = value.map((item, index) => cloneSerializableData(item, `${path}[${index}]`, ancestors));
  } else {
    copy = prototype === null ? Object.create(null) : {};
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new TypeError(`${path}에는 symbol key를 허용하지 않습니다.`);
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} accessor는 허용되지 않습니다.`);
      }
      copy[key] = cloneSerializableData(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return copy;
}

function normalizeQueueItem(input, { currentGenerationId, assignInsertionSequence = null }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("scheduler item은 plain object여야 합니다.");
  }
  const eventClass = requireEventClass(input.eventClass);
  const canonicalPriority = priorityForEventClass(eventClass);
  const priority = input.priority === undefined ? canonicalPriority : requirePriority(input.priority);
  if (priority !== canonicalPriority) {
    throw new RangeError(`${eventClass} priority가 canonical 값과 다릅니다.`);
  }
  const generationId = input.generationId === undefined
    ? currentGenerationId
    : requireSafeNonNegativeInteger(input.generationId, "item.generationId");
  if (generationId > currentGenerationId) {
    throw new RangeError("future generation scheduler item은 복원할 수 없습니다.");
  }
  const insertionSequence = assignInsertionSequence === null
    ? requireSafeNonNegativeInteger(input.insertionSequence, "item.insertionSequence")
    : assignInsertionSequence;
  const payload = Object.prototype.hasOwnProperty.call(input, "payload")
    ? cloneSerializableData(input.payload)
    : null;

  return {
    simulationTimeMs: requireSafeNonNegativeInteger(input.simulationTimeMs, "item.simulationTimeMs"),
    priority,
    insertionSequence,
    stableId: requireStableId(input.stableId),
    generationId,
    eventClass,
    payload,
  };
}

export function createSchedulerState({
  generationId = 0,
  simulationTimeMs = 0,
  nextInsertionSequence = 0,
  nextTraceSequence = 0,
  paused = false,
  queue = [],
} = {}) {
  requireSafeNonNegativeInteger(generationId, "generationId");
  requireSafeNonNegativeInteger(simulationTimeMs, "simulationTimeMs");
  requireSafeNonNegativeInteger(nextInsertionSequence, "nextInsertionSequence");
  requireSafeNonNegativeInteger(nextTraceSequence, "nextTraceSequence");
  if (typeof paused !== "boolean") throw new TypeError("paused는 boolean이어야 합니다.");
  if (!Array.isArray(queue)) throw new TypeError("scheduler queue는 배열이어야 합니다.");

  const normalizedQueue = queue.map((item) => normalizeQueueItem(item, { currentGenerationId: generationId }));
  const stableIds = new Set();
  let maximumSequence = -1;
  for (const item of normalizedQueue) {
    if (item.simulationTimeMs < simulationTimeMs) {
      throw new RangeError(`scheduler cursor보다 과거인 queue item입니다: ${item.stableId}`);
    }
    if (stableIds.has(item.stableId)) {
      throw new RangeError(`scheduler stableId가 중복입니다: ${item.stableId}`);
    }
    stableIds.add(item.stableId);
    maximumSequence = Math.max(maximumSequence, item.insertionSequence);
  }
  if (nextInsertionSequence <= maximumSequence) {
    throw new RangeError("nextInsertionSequence는 queue의 모든 sequence보다 커야 합니다.");
  }
  normalizedQueue.sort(compareScheduledItems);

  return freezeDeep({
    generationId,
    simulationTimeMs,
    nextInsertionSequence,
    nextTraceSequence,
    paused,
    queue: normalizedQueue,
  });
}

/** Deterministic scheduler with checkpointable queue and generation cursor. */
export class Scheduler {
  constructor(state = {}) {
    this._state = cloneValue(createSchedulerState(state));
    this._trace = [];
  }

  static fromState(state) {
    return new Scheduler(state);
  }

  get generationId() {
    return this._state.generationId;
  }

  get simulationTimeMs() {
    return this._state.simulationTimeMs;
  }

  get paused() {
    return this._state.paused;
  }

  get size() {
    return this._state.queue.length;
  }

  schedule(input) {
    if (this._state.nextInsertionSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("scheduler insertion sequence가 safe integer 범위를 초과했습니다.");
    }
    const item = normalizeQueueItem(input, {
      currentGenerationId: this._state.generationId,
      assignInsertionSequence: this._state.nextInsertionSequence,
    });
    if (item.generationId !== this._state.generationId) {
      throw new RangeError("현재 generation이 아닌 item을 새로 예약할 수 없습니다.");
    }
    if (item.simulationTimeMs < this._state.simulationTimeMs) {
      throw new RangeError("scheduler cursor보다 과거 timestamp에는 예약할 수 없습니다.");
    }
    if (this._state.queue.some((queued) => queued.stableId === item.stableId)) {
      throw new RangeError(`scheduler stableId가 중복입니다: ${item.stableId}`);
    }

    this._state.nextInsertionSequence += 1;
    this._state.queue.push(item);
    this._state.queue.sort(compareScheduledItems);
    this._appendTrace("SCHEDULED", item);
    return freezeDeep(cloneValue(item));
  }

  cancel(stableId, reason = "CANCELLED_BY_REQUEST") {
    const normalizedId = requireStableId(stableId);
    const index = this._state.queue.findIndex((item) => item.stableId === normalizedId);
    if (index < 0) return false;
    const [item] = this._state.queue.splice(index, 1);
    this._appendTrace("CANCELLED", item, reason);
    return true;
  }

  /**
   * Executes all due items in canonical order. Returning `PAUSE_ACCEPTED` (or an object with
   * `pauseAccepted: true`) commits scheduler pause immediately and leaves every remaining item in
   * the queue, including the rest of the same timestamp batch.
   */
  runDue(throughSimulationTimeMs, execute) {
    requireSafeNonNegativeInteger(throughSimulationTimeMs, "throughSimulationTimeMs");
    if (throughSimulationTimeMs < this._state.simulationTimeMs) {
      throw new RangeError("scheduler time은 역행할 수 없습니다.");
    }
    if (typeof execute !== "function") throw new TypeError("scheduler execute 함수가 필요합니다.");
    if (this._state.paused) {
      return freezeDeep({
        executed: [],
        deferred: this._state.queue.length,
        paused: true,
        simulationTimeMs: this._state.simulationTimeMs,
      });
    }

    const executed = [];
    while (this._state.queue.length > 0) {
      const item = this._state.queue[0];
      if (item.simulationTimeMs > throughSimulationTimeMs) break;
      this._state.queue.shift();

      if (item.generationId !== this._state.generationId) {
        this._appendTrace("CANCELLED", item, "STALE_GENERATION");
        continue;
      }

      let outcome;
      try {
        outcome = execute(freezeDeep(cloneValue(item)));
        if (outcome && typeof outcome.then === "function") {
          throw new TypeError("scheduler execute callback은 Promise를 반환할 수 없습니다.");
        }
      } catch (error) {
        this._state.queue.push(item);
        this._state.queue.sort(compareScheduledItems);
        this._appendTrace("EXECUTION_FAILED", item, error instanceof Error ? error.message : String(error));
        throw error;
      }

      this._state.simulationTimeMs = item.simulationTimeMs;
      executed.push(cloneValue(item));
      this._appendTrace("EXECUTED", item);

      const pauseAccepted = outcome === SCHEDULER_CONTROL.PAUSE_ACCEPTED || outcome?.pauseAccepted === true;
      if (pauseAccepted) {
        this._state.paused = true;
        for (const deferred of this._state.queue) {
          if (
            deferred.generationId === this._state.generationId &&
            deferred.simulationTimeMs === item.simulationTimeMs
          ) {
            this._appendTrace("DEFERRED", deferred, "PAUSE_ACCEPTED");
          }
        }
        return freezeDeep({
          executed,
          deferred: this._state.queue.length,
          paused: true,
          simulationTimeMs: this._state.simulationTimeMs,
        });
      }
    }

    this._state.simulationTimeMs = throughSimulationTimeMs;
    return freezeDeep({
      executed,
      deferred: this._state.queue.length,
      paused: false,
      simulationTimeMs: this._state.simulationTimeMs,
    });
  }

  resume() {
    if (!this._state.paused) return false;
    this._state.paused = false;
    this._appendTrace("RESUMED", {
      simulationTimeMs: this._state.simulationTimeMs,
      priority: SCHEDULER_PRIORITY.PAUSE,
      insertionSequence: this._state.nextInsertionSequence,
      stableId: "scheduler:resume",
      generationId: this._state.generationId,
      eventClass: SCHEDULER_EVENT_CLASS.PAUSE,
    }, "EXPLICIT_RESUME");
    return true;
  }

  restartGeneration({ simulationTimeMs = 0 } = {}) {
    requireSafeNonNegativeInteger(simulationTimeMs, "simulationTimeMs");
    if (this._state.generationId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("scheduler generationId가 safe integer 범위를 초과했습니다.");
    }
    const cancelled = this._state.queue.map((item) => freezeDeep(cloneValue(item)));
    for (const item of this._state.queue) {
      this._appendTrace("CANCELLED", item, "GENERATION_RESTART");
    }
    this._state.queue.length = 0;
    this._state.generationId += 1;
    this._state.simulationTimeMs = simulationTimeMs;
    this._state.paused = false;
    return freezeDeep({ generationId: this._state.generationId, cancelled });
  }

  snapshot() {
    return freezeDeep(cloneValue(this._state));
  }

  getTrace() {
    return freezeDeep(cloneValue(this._trace));
  }

  clearTrace() {
    this._trace.length = 0;
  }

  _appendTrace(action, item, reason = null) {
    if (this._state.nextTraceSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("scheduler trace sequence가 safe integer 범위를 초과했습니다.");
    }
    this._trace.push({
      traceSequence: this._state.nextTraceSequence,
      action,
      simulationTimeMs: item.simulationTimeMs,
      priority: item.priority,
      insertionSequence: item.insertionSequence,
      stableId: item.stableId,
      generationId: item.generationId,
      eventClass: item.eventClass,
      reason,
    });
    this._state.nextTraceSequence += 1;
  }
}
