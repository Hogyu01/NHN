import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { cloneValue, freezeDeep } from "../core/result.js";
import { GameStore } from "../core/store.js";
import {
  DAY_LOOP_TRIGGER,
  evaluateServiceEarlyEnd,
  registerDayLoopController,
  RUNTIME_PHASE,
  SERVICE_LIFECYCLE,
} from "../domain/day-loop.js";
import { createRngRegistryState } from "../core/rng.js";
import { createEventState } from "../domain/events.js";
import { createFacilityState } from "../domain/facility.js";
import { COMPLETED_DISH_STATE, createCompletedDish, createInventoryState } from "../domain/inventory.js";
import { createMenuState, registerMenuSystem } from "../domain/menu.js";
import { createRecipeState } from "../domain/recipe.js";
import {
  createSaleSlotsState,
  SALE_SLOT_STATE,
} from "../domain/sale-slots.js";
import { createServiceTimerState } from "../domain/timer-state.js";

const QA_GENERATION_ID = 20;
const PROPERTY_MINIMUM_SAMPLES = 100;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function equivalent(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function allIngredientIds(recipes) {
  return [...new Set(recipes.flatMap((recipe) =>
    recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))].sort(compareIds);
}

function createLots(recipes, quantity = 80) {
  return allIngredientIds(recipes).map((ingredientId, index) => ({
    lotId: `qa.day-loop.lot.${String(index).padStart(3, "0")}`,
    ingredientId,
    quantity,
    quality: 70,
    bookCostG: quantity * 2,
    acquiredDay: 1,
  }));
}

function createHarness({
  canonicalRecipes,
  canonicalFacilities,
  balance,
  guestArchetypes,
  seed = 0x20a11ce,
  snapshot = null,
} = {}) {
  let initialState;
  if (snapshot !== null) {
    initialState = cloneValue(snapshot);
  } else {
    const campaignId = createCampaignId(seed, 0);
    const recipes = createRecipeState({
      recipes: canonicalRecipes,
      ingredientIds: allIngredientIds(canonicalRecipes),
    });
    initialState = {
      formatVersion: 1,
      revision: 0,
      runtimePhase: RUNTIME_PHASE.TITLE,
      checkpointPhase: null,
      generationId: QA_GENERATION_ID,
      campaign: {
        campaignId,
        masterSeed: seed,
        day: 1,
        consecutiveArrearsCount: 0,
      },
      events: createEventState(),
      facilities: createFacilityState({ facilities: canonicalFacilities }),
      recipes,
      menu: createMenuState({ day: 1, recipes }),
      saleSlots: createSaleSlotsState({ day: 1 }),
      inventory: createInventoryState({ lots: createLots(canonicalRecipes) }),
      service: createServiceTimerState({
        durationMs: balance.service.durationMs,
        cleanupOvertimeMs: balance.service.cleanupOvertimeMs,
      }),
      idCounters: createIdServiceState({
        campaignId,
        day: 1,
        generationId: QA_GENERATION_ID,
      }),
      rng: createRngRegistryState(seed),
      untouched: { marker: "task-20-structural-sharing" },
    };
  }
  const store = new GameStore(initialState);
  const bus = new CommandBus({ store });
  const menuSystem = registerMenuSystem(bus);
  const dayLoopController = registerDayLoopController(bus, { guestArchetypes });
  return {
    store, bus, menuSystem, dayLoopController, canonicalRecipes, canonicalFacilities, balance, guestArchetypes,
  };
}

function cloneHarness(source, snapshot = source.store.getSnapshot()) {
  return createHarness({
    canonicalRecipes: source.canonicalRecipes,
    canonicalFacilities: source.canonicalFacilities,
    balance: source.balance,
    guestArchetypes: source.guestArchetypes,
    snapshot,
  });
}

function commandInput(harness, commandId, payload) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: harness.store.revision * 20,
    payload,
  };
}

async function transition(harness, commandId, trigger, additions = {}) {
  return harness.dayLoopController.transition(commandInput(harness, commandId, {
    trigger,
    ...additions,
  }));
}

async function enterPlanning(harness, commandId = "qa:day-loop:title-to-planning") {
  return transition(harness, commandId, DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY);
}

function activeRecipe(snapshot) {
  return snapshot.recipes.definitions.find((recipe) =>
    snapshot.recipes.unlockedRecipeIds.includes(recipe.recipeId));
}

async function editPlanQuantity(harness, quantity, commandId = `qa:day-loop:menu-edit:${harness.store.revision}`) {
  const recipe = activeRecipe(harness.store.getSnapshot());
  assert(recipe, "활성 Recipe fixture가 없습니다.");
  return harness.menuSystem.editEntry(commandInput(harness, commandId, {
    recipeId: recipe.recipeId,
    enabled: true,
    priceG: recipe.basePriceG,
    plannedQuantity: quantity,
  }));
}

async function confirmPlan(harness, commandId = `qa:day-loop:menu-confirm:${harness.store.revision}`) {
  return harness.menuSystem.confirmPlan(commandInput(harness, commandId, { day: 1 }));
}

async function preparePlanningPlan(harness, quantity = 2, namespace = "default") {
  if (harness.store.runtimePhase === RUNTIME_PHASE.TITLE) {
    const entered = await enterPlanning(harness, `qa:day-loop:${namespace}:planning`);
    assert(entered.ok, `${namespace}: TITLE→PLANNING이 실패했습니다: ${entered.code}`);
  }
  const edited = await editPlanQuantity(harness, quantity, `qa:day-loop:${namespace}:edit`);
  assert(edited.ok, `${namespace}: menu edit가 실패했습니다: ${edited.code}`);
  const confirmed = await confirmPlan(harness, `qa:day-loop:${namespace}:confirm-plan`);
  assert(confirmed.ok, `${namespace}: menu confirm이 실패했습니다: ${confirmed.code}`);
  return harness.store.getSnapshot();
}

async function confirmServiceStart(harness, commandId = `qa:day-loop:start:${harness.store.revision}`) {
  return harness.dayLoopController.confirmServiceStart(commandInput(harness, commandId, { day: 1 }));
}

function eligibleEarlyEnd() {
  return {
    scheduledPlansComplete: true,
    activeOrderCount: 0,
    carriedDishId: null,
    nonExitedGuestCount: 0,
  };
}

function transitionPayload(trigger, snapshot) {
  if (trigger === DAY_LOOP_TRIGGER.EARLY_COMPLETION) {
    return { trigger, earlyEnd: eligibleEarlyEnd() };
  }
  if ([DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE, DAY_LOOP_TRIGGER.CLEANUP_OVERTIME_CAP].includes(trigger)) {
    return {
      trigger,
      transitionToken: snapshot.service.settlementTransitionToken ?? "qa:day-loop:fallback-token",
    };
  }
  return { trigger };
}

async function assertRejectedUnchanged(harness, execute, expectedCode, label) {
  const before = harness.store.getSnapshot();
  const beforeValue = cloneValue(before);
  const metadataBefore = harness.store.getCommandMetadata();
  const signalsBefore = harness.bus.getSignalSnapshot();
  const revisionBefore = harness.store.revision;
  const commitCountBefore = harness.store.commitCount;
  const result = await execute();
  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), beforeValue), `${label}: state가 변경됐습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadataBefore), `${label}: command metadata가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signalsBefore), `${label}: event/effect journal이 변경됐습니다.`);
  assert(harness.store.revision === revisionBefore, `${label}: revision이 변경됐습니다.`);
  assert(harness.store.commitCount === commitCountBefore, `${label}: commit이 발생했습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 거절 결과에 signal이 있습니다.`);
  return result;
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

async function createSourceSnapshots(configuration) {
  const titleHarness = createHarness(configuration);
  const snapshots = { TITLE: titleHarness.store.getSnapshot() };

  const planningHarness = cloneHarness(titleHarness, snapshots.TITLE);
  await preparePlanningPlan(planningHarness, 2, "sources");
  snapshots.PLANNING = planningHarness.store.getSnapshot();

  const runningHarness = cloneHarness(planningHarness, snapshots.PLANNING);
  const started = await confirmServiceStart(runningHarness, "qa:day-loop:sources:start");
  assert(started.ok, `source SERVICE/RUNNING 생성 실패: ${started.code}`);
  snapshots.SERVICE_RUNNING = runningHarness.store.getSnapshot();

  const pausedRunningHarness = cloneHarness(runningHarness, snapshots.SERVICE_RUNNING);
  const pausedRunning = await transition(
    pausedRunningHarness,
    "qa:day-loop:sources:pause-running",
    DAY_LOOP_TRIGGER.PAUSE_REQUESTED,
  );
  assert(pausedRunning.ok, `source PAUSED/RUNNING 생성 실패: ${pausedRunning.code}`);
  snapshots.PAUSED_RUNNING = pausedRunningHarness.store.getSnapshot();

  const cleanupHarness = cloneHarness(runningHarness, snapshots.SERVICE_RUNNING);
  const closed = await transition(
    cleanupHarness,
    "qa:day-loop:sources:timer-zero",
    DAY_LOOP_TRIGGER.TIMER_ZERO,
  );
  assert(closed.ok, `source SERVICE/CLEANUP 생성 실패: ${closed.code}`);
  snapshots.SERVICE_CLEANUP = cleanupHarness.store.getSnapshot();

  const pausedCleanupHarness = cloneHarness(cleanupHarness, snapshots.SERVICE_CLEANUP);
  const pausedCleanup = await transition(
    pausedCleanupHarness,
    "qa:day-loop:sources:pause-cleanup",
    DAY_LOOP_TRIGGER.VISIBILITY_AUTO_PAUSE,
  );
  assert(pausedCleanup.ok, `source PAUSED/CLEANUP 생성 실패: ${pausedCleanup.code}`);
  snapshots.PAUSED_CLEANUP = pausedCleanupHarness.store.getSnapshot();

  const settlementHarness = cloneHarness(cleanupHarness, snapshots.SERVICE_CLEANUP);
  const settled = await transition(
    settlementHarness,
    "qa:day-loop:sources:settlement",
    DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE,
    { transitionToken: snapshots.SERVICE_CLEANUP.service.settlementTransitionToken },
  );
  assert(settled.ok, `source SETTLEMENT 생성 실패: ${settled.code}`);
  snapshots.SETTLEMENT = settlementHarness.store.getSnapshot();

  const terminalHarness = cloneHarness(settlementHarness, snapshots.SETTLEMENT);
  const terminated = await transition(
    terminalHarness,
    "qa:day-loop:sources:terminal",
    DAY_LOOP_TRIGGER.CAMPAIGN_TERMINAL_READY,
  );
  assert(terminated.ok, `source TERMINAL 생성 실패: ${terminated.code}`);
  snapshots.TERMINAL = terminalHarness.store.getSnapshot();

  return { baseHarness: titleHarness, snapshots };
}

function genericTransitionIsLegal(sourceKey, trigger) {
  if (sourceKey === "TITLE") {
    return [
      DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY,
      DAY_LOOP_TRIGGER.CONTINUE_READY,
      DAY_LOOP_TRIGGER.RECOVERY_READY,
    ].includes(trigger);
  }
  if (sourceKey === "SERVICE_RUNNING") {
    return [
      DAY_LOOP_TRIGGER.PAUSE_REQUESTED,
      DAY_LOOP_TRIGGER.VISIBILITY_AUTO_PAUSE,
      DAY_LOOP_TRIGGER.TIMER_ZERO,
      DAY_LOOP_TRIGGER.EARLY_COMPLETION,
    ].includes(trigger);
  }
  if (sourceKey === "SERVICE_CLEANUP") {
    return [
      DAY_LOOP_TRIGGER.PAUSE_REQUESTED,
      DAY_LOOP_TRIGGER.VISIBILITY_AUTO_PAUSE,
      DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE,
      DAY_LOOP_TRIGGER.CLEANUP_OVERTIME_CAP,
    ].includes(trigger);
  }
  if (["PAUSED_RUNNING", "PAUSED_CLEANUP"].includes(sourceKey)) {
    return trigger === DAY_LOOP_TRIGGER.RESUME_REQUESTED;
  }
  if (sourceKey === "SETTLEMENT") {
    return [DAY_LOOP_TRIGGER.NEXT_DAY_READY, DAY_LOOP_TRIGGER.CAMPAIGN_TERMINAL_READY].includes(trigger);
  }
  if (sourceKey === "TERMINAL") {
    return trigger === DAY_LOOP_TRIGGER.NEW_CAMPAIGN_CONFIRMED;
  }
  return false;
}

/** Unit/integration examples for every allowed row in the phase table.
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.11, 2.12, 2.13, 19.2** */
async function allAllowedTransitions(configuration) {
  const { baseHarness, snapshots } = await createSourceSnapshots(configuration);
  const rows = [
    ["TITLE", DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY, RUNTIME_PHASE.PLANNING, SERVICE_LIFECYCLE.INACTIVE],
    ["TITLE", DAY_LOOP_TRIGGER.CONTINUE_READY, RUNTIME_PHASE.PLANNING, SERVICE_LIFECYCLE.INACTIVE],
    ["TITLE", DAY_LOOP_TRIGGER.RECOVERY_READY, RUNTIME_PHASE.PLANNING, SERVICE_LIFECYCLE.INACTIVE],
    ["SERVICE_RUNNING", DAY_LOOP_TRIGGER.PAUSE_REQUESTED, RUNTIME_PHASE.PAUSED, SERVICE_LIFECYCLE.RUNNING],
    ["SERVICE_RUNNING", DAY_LOOP_TRIGGER.VISIBILITY_AUTO_PAUSE, RUNTIME_PHASE.PAUSED, SERVICE_LIFECYCLE.RUNNING],
    ["SERVICE_RUNNING", DAY_LOOP_TRIGGER.TIMER_ZERO, RUNTIME_PHASE.SERVICE, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP],
    ["SERVICE_RUNNING", DAY_LOOP_TRIGGER.EARLY_COMPLETION, RUNTIME_PHASE.SERVICE, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP],
    ["SERVICE_CLEANUP", DAY_LOOP_TRIGGER.PAUSE_REQUESTED, RUNTIME_PHASE.PAUSED, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP],
    ["SERVICE_CLEANUP", DAY_LOOP_TRIGGER.VISIBILITY_AUTO_PAUSE, RUNTIME_PHASE.PAUSED, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP],
    ["SERVICE_CLEANUP", DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE, RUNTIME_PHASE.SETTLEMENT, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP],
    ["SERVICE_CLEANUP", DAY_LOOP_TRIGGER.CLEANUP_OVERTIME_CAP, RUNTIME_PHASE.SETTLEMENT, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP],
    ["PAUSED_RUNNING", DAY_LOOP_TRIGGER.RESUME_REQUESTED, RUNTIME_PHASE.SERVICE, SERVICE_LIFECYCLE.RUNNING],
    ["PAUSED_CLEANUP", DAY_LOOP_TRIGGER.RESUME_REQUESTED, RUNTIME_PHASE.SERVICE, SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP],
    ["SETTLEMENT", DAY_LOOP_TRIGGER.NEXT_DAY_READY, RUNTIME_PHASE.PLANNING, SERVICE_LIFECYCLE.INACTIVE],
    ["SETTLEMENT", DAY_LOOP_TRIGGER.CAMPAIGN_TERMINAL_READY, RUNTIME_PHASE.TERMINAL, SERVICE_LIFECYCLE.INACTIVE],
    ["TERMINAL", DAY_LOOP_TRIGGER.NEW_CAMPAIGN_CONFIRMED, RUNTIME_PHASE.PLANNING, SERVICE_LIFECYCLE.INACTIVE],
  ];
  let genericRows = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const [sourceKey, trigger, expectedPhase, expectedLifecycle] = rows[index];
    const harness = cloneHarness(baseHarness, snapshots[sourceKey]);
    const payload = transitionPayload(trigger, snapshots[sourceKey]);
    const result = await harness.dayLoopController.transition(commandInput(
      harness,
      `qa:day-loop:allowed:${index}`,
      payload,
    ));
    assert(result.ok, `${sourceKey}/${trigger} 허용 전이가 실패했습니다: ${result.code}`);
    assert(harness.store.runtimePhase === expectedPhase, `${sourceKey}/${trigger} target phase가 다릅니다.`);
    assert(harness.store.getSnapshot().service.lifecycle === expectedLifecycle,
      `${sourceKey}/${trigger} target lifecycle이 다릅니다.`);
    assert(result.events.length === 1, `${sourceKey}/${trigger} event cardinality가 1이 아닙니다.`);
    genericRows += 1;
  }

  const planningHarness = cloneHarness(baseHarness, snapshots.PLANNING);
  const before = planningHarness.store.getSnapshot();
  const explicit = await confirmServiceStart(planningHarness, "qa:day-loop:allowed:explicit-start");
  assert(explicit.ok, `PLANNING/ConfirmServiceStart 허용 전이가 실패했습니다: ${explicit.code}`);
  const after = planningHarness.store.getSnapshot();
  assert(after.runtimePhase === RUNTIME_PHASE.SERVICE && after.service.lifecycle === SERVICE_LIFECYCLE.RUNNING,
    "명시적 Service Start가 SERVICE/RUNNING으로 전이하지 않았습니다.");
  assert(after.menu.locked && !after.menu.cleanupComplete, "Service Start가 메뉴를 잠그지 않았습니다.");
  assert(after.checkpointPhase === null, "Service Start 뒤 checkpoint가 남았습니다.");
  assert(after.recipes === before.recipes && after.saleSlots === before.saleSlots &&
    after.events === before.events &&
    after.facilities === before.facilities && after.untouched === before.untouched,
  "Service Start가 write-set 밖 slice를 교체했습니다.");
  // inventory는 write-set에 있지만, Service Start가 건드려도 되는 필드는 completedDishes뿐이다
  // (service.completedDishes가 매일 []로 새로 시작하는 것과 짝을 맞추기 위함). lots/reservations/
  // cookEscrows는 재료 재고·예약이라 하루가 지나도 절대 바뀌면 안 된다.
  assert(equivalent(after.inventory.lots, before.inventory.lots) &&
    equivalent(after.inventory.reservations, before.inventory.reservations) &&
    equivalent(after.inventory.cookEscrows, before.inventory.cookEscrows),
  "Service Start가 inventory의 lots/reservations/cookEscrows를 건드렸습니다.");
  assert(after.inventory.completedDishes.length === 0,
    "Service Start가 completedDishes를 새로 비우지 않았습니다.");
  assert(explicit.events.length === 1 && explicit.events[0].type === "day-loop.service-started",
    "Service Start committed event가 정확히 하나가 아닙니다.");
  return { allowedRows: genericRows + 1, genericRows, explicitStartRows: 1 };
}

/** Property 1: 합법 phase 전이와 명시 Service Start.
 * Feature: dungeon-restaurant-management-mvp, Property 1: 합법 phase 전이와 명시 Service Start
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.11, 2.12, 2.13** */
async function phaseTransitionPropertyMatrix(configuration) {
  const { baseHarness, snapshots } = await createSourceSnapshots(configuration);
  const sourceEntries = Object.entries(snapshots);
  const triggers = Object.values(DAY_LOOP_TRIGGER);
  let samples = 0;
  let legalSamples = 0;
  let rejectedSamples = 0;
  let fullRejectionChecks = 0;

  for (const [sourceKey, snapshot] of sourceEntries) {
    for (const trigger of triggers) {
      const harness = cloneHarness(baseHarness, snapshot);
      const payload = transitionPayload(trigger, snapshot);
      const legal = genericTransitionIsLegal(sourceKey, trigger);
      if (legal) {
        const result = await harness.dayLoopController.transition(commandInput(
          harness,
          `qa:day-loop:property:${sourceKey}:${trigger}`,
          payload,
        ));
        assert(result.ok, `Property sample ${sourceKey}/${trigger}가 허용되지 않았습니다: ${result.code}`);
        legalSamples += 1;
      } else {
        const expectedCode = trigger === DAY_LOOP_TRIGGER.CONFIRM_SERVICE_START
          ? "SERVICE_START_REQUIRES_EXPLICIT_CONFIRM_COMMAND"
          : "ILLEGAL_PHASE_TRANSITION";
        await assertRejectedUnchanged(
          harness,
          () => harness.dayLoopController.transition(commandInput(
            harness,
            `qa:day-loop:property:${sourceKey}:${trigger}`,
            payload,
          )),
          expectedCode,
          `Property sample ${sourceKey}/${trigger}`,
        );
        rejectedSamples += 1;
        fullRejectionChecks += 8;
      }
      samples += 1;
    }
  }
  assert(samples >= PROPERTY_MINIMUM_SAMPLES, `Property 1 sample 수가 ${samples}로 100 미만입니다.`);
  return { samples, legalSamples, rejectedSamples, fullRejectionChecks };
}

/** Explicit start unit examples for plan/enabled/AVAILABLE/full-reservation invariants.
 * **Validates: Requirements 2.3, 2.4, 2.5, 9.5** */
async function explicitStartInvariants(configuration) {
  const noPlan = createHarness(configuration);
  assert((await enterPlanning(noPlan, "qa:day-loop:no-plan:planning")).ok, "no-plan Planning 진입 실패");
  const noPlanResult = await assertRejectedUnchanged(
    noPlan,
    () => confirmServiceStart(noPlan, "qa:day-loop:no-plan:start"),
    "SERVICE_START_PLAN_REQUIRED",
    "확정 plan 없는 Service Start",
  );
  assert(/[가-힣]/.test(JSON.stringify(noPlanResult.diagnostics)), "Service Start 진단에 한국어 설명이 없습니다.");

  const emptyPlanState = cloneValue(noPlan.store.getSnapshot());
  emptyPlanState.menu.activePlanId = "qa:day-loop:empty-plan";
  emptyPlanState.menu.planRevision = 1;
  const emptyPlan = createHarness({ ...configuration, snapshot: emptyPlanState });
  await assertRejectedUnchanged(
    emptyPlan,
    () => confirmServiceStart(emptyPlan, "qa:day-loop:empty-plan:start"),
    "SERVICE_START_ENABLED_RECIPE_REQUIRED",
    "활성 Planned_Quantity 없는 Service Start",
  );

  const planned = createHarness(configuration);
  await preparePlanningPlan(planned, 2, "invariants");
  const plannedSnapshot = planned.store.getSnapshot();

  const assignedState = cloneValue(plannedSnapshot);
  assignedState.saleSlots.slots[0].state = SALE_SLOT_STATE.ASSIGNED;
  assignedState.saleSlots.slots[0].activeOrderId = "qa:day-loop:pre-service-order";
  const assigned = createHarness({ ...configuration, snapshot: assignedState });
  await assertRejectedUnchanged(
    assigned,
    () => confirmServiceStart(assigned, "qa:day-loop:assigned-slot:start"),
    "SERVICE_START_REQUIRES_ALL_SLOTS_AVAILABLE",
    "pre-Service ASSIGNED slot",
  );

  const noAvailableState = cloneValue(plannedSnapshot);
  for (let index = 0; index < noAvailableState.saleSlots.slots.length; index += 1) {
    noAvailableState.saleSlots.slots[index].state = SALE_SLOT_STATE.ASSIGNED;
    noAvailableState.saleSlots.slots[index].activeOrderId = `qa:day-loop:pre-service-order:${index}`;
  }
  const noAvailable = createHarness({ ...configuration, snapshot: noAvailableState });
  await assertRejectedUnchanged(
    noAvailable,
    () => confirmServiceStart(noAvailable, "qa:day-loop:no-available:start"),
    "SERVICE_START_AVAILABLE_SLOT_REQUIRED",
    "AVAILABLE slot 없는 Service Start",
  );

  const brokenReservationState = cloneValue(plannedSnapshot);
  brokenReservationState.inventory.reservations.pop();
  const brokenReservation = createHarness({ ...configuration, snapshot: brokenReservationState });
  await assertRejectedUnchanged(
    brokenReservation,
    () => confirmServiceStart(brokenReservation, "qa:day-loop:broken-reservation:start"),
    "SERVICE_START_PLAN_RECONCILIATION_FAILED",
    "reservation 불일치 Service Start",
  );

  const historicalDishState = cloneValue(plannedSnapshot);
  historicalDishState.inventory.completedDishes.push(createCompletedDish({
    dishId: "qa.day-loop.historical-sold-dish",
    recipeId: activeRecipe(plannedSnapshot).recipeId,
    quality: 70,
    bookCostG: 0,
    recognizedBookCostG: 4,
    state: COMPLETED_DISH_STATE.SOLD,
  }));
  const historicalDish = createHarness({ ...configuration, snapshot: historicalDishState });
  const historicalStart = await confirmServiceStart(historicalDish, "qa:day-loop:historical-dish:start");
  assert(historicalStart.ok, `이전 판매 요리 이력이 다음 Service를 막았습니다: ${historicalStart.code}`);

  const carriedDishState = cloneValue(plannedSnapshot);
  carriedDishState.inventory.completedDishes.push(createCompletedDish({
    dishId: "qa.day-loop.carried-dish",
    recipeId: activeRecipe(plannedSnapshot).recipeId,
    quality: 70,
    bookCostG: 4,
    recognizedBookCostG: 0,
    state: COMPLETED_DISH_STATE.CARRIED,
  }));
  const carriedDish = createHarness({ ...configuration, snapshot: carriedDishState });
  await assertRejectedUnchanged(
    carriedDish,
    () => confirmServiceStart(carriedDish, "qa:day-loop:carried-dish:start"),
    "SERVICE_START_TRANSIENTS_NOT_EMPTY",
    "미서빙 CARRIED dish가 남은 Service Start",
  );

  return {
    invalidCases: 6,
    exactPreservationCases: 6,
    enabledRecipeInvariant: true,
    availableSlotInvariant: true,
    fullReservationInvariant: true,
    historicalTerminalDishAllowed: true,
  };
}

/** Invalid menu and ordinary menu edit examples preserve phase/revision and never auto-start.
 * **Validates: Requirements 2.4, 2.5, 2.13, 9.1, 9.5** */
async function invalidMenuAndEditIsolation(configuration) {
  const harness = createHarness(configuration);
  await preparePlanningPlan(harness, 2, "edit-isolation");
  const attemptsBeforeEdit = harness.dayLoopController.getAuditSnapshot().serviceStartValidationAttempts;
  const edit = await editPlanQuantity(harness, 1, "qa:day-loop:edit-isolation:unconfirmed-edit");
  assert(edit.ok, `production MenuSystem edit가 실패했습니다: ${edit.code}`);
  assert(harness.store.runtimePhase === RUNTIME_PHASE.PLANNING, "menu edit가 Service를 자동 시작했습니다.");
  assert(harness.dayLoopController.getAuditSnapshot().serviceStartValidationAttempts === attemptsBeforeEdit,
    "menu edit가 Service Start validator를 호출했습니다.");

  const revisionBeforeStart = harness.store.revision;
  const phaseBeforeStart = harness.store.runtimePhase;
  const result = await assertRejectedUnchanged(
    harness,
    () => confirmServiceStart(harness, "qa:day-loop:edit-isolation:start"),
    "SERVICE_START_UNCONFIRMED_MENU_EDITS",
    "미확정 menu edit Service Start",
  );
  assert(harness.store.revision === revisionBeforeStart && harness.store.runtimePhase === phaseBeforeStart,
    "invalid menu가 phase/revision을 변경했습니다.");
  assert(harness.dayLoopController.getAuditSnapshot().serviceStartValidationAttempts === attemptsBeforeEdit + 1,
    "명시적 ConfirmServiceStart만 validator attempt를 기록하지 않았습니다.");
  assert(/[가-힣]/.test(JSON.stringify(result.diagnostics)), "invalid menu 진단의 한국어 설명이 누락됐습니다.");
  return {
    menuEditCommits: 1,
    automaticServiceStarts: 0,
    validationAttemptsBeforeExplicitStart: attemptsBeforeEdit,
    validationAttemptsAfterExplicitStart: attemptsBeforeEdit + 1,
    invalidMenuPhase: phaseBeforeStart,
    invalidMenuRevision: revisionBeforeStart,
  };
}

/** Early-end truth table unit/property examples.
 * **Validates: Requirements 2.12** */
function earlyEndPredicateTruthTable() {
  let samples = 0;
  let eligibleCount = 0;
  for (const scheduledPlansComplete of [false, true]) {
    for (const activeOrderCount of [0, 1, 3]) {
      for (const carriedDishId of [null, "qa:day-loop:dish"] ) {
        for (const nonExitedGuestCount of [0, 1, 4]) {
          const input = {
            scheduledPlansComplete,
            activeOrderCount,
            carriedDishId,
            nonExitedGuestCount,
          };
          const result = evaluateServiceEarlyEnd(input);
          const expected = scheduledPlansComplete && activeOrderCount === 0 &&
            carriedDishId === null && nonExitedGuestCount === 0;
          assert(result.ok && result.eligible === expected,
            `early-end predicate가 truth table과 다릅니다: ${JSON.stringify(input)}`);
          eligibleCount += Number(result.eligible);
          samples += 1;
        }
      }
    }
  }
  assert(eligibleCount === 1, `early-end eligible 조합이 ${eligibleCount}개입니다.`);
  const invalid = evaluateServiceEarlyEnd({
    scheduledPlansComplete: true,
    activeOrderCount: -1,
    carriedDishId: null,
    nonExitedGuestCount: 0,
  });
  assert(!invalid.ok && !invalid.eligible && invalid.code === "INVALID_EARLY_END_PREDICATE",
    "invalid early-end metric이 명시 code로 거절되지 않았습니다.");
  return { samples, eligibleCount, invalidCases: 1 };
}

/** Duplicate end/cleanup signals consume one token and schedule Settlement exactly once.
 * **Validates: Requirements 2.11, 2.13** */
async function duplicateEndSignalSingleSettlement(configuration) {
  const { baseHarness, snapshots } = await createSourceSnapshots(configuration);
  const harness = cloneHarness(baseHarness, snapshots.SERVICE_CLEANUP);
  const token = harness.store.getSnapshot().service.settlementTransitionToken;
  const first = await transition(
    harness,
    "qa:day-loop:duplicate-end:first",
    DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE,
    { transitionToken: token },
  );
  assert(first.ok && harness.store.runtimePhase === RUNTIME_PHASE.SETTLEMENT,
    `첫 Settlement 전이가 실패했습니다: ${first.code}`);
  assert(first.events.length === 1 && first.events[0].type === "day-loop.settlement-transition-issued",
    "첫 Settlement transition event가 정확히 하나가 아닙니다.");
  await assertRejectedUnchanged(
    harness,
    () => transition(
      harness,
      "qa:day-loop:duplicate-end:second",
      DAY_LOOP_TRIGGER.CLEANUP_OVERTIME_CAP,
      { transitionToken: token },
    ),
    "ILLEGAL_PHASE_TRANSITION",
    "duplicate Settlement end signal",
  );
  const settlementEvents = harness.bus.getSignalSnapshot().events.filter(
    (event) => event.type === "day-loop.settlement-transition-issued",
  );
  assert(settlementEvents.length === 1, `Settlement transition이 ${settlementEvents.length}번 예약됐습니다.`);
  assert(settlementEvents[0].payload.transitionToken === token, "Settlement event가 단일 Service token을 보존하지 않았습니다.");
  return {
    transitionToken: token,
    settlementTransitionEvents: settlementEvents.length,
    duplicateSignalsRejected: 1,
  };
}

export async function runDayLoopProbe({ recipes, facilities, balance, guestArchetypes }) {
  const configuration = {
    canonicalRecipes: recipes,
    canonicalFacilities: facilities,
    balance,
    guestArchetypes,
  };
  const results = await Promise.all([
    runCase(
      "allowed-transition-table",
      "허용 전이표의 모든 행이 production command 경로에서 정확한 phase/lifecycle로 전이한다",
      "Requirements 2.1, 2.2, 2.3, 2.11, 2.12, 2.13, 19.2",
      () => allAllowedTransitions(configuration),
    ),
    runCase(
      "property-1-phase-transition-matrix",
      "모든 phase/lifecycle×trigger 조합에서 합법 전이만 commit되고 나머지는 full rejection된다",
      "Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.11, 2.12, 2.13",
      () => phaseTransitionPropertyMatrix(configuration),
    ),
    runCase(
      "explicit-service-start-invariants",
      "ConfirmServiceStart가 enabled Recipe, AVAILABLE slot, 확정 plan/full reservation을 모두 요구한다",
      "Requirements 2.3, 2.4, 9.5",
      () => explicitStartInvariants(configuration),
    ),
    runCase(
      "invalid-menu-and-edit-isolation",
      "invalid menu는 phase/revision을 보존하고 menu edit는 start validator를 호출하지 않는다",
      "Requirements 2.4, 2.5, 2.13, 9.1, 9.5",
      () => invalidMenuAndEditIsolation(configuration),
    ),
    runCase(
      "early-end-predicate-truth-table",
      "조기 종료는 네 조건이 모두 충족된 유일한 조합에서만 true다",
      "Requirements 2.12",
      () => earlyEndPredicateTruthTable(),
    ),
    runCase(
      "single-settlement-transition-token",
      "중복 end signal은 동일 token으로 Settlement를 한 번만 예약한다",
      "Requirements 2.11, 2.13",
      () => duplicateEndSignalSingleSettlement(configuration),
    ),
  ]);
  const passed = results.filter((result) => result.status === "PASS").length;
  const property = results.find((result) => result.id === "property-1-phase-transition-matrix")?.details ?? {};
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    propertySampleCount: property.samples ?? 0,
    propertyRejectedSampleCount: property.rejectedSamples ?? 0,
    results,
  });
}

function browserCommand(store, commandId, payload) {
  return {
    commandId,
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs: store.revision * 20,
    payload,
  };
}

function publishBrowserReport(root, report) {
  root.body.dataset.dayLoopQa = report.status.toLowerCase();
  root.body.dataset.dayLoopQaPassed = String(report.passed);
  root.body.dataset.dayLoopQaTotal = String(report.total);
  root.documentElement.dataset.dayLoopPhase = report.runtimePhase;
  root.documentElement.dataset.dayLoopStartValidationAttempts = String(report.validationAttempts);
}

/** Actual authored zone/panel and MenuSystem paths prove that only explicit confirmation validates start.
 * **Validates: Requirements 2.4, 2.5, 9.1** */
export async function runDayLoopBrowserProbe({
  root,
  hub,
  baseMap,
  store,
  dayLoopController,
  menuSystem,
}) {
  const results = [];
  if (store.runtimePhase === RUNTIME_PHASE.TITLE) {
    const entered = await dayLoopController.transition(browserCommand(
      store,
      "qa:day-loop:browser:title-ready",
      { trigger: DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY },
    ));
    assert(entered.ok, `browser TITLE→PLANNING 실패: ${entered.code}`);
  }
  const attemptsBefore = dayLoopController.getAuditSnapshot().serviceStartValidationAttempts;

  results.push(await runCase(
    "browser-authored-zone-panel-no-start-validation",
    "실제 authored board/stove/counter/storage 진입과 panel open은 Service Start validator를 호출하지 않는다",
    "Requirements 2.5, 1.3",
    () => {
      const opened = [];
      for (const zone of baseMap.zones) {
        hub.reset();
        hub.setPlayerPosition(zone.rect.x + zone.rect.width / 2, zone.rect.y + zone.rect.height + 6);
        const state = hub.getState();
        assert(state.panelOpen, `${zone.semantic} authored zone이 panel을 열지 않았습니다.`);
        assert(state.activePanelZoneId === zone.semantic, `${zone.semantic} panel semantic이 다릅니다.`);
        assert(dayLoopController.getAuditSnapshot().serviceStartValidationAttempts === attemptsBefore,
          `${zone.semantic} zone/panel이 Service Start validator를 호출했습니다.`);
        opened.push(zone.semantic);
      }
      return { opened, validationAttempts: attemptsBefore };
    },
  ));

  results.push(await runCase(
    "browser-production-menu-edit-no-start-validation",
    "production MenuSystem edit는 Planning을 유지하고 Service Start validator를 호출하지 않는다",
    "Requirements 2.4, 2.5, 9.1, 9.5",
    async () => {
      hub.reset();
      const snapshot = store.getSnapshot();
      const recipe = activeRecipe(snapshot);
      const entry = snapshot.menu.draftEntries.find((candidate) => candidate.recipeId === recipe.recipeId);
      const edited = await menuSystem.editEntry(browserCommand(
        store,
        "qa:day-loop:browser:menu-edit",
        { ...entry },
      ));
      assert(edited.ok, `browser production menu edit 실패: ${edited.code}`);
      assert(store.runtimePhase === RUNTIME_PHASE.PLANNING, "browser menu edit가 Service를 자동 시작했습니다.");
      assert(dayLoopController.getAuditSnapshot().serviceStartValidationAttempts === attemptsBefore,
        "browser menu edit가 Service Start validator를 호출했습니다.");
      const beforeRejectedStart = store.getSnapshot();
      const revisionBeforeRejectedStart = store.revision;
      const rejected = await dayLoopController.confirmServiceStart(browserCommand(
        store,
        "qa:day-loop:browser:explicit-invalid-start",
        { day: snapshot.campaign.day },
      ));
      assert(!rejected.ok && rejected.code === "SERVICE_START_PLAN_REQUIRED",
        `browser invalid explicit start code가 다릅니다: ${rejected.code}`);
      assert(store.getSnapshot() === beforeRejectedStart && store.revision === revisionBeforeRejectedStart,
        "browser invalid explicit start가 phase/revision을 변경했습니다.");
      assert(dayLoopController.getAuditSnapshot().serviceStartValidationAttempts === attemptsBefore + 1,
        "browser explicit start만 validation attempt를 만들지 않았습니다.");
      return { menuEditCommitted: true, automaticStarts: 0, explicitValidationAttempts: 1 };
    },
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  const report = freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    runtimePhase: store.runtimePhase,
    validationAttempts: dayLoopController.getAuditSnapshot().serviceStartValidationAttempts,
    results,
  });
  publishBrowserReport(root, report);
  return report;
}
