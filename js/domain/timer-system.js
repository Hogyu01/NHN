import { SCHEDULER_CONTROL, SCHEDULER_EVENT_CLASS } from "../core/scheduler.js";
import { DAY_LOOP_COMMAND, DAY_LOOP_TRANSITION_READ_SET, DAY_LOOP_TRANSITION_WRITE_SET, DAY_LOOP_TRIGGER, planDayLoopTransition } from "./day-loop.js";
import { ORDER_REACTION_DURATION_MS } from "./orders.js";
import { planNextCleanupStep } from "./service-cleanup.js";
import { SALE_SLOT_RELEASE_REASON } from "./sale-slots.js";
import { SERVICE_TIMER_LIMITS } from "./timer-state.js";

/**
 * Scheduler(js/core/scheduler.js)는 순수 동기 API고 CommandBus.dispatch는 항상 Promise를
 * 반환하는 async API라 같은 tick 안에서 직접 이어붙일 수 없다. 그래서 TimerSystem은
 * PAUSE/TIMER_ZERO 두 event class에 한해 "predict → 즉시 async dispatch" 두 단계로 다리를
 * 놓는다. predict는 planDayLoopTransition(순수 함수)로 scheduler.runDue()의 pauseAccepted
 * 신호를 동기적으로 결정하고, 실제 GameStore 반영은 runDue가 반환한 executed 목록을 그대로
 * 순서대로 await dispatch한다. guest arrival(Task 30)도 ARRIVAL class로 이 다리를 그대로
 * 쓴다 — stableId 접두사(`guest-arrival:`/`seat-arrival:`)로 "도착 처리"와 "좌석 도착"을
 * 구분하고 주문 TIMEOUT도 같은 queue에서 deadline 순서로 처리한다. cook completion은
 * player command가 authoritative하므로 이 timer bridge에서 별도 판정을 만들지 않는다.
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

export function guestArrivalStableId(guestId) {
  return `guest-arrival:${guestId}`;
}

export function seatArrivalStableId(guestId) {
  return `seat-arrival:${guestId}`;
}

export function guestReactionStableId(guestId) {
  return `guest-reaction:${guestId}`;
}

export function guestExitStableId(guestId) {
  return `guest-exit:${guestId}`;
}

export function orderTimeoutStableId(orderId) {
  return `order-timeout:${orderId}`;
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
  constructor({
    store, commandBus, scheduler, directServiceSystem, menuSystem, serviceCleanupSystem, dayLoopController,
    guestFlowSystem, guestOutcomeSystem, orderSystem,
  }) {
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
    this.guestFlowSystem = guestFlowSystem ?? null;
    this.guestOutcomeSystem = guestOutcomeSystem ?? null;
    this.orderSystem = orderSystem ?? null;
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

  /** Service Start 직후 호출한다. 각 ScheduledGuestPlan의 arrivalAtMs에 ARRIVAL을 예약한다. */
  armGuestArrivals({ plans }) {
    const baseMs = this.scheduler.simulationTimeMs;
    for (const plan of plans) {
      this.scheduler.schedule({
        eventClass: SCHEDULER_EVENT_CLASS.ARRIVAL,
        simulationTimeMs: baseMs + plan.arrivalAtMs,
        stableId: guestArrivalStableId(plan.guestId),
      });
    }
  }

  /** Early completion 등으로 남은 예약 도착을 취소한다. */
  disarmGuestArrivals({ plans }) {
    for (const plan of plans) {
      this.scheduler.cancel(guestArrivalStableId(plan.guestId), "SERVICE_ENDED_EARLY");
      this.scheduler.cancel(seatArrivalStableId(plan.guestId), "SERVICE_ENDED_EARLY");
    }
  }

  armOrderTimeout({ orderId, createdAtMs, patienceRemainingMs }) {
    this.scheduler.cancel(orderTimeoutStableId(orderId), "ORDER_TIMEOUT_RESCHEDULED");
    return this.scheduler.schedule({
      eventClass: SCHEDULER_EVENT_CLASS.TIMEOUT,
      simulationTimeMs: Math.max(this.scheduler.simulationTimeMs, createdAtMs + patienceRemainingMs),
      stableId: orderTimeoutStableId(orderId),
    });
  }

  disarmOrderTimeout(orderId, reason = "ORDER_COMPLETED") {
    return this.scheduler.cancel(orderTimeoutStableId(orderId), reason);
  }

  disarmOrderTimeouts({ orders }) {
    for (const order of orders) this.disarmOrderTimeout(order.orderId, "SERVICE_ENDED");
  }

  /** stockout/sale/timeout commit 직후 호출한다. 지금부터 480ms 뒤 reaction 종료를 예약한다. */
  armGuestReaction({ guestId }) {
    return this.scheduler.schedule({
      eventClass: SCHEDULER_EVENT_CLASS.ARRIVAL,
      simulationTimeMs: this.scheduler.simulationTimeMs + ORDER_REACTION_DURATION_MS,
      stableId: guestReactionStableId(guestId),
    });
  }

  /** Service가 일찍 끝나거나 timer-zero cleanup이 넘겨받을 때 남은 reaction/exit 예약을 취소한다. */
  disarmGuestOutcomes({ guests }) {
    for (const guest of guests) {
      this.scheduler.cancel(guestReactionStableId(guest.guestId), "SERVICE_ENDED_EARLY");
      this.scheduler.cancel(guestExitStableId(guest.guestId), "SERVICE_ENDED_EARLY");
    }
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
      } else if (item.stableId.startsWith("order-timeout:")) {
        const orderId = item.stableId.slice("order-timeout:".length);
        const result = await this.orderSystem.timeoutOrder({
          commandId: `timer-system:order-timeout:${this.store.revision}`,
          expectedRevision: this.store.revision,
          generationId: this.store.generationId,
          issuedAtSimulationMs: item.simulationTimeMs,
          payload: { orderId },
        });
        dispatched.push({ item, result });
      } else if (item.eventClass === SCHEDULER_EVENT_CLASS.TIMER_ZERO) {
        const result = await this.commandBus.dispatch(
          transitionCommandInput(this.store, "timer-system:timer-zero", item.simulationTimeMs, {
            trigger: DAY_LOOP_TRIGGER.TIMER_ZERO,
          }),
        );
        if (result.ok) this.disarmOrderTimeouts({ orders: this.store.getSnapshot().service.orders });
        dispatched.push({ item, result });
      } else if (item.stableId.startsWith("guest-arrival:")) {
        const guestId = item.stableId.slice("guest-arrival:".length);
        const result = await this.guestFlowSystem.processArrival({
          commandId: `timer-system:guest-arrival:${this.store.revision}`,
          expectedRevision: this.store.revision,
          generationId: this.store.generationId,
          issuedAtSimulationMs: item.simulationTimeMs,
          payload: { guestId },
        });
        if (result.ok) {
          const moved = result.events.find((event) => event.type === "guest-flow.moving-to-seat");
          if (moved) {
            this._scheduleFollowUp(seatArrivalStableId(guestId), item.simulationTimeMs + moved.payload.travelTimeMs);
          }
        }
        dispatched.push({ item, result });
      } else if (item.stableId.startsWith("seat-arrival:")) {
        const guestId = item.stableId.slice("seat-arrival:".length);
        const result = await this.guestFlowSystem.seatArrival({
          commandId: `timer-system:seat-arrival:${this.store.revision}`,
          expectedRevision: this.store.revision,
          generationId: this.store.generationId,
          issuedAtSimulationMs: item.simulationTimeMs,
          payload: { guestId },
        });
        dispatched.push({ item, result });
      } else if (item.stableId.startsWith("guest-reaction:")) {
        const guestId = item.stableId.slice("guest-reaction:".length);
        const result = await this.guestOutcomeSystem.reactionComplete({
          commandId: `timer-system:guest-reaction:${this.store.revision}`,
          expectedRevision: this.store.revision,
          generationId: this.store.generationId,
          issuedAtSimulationMs: item.simulationTimeMs,
          payload: { guestId },
        });
        if (result.ok) {
          const moving = result.events.find((event) => event.type === "guest-flow.moving-to-exit");
          if (moving) {
            this._scheduleFollowUp(guestExitStableId(guestId), item.simulationTimeMs + moving.payload.travelTimeMs);
          }
        }
        dispatched.push({ item, result });
      } else if (item.stableId.startsWith("guest-exit:")) {
        const guestId = item.stableId.slice("guest-exit:".length);
        const result = await this.guestOutcomeSystem.exitArrival({
          commandId: `timer-system:guest-exit:${this.store.revision}`,
          expectedRevision: this.store.revision,
          generationId: this.store.generationId,
          issuedAtSimulationMs: item.simulationTimeMs,
          payload: { guestId },
        });
        if (result.ok) {
          const pendingGuestId = this.store.getSnapshot().service.pendingSeatQueue[0] ?? null;
          if (pendingGuestId) {
            const promoted = await this.guestFlowSystem.processArrival({
              commandId: `timer-system:pending-seat-promotion:${this.store.revision}`,
              expectedRevision: this.store.revision,
              generationId: this.store.generationId,
              issuedAtSimulationMs: item.simulationTimeMs,
              payload: { guestId: pendingGuestId, promotePending: true },
            });
            if (promoted.ok) {
              const moved = promoted.events.find((event) => event.type === "guest-flow.moving-to-seat");
              if (moved) {
                this._scheduleFollowUp(
                  seatArrivalStableId(pendingGuestId),
                  item.simulationTimeMs + moved.payload.travelTimeMs,
                );
              }
            }
          }
        }
        dispatched.push({ item, result });
      }
    }
    return { due, dispatched };
  }

  /**
   * arrival/reaction 뒤 후속 이동을 예약한다. runDue()는 한 tick() 호출 안의 due item을
   * 전부 동기적으로 dequeue한 뒤에야 이 async loop가 그 결과를 하나씩 처리하므로, scheduler
   * cursor는 이미 이 tick()의 목표 시각까지 전진해 있을 수 있다 — 그러면 "이전" item의
   * timestamp를 기준으로 계산한 목표가 cursor보다 과거가 되어 schedule()이 거절한다(정상
   * 20ms 단일 step 진행에서는 나타나지 않고, QA harness가 한 번에 크게 건너뛸 때만 나타난다).
   * cursor 이전으로는 예약할 수 없으니 cursor로 clamp해 다음 runDue에서 확실히 처리되게 한다.
   */
  _scheduleFollowUp(stableId, simulationTimeMs) {
    return this.scheduler.schedule({
      eventClass: SCHEDULER_EVENT_CLASS.ARRIVAL,
      simulationTimeMs: Math.max(simulationTimeMs, this.scheduler.simulationTimeMs),
      stableId,
    });
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
    if (step === "GUEST_CLEANUP") {
      return this.serviceCleanupSystem.releaseGuests({
        commandId: `timer-system:cleanup-release-guests:${store.revision}`,
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
