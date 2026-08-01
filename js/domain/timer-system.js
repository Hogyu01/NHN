import { SCHEDULER_CONTROL, SCHEDULER_EVENT_CLASS } from "../core/scheduler.js";
import { DAY_LOOP_COMMAND, DAY_LOOP_TRANSITION_READ_SET, DAY_LOOP_TRANSITION_WRITE_SET, DAY_LOOP_TRIGGER, planDayLoopTransition } from "./day-loop.js";
import { planNextCleanupStep } from "./service-cleanup.js";
import { SALE_SLOT_RELEASE_REASON } from "./sale-slots.js";
import { SERVICE_TIMER_LIMITS } from "./timer-state.js";

/**
 * Scheduler(js/core/scheduler.js)는 순수 동기 API고 CommandBus.dispatch는 항상 Promise를
 * 반환하는 async API라 같은 tick 안에서 직접 이어붙일 수 없다. 그래서 TimerSystem은
 * PAUSE/TIMER_ZERO 두 event class에 한해 "predict → 즉시 async dispatch" 두 단계로 다리를
 * 놓는다. predict는 planDayLoopTransition(순수 함수)로 scheduler.runDue()의 pauseAccepted
 * 신호를 동기적으로 결정하고, 실제 GameStore 반영은 runDue가 반환한 executed 목록을 그대로
 * 순서대로 await dispatch한다. arrival/timeout/cook 같은 진짜 동시다발 event class를
 * scheduler에 태우는 일은 Task 30에서 다룬다.
 *
 * 12초 cleanup cap도 같은 TIMER_ZERO priority class를 재사용한다(design에 별도
 * event class가 없다) — stableId 접두사(`timer-zero:`/`cleanup-cap:`)로 두 의미를
 * 구분한다.
 */

export function timerZeroStableId(serviceToken) {
  return `timer-zero:${serviceToken}`;
}

export function cleanupCapStableId(serviceToken) {
  return `cleanup-cap:${serviceToken}`;
}

function pauseStableId(sequence) {
  return `pause:${sequence}`;
}

function transitionCommandInput(store, idPrefix, issuedAtSimulationMs, payload) {
  return {
    commandId: `${idPrefix}:${store.revision}`,
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs,
    type: DAY_LOOP_COMMAND.TRANSITION,
    payload,
    readSet: [...DAY_LOOP_TRANSITION_READ_SET],
    writeSet: [...DAY_LOOP_TRANSITION_WRITE_SET],
  };
}

export class TimerSystem {
  constructor({ store, commandBus, scheduler, directServiceSystem, menuSystem, serviceCleanupSystem, dayLoopController }) {
    if (!store || typeof store.getSnapshot !== "function") {
      throw new TypeError("TimerSystem에는 GameStore가 필요합니다.");
    }
    if (!commandBus || typeof commandBus.dispatch !== "function") {
      throw new TypeError("TimerSystem에는 CommandBus가 필요합니다.");
    }
    if (!scheduler || typeof scheduler.schedule !== "function") {
      throw new TypeError("TimerSystem에는 Scheduler가 필요합니다.");
    }
    this.store = store;
    this.commandBus = commandBus;
    this.scheduler = scheduler;
    this.directServiceSystem = directServiceSystem ?? null;
    this.menuSystem = menuSystem ?? null;
    this.serviceCleanupSystem = serviceCleanupSystem ?? null;
    this.dayLoopController = dayLoopController ?? null;
    this._pauseSequence = 0;
    this._predict = this._predict.bind(this);
  }

  /** Service Start commit 직후 호출한다. durationMs 뒤 TIMER_ZERO를 예약한다. */
  armServiceTimer({ serviceToken, durationMs }) {
    return this.scheduler.schedule({
      eventClass: SCHEDULER_EVENT_CLASS.TIMER_ZERO,
      simulationTimeMs: this.scheduler.simulationTimeMs + durationMs,
      stableId: timerZeroStableId(serviceToken),
    });
  }

  /** Early completion 등으로 Service가 timer-zero 전에 끝날 때 예약을 취소한다. */
  disarmServiceTimer(serviceToken) {
    return this.scheduler.cancel(timerZeroStableId(serviceToken), "SERVICE_ENDED_EARLY");
  }

  /** RESULTS_CLOSED_CLEANUP 진입 직후 호출한다. pause 제외 12초 뒤 강제 cleanup을 예약한다. */
  armCleanupCap({ serviceToken }) {
    return this.scheduler.schedule({
      eventClass: SCHEDULER_EVENT_CLASS.TIMER_ZERO,
      simulationTimeMs: this.scheduler.simulationTimeMs + SERVICE_TIMER_LIMITS.maximumCleanupOvertimeMs,
      stableId: cleanupCapStableId(serviceToken),
    });
  }

  /** cleanup이 cap 전에 자연 완료됐을 때 예약된 cap을 취소한다. */
  disarmCleanupCap(serviceToken) {
    return this.scheduler.cancel(cleanupCapStableId(serviceToken), "CLEANUP_COMPLETED_BEFORE_CAP");
  }

  /**
   * 동기 predict. Scheduler.runDue()의 execute 콜백으로 그대로 넘긴다.
   * PAUSE만 pauseAccepted 여부를 결정하고, TIMER_ZERO류는 그대로 executed 처리한다.
   */
  _predict(item) {
    if (item.eventClass !== SCHEDULER_EVENT_CLASS.PAUSE) return undefined;
    const snapshot = this.store.getSnapshot();
    const planned = planDayLoopTransition({
      runtimePhase: snapshot.runtimePhase,
      checkpointPhase: snapshot.checkpointPhase,
      service: snapshot.service,
    }, { trigger: item.payload.trigger });
    return planned.ok ? SCHEDULER_CONTROL.PAUSE_ACCEPTED : undefined;
  }

  /** throughSimulationTimeMs까지 due item을 처리하고, 실제 dispatch는 순서대로 await한다. */
  async tick(throughSimulationTimeMs) {
    const due = this.scheduler.runDue(throughSimulationTimeMs, this._predict);
    const dispatched = [];
    for (const item of due.executed) {
      if (item.eventClass === SCHEDULER_EVENT_CLASS.PAUSE) {
        const result = await this.commandBus.dispatch(
          transitionCommandInput(this.store, "timer-system:pause", item.simulationTimeMs, {
            trigger: item.payload.trigger,
          }),
        );
        dispatched.push({ item, result });
      } else if (item.stableId.startsWith("cleanup-cap:")) {
        const result = await this._forceCleanupAtCap(item.simulationTimeMs);
        dispatched.push({ item, result });
      } else if (item.eventClass === SCHEDULER_EVENT_CLASS.TIMER_ZERO) {
        const result = await this.commandBus.dispatch(
          transitionCommandInput(this.store, "timer-system:timer-zero", item.simulationTimeMs, {
            trigger: DAY_LOOP_TRIGGER.TIMER_ZERO,
          }),
        );
        dispatched.push({ item, result });
      }
    }
    return { due, dispatched };
  }

  /** pause 요청을 현재 scheduler 시각의 최우선순위로 예약하고 즉시 flush한다. */
  async requestPause(trigger) {
    this._pauseSequence += 1;
    this.scheduler.schedule({
      eventClass: SCHEDULER_EVENT_CLASS.PAUSE,
      simulationTimeMs: this.scheduler.simulationTimeMs,
      stableId: pauseStableId(this._pauseSequence),
      payload: { trigger },
    });
    return this.tick(this.scheduler.simulationTimeMs);
  }

  /** resume은 시간을 흘려보내지 않고 같은 batch의 나머지를 한 번 이어서 처리한다. */
  async resume() {
    const store = this.store;
    const result = await this.commandBus.dispatch(
      transitionCommandInput(store, "timer-system:resume", this.scheduler.simulationTimeMs, {
        trigger: DAY_LOOP_TRIGGER.RESUME_REQUESTED,
      }),
    );
    if (!result.ok) return { resumed: false, result, flushed: null };
    this.scheduler.resume();
    const flushed = await this.tick(this.scheduler.simulationTimeMs);
    return { resumed: true, result, flushed };
  }

  /**
   * RUNNING_ESCROW cook 복구 → ACTIVE order technical-cancel → 미사용 reservation/slot 해제
   * 순서로 필요한 real command만 골라 dispatch하고, 완료되면 CLEANUP_VISUALS_COMPLETE로
   * Settlement 전이까지 마친다. cap이 먼저 발화하면(_forceCleanupAtCap) 같은 결과에
   * compare-and-set으로 수렴하므로 두 경로가 동시에 걸려도 안전하다.
   */
  async runCleanupToCompletion({ transitionToken }) {
    const steps = [];
    for (let guard = 0; guard < 64; guard += 1) {
      const snapshot = this.store.getSnapshot();
      const next = planNextCleanupStep(snapshot);
      if (next.step === "COMPLETE" || next.step === "NONE") break;
      const result = await this._dispatchCleanupStep(next.step);
      steps.push({ step: next.step, result });
      if (!result.ok) break;
    }
    this.disarmCleanupCap(transitionToken);
    const completion = await this.commandBus.dispatch(
      transitionCommandInput(this.store, "timer-system:cleanup-complete", this.scheduler.simulationTimeMs, {
        trigger: DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE,
        transitionToken,
      }),
    );
    return { steps, completion };
  }

  async _dispatchCleanupStep(step) {
    const store = this.store;
    if (step === "CANCEL_COOK") {
      return this.directServiceSystem.cancelCookAtZero({
        commandId: `timer-system:cleanup-cancel-cook:${store.revision}`,
        expectedRevision: store.revision,
        generationId: store.generationId,
        issuedAtSimulationMs: this.scheduler.simulationTimeMs,
        payload: {},
      });
    }
    if (step === "RELEASE_ORDERS") {
      return this.serviceCleanupSystem.releaseOrders({
        commandId: `timer-system:cleanup-release-orders:${store.revision}`,
        expectedRevision: store.revision,
        generationId: store.generationId,
        issuedAtSimulationMs: this.scheduler.simulationTimeMs,
        payload: {},
      });
    }
    return this.menuSystem.cleanup({
      commandId: `timer-system:cleanup-menu:${store.revision}`,
      expectedRevision: store.revision,
      generationId: store.generationId,
      issuedAtSimulationMs: this.scheduler.simulationTimeMs,
      payload: { reason: SALE_SLOT_RELEASE_REASON.CLEANUP },
    });
  }

  async _forceCleanupAtCap(issuedAtSimulationMs) {
    const store = this.store;
    const forced = await this.serviceCleanupSystem.forceCleanupAtCap({
      commandId: `timer-system:force-cleanup-at-cap:${store.revision}`,
      expectedRevision: store.revision,
      generationId: store.generationId,
      issuedAtSimulationMs,
      payload: {},
    });
    const transitionToken = this.store.getSnapshot().service.settlementTransitionToken;
    const transitioned = await this.commandBus.dispatch(
      transitionCommandInput(this.store, "timer-system:cleanup-overtime-cap", issuedAtSimulationMs, {
        trigger: DAY_LOOP_TRIGGER.CLEANUP_OVERTIME_CAP,
        transitionToken,
      }),
    );
    return { ok: forced.ok && transitioned.ok, forced, transitioned };
  }
}
