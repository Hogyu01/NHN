import { cloneValue, freezeDeep } from "./result.js";
import { checkedAdd } from "./fixed-point.js";

export const SIMULATION_STEP_MS = 20;
export const ACCUMULATOR_CAP_MS = 250;

function requireSafeNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field}는 0 이상의 safe integer여야 합니다.`);
  }
  return value;
}

export function createSimulationClockState({
  simulationTimeMs = 0,
  accumulatorMs = 0,
  pendingElapsedMs = 0,
  logicalStepCount = simulationTimeMs / SIMULATION_STEP_MS,
  paused = false,
  lagEventCount = 0,
} = {}) {
  requireSafeNonNegativeInteger(simulationTimeMs, "simulationTimeMs");
  requireSafeNonNegativeInteger(accumulatorMs, "accumulatorMs");
  requireSafeNonNegativeInteger(pendingElapsedMs, "pendingElapsedMs");
  requireSafeNonNegativeInteger(logicalStepCount, "logicalStepCount");
  requireSafeNonNegativeInteger(lagEventCount, "lagEventCount");
  if (simulationTimeMs % SIMULATION_STEP_MS !== 0) {
    throw new RangeError("simulationTimeMs는 정확한 20ms step 경계여야 합니다.");
  }
  if (logicalStepCount !== simulationTimeMs / SIMULATION_STEP_MS) {
    throw new RangeError("logicalStepCount와 simulationTimeMs가 일치하지 않습니다.");
  }
  if (accumulatorMs >= SIMULATION_STEP_MS) {
    throw new RangeError("정규화된 accumulatorMs는 20ms보다 작아야 합니다.");
  }
  if (typeof paused !== "boolean") {
    throw new TypeError("paused는 boolean이어야 합니다.");
  }
  if (paused && (accumulatorMs !== 0 || pendingElapsedMs !== 0)) {
    throw new RangeError("PAUSED clock은 accumulator와 pending elapsed가 비어 있어야 합니다.");
  }

  return freezeDeep({
    simulationTimeMs,
    accumulatorMs,
    pendingElapsedMs,
    logicalStepCount,
    paused,
    lagEventCount,
  });
}

/**
 * Fixed-step logical clock. Wall elapsed is supplied by an adapter; this class never reads a
 * clock itself. A frame accepts at most 250ms, while excess elapsed remains pending for later
 * frames so no 20ms logical step is silently dropped.
 */
export class SimulationClock {
  constructor(state = {}) {
    this._state = cloneValue(createSimulationClockState(state));
  }

  static fromState(state) {
    return new SimulationClock(state);
  }

  get simulationTimeMs() {
    return this._state.simulationTimeMs;
  }

  get paused() {
    return this._state.paused;
  }

  get hasPendingElapsed() {
    return this._state.pendingElapsedMs > 0;
  }

  advance(elapsedMs) {
    requireSafeNonNegativeInteger(elapsedMs, "elapsedMs");
    if (this._state.paused) {
      return freezeDeep({
        acceptedElapsedMs: 0,
        deferredElapsedMs: 0,
        ignoredPausedElapsedMs: elapsedMs,
        lagged: false,
        steps: [],
        state: this.snapshot(),
      });
    }

    const pendingBeforeIntake = checkedAdd(this._state.pendingElapsedMs, elapsedMs);
    const acceptedElapsedMs = Math.min(pendingBeforeIntake, ACCUMULATOR_CAP_MS);
    const pendingElapsedMs = pendingBeforeIntake - acceptedElapsedMs;
    const accumulated = checkedAdd(this._state.accumulatorMs, acceptedElapsedMs);
    const stepCount = Math.floor(accumulated / SIMULATION_STEP_MS);
    const accumulatorMs = accumulated - stepCount * SIMULATION_STEP_MS;
    const timeDeltaMs = stepCount * SIMULATION_STEP_MS;
    const simulationTimeMs = checkedAdd(this._state.simulationTimeMs, timeDeltaMs);
    const logicalStepCount = checkedAdd(this._state.logicalStepCount, stepCount);
    const lagEventCount = elapsedMs > ACCUMULATOR_CAP_MS
      ? checkedAdd(this._state.lagEventCount, 1)
      : this._state.lagEventCount;

    const firstStepIndex = this._state.logicalStepCount + 1;
    const firstStepTimeMs = this._state.simulationTimeMs + SIMULATION_STEP_MS;
    const steps = Array.from({ length: stepCount }, (_unused, index) => ({
      stepIndex: firstStepIndex + index,
      simulationTimeMs: firstStepTimeMs + index * SIMULATION_STEP_MS,
      deltaMs: SIMULATION_STEP_MS,
    }));

    Object.assign(this._state, {
      simulationTimeMs,
      accumulatorMs,
      pendingElapsedMs,
      logicalStepCount,
      lagEventCount,
    });

    return freezeDeep({
      acceptedElapsedMs,
      deferredElapsedMs: pendingElapsedMs,
      ignoredPausedElapsedMs: 0,
      lagged: pendingElapsedMs > 0,
      steps,
      state: this.snapshot(),
    });
  }

  /** Drains one additional capped frame from already pending elapsed. */
  drainPendingFrame() {
    return this.advance(0);
  }

  pause() {
    if (this._state.paused) {
      return freezeDeep({ changed: false, discardedElapsedMs: 0, state: this.snapshot() });
    }
    const discardedElapsedMs = checkedAdd(
      this._state.accumulatorMs,
      this._state.pendingElapsedMs,
    );
    this._state.paused = true;
    this._state.accumulatorMs = 0;
    this._state.pendingElapsedMs = 0;
    return freezeDeep({ changed: true, discardedElapsedMs, state: this.snapshot() });
  }

  resume() {
    if (!this._state.paused) {
      return freezeDeep({ changed: false, state: this.snapshot() });
    }
    this._state.paused = false;
    return freezeDeep({ changed: true, state: this.snapshot() });
  }

  snapshot() {
    return freezeDeep(cloneValue(this._state));
  }
}
