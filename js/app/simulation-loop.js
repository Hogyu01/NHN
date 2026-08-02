import { SimulationClock } from "../core/time.js";
import { DAY_LOOP_TRIGGER } from "../domain/day-loop.js";
import { TimerSystem } from "../domain/timer-system.js";

/**
 * Task 25 — 20ms fixed-step accumulator(SimulationClock)로 실제 RAF elapsed을 소비하고,
 * 각 logical step마다 Scheduler.runDue()를 거쳐 TimerSystem이 PAUSE/TIMER_ZERO를 처리하게
 * 하는 단일 루프. 새 campaign/day restart 시 generation을 통째로 버리고 loop 하나만 다시
 * 등록한다 ("single RAF loop").
 */
export class SimulationLoop {
  constructor({
    store,
    commandBus,
    scheduler,
    directServiceSystem,
    menuSystem,
    serviceCleanupSystem,
    dayLoopController,
    guestFlowSystem,
    guestOutcomeSystem,
    orderSystem,
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    visibilityTarget = null,
    onPresentationFrame = null,
  }) {
    if (!store || !commandBus || !scheduler) {
      throw new TypeError("SimulationLoop에는 store/commandBus/scheduler가 필요합니다.");
    }
    if (typeof raf !== "function" || typeof caf !== "function") {
      throw new TypeError("SimulationLoop에는 requestAnimationFrame/cancelAnimationFrame이 필요합니다.");
    }
    this.store = store;
    this.scheduler = scheduler;
    this.timerSystem = new TimerSystem({
      store,
      commandBus,
      scheduler,
      directServiceSystem,
      menuSystem,
      serviceCleanupSystem,
      dayLoopController,
      guestFlowSystem,
      guestOutcomeSystem,
      orderSystem,
    });
    this.clock = new SimulationClock({ simulationTimeMs: scheduler.simulationTimeMs });
    this._raf = raf;
    this._caf = caf;
    this._visibilityTarget = visibilityTarget;
    if (onPresentationFrame !== null && typeof onPresentationFrame !== "function") {
      throw new TypeError("SimulationLoop onPresentationFrame은 함수 또는 null이어야 합니다.");
    }
    this._onPresentationFrame = onPresentationFrame;
    this._frameHandle = null;
    this._lastFrameTimeMs = null;
    this._running = false;
    this._ticking = Promise.resolve();
    this._onFrame = this._onFrame.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastFrameTimeMs = null;
    this._frameHandle = this._raf(this._onFrame);
    this._visibilityTarget?.addEventListener?.("visibilitychange", this._onVisibilityChange);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._frameHandle !== null) this._caf(this._frameHandle);
    this._frameHandle = null;
    this._visibilityTarget?.removeEventListener?.("visibilitychange", this._onVisibilityChange);
  }

  /** 새 generation으로 재시작한다: 이전 queue/RAF subscription을 버리고 loop 하나만 다시 건다. */
  restart() {
    const wasRunning = this._running;
    this.stop();
    const cancelled = this.scheduler.restartGeneration({ simulationTimeMs: 0 });
    this.clock = new SimulationClock({ simulationTimeMs: 0 });
    if (wasRunning) this.start();
    return cancelled;
  }

  async pause(trigger = DAY_LOOP_TRIGGER.PAUSE_REQUESTED) {
    const outcome = await this.timerSystem.requestPause(trigger);
    if (this.scheduler.paused) this.clock.pause();
    return outcome;
  }

  async resume() {
    const outcome = await this.timerSystem.resume();
    if (outcome.resumed) this.clock.resume();
    return outcome;
  }

  _onFrame(rafTimestampMs) {
    this._frameHandle = this._running ? this._raf(this._onFrame) : null;
    this._ticking = this._ticking.then(() => this._advance(rafTimestampMs));
  }

  async _advance(rafTimestampMs) {
    if (!this._running) return;
    const elapsedMs = this._lastFrameTimeMs === null
      ? 0
      : Math.max(0, Math.round(rafTimestampMs - this._lastFrameTimeMs));
    this._lastFrameTimeMs = rafTimestampMs;
    const advanced = this.clock.advance(elapsedMs);
    for (const step of advanced.steps) {
      if (!this._running) return;
      await this.timerSystem.tick(step.simulationTimeMs);
    }
    this._onPresentationFrame?.(elapsedMs);
  }

  async _onVisibilityChange() {
    if (this._visibilityTarget?.visibilityState !== "hidden") return;
    await this.pause(DAY_LOOP_TRIGGER.VISIBILITY_AUTO_PAUSE);
  }
}
