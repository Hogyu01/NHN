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
import { ORDER_GUEST_STATE, registerOrderSystem } from "../domain/orders.js";
import { createRecipeState } from "../domain/recipe.js";
import { createReputationCampaignFields } from "../domain/reputation.js";
import { createSaleSlotsState } from "../domain/sale-slots.js";
import { createServiceTimerState, RUNTIME_PHASE } from "../domain/timer-state.js";
import { seatArrivalStableId, TimerSystem } from "../domain/timer-system.js";
import { computeTravelTimeMs, firstVacantSeatPoint, occupiedSeatIds, registerGuestFlowSystem } from "../world/guest-flow.js";
import { createGuestPassabilityGrid } from "../world/passability-grid.js";

const QA_GENERATION_ID = 30;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function allIngredientIds(recipes) {
  return [...new Set(recipes.flatMap((recipe) =>
    recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))].sort();
}

function createLots(recipes, quantity = 80) {
  return allIngredientIds(recipes).map((ingredientId, index) => ({
    lotId: `qa.guest-flow.lot.${String(index).padStart(3, "0")}`,
    ingredientId,
    quantity,
    quality: 70,
    bookCostG: quantity * 2,
    acquiredDay: 1,
  }));
}

function createHarness({ recipes, facilities, balance, guestArchetypes, map, seed = 0x30 }) {
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
  const guestFlowSystem = registerGuestFlowSystem(bus, {
    seatPoints: map.navigation.seatPoints,
    spawnPoint: map.navigation.spawnPoint,
    guestPassabilityGrid: createGuestPassabilityGrid(map),
  });
  const scheduler = new Scheduler();
  const timerSystem = new TimerSystem({ store, commandBus: bus, scheduler, dayLoopController, guestFlowSystem });
  return { store, bus, menuSystem, dayLoopController, orderSystem, guestFlowSystem, scheduler, timerSystem, map };
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
    recipeId: recipe.recipeId, enabled: true, priceG: recipe.basePriceG, plannedQuantity: 1,
  }));
  assert(edited.ok, `menu edit 실패: ${edited.code}`);
  const confirmed = await harness.menuSystem.confirmPlan(commandInput(harness, `confirm:${harness.store.revision}`, { day: 1 }));
  assert(confirmed.ok, `menu confirm 실패: ${confirmed.code}`);
  const started = await harness.dayLoopController.confirmServiceStart(commandInput(harness, `start:${harness.store.revision}`, { day: 1 }));
  assert(started.ok, `service start 실패: ${started.code}`);
  const durationMs = harness.store.getSnapshot().service.durationMs;
  const transitionToken = harness.store.getSnapshot().service.settlementTransitionToken;
  harness.timerSystem.armServiceTimer({ serviceToken: transitionToken, durationMs });
  harness.timerSystem.armGuestArrivals({ plans: harness.store.getSnapshot().service.plans });
  return { durationMs, transitionToken };
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

async function firstArrivalTravelsAndSeats(harness) {
  await startService(harness);
  const plans = harness.store.getSnapshot().service.plans;
  const first = [...plans].sort((a, b) => a.arrivalAtMs - b.arrivalAtMs)[0];
  const arrivalTick = await harness.timerSystem.tick(first.arrivalAtMs);
  assert(arrivalTick.dispatched.length >= 1, "arrival dispatch가 없습니다.");
  const moving = harness.store.getSnapshot().service.guests.find((g) => g.guestId === first.guestId);
  assert(moving, "guest entity가 생성되지 않았습니다.");
  assert(moving.state === ORDER_GUEST_STATE.MOVING_TO_SEAT, `MOVING_TO_SEAT가 아닙니다: ${moving.state}`);
  const seatArrivalItem = harness.scheduler.snapshot().queue.find(
    (item) => item.stableId === seatArrivalStableId(first.guestId),
  );
  assert(seatArrivalItem, "seat-arrival이 예약되지 않았습니다.");
  const seatTick = await harness.timerSystem.tick(seatArrivalItem.simulationTimeMs);
  assert(seatTick.dispatched.some((d) => d.item.stableId === seatArrivalStableId(first.guestId) && d.result.ok),
    "seat-arrival dispatch가 실패했습니다.");
  const seated = harness.store.getSnapshot().service.guests.find((g) => g.guestId === first.guestId);
  assert(seated.state === ORDER_GUEST_STATE.SEATED, `SEATED가 아닙니다: ${seated.state}`);
  assert(typeof seated.seatId === "string" && seated.seatId.length > 0, "seatId가 없습니다.");
  return { guestId: first.guestId, seatId: seated.seatId };
}

async function realSeatedGuestCanOrder(harness) {
  const { guestId } = await firstArrivalTravelsAndSeats(harness);
  const created = await harness.orderSystem.createOrder(commandInput(harness, `order:${harness.store.revision}`, { guestId }));
  assert(created.ok, `SEATED 손님이 실제 order.create를 통과하지 못했습니다: ${created.code}`);
  return { guestId };
}

async function overflowGoesToPendingQueue(harness) {
  await startService(harness);
  const seatCount = harness.map.navigation.seatPoints.length;
  const plans = [...harness.store.getSnapshot().service.plans].sort((a, b) => a.arrivalAtMs - b.arrivalAtMs);
  assert(plans.length >= 1, "plan이 없습니다.");
  // 실제 plan 수는 4..12명이라 좌석(12)을 넘기지 못할 수 있으니, 남은 좌석을 QA로 직접 채운다.
  const snapshot = harness.store.getSnapshot();
  const syntheticGuests = Array.from({ length: seatCount }, (_unused, index) => ({
    guestId: `qa.guest-flow.synthetic.${index}`,
    entityId: `qa.guest-flow.synthetic-entity.${index}`,
    state: ORDER_GUEST_STATE.SEATED,
    seatId: harness.map.navigation.seatPoints[index].seatId,
    reaction: null,
  }));
  harness.store.commit({
    ...snapshot,
    service: { ...snapshot.service, guests: syntheticGuests },
  }, { commandId: `qa:fill-seats:${harness.store.revision}`, expectedRevision: harness.store.revision });
  assert(occupiedSeatIds(harness.store.getSnapshot().service.guests).size === seatCount, "좌석이 다 안 찼습니다.");

  const first = plans[0];
  const arrivalTick = await harness.timerSystem.tick(first.arrivalAtMs);
  const dispatch = arrivalTick.dispatched.find((d) => d.item.stableId.includes(first.guestId));
  assert(dispatch && dispatch.result.ok, `arrival dispatch 실패: ${dispatch?.result.code}`);
  const after = harness.store.getSnapshot().service;
  assert(!after.guests.some((g) => g.guestId === first.guestId), "좌석이 없는데 guest entity가 생성됐습니다.");
  assert(after.pendingSeatQueue.includes(first.guestId), "pendingSeatQueue에 들어가지 않았습니다.");
  const firstSeatId = [...harness.map.navigation.seatPoints]
    .sort((a, b) => (a.seatId < b.seatId ? -1 : 1))[0].seatId;
  const queuedSnapshot = harness.store.getSnapshot();
  harness.store.commit({
    ...queuedSnapshot,
    service: {
      ...queuedSnapshot.service,
      guests: queuedSnapshot.service.guests.filter((guest) => guest.seatId !== firstSeatId),
    },
  }, { commandId: `qa:free-seat:${harness.store.revision}`, expectedRevision: harness.store.revision });
  const promoted = await harness.guestFlowSystem.processArrival(commandInput(
    harness,
    `promote:${harness.store.revision}`,
    { guestId: first.guestId, promotePending: true },
  ));
  assert(promoted.ok, `pending promotion 실패: ${promoted.code}`);
  const promotedService = harness.store.getSnapshot().service;
  assert(!promotedService.pendingSeatQueue.includes(first.guestId), "promotion 뒤 pending queue에 남았습니다.");
  assert(promotedService.guests.some((guest) => guest.guestId === first.guestId && guest.seatId === firstSeatId),
    "vacant seat가 생긴 뒤 대기 손님이 승격되지 않았습니다.");
  return { pendingBeforePromotion: after.pendingSeatQueue, promotedSeatId: firstSeatId };
}

async function twelveSimultaneousArrivalsUseStableUniqueSeats(harness) {
  await startService(harness);
  const before = harness.store.getSnapshot();
  harness.timerSystem.disarmGuestArrivals({ plans: before.service.plans });
  const template = before.service.plans[0];
  const plans = Array.from({ length: 12 }, (_unused, index) => ({
    ...template,
    guestId: `qa.simultaneous.guest.${String(index).padStart(2, "0")}`,
    entityId: `qa.simultaneous.entity.${String(index).padStart(2, "0")}`,
    planSequence: index,
    arrivalAtMs: 0,
  }));
  harness.store.commit({
    ...before,
    service: { ...before.service, plans },
  }, { commandId: `qa:twelve-plans:${harness.store.revision}`, expectedRevision: harness.store.revision });
  harness.timerSystem.armGuestArrivals({ plans });

  const tick = await harness.timerSystem.tick(0);
  const arrivals = tick.dispatched.filter((entry) => entry.item.stableId.startsWith("guest-arrival:"));
  assert(arrivals.length === 12 && arrivals.every((entry) => entry.result.ok), "12명 동시 arrival 중 실패가 있습니다.");
  const guests = harness.store.getSnapshot().service.guests;
  const expectedSeats = [...harness.map.navigation.seatPoints]
    .sort((a, b) => (a.seatId < b.seatId ? -1 : 1))
    .map((seat) => seat.seatId);
  assert(guests.length === 12, `guest entity 수가 다릅니다: ${guests.length}`);
  assert(new Set(guests.map((guest) => guest.seatId)).size === 12, "동시 도착 손님이 같은 좌석을 점유했습니다.");
  assert(JSON.stringify(guests.map((guest) => guest.seatId)) === JSON.stringify(expectedSeats),
    "동시 도착의 Seat_ID ascending 배정이 다릅니다.");
  return { guestCount: guests.length, seatIds: guests.map((guest) => guest.seatId) };
}

export async function runGuestFlowProbe({ recipes, facilities, balance, guestArchetypes, map }) {
  const results = [];
  const base = { recipes, facilities, balance, guestArchetypes, map };

  results.push(await runCase(
    "first-arrival-travels-and-seats",
    "예약된 도착이 오면 vacant seat로 경로가 계산되고 travelTimeMs 뒤 정확히 SEATED로 전이한다",
    "Requirement 10.1~10.2, 2 AC9~10",
    () => firstArrivalTravelsAndSeats(createHarness(base)),
  ));

  results.push(await runCase(
    "real-seated-guest-can-order",
    "GuestFlow로 실제 SEATED된 손님은 QA shortcut 없이 order.create를 통과한다",
    "Requirement 10.5",
    () => realSeatedGuestCanOrder(createHarness(base)),
  ));

  results.push(await runCase(
    "overflow-goes-to-pending-queue",
    "vacant seat가 없으면 pendingSeatQueue에 넣고 좌석이 비면 첫 대기 손님을 승격한다",
    "Requirement 10 AC1, design 10.1",
    () => overflowGoesToPendingQueue(createHarness(base)),
  ));

  results.push(await runCase(
    "twelve-simultaneous-arrivals-stable-seat-order",
    "같은 timestamp에 도착한 12명이 plan 순서대로 서로 다른 Seat_ID ascending 좌석을 점유한다",
    "Task 30 simultaneous arrival/seat ownership",
    () => twelveSimultaneousArrivalsUseStableUniqueSeats(createHarness(base)),
  ));

  results.push(await runCase(
    "travel-time-matches-1920-milli-px-per-tick",
    "computeTravelTimeMs가 20ms/1,920milli-px 규칙과 정확히 일치한다",
    "design 10.2",
    () => {
      const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
      const travelTimeMs = computeTravelTimeMs(path, 32);
      // 2 tile * 32px * 1000 = 64,000 milli-px; 64000/1920 = 33.33 -> 34 steps * 20ms = 680ms
      assert(travelTimeMs === 680, `travelTimeMs가 다릅니다: ${travelTimeMs}`);
      return { travelTimeMs };
    },
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}
