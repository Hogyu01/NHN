import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { cloneValue, freezeDeep } from "../core/result.js";
import { createRngRegistryState } from "../core/rng.js";
import { Scheduler, SCHEDULER_EVENT_CLASS, SCHEDULER_PRIORITY } from "../core/scheduler.js";
import { GameStore } from "../core/store.js";
import {
  DAY_LOOP_TRIGGER,
  registerDayLoopController,
} from "../domain/day-loop.js";
import { registerDirectServiceSystem } from "../domain/direct-service.js";
import { createEventState } from "../domain/events.js";
import { createFacilityState } from "../domain/facility.js";
import { createInventoryAccountingState, registerInventoryAccounting } from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import { createMenuState, registerMenuSystem } from "../domain/menu.js";
import { ACTIVE_ORDER_STATE, registerOrderSystem } from "../domain/orders.js";
import { createRecipeState } from "../domain/recipe.js";
import { createSaleSlotsState, SALE_SLOT_STATE } from "../domain/sale-slots.js";
import { registerServiceCleanupSystem } from "../domain/service-cleanup.js";
import { createServiceTimerState, RUNTIME_PHASE, SERVICE_LIFECYCLE } from "../domain/timer-state.js";
import { cleanupCapStableId, timerZeroStableId, TimerSystem } from "../domain/timer-system.js";
import { COOK_TRIGGER, TIMING_COOK_STATE } from "../domain/timing-cook.js";
import { resolveOrderableRecipe } from "../app/one-day-scenario.js";
import { createRuntimeComposition } from "../app/runtime-composition.js";

const QA_GENERATION_ID = 25;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function allIngredientIds(recipes) {
  return [...new Set(recipes.flatMap((recipe) =>
    recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))].sort();
}

function createLots(recipes, quantity = 80) {
  return allIngredientIds(recipes).map((ingredientId, index) => ({
    lotId: `qa.timer-system.lot.${String(index).padStart(3, "0")}`,
    ingredientId,
    quantity,
    quality: 70,
    bookCostG: quantity * 2,
    acquiredDay: 1,
  }));
}

function createHarness({ canonicalRecipes, canonicalFacilities, balance, guestArchetypes, seed = 0x25 } = {}) {
  const campaignId = createCampaignId(seed, 0);
  const recipes = createRecipeState({
    recipes: canonicalRecipes,
    ingredientIds: allIngredientIds(canonicalRecipes),
  });
  const initialState = {
    formatVersion: 1,
    revision: 0,
    runtimePhase: RUNTIME_PHASE.PLANNING,
    checkpointPhase: "PLANNING_READY",
    generationId: QA_GENERATION_ID,
    campaign: { campaignId, masterSeed: seed, day: 1, consecutiveArrearsCount: 0 },
    events: createEventState(),
    facilities: createFacilityState({ facilities: canonicalFacilities }),
    recipes,
    menu: createMenuState({ day: 1, recipes }),
    saleSlots: createSaleSlotsState({ day: 1 }),
    inventory: createInventoryState({ lots: createLots(canonicalRecipes) }),
    inventoryAccounting: createInventoryAccountingState({
      openingInventoryBookCostG: createLots(canonicalRecipes).reduce((total, lot) => total + lot.bookCostG, 0),
    }),
    service: createServiceTimerState({
      durationMs: balance.service.durationMs,
      cleanupOvertimeMs: balance.service.cleanupOvertimeMs,
    }),
    idCounters: createIdServiceState({ campaignId, day: 1, generationId: QA_GENERATION_ID }),
    rng: createRngRegistryState(seed),
  };
  const store = new GameStore(initialState);
  const bus = new CommandBus({ store });
  registerInventoryAccounting(bus);
  const menuSystem = registerMenuSystem(bus);
  const dayLoopController = registerDayLoopController(bus, { guestArchetypes });
  const orderSystem = registerOrderSystem(bus);
  const directServiceSystem = registerDirectServiceSystem(bus, {
    wrongServePenaltyMs: balance.service.wrongServePenaltyMs,
    reactionDurationMs: balance.service.reactionFrameMs * balance.service.reactionFrameCount,
  });
  const serviceCleanupSystem = registerServiceCleanupSystem(bus);
  const scheduler = new Scheduler();
  const timerSystem = new TimerSystem({
    store,
    commandBus: bus,
    scheduler,
    directServiceSystem,
    menuSystem,
    serviceCleanupSystem,
    dayLoopController,
  });
  return {
    store, bus, menuSystem, dayLoopController, orderSystem, directServiceSystem, serviceCleanupSystem,
    scheduler, timerSystem, canonicalRecipes, balance,
  };
}

function commandInput(harness, commandId, payload) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: harness.scheduler.simulationTimeMs,
    payload,
  };
}

function activeRecipe(snapshot) {
  return snapshot.recipes.definitions.find((recipe) => snapshot.recipes.unlockedRecipeIds.includes(recipe.recipeId));
}

async function startService(harness) {
  const recipe = activeRecipe(harness.store.getSnapshot());
  const edited = await harness.menuSystem.editEntry(commandInput(harness, `edit:${harness.store.revision}`, {
    recipeId: recipe.recipeId,
    enabled: true,
    priceG: recipe.basePriceG,
    plannedQuantity: 1,
  }));
  assert(edited.ok, `menu edit 실패: ${edited.code}`);
  const confirmed = await harness.menuSystem.confirmPlan(commandInput(harness, `confirm:${harness.store.revision}`, { day: 1 }));
  assert(confirmed.ok, `menu confirm 실패: ${confirmed.code}`);
  const started = await harness.dayLoopController.confirmServiceStart(
    commandInput(harness, `start:${harness.store.revision}`, { day: 1 }),
  );
  assert(started.ok, `service start 실패: ${started.code}`);
  const transitionToken = harness.store.getSnapshot().service.settlementTransitionToken;
  const durationMs = harness.store.getSnapshot().service.durationMs;
  harness.timerSystem.armServiceTimer({ serviceToken: transitionToken, durationMs });
  return { transitionToken, durationMs };
}

/** Task 24와 동일한 QA 전용 shortcut: GuestFlow(Task 30)가 없어 SEATED 손님을 직접 심는다. */
function seedSeatedGuest(harness) {
  const snapshot = harness.store.getSnapshot();
  const plan = snapshot.service.plans[0];
  assert(plan, "ScheduledGuestPlan이 생성되지 않았습니다.");
  const guest = {
    guestId: plan.guestId,
    entityId: plan.entityId,
    state: "SEATED",
    seatId: `qa-seat:${plan.guestId}`,
    reaction: null,
  };
  const candidate = {
    ...snapshot,
    service: { ...snapshot.service, guests: [...snapshot.service.guests, guest] },
  };
  harness.store.commit(candidate, {
    commandId: `qa:seed-seated-guest:${harness.store.revision}`,
    expectedRevision: harness.store.revision,
  });
  return guest;
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Property 11: 고정 priority 순서(0..5)가 canonical 값과 정확히 일치한다. */
async function canonicalPriorityOrder() {
  assert(SCHEDULER_PRIORITY.PAUSE === 0, "PAUSE priority !== 0");
  assert(SCHEDULER_PRIORITY.TIMER_ZERO === 1, "TIMER_ZERO priority !== 1");
  assert(SCHEDULER_PRIORITY.TIMEOUT === 2, "TIMEOUT priority !== 2");
  assert(SCHEDULER_PRIORITY.PLAYER_INPUT === 3, "PLAYER_INPUT priority !== 3");
  assert(SCHEDULER_PRIORITY.COOK_COMPLETION === 4, "COOK_COMPLETION priority !== 4");
  assert(SCHEDULER_PRIORITY.ARRIVAL === 5, "ARRIVAL priority !== 5");
  const scheduler = new Scheduler();
  const classes = Object.values(SCHEDULER_EVENT_CLASS);
  const shuffled = [...classes].reverse();
  for (const eventClass of shuffled) {
    scheduler.schedule({ eventClass, simulationTimeMs: 100, stableId: `probe:${eventClass}` });
  }
  const order = [];
  scheduler.runDue(100, (item) => { order.push(item.eventClass); });
  const expected = [
    SCHEDULER_EVENT_CLASS.PAUSE,
    SCHEDULER_EVENT_CLASS.TIMER_ZERO,
    SCHEDULER_EVENT_CLASS.TIMEOUT,
    SCHEDULER_EVENT_CLASS.PLAYER_INPUT,
    SCHEDULER_EVENT_CLASS.COOK_COMPLETION,
    SCHEDULER_EVENT_CLASS.ARRIVAL,
  ];
  assert(JSON.stringify(order) === JSON.stringify(expected), `순서 불일치: ${JSON.stringify(order)}`);
  return { order };
}

/** TimerSystem이 Service Start 뒤 durationMs에 정확히 TIMER_ZERO를 예약하고, 도달 시 RESULTS_CLOSED_CLEANUP으로 real command 전이시킨다. */
async function timerZeroFiresAtDuration(harness) {
  const { transitionToken, durationMs } = await startService(harness);
  const armed = harness.scheduler.snapshot().queue.find(
    (item) => item.stableId === timerZeroStableId(transitionToken),
  );
  assert(armed, "TIMER_ZERO가 예약되지 않았습니다.");
  assert(armed.simulationTimeMs === durationMs, `TIMER_ZERO 시각이 다릅니다: ${armed.simulationTimeMs}`);

  const before = await harness.timerSystem.tick(durationMs - 20);
  assert(before.dispatched.length === 0, "durationMs 전에 TIMER_ZERO가 발화했습니다.");
  assert(harness.store.runtimePhase === RUNTIME_PHASE.SERVICE, "조기에 phase가 바뀌었습니다.");

  const due = await harness.timerSystem.tick(durationMs);
  assert(due.dispatched.length === 1, `TIMER_ZERO dispatch 개수가 다릅니다: ${due.dispatched.length}`);
  assert(due.dispatched[0].result.ok, `TIMER_ZERO dispatch 실패: ${due.dispatched[0].result.code}`);
  const snapshot = harness.store.getSnapshot();
  assert(snapshot.service.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP, "lifecycle이 전이되지 않았습니다.");
  assert(snapshot.service.remainingMs === 0, "remainingMs가 0이 아닙니다.");
  return { transitionToken, durationMs };
}

/** PAUSED 동안 result-affecting Service input(order.create)은 거절되고 state가 그대로 유지된다. */
async function pauseRejectsServiceInput(harness) {
  await startService(harness);
  const paused = await harness.timerSystem.requestPause(DAY_LOOP_TRIGGER.PAUSE_REQUESTED);
  assert(paused.dispatched.length === 1 && paused.dispatched[0].result.ok, "pause dispatch 실패");
  assert(harness.store.runtimePhase === RUNTIME_PHASE.PAUSED, "PAUSED로 전이되지 않았습니다.");
  assert(harness.scheduler.paused, "scheduler가 paused 상태가 아닙니다.");

  const before = harness.store.getSnapshot();
  const rejected = await harness.bus.dispatch({
    commandId: `order-while-paused:${harness.store.revision}`,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: 0,
    type: "order.create",
    payload: { guestId: "guest:probe" },
    readSet: ["menu", "campaign", "recipes", "events", "facilities"],
    writeSet: ["service", "saleSlots", "idCounters"],
  });
  assert(!rejected.ok, "PAUSED에서 order.create가 수락됐습니다.");
  assert(harness.store.getSnapshot() === before, "PAUSED 거절 이후 state가 바뀌었습니다.");
  return { rejectCode: rejected.code };
}

/** resume은 정확히 한 번만 적용되고, 중복 resume은 상태를 바꾸지 않는다. */
async function resumeIsIdempotent(harness) {
  await startService(harness);
  await harness.timerSystem.requestPause(DAY_LOOP_TRIGGER.PAUSE_REQUESTED);
  assert(harness.store.runtimePhase === RUNTIME_PHASE.PAUSED, "pause 실패");

  const first = await harness.timerSystem.resume();
  assert(first.resumed && first.result.ok, "첫 resume이 실패했습니다.");
  assert(harness.store.runtimePhase === RUNTIME_PHASE.SERVICE, "resume 후 SERVICE로 돌아오지 않았습니다.");
  assert(!harness.scheduler.paused, "resume 후 scheduler가 여전히 paused입니다.");

  const revisionAfterFirst = harness.store.revision;
  const second = await harness.timerSystem.resume();
  assert(!second.resumed, "중복 resume이 다시 적용됐습니다.");
  assert(harness.store.revision === revisionAfterFirst, "중복 resume이 revision을 바꿨습니다.");
  return { revisionAfterFirst };
}

/** early completion처럼 timer-zero 전에 서비스가 끝나면 예약된 TIMER_ZERO를 해제해 stale 발화를 막는다. */
async function disarmPreventsStaleTimerZero(harness) {
  const { transitionToken } = await startService(harness);
  const cancelled = harness.timerSystem.disarmServiceTimer(transitionToken);
  assert(cancelled, "disarmServiceTimer가 취소하지 못했습니다.");
  const remaining = harness.scheduler.snapshot().queue.find(
    (item) => item.stableId === timerZeroStableId(transitionToken),
  );
  assert(!remaining, "TIMER_ZERO가 여전히 큐에 남아 있습니다.");
  return { cancelled };
}

/** restart는 이전 generation의 대기 item을 전부 취소하고 generationId를 증가시킨다. */
async function restartCancelsOldGeneration(harness) {
  await startService(harness);
  const beforeGenerationId = harness.scheduler.generationId;
  const beforeQueueSize = harness.scheduler.size;
  assert(beforeQueueSize > 0, "restart 전 예약된 item이 없습니다.");
  const restarted = harness.scheduler.restartGeneration({ simulationTimeMs: 0 });
  assert(restarted.generationId === beforeGenerationId + 1, "generationId가 증가하지 않았습니다.");
  assert(restarted.cancelled.length === beforeQueueSize, "취소된 item 수가 다릅니다.");
  assert(harness.scheduler.size === 0, "restart 후 큐가 비지 않았습니다.");
  assert(!harness.scheduler.paused, "restart 후 scheduler가 paused 상태입니다.");
  return { cancelledCount: restarted.cancelled.length, newGenerationId: restarted.generationId };
}

/** timer-zero 시점에 RUNNING_ESCROW cook이 있으면 cleanup이 정확히 lot/reservation을 복구하고 Settlement에 정확히 한 번 도달한다. */
async function cookRollbackDuringCleanup(harness) {
  const { transitionToken, durationMs } = await startService(harness);
  const snapshot = harness.store.getSnapshot();
  const recipe = activeRecipe(snapshot);
  const slot = snapshot.saleSlots.slots.find((candidate) => candidate.recipeId === recipe.recipeId);
  assert(slot, "AVAILABLE slot을 찾지 못했습니다.");
  const lotsBeforeZero = harness.store.getSnapshot().inventory.lots;
  const cooked = await harness.directServiceSystem.startCook(commandInput(harness, `cook-start:${harness.store.revision}`, {
    recipeId: recipe.recipeId,
    saleSlotId: slot.saleSlotId,
    sourceOrderId: null,
    trigger: COOK_TRIGGER.PLAYER,
  }));
  assert(cooked.ok, `조리 시작 실패: ${cooked.code}`);

  const due = await harness.timerSystem.tick(durationMs);
  assert(due.dispatched.length === 1 && due.dispatched[0].result.ok, "TIMER_ZERO dispatch 실패");
  assert(harness.store.getSnapshot().service.timingCook.state === TIMING_COOK_STATE.RUNNING_ESCROW,
    "cleanup 전인데 이미 cook 상태가 바뀌었습니다.");

  const cleanup = await harness.timerSystem.runCleanupToCompletion({ transitionToken });
  assert(cleanup.completion.ok, `cleanup 완료 dispatch 실패: ${cleanup.completion.code}`);
  const after = harness.store.getSnapshot();
  assert(after.service.timingCook.state === TIMING_COOK_STATE.CANCELLED_RESTORED,
    `cook이 복구되지 않았습니다: ${after.service.timingCook.state}`);
  assert(after.runtimePhase === RUNTIME_PHASE.SETTLEMENT, "Settlement에 도달하지 못했습니다.");
  for (const lot of lotsBeforeZero) {
    const restored = after.inventory.lots.find((candidate) => candidate.lotId === lot.lotId);
    assert(restored.quantity === lot.quantity && restored.bookCostG === lot.bookCostG,
      `lot ${lot.lotId} exact restore 실패`);
  }
  const duplicate = await harness.bus.dispatch({
    commandId: `duplicate-cleanup-complete:${harness.store.revision}`,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: durationMs,
    type: "day-loop.transition",
    payload: { trigger: DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE, transitionToken },
    readSet: [],
    writeSet: ["runtimePhase", "checkpointPhase", "service"],
  });
  assert(!duplicate.ok, "Settlement 전이가 중복 수락됐습니다.");
  return { restoredLotCount: lotsBeforeZero.length };
}

/** timer-zero 시점에 ACTIVE order가 있으면 cleanup이 TECHNICAL_CANCELLED로 정리하고 slot을 AVAILABLE로 되돌린다. */
async function orderTechnicalCancelDuringCleanup(harness) {
  const { transitionToken, durationMs } = await startService(harness);
  const guest = seedSeatedGuest(harness);
  const created = await harness.orderSystem.createOrder(commandInput(harness, `order-create:${harness.store.revision}`, {
    guestId: guest.guestId,
  }));
  assert(created.ok, `주문 생성 실패: ${created.code}`);
  const order = created.events.find((event) => event.type === "order.created").payload;

  const due = await harness.timerSystem.tick(durationMs);
  assert(due.dispatched.length === 1 && due.dispatched[0].result.ok, "TIMER_ZERO dispatch 실패");

  const cleanup = await harness.timerSystem.runCleanupToCompletion({ transitionToken });
  assert(cleanup.completion.ok, `cleanup 완료 dispatch 실패: ${cleanup.completion.code}`);
  const after = harness.store.getSnapshot();
  const orderAfter = after.service.orders.find((candidate) => candidate.orderId === order.orderId);
  assert(orderAfter.state === ACTIVE_ORDER_STATE.TECHNICAL_CANCELLED,
    `order가 technical cancel되지 않았습니다: ${orderAfter.state}`);
  const slotAfter = after.saleSlots.slots.find((candidate) => candidate.saleSlotId === order.saleSlotId);
  assert(slotAfter.state === SALE_SLOT_STATE.AVAILABLE, `slot이 풀리지 않았습니다: ${slotAfter.state}`);
  assert(after.runtimePhase === RUNTIME_PHASE.SETTLEMENT, "Settlement에 도달하지 못했습니다.");
  return { orderId: order.orderId };
}

/** cleanup이 12초 안에 자연 완료되지 않으면 cap이 RUNNING_ESCROW cook과 ACTIVE order를 한 transaction으로 강제 해제한다. */
async function forceCleanupAtCapReleasesEverything(harness) {
  const { transitionToken, durationMs } = await startService(harness);
  const snapshot = harness.store.getSnapshot();
  const recipe = activeRecipe(snapshot);
  const slot = snapshot.saleSlots.slots.find((candidate) => candidate.recipeId === recipe.recipeId);
  const cooked = await harness.directServiceSystem.startCook(commandInput(harness, `cook-start:${harness.store.revision}`, {
    recipeId: recipe.recipeId,
    saleSlotId: slot.saleSlotId,
    sourceOrderId: null,
    trigger: COOK_TRIGGER.PLAYER,
  }));
  assert(cooked.ok, `조리 시작 실패: ${cooked.code}`);

  const due = await harness.timerSystem.tick(durationMs);
  assert(due.dispatched.length === 1 && due.dispatched[0].result.ok, "TIMER_ZERO dispatch 실패");

  // orchestrator를 부르지 않고, cap만 무장한 뒤 12초 뒤로 직접 진행시켜 cap 경로를 검증한다.
  harness.timerSystem.armCleanupCap({ serviceToken: transitionToken });
  const capDeadline = harness.scheduler.snapshot().queue.find(
    (item) => item.stableId === cleanupCapStableId(transitionToken),
  ).simulationTimeMs;
  assert(capDeadline === durationMs + 12_000, `cap 시각이 다릅니다: ${capDeadline}`);

  const capTick = await harness.timerSystem.tick(capDeadline);
  assert(capTick.dispatched.length === 1, `cap dispatch 개수가 다릅니다: ${capTick.dispatched.length}`);
  assert(capTick.dispatched[0].result.ok, `cap dispatch 실패: ${JSON.stringify(capTick.dispatched[0].result)}`);
  const after = harness.store.getSnapshot();
  assert(after.service.timingCook.state === TIMING_COOK_STATE.CANCELLED_RESTORED, "cap이 cook을 복구하지 못했습니다.");
  assert(after.service.cleanupElapsedMs === 12_000, "cleanupElapsedMs가 cap 값으로 기록되지 않았습니다.");
  assert(after.runtimePhase === RUNTIME_PHASE.SETTLEMENT, "cap 뒤 Settlement에 도달하지 못했습니다.");
  return { capDeadline };
}

export async function runTimerSystemProbe({ recipes, facilities, balance, guestArchetypes }) {
  const results = [];
  const cases = [
    ["canonical-priority-order", "Requirement 10.9, 19.3", () => canonicalPriorityOrder()],
    ["timer-zero-fires-at-duration", "Requirement 2.6, 19.1", () =>
      timerZeroFiresAtDuration(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
    ["pause-rejects-service-input", "Requirement 19.2, 19.4, 19.5", () =>
      pauseRejectsServiceInput(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
    ["resume-is-idempotent", "Requirement 19.6", () =>
      resumeIsIdempotent(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
    ["disarm-prevents-stale-timer-zero", "Requirement 2.6", () =>
      disarmPreventsStaleTimerZero(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
    ["restart-cancels-old-generation", "Requirement 19.7", () =>
      restartCancelsOldGeneration(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
    ["cook-rollback-during-cleanup", "Requirement 2.7, 11.7~11.13", () =>
      cookRollbackDuringCleanup(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
    ["order-technical-cancel-during-cleanup", "Requirement 2.9, 9.11", () =>
      orderTechnicalCancelDuringCleanup(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
    ["force-cleanup-at-cap-releases-everything", "Requirement 2.10, 2.11", () =>
      forceCleanupAtCapReleasesEverything(createHarness({ canonicalRecipes: recipes, canonicalFacilities: facilities, balance, guestArchetypes }))],
  ];
  for (const [id, validates, execute] of cases) {
    results.push(await runCase(id, id, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}

function publishBrowserReport(root, report) {
  root.body.dataset.timerSystemQa = report.status.toLowerCase();
  root.body.dataset.timerSystemQaPassed = String(report.passed);
  root.body.dataset.timerSystemQaTotal = String(report.total);
}

/** 실제 부팅된 production app의 scheduler/simulationLoop/timerSystem을 재사용하는 browser smoke. */
export async function runTimerSystemBrowserProbe({ root, app }) {
  const results = [];
  results.push(await runCase(
    "browser-single-loop-running",
    "실제 부팅된 production app에 simulationLoop가 정확히 하나 실행 중이다",
    "Requirement 19.7",
    () => {
      assert(app.simulationLoop.running, "simulationLoop가 실행 중이 아닙니다.");
      assert(app.scheduler.generationId >= 0, "scheduler generationId가 유효하지 않습니다.");
      return { generationId: app.scheduler.generationId };
    },
  ));
  results.push(await runCase(
    "browser-automatic-cleanup-reaches-settlement",
    "TIMER_ZERO dispatch만으로, cleanup을 직접 부르지 않아도 bootstrap의 event 구독이 자동으로 Settlement까지 도달시킨다",
    "Requirement 2.9, 2.11, 19.7",
    async () => {
      const composition = createRuntimeComposition(app);
      if (app.store.runtimePhase === "TITLE") {
        const entered = await composition.transitionDayLoop({ trigger: "NEW_CAMPAIGN_READY" });
        assert(entered.ok, `TITLE→PLANNING 실패: ${entered.code}`);
      }
      const { recipeId, recipe, offers } = resolveOrderableRecipe(app);
      for (const offer of offers) {
        const bought = await composition.buyMarketOffer(offer);
        assert(bought.ok, `market purchase 실패: ${bought.code}`);
      }
      const edited = await composition.confirmMenuEntry({
        recipeId, enabled: true, priceG: recipe.basePriceG, plannedQuantity: 1,
      });
      assert(edited.ok, `menu edit 실패: ${edited.code}`);
      const confirmed = await composition.confirmMenuPlan();
      assert(confirmed.ok, `menu confirm 실패: ${confirmed.code}`);
      const started = await composition.startService();
      assert(started.ok, `service start 실패: ${started.code}`);
      const fired = await composition.transitionDayLoop({ trigger: "TIMER_ZERO" });
      assert(fired.ok, `TIMER_ZERO dispatch 실패: ${fired.code}`);
      assert(app.store.runtimePhase === "SERVICE", "TIMER_ZERO 직후 이미 phase가 바뀌었습니다.");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert(app.store.runtimePhase === "SETTLEMENT",
        `자동 cleanup 뒤에도 Settlement에 도달하지 못했습니다: ${app.store.runtimePhase}`);
      return { runtimePhase: app.store.runtimePhase };
    },
  ));
  const passed = results.filter((result) => result.status === "PASS").length;
  const report = freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
  publishBrowserReport(root, report);
  return report;
}
