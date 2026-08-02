import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { freezeDeep } from "../core/result.js";
import { createRngRegistryState } from "../core/rng.js";
import { Scheduler } from "../core/scheduler.js";
import { GameStore } from "../core/store.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";
import { registerDayLoopController } from "../domain/day-loop.js";
import { createEconomyState } from "../domain/economy.js";
import { createEventState } from "../domain/events.js";
import { createFacilityState } from "../domain/facility.js";
import { createInventoryAccountingState, registerInventoryAccounting } from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import { createMenuState, registerMenuSystem } from "../domain/menu.js";
import { ACTIVE_ORDER_STATE, ORDER_GUEST_STATE, ORDER_REACTION_KIND, registerOrderSystem } from "../domain/orders.js";
import { createRecipeState } from "../domain/recipe.js";
import { createReputationCampaignFields } from "../domain/reputation.js";
import { createSaleSlotsState, SALE_SLOT_STATE } from "../domain/sale-slots.js";
import { createSalesState } from "../domain/sales.js";
import { registerServiceCleanupSystem } from "../domain/service-cleanup.js";
import { createServiceTimerState, RUNTIME_PHASE, SERVICE_LIFECYCLE } from "../domain/timer-state.js";
import {
  guestExitStableId,
  guestReactionStableId,
  seatArrivalStableId,
  TimerSystem,
} from "../domain/timer-system.js";
import { GUEST_CLEANUP_TIER, GUEST_TERMINATION_CAUSE, registerGuestCleanupSystem } from "../world/guest-cleanup.js";
import { registerGuestFlowSystem } from "../world/guest-flow.js";
import { registerGuestOutcomeSystem } from "../world/guest-outcomes.js";
import { createGuestPassabilityGrid } from "../world/passability-grid.js";

const QA_GENERATION_ID = 31;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function allIngredientIds(recipes) {
  return [...new Set(recipes.flatMap((recipe) =>
    recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))].sort();
}

function createLots(recipes, quantity = 80) {
  return allIngredientIds(recipes).map((ingredientId, index) => ({
    lotId: `qa.guest-outcomes.lot.${String(index).padStart(3, "0")}`,
    ingredientId,
    quantity,
    quality: 70,
    bookCostG: quantity * 2,
    acquiredDay: 1,
  }));
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

function blockedGrid(grid, tileX, tileY) {
  const cells = [...grid.cells];
  cells[tileY * grid.width + tileX] = 0;
  return Object.freeze({ ...grid, cells: Object.freeze(cells) });
}

function createHarness({ recipes, facilities, balance, guestArchetypes, map, seed = 0x31, blockSeatId = null, blockExit = false }) {
  const campaignId = createCampaignId(seed, 0);
  const recipeState = createRecipeState({ recipes, ingredientIds: allIngredientIds(recipes) });
  const lots = createLots(recipes);
  const initialState = {
    formatVersion: 1,
    revision: 0,
    runtimePhase: RUNTIME_PHASE.PLANNING,
    checkpointPhase: "PLANNING_READY",
    generationId: QA_GENERATION_ID,
    campaign: {
      campaignId, masterSeed: seed, day: 1, consecutiveArrearsCount: 0, canonicalDayResults: [],
      settlementOutcomeSealedForDay: null, terminalResult: null,
      ...createReputationCampaignFields(30),
    },
    events: createEventState(),
    facilities: createFacilityState({ facilities }),
    recipes: recipeState,
    menu: createMenuState({ day: 1, recipes: recipeState }),
    saleSlots: createSaleSlotsState({ day: 1 }),
    economy: createEconomyState({ cashG: 300, debtG: 500 }),
    inventory: createInventoryState({ lots }),
    inventoryAccounting: createInventoryAccountingState({
      openingInventoryBookCostG: lots.reduce((total, lot) => total + lot.bookCostG, 0),
    }),
    sales: createSalesState({ day: 1 }),
    service: createServiceTimerState({
      durationMs: balance.service.durationMs,
      cleanupOvertimeMs: balance.service.cleanupOvertimeMs,
    }),
    idCounters: createIdServiceState({ campaignId, day: 1, generationId: QA_GENERATION_ID }),
    rng: createRngRegistryState(seed),
  };
  const store = new GameStore(initialState);
  const bus = new CommandBus({ store });
  registerCashTransactionAPI(bus);
  registerInventoryAccounting(bus);
  const menuSystem = registerMenuSystem(bus);
  const dayLoopController = registerDayLoopController(bus, { guestArchetypes });
  const orderSystem = registerOrderSystem(bus);
  const serviceCleanupSystem = registerServiceCleanupSystem(bus);
  const guestCleanupSystem = registerGuestCleanupSystem(bus);

  let guestGrid = createGuestPassabilityGrid(map);
  if (blockSeatId) {
    const seat = map.navigation.seatPoints.find((point) => point.seatId === blockSeatId);
    guestGrid = blockedGrid(guestGrid, seat.tileX, seat.tileY);
  }
  if (blockExit) {
    guestGrid = blockedGrid(guestGrid, map.navigation.exitPoint.tileX, map.navigation.exitPoint.tileY);
  }

  const guestFlowSystem = registerGuestFlowSystem(bus, {
    seatPoints: map.navigation.seatPoints,
    spawnPoint: map.navigation.spawnPoint,
    guestPassabilityGrid: guestGrid,
  });
  const guestOutcomeSystem = registerGuestOutcomeSystem(bus, {
    seatPoints: map.navigation.seatPoints,
    exitPoint: map.navigation.exitPoint,
    guestPassabilityGrid: guestGrid,
  });
  const scheduler = new Scheduler();
  const timerSystem = new TimerSystem({
    store, commandBus: bus, scheduler, dayLoopController, menuSystem, serviceCleanupSystem, guestFlowSystem, guestOutcomeSystem,
    orderSystem,
  });
  return {
    store, bus, menuSystem, dayLoopController, orderSystem, serviceCleanupSystem, guestCleanupSystem,
    guestFlowSystem, guestOutcomeSystem, scheduler, timerSystem, map,
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

async function startServiceWithoutMenu(harness) {
  const started = await harness.dayLoopController.confirmServiceStart(commandInput(harness, `start:${harness.store.revision}`, { day: 1 }));
  return started;
}

/** 메뉴를 확정하고 Service를 시작한 뒤, 첫 손님을 실제 GuestFlow로 SEATED까지 옮긴다. */
async function startServiceAndSeatFirstGuest(harness, { withMenu = true } = {}) {
  if (withMenu) {
    const recipe = activeRecipe(harness.store.getSnapshot());
    const edited = await harness.menuSystem.editEntry(commandInput(harness, `edit:${harness.store.revision}`, {
      recipeId: recipe.recipeId, enabled: true, priceG: recipe.basePriceG, plannedQuantity: 1,
    }));
    assert(edited.ok, `menu edit 실패: ${edited.code}`);
  }
  const confirmed = await harness.menuSystem.confirmPlan(commandInput(harness, `confirm:${harness.store.revision}`, { day: 1 }));
  assert(confirmed.ok, `menu confirm 실패: ${confirmed.code}`);
  const started = await harness.dayLoopController.confirmServiceStart(commandInput(harness, `start:${harness.store.revision}`, { day: 1 }));
  assert(started.ok, `service start 실패: ${started.code}`);
  const durationMs = harness.store.getSnapshot().service.durationMs;
  const transitionToken = harness.store.getSnapshot().service.settlementTransitionToken;
  harness.timerSystem.armServiceTimer({ serviceToken: transitionToken, durationMs });
  harness.timerSystem.armGuestArrivals({ plans: harness.store.getSnapshot().service.plans });

  const plans = [...harness.store.getSnapshot().service.plans].sort((a, b) => a.arrivalAtMs - b.arrivalAtMs);
  const first = plans[0];
  const beforeArrival = harness.store.getSnapshot();
  const arrivalTick = await harness.timerSystem.tick(first.arrivalAtMs);
  const arrivalDispatch = arrivalTick.dispatched.find((d) => d.item.stableId.includes(first.guestId));
  if (!arrivalDispatch?.result.ok) {
    return { guestId: first.guestId, transitionToken, seated: false, arrivalDispatch, beforeArrival };
  }
  const seatItem = harness.scheduler.snapshot().queue.find((item) => item.stableId === seatArrivalStableId(first.guestId));
  if (!seatItem) return { guestId: first.guestId, transitionToken, seated: false, beforeArrival };
  await harness.timerSystem.tick(seatItem.simulationTimeMs);
  const seated = harness.store.getSnapshot().service.guests.find((g) => g.guestId === first.guestId);
  return { guestId: first.guestId, transitionToken, seated: seated?.state === ORDER_GUEST_STATE.SEATED, beforeArrival };
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id, description, validates, status: "FAIL", error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 진짜 order.create가 stockout(AVAILABLE slot 0)으로 MEAL_REACTION을 만들게 한 뒤
 * armGuestReaction으로 예약한다 — 확정된 메뉴가 있어야 Service가 시작되므로, SEATED 직후
 * 유일한 slot을 SOLD로 미리 seed해 실제로 AVAILABLE slot이 없게 만든다. */
async function armStockoutReaction(harness) {
  const { guestId } = await startServiceAndSeatFirstGuest(harness);
  const snapshot = harness.store.getSnapshot();
  harness.store.commit({
    ...snapshot,
    saleSlots: {
      ...snapshot.saleSlots,
      slots: snapshot.saleSlots.slots.map((slot) => ({ ...slot, state: SALE_SLOT_STATE.SOLD, activeOrderId: null })),
    },
  }, { commandId: `qa:seed-no-available-slots:${harness.store.revision}`, expectedRevision: harness.store.revision });

  const created = await harness.orderSystem.createOrder(commandInput(harness, `order:${harness.store.revision}`, { guestId }));
  assert(created.ok, `stockout order.create 실패: ${created.code}`);
  const guest = harness.store.getSnapshot().service.guests.find((g) => g.guestId === guestId);
  assert(guest.state === ORDER_GUEST_STATE.MEAL_REACTION, `stockout 뒤 MEAL_REACTION이 아닙니다: ${guest.state}`);
  assert(guest.reaction.kind === ORDER_REACTION_KIND.FAILURE_STOCKOUT, "stockout reaction kind가 다릅니다.");
  harness.timerSystem.armGuestReaction({ guestId });
  return { guestId, reactionArmedAtMs: harness.scheduler.simulationTimeMs };
}

async function reactionBoundary479Vs480(harness) {
  const { guestId } = await armStockoutReaction(harness);
  const before = await harness.timerSystem.tick(harness.scheduler.simulationTimeMs + 479);
  const guestAt479 = harness.store.getSnapshot().service.guests.find((g) => g.guestId === guestId);
  assert(guestAt479.state === ORDER_GUEST_STATE.MEAL_REACTION, `479ms에 이미 전이했습니다: ${guestAt479.state}`);
  const after = await harness.timerSystem.tick(harness.scheduler.simulationTimeMs + 1);
  const reactionDispatch = after.dispatched.find((d) => d.item.stableId === guestReactionStableId(guestId));
  assert(reactionDispatch?.result.ok, "480ms boundary에서 reaction-complete가 dispatch되지 않았습니다.");
  const guestAt480 = harness.store.getSnapshot().service.guests.find((g) => g.guestId === guestId);
  assert(guestAt480.state === ORDER_GUEST_STATE.MOVING_TO_EXIT, `480ms에 MOVING_TO_EXIT가 아닙니다: ${guestAt480.state}`);
  return { at479: guestAt479.state, at480: guestAt480.state };
}

async function stockoutReactionToExit(harness) {
  const { guestId } = await armStockoutReaction(harness);
  const before = harness.store.getSnapshot();
  const reactionTick = await harness.timerSystem.tick(harness.scheduler.simulationTimeMs + 480);
  const moving = harness.store.getSnapshot().service.guests.find((g) => g.guestId === guestId);
  assert(moving.state === ORDER_GUEST_STATE.MOVING_TO_EXIT, `MOVING_TO_EXIT가 아닙니다: ${moving.state}`);
  const exitItem = harness.scheduler.snapshot().queue.find((item) => item.stableId === guestExitStableId(guestId));
  assert(exitItem, "guest-exit이 예약되지 않았습니다.");
  await harness.timerSystem.tick(exitItem.simulationTimeMs);
  const after = harness.store.getSnapshot();
  assert(!after.service.guests.some((g) => g.guestId === guestId), "EXITED 뒤 guest가 제거되지 않았습니다.");
  assert(after.economy.cashG === before.economy.cashG, "stockout exit이 cash를 바꿨습니다.");
  assert(after.service.unmetDemandCount === 1, `unmetDemandCount가 1이 아닙니다: ${after.service.unmetDemandCount}`);
  return { unmetDemandCount: after.service.unmetDemandCount };
}

async function timeoutReactionReleasesSlotAndExits(harness) {
  const { guestId } = await startServiceAndSeatFirstGuest(harness);
  const created = await harness.orderSystem.createOrder(commandInput(
    harness,
    `order:${harness.store.revision}`,
    { guestId },
  ));
  assert(created.ok, `order.create 실패: ${created.code}`);
  const active = harness.store.getSnapshot().service.orders.find((order) => order.guestId === guestId);
  const before = harness.store.getSnapshot();
  harness.timerSystem.armOrderTimeout({
    orderId: active.orderId,
    createdAtMs: active.createdAtMs,
    patienceRemainingMs: active.patienceRemainingMs,
  });
  const timeoutTick = await harness.timerSystem.tick(active.createdAtMs + active.patienceRemainingMs);
  const timedOut = timeoutTick.dispatched.find(
    (entry) => entry.item.stableId === `order-timeout:${active.orderId}`,
  )?.result;
  assert(timedOut.ok, `order.timeout 실패: ${timedOut.code}`);
  const afterTimeout = harness.store.getSnapshot();
  const guest = afterTimeout.service.guests.find((candidate) => candidate.guestId === guestId);
  const slot = afterTimeout.saleSlots.slots.find((candidate) => candidate.saleSlotId === active.saleSlotId);
  assert(guest.state === ORDER_GUEST_STATE.MEAL_REACTION && guest.reaction.kind === ORDER_REACTION_KIND.FAILURE_TIMEOUT,
    "timeout reaction 상태가 다릅니다.");
  assert(slot.state === SALE_SLOT_STATE.AVAILABLE, "timeout 뒤 slot이 해제되지 않았습니다.");
  harness.timerSystem.armGuestReaction({ guestId });
  await harness.timerSystem.tick(harness.scheduler.simulationTimeMs + 480);
  const exitItem = harness.scheduler.snapshot().queue.find((item) => item.stableId === guestExitStableId(guestId));
  assert(exitItem, "timeout guest exit이 예약되지 않았습니다.");
  await harness.timerSystem.tick(exitItem.simulationTimeMs);
  const afterExit = harness.store.getSnapshot();
  assert(!afterExit.service.guests.some((candidate) => candidate.guestId === guestId), "timeout guest가 EXITED 처리되지 않았습니다.");
  assert(afterExit.economy.cashG === before.economy.cashG, "timeout이 cash를 바꿨습니다.");
  assert(equivalent(afterExit.inventory, before.inventory), "timeout이 inventory를 바꿨습니다.");
  assert(afterExit.campaign.reputation === before.campaign.reputation, "timeout이 reputation을 직접 바꿨습니다.");
  return { orderState: active.state, slotState: slot.state, exited: true };
}

/** SUCCESS reaction을 직접 seed해(실제 cook/serve 파이프라인은 Task 22 QA가 이미 검증) 판매 회계가
 * exit 과정에서 전혀 바뀌지 않음을 확인한다. */
async function seededSaleReactionPreservesAccounting(harness) {
  const { guestId } = await startServiceAndSeatFirstGuest(harness);
  const snapshot = harness.store.getSnapshot();
  const guest = snapshot.service.guests.find((g) => g.guestId === guestId);
  const seededGuest = { ...guest, state: ORDER_GUEST_STATE.MEAL_REACTION, reaction: { kind: ORDER_REACTION_KIND.SUCCESS, elapsedMs: 0, durationMs: 480 } };
  const seededEconomy = { ...snapshot.economy, cashG: snapshot.economy.cashG + 999 };
  harness.store.commit({
    ...snapshot,
    economy: seededEconomy,
    service: { ...snapshot.service, guests: snapshot.service.guests.map((g) => (g.guestId === guestId ? seededGuest : g)) },
  }, { commandId: `qa:seed-sale-reaction:${harness.store.revision}`, expectedRevision: harness.store.revision });
  harness.timerSystem.armGuestReaction({ guestId });

  const before = harness.store.getSnapshot();
  await harness.timerSystem.tick(harness.scheduler.simulationTimeMs + 480);
  const moving = harness.store.getSnapshot().service.guests.find((g) => g.guestId === guestId);
  assert(moving.state === ORDER_GUEST_STATE.MOVING_TO_EXIT, `MOVING_TO_EXIT가 아닙니다: ${moving.state}`);
  const exitItem = harness.scheduler.snapshot().queue.find((item) => item.stableId === guestExitStableId(guestId));
  await harness.timerSystem.tick(exitItem.simulationTimeMs);
  const after = harness.store.getSnapshot();
  assert(!after.service.guests.some((g) => g.guestId === guestId), "EXITED 뒤 guest가 제거되지 않았습니다.");
  assert(equivalent(after.economy, before.economy), "sale 뒤 exit 과정이 economy를 바꿨습니다.");
  assert(equivalent(after.sales, before.sales), "sale 뒤 exit 과정이 sales를 바꿨습니다.");
  return { cashG: after.economy.cashG };
}

/** design 10.4 "order 전" tier — arrival path가 막히면 entity를 만들지 않고 tombstone만 남긴다. */
async function preOrderPathFaultTombstones(harness) {
  const started = await startServiceAndSeatFirstGuest(harness);
  assert(started.seated === false, "path가 막혔는데 SEATED에 도달했습니다.");
  const before = started.beforeArrival;
  const after = harness.store.getSnapshot();
  assert(!after.service.guests.some((g) => g.guestId === started.guestId), "path fault인데 guest entity가 생성됐습니다.");
  const record = after.service.terminationRecords.find((r) => r.guestId === started.guestId);
  assert(record, "GuestTerminationRecord가 없습니다.");
  assert(record.cause === GUEST_TERMINATION_CAUSE.PATH_FAULT, `cause가 다릅니다: ${record.cause}`);
  assert(record.tier === GUEST_CLEANUP_TIER.PRE_ORDER, `tier가 다릅니다: ${record.tier}`);
  assert(after.economy.cashG === before.economy.cashG, "path fault가 cash를 바꿨습니다.");
  assert(equivalent(after.inventory, before.inventory), "path fault가 inventory를 바꿨습니다.");
  assert(after.campaign.reputation === before.campaign.reputation, "path fault가 reputation을 바꿨습니다.");
  return { record };
}

/** design 10.4 "committed sale 후" tier — exit path가 막히면 sale/회계를 보존하고 guest만 종료한다. */
async function postSalePathFaultPreservesSale(harness) {
  const { guestId } = await startServiceAndSeatFirstGuest(harness);
  const snapshot = harness.store.getSnapshot();
  const guest = snapshot.service.guests.find((g) => g.guestId === guestId);
  const seededGuest = { ...guest, state: ORDER_GUEST_STATE.MEAL_REACTION, reaction: { kind: ORDER_REACTION_KIND.SUCCESS, elapsedMs: 0, durationMs: 480 } };
  const seededEconomy = { ...snapshot.economy, cashG: snapshot.economy.cashG + 500 };
  harness.store.commit({
    ...snapshot,
    economy: seededEconomy,
    service: { ...snapshot.service, guests: snapshot.service.guests.map((g) => (g.guestId === guestId ? seededGuest : g)) },
  }, { commandId: `qa:seed-post-sale-fault:${harness.store.revision}`, expectedRevision: harness.store.revision });
  harness.timerSystem.armGuestReaction({ guestId });

  const before = harness.store.getSnapshot();
  await harness.timerSystem.tick(harness.scheduler.simulationTimeMs + 480);
  const after = harness.store.getSnapshot();
  assert(!after.service.guests.some((g) => g.guestId === guestId), "exit path fault인데 guest가 남아 있습니다.");
  assert(equivalent(after.economy, before.economy), "exit path fault가 economy를 바꿨습니다.");
  const record = after.service.terminationRecords.find((r) => r.guestId === guestId);
  assert(record, "GuestTerminationRecord가 없습니다.");
  assert(record.tier === GUEST_CLEANUP_TIER.POST_SALE, `tier가 다릅니다: ${record.tier}`);
  return { record };
}

/** design 10.4 "ACTIVE order 후 sale 전" tier — QA fault-injection으로 order 취소+slot 해제를 함께 확인한다. */
async function activeOrderFaultInjectionReleasesSlot(harness) {
  const { guestId } = await startServiceAndSeatFirstGuest(harness);
  const created = await harness.orderSystem.createOrder(commandInput(harness, `order:${harness.store.revision}`, { guestId }));
  assert(created.ok, `order.create 실패: ${created.code}`);
  const before = harness.store.getSnapshot();
  const order = before.service.orders.find((candidate) => candidate.guestId === guestId);
  assert(order.state === ACTIVE_ORDER_STATE.ACTIVE, "order가 ACTIVE가 아닙니다.");
  const slotBefore = before.saleSlots.slots.find((slot) => slot.saleSlotId === order.saleSlotId);
  assert(slotBefore.state === SALE_SLOT_STATE.ASSIGNED, "slot이 ASSIGNED가 아닙니다.");

  const terminated = await harness.guestCleanupSystem.terminateForFault(
    commandInput(harness, `fault:${harness.store.revision}`, { guestId }),
  );
  assert(terminated.ok, `fault-injection 실패: ${terminated.code}`);
  const after = harness.store.getSnapshot();
  assert(!after.service.guests.some((g) => g.guestId === guestId), "fault-injection 뒤 guest가 남아 있습니다.");
  const orderAfter = after.service.orders.find((candidate) => candidate.orderId === order.orderId);
  assert(orderAfter.state === ACTIVE_ORDER_STATE.TECHNICAL_CANCELLED, `order가 취소되지 않았습니다: ${orderAfter.state}`);
  const slotAfter = after.saleSlots.slots.find((slot) => slot.saleSlotId === order.saleSlotId);
  assert(slotAfter.state === SALE_SLOT_STATE.AVAILABLE, `slot이 해제되지 않았습니다: ${slotAfter.state}`);
  assert(after.economy.cashG === before.economy.cashG, "fault-injection이 cash를 바꿨습니다.");
  const record = after.service.terminationRecords.find((r) => r.guestId === guestId);
  assert(record.tier === GUEST_CLEANUP_TIER.ACTIVE_ORDER, `tier가 다릅니다: ${record.tier}`);
  return { record };
}

/** Requirement 2 AC9~11 — timer-zero cleanup이 pending/moving/reaction guest를 12초 안에
 * 결과 중립으로 전부 치우고 Settlement로 deadlock 없이 전환한다("seat/visual leak 0"). */
async function timerZeroCleanupClearsAllGuests(harness) {
  const { guestId: seatedGuestId, transitionToken } = await startServiceAndSeatFirstGuest(harness);
  const orderCreated = await harness.orderSystem.createOrder(commandInput(harness, `order:${harness.store.revision}`, { guestId: seatedGuestId }));
  assert(orderCreated.ok, `order.create 실패: ${orderCreated.code}`);

  const snapshot = harness.store.getSnapshot();
  const movingGuest = { guestId: "qa.outcomes.moving", entityId: "qa.outcomes.moving-entity", state: ORDER_GUEST_STATE.MOVING_TO_SEAT, seatId: harness.map.navigation.seatPoints[1].seatId, reaction: null };
  harness.store.commit({
    ...snapshot,
    service: {
      ...snapshot.service,
      guests: [...snapshot.service.guests, movingGuest],
      pendingSeatQueue: ["qa.outcomes.pending"],
    },
  }, { commandId: `qa:seed-mixed-guests:${harness.store.revision}`, expectedRevision: harness.store.revision });

  const durationMs = harness.store.getSnapshot().service.durationMs;
  const zero = await harness.timerSystem.tick(durationMs);
  const timerZeroDispatch = zero.dispatched.find((d) => d.item.stableId.startsWith("timer-zero:"));
  assert(timerZeroDispatch?.result.ok, "TIMER_ZERO 전이 실패");
  assert(harness.store.getSnapshot().runtimePhase === RUNTIME_PHASE.SERVICE, "cleanup lifecycle에 진입하지 못했습니다.");
  assert(harness.store.getSnapshot().service.lifecycle === SERVICE_LIFECYCLE.RESULTS_CLOSED_CLEANUP, "RESULTS_CLOSED_CLEANUP이 아닙니다.");

  const cleanup = await harness.timerSystem.runCleanupToCompletion({ transitionToken });
  assert(cleanup.completion.ok, `cleanup 완료 실패: ${cleanup.completion.code}`);
  const after = harness.store.getSnapshot();
  assert(after.service.guests.length === 0, `guest가 남아 있습니다: ${after.service.guests.length}`);
  assert(after.service.pendingSeatQueue.length === 0, `pendingSeatQueue가 남아 있습니다: ${after.service.pendingSeatQueue.length}`);
  assert(after.runtimePhase === RUNTIME_PHASE.SETTLEMENT, "Settlement에 도달하지 못했습니다.");
  assert(after.service.terminationRecords.length >= 3, `termination record가 부족합니다: ${after.service.terminationRecords.length}`);
  return { steps: cleanup.steps.map((s) => s.step), terminationRecords: after.service.terminationRecords.length };
}

export async function runGuestOutcomesProbe({ recipes, facilities, balance, guestArchetypes, map }) {
  const results = [];
  const base = { recipes, facilities, balance, guestArchetypes, map };
  const firstSeatId = map.navigation.seatPoints.slice().sort((a, b) => (a.seatId < b.seatId ? -1 : 1))[0].seatId;

  results.push(await runCase(
    "reaction-boundary-479-vs-480ms",
    "elapsed<480ms에는 exit path를 만들지 않고 정확히 480ms 경계에서 MOVING_TO_EXIT로 전이한다",
    "design 10.3, Requirement 34 AC7",
    () => reactionBoundary479Vs480(createHarness(base)),
  ));

  results.push(await runCase(
    "stockout-reaction-to-exit",
    "stockout guest가 MEAL_REACTION→MOVING_TO_EXIT→EXITED를 거치며 cash/slot을 그대로 두고 unmetDemand만 1 늘린다",
    "Requirement 10 AC6, Requirement 34 AC9",
    () => stockoutReactionToExit(createHarness(base)),
  ));

  results.push(await runCase(
    "timeout-reaction-releases-slot-and-exits",
    "timeout은 slot을 반환하고 480ms reaction 뒤 guest를 퇴장시키며 cash/inventory/reputation을 직접 바꾸지 않는다",
    "Task 31 timeout outcome, Requirement 34 AC9",
    () => timeoutReactionReleasesSlotAndExits(createHarness(base)),
  ));

  results.push(await runCase(
    "seeded-sale-reaction-preserves-accounting",
    "SUCCESS reaction 뒤 exit 과정이 economy/sales를 전혀 바꾸지 않는다",
    "Requirement 34 AC9, design 10.3",
    () => seededSaleReactionPreservesAccounting(createHarness(base)),
  ));

  results.push(await runCase(
    "pre-order-path-fault-tombstones-without-side-effects",
    "arrival(Spawn→Seat) path fault는 entity 없이 tombstone만 남기고 cash/inventory/reputation을 보존한다",
    "design 10.4, Requirement 34 AC10",
    () => preOrderPathFaultTombstones(createHarness({ ...base, blockSeatId: firstSeatId })),
  ));

  results.push(await runCase(
    "post-sale-path-fault-preserves-sale",
    "exit(Seat→Exit) path fault는 sale/회계를 보존하고 guest만 원자 종료한다",
    "design 10.4, Requirement 34 AC11",
    () => postSalePathFaultPreservesSale(createHarness({ ...base, blockExit: true })),
  ));

  results.push(await runCase(
    "active-order-fault-injection-releases-slot",
    "ACTIVE order 상태에서 fault-injection하면 order를 TECHNICAL_CANCELLED, slot을 AVAILABLE로 되돌리고 cash는 보존한다",
    "design 10.4(ACTIVE order tier), Requirement 34 AC10~11",
    () => activeOrderFaultInjectionReleasesSlot(createHarness(base)),
  ));

  results.push(await runCase(
    "timer-zero-cleanup-clears-all-guests",
    "timer-zero cleanup이 pending/moving/ordering guest를 12초 안에 결과 중립으로 모두 치우고 Settlement로 deadlock 없이 전환한다",
    "Requirement 2 AC9~11, Requirement 34 AC13",
    () => timerZeroCleanupClearsAllGuests(createHarness(base)),
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}
