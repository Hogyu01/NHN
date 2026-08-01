import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { cloneValue, freezeDeep } from "../core/result.js";
import { GameStore } from "../core/store.js";
import {
  registerDirectServiceSystem,
  validateDirectServiceState,
} from "../domain/direct-service.js";
import { createEconomyState } from "../domain/economy.js";
import { createEventState } from "../domain/events.js";
import { createFacilityState } from "../domain/facility.js";
import {
  createInventoryAccountingState,
  reconcileInventoryAccounting,
} from "../domain/inventory-accounting.js";
import {
  COMPLETED_DISH_STATE,
  createInventoryState,
} from "../domain/inventory.js";
import { createMenuState, validateMenuPlanReconciliation } from "../domain/menu.js";
import {
  ACTIVE_ORDER_STATE,
  ORDER_GUEST_STATE,
  ORDER_REACTION_KIND,
  registerOrderSystem,
} from "../domain/orders.js";
import { createRecipeState } from "../domain/recipe.js";
import { createReputationCampaignFields } from "../domain/reputation.js";
import { planHardReservations } from "../domain/reservation-planner.js";
import { createSaleSlotsState, SALE_SLOT_STATE } from "../domain/sale-slots.js";
import { createSalesState } from "../domain/sales.js";
import {
  completeTimingCook,
  COOK_JUDGMENT,
  COOK_TRIGGER,
  createTimingCook,
  judgeTimingCook,
  TIMING_COOK_STATE,
} from "../domain/timing-cook.js";
import {
  closeServiceResultsState,
  createServiceTimerState,
  RUNTIME_PHASE,
  SERVICE_END_REASON,
  SERVICE_LIFECYCLE,
} from "../domain/timer-state.js";
import { createProgressionState, createUnlockCatalog } from "../domain/unlocks.js";

const QA_GENERATION_ID = 22;
const QA_DAY = 1;
const PROPERTY_MINIMUM_SAMPLES = 100;
const PROPERTY_SAMPLE_COUNT = 128;

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

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function startingDefinitions(recipes) {
  return recipes.definitions.filter((recipe) => recipe.unlock.type === "STARTING");
}

function buildPlans(primaryRecipeId, alternateRecipeId) {
  return Array.from({ length: 4 }, (_, index) => ({
    guestId: `qa.direct.guest.${index}`,
    entityId: `qa.direct.entity.${index}`,
    archetypeId: `qa.direct.archetype.${index}`,
    planSequence: index,
    arrivalAtMs: index * 1_000,
    recipePreference: index % 2 === 0
      ? [primaryRecipeId, alternateRecipeId]
      : [alternateRecipeId, primaryRecipeId],
  }));
}

function lotFor(ingredientId, suffix, quantity, unitCostG, acquiredDay, quality) {
  return {
    lotId: `qa.direct.lot.${ingredientId}.${suffix}`,
    ingredientId,
    quantity,
    quality,
    bookCostG: quantity * unitCostG,
    acquiredDay,
  };
}

function createRootFixture({
  canonicalRecipes,
  canonicalFacilities,
  balance,
  sourcePatienceMs = 30_000,
  secondPatienceMs = 30_000,
  alternatePatienceMs = 30_000,
  shortage = false,
  mixedAllocation = false,
  seed = 0x22d1ce,
} = {}) {
  const campaignId = createCampaignId(seed, 0);
  const ingredientIds = [...new Set(canonicalRecipes.flatMap((recipe) =>
    recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))];
  const recipes = createRecipeState({ recipes: canonicalRecipes, ingredientIds });
  const [primaryRecipe, alternateRecipe] = startingDefinitions(recipes);
  assert(primaryRecipe && alternateRecipe, "Task 22 QA에는 시작 Recipe 두 개가 필요합니다.");

  const defaultMenu = createMenuState({ day: QA_DAY, recipes });
  const entries = defaultMenu.draftEntries.map((entry) => {
    const definition = recipes.definitions.find((recipe) => recipe.recipeId === entry.recipeId);
    const plannedQuantity = entry.recipeId === primaryRecipe.recipeId
      ? 2
      : entry.recipeId === alternateRecipe.recipeId
        ? 1
        : 0;
    return {
      ...entry,
      enabled: plannedQuantity > 0,
      priceG: definition.basePriceG,
      plannedQuantity,
    };
  });
  const planId = "qa.direct.menu-plan";
  const menu = createMenuState({
    day: QA_DAY,
    recipes,
    draftEntries: entries,
    confirmedEntries: entries,
    activePlanId: planId,
    planRevision: 1,
    locked: true,
    cleanupComplete: false,
  });

  const aliases = {
    primaryRecipeId: primaryRecipe.recipeId,
    alternateRecipeId: alternateRecipe.recipeId,
    primarySlot0: "qa.direct.slot.primary.0",
    primarySlot1: "qa.direct.slot.primary.1",
    alternateSlot0: "qa.direct.slot.alternate.0",
    primaryOrder0: "qa.direct.order.primary.0",
    primaryOrder1: "qa.direct.order.primary.1",
    alternateOrder0: "qa.direct.order.alternate.0",
  };
  const slots = [
    {
      saleSlotId: aliases.primarySlot0,
      recipeId: aliases.primaryRecipeId,
      ordinal: 0,
      state: SALE_SLOT_STATE.ASSIGNED,
      activeOrderId: aliases.primaryOrder0,
    },
    {
      saleSlotId: aliases.primarySlot1,
      recipeId: aliases.primaryRecipeId,
      ordinal: 1,
      state: SALE_SLOT_STATE.ASSIGNED,
      activeOrderId: aliases.primaryOrder1,
    },
    {
      saleSlotId: aliases.alternateSlot0,
      recipeId: aliases.alternateRecipeId,
      ordinal: 0,
      state: SALE_SLOT_STATE.ASSIGNED,
      activeOrderId: aliases.alternateOrder0,
    },
  ];
  const saleSlots = createSaleSlotsState({ day: QA_DAY, slots });

  let lots;
  let reservations = [];
  if (shortage) {
    lots = primaryRecipe.ingredientRequirements.map((requirement, index) => lotFor(
      requirement.ingredientId,
      "shortage",
      index === 0 ? Math.max(1, requirement.quantity - 1) : requirement.quantity,
      index + 2,
      1,
      60 + index,
    ));
  } else {
    const usedIngredientIds = [...new Set([
      ...primaryRecipe.ingredientRequirements.map((requirement) => requirement.ingredientId),
      ...alternateRecipe.ingredientRequirements.map((requirement) => requirement.ingredientId),
    ])].sort();
    lots = usedIngredientIds.flatMap((ingredientId, index) => [
      lotFor(ingredientId, "a", 8, index + 2, 1, 60 + index),
      lotFor(ingredientId, "b", 12, index + 3, 2, 75 + index),
    ]);
    const requests = slots.map((slot) => ({
      saleSlotId: slot.saleSlotId,
      recipeId: slot.recipeId,
      requirements: recipes.definitions.find((recipe) => recipe.recipeId === slot.recipeId)
        .ingredientRequirements,
    }));
    const reservationPlan = planHardReservations(createInventoryState({ lots }), {
      reservationPlanId: "qa.direct.reservation-plan",
      requests,
    });
    assert(reservationPlan.ok, `Task 22 reservation fixture 생성 실패: ${reservationPlan.code}`);
    reservations = cloneValue(reservationPlan.plan.reservations);
    if (mixedAllocation) {
      const firstRequirement = primaryRecipe.ingredientRequirements[0];
      const reserved = reservations.find((reservation) =>
        reservation.saleSlotId === aliases.primarySlot0 &&
        reservation.ingredientId === firstRequirement.ingredientId);
      assert(reserved && reserved.quantity >= 1, "mixed allocation용 reservation이 없습니다.");
      if (reserved.quantity === 1) {
        reservations = reservations.filter((reservation) => reservation !== reserved);
      } else {
        reserved.quantity -= 1;
      }
    }
  }
  const inventory = createInventoryState({ lots, reservations });
  const openingInventoryBookCostG = sum(lots.map((lot) => lot.bookCostG));
  const inventoryAccounting = createInventoryAccountingState({ openingInventoryBookCostG });

  const guests = [
    ["qa.direct.guest.0", "qa.direct.entity.0", "qa.direct.seat.0"],
    ["qa.direct.guest.1", "qa.direct.entity.1", "qa.direct.seat.1"],
    ["qa.direct.guest.2", "qa.direct.entity.2", "qa.direct.seat.2"],
  ].map(([guestId, entityId, seatId]) => ({
    guestId,
    entityId,
    seatId,
    state: ORDER_GUEST_STATE.ORDERING,
    reaction: null,
  }));
  const orders = [
    {
      orderId: aliases.primaryOrder0,
      guestId: guests[0].guestId,
      recipeId: aliases.primaryRecipeId,
      saleSlotId: aliases.primarySlot0,
      createdAtMs: 100,
      patienceRemainingMs: sourcePatienceMs,
      state: ACTIVE_ORDER_STATE.ACTIVE,
    },
    {
      orderId: aliases.primaryOrder1,
      guestId: guests[1].guestId,
      recipeId: aliases.primaryRecipeId,
      saleSlotId: aliases.primarySlot1,
      createdAtMs: 200,
      patienceRemainingMs: secondPatienceMs,
      state: ACTIVE_ORDER_STATE.ACTIVE,
    },
    {
      orderId: aliases.alternateOrder0,
      guestId: guests[2].guestId,
      recipeId: aliases.alternateRecipeId,
      saleSlotId: aliases.alternateSlot0,
      createdAtMs: 300,
      patienceRemainingMs: alternatePatienceMs,
      state: ACTIVE_ORDER_STATE.ACTIVE,
    },
  ];
  const service = createServiceTimerState({
    durationMs: balance.service.durationMs,
    cleanupOvertimeMs: balance.service.cleanupOvertimeMs,
    lifecycle: SERVICE_LIFECYCLE.RUNNING,
    remainingMs: balance.service.durationMs,
    plans: buildPlans(aliases.primaryRecipeId, aliases.alternateRecipeId),
    guests,
    orders,
    startedDay: QA_DAY,
    startedPlanId: planId,
    startedPlanRevision: 1,
    settlementTransitionToken: "qa.direct.settlement-token",
  });
  const facilities = createFacilityState({ facilities: canonicalFacilities });
  const unlockCatalog = createUnlockCatalog({
    recipes: canonicalRecipes,
    facilities: canonicalFacilities,
  });
  const campaign = {
    campaignId,
    masterSeed: seed,
    day: QA_DAY,
    consecutiveArrearsCount: 0,
    ...createReputationCampaignFields(30),
  };
  const root = {
    formatVersion: 1,
    revision: 0,
    runtimePhase: RUNTIME_PHASE.SERVICE,
    checkpointPhase: null,
    generationId: QA_GENERATION_ID,
    campaign,
    progression: createProgressionState({ unlockCatalog }),
    events: createEventState(),
    facilities,
    economy: createEconomyState({ cashG: 300, debtG: 500 }),
    inventory,
    inventoryAccounting,
    recipes,
    menu,
    saleSlots,
    sales: createSalesState({ day: QA_DAY }),
    service,
    idCounters: createIdServiceState({
      campaignId,
      day: QA_DAY,
      generationId: QA_GENERATION_ID,
    }),
    untouched: { marker: "task-22-structural-sharing" },
  };
  return { root, aliases, primaryRecipe, alternateRecipe };
}

function createHarness(configuration, fixtureOptions = {}, snapshot = null) {
  const fixture = snapshot === null
    ? createRootFixture({ ...configuration, ...fixtureOptions })
    : { root: cloneValue(snapshot), aliases: fixtureOptions.aliases };
  const store = new GameStore(fixture.root);
  const bus = new CommandBus({ store });
  const directService = registerDirectServiceSystem(bus, {
    wrongServePenaltyMs: configuration.balance.service.wrongServePenaltyMs,
    reactionDurationMs: configuration.balance.service.reactionFrameMs *
      configuration.balance.service.reactionFrameCount,
  });
  const orderSystem = registerOrderSystem(bus, {
    reactionDurationMs: configuration.balance.service.reactionFrameMs *
      configuration.balance.service.reactionFrameCount,
  });
  return {
    store,
    bus,
    directService,
    orderSystem,
    aliases: fixture.aliases,
    primaryRecipe: fixture.primaryRecipe,
    alternateRecipe: fixture.alternateRecipe,
  };
}

function commandInput(harness, commandId, payload, issuedAtSimulationMs) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs,
    payload,
  };
}

async function startPrimaryCook(harness, namespace, trigger = COOK_TRIGGER.PLAYER) {
  const result = await harness.directService.startCook(commandInput(
    harness,
    `qa.direct.${namespace}.start`,
    {
      recipeId: harness.aliases.primaryRecipeId,
      saleSlotId: harness.aliases.primarySlot0,
      sourceOrderId: harness.aliases.primaryOrder0,
      trigger,
    },
    1_000,
  ));
  assert(result.ok, `${namespace}: 조리 시작 실패: ${result.code}`);
  return harness.store.getSnapshot().service.timingCook;
}

function completionTime(timingCook, judgment) {
  if (judgment === COOK_JUDGMENT.SUCCESS) return timingCook.targetAtMs;
  if (judgment === COOK_JUDGMENT.NORMAL) {
    return timingCook.targetAtMs + timingCook.successWindowMs + 1;
  }
  return timingCook.targetAtMs + timingCook.normalWindowMs + 1;
}

async function completePrimaryCook(harness, namespace, judgment, { noInput = false } = {}) {
  const timingCook = harness.store.getSnapshot().service.timingCook;
  const time = noInput ? timingCook.failureAtMs : completionTime(timingCook, judgment);
  const result = await harness.directService.completeCook(commandInput(
    harness,
    `qa.direct.${namespace}.complete`,
    { inputAtMs: noInput ? null : time },
    time,
  ));
  assert(result.ok, `${namespace}: 조리 완료 실패: ${result.code}`);
  return harness.store.getSnapshot();
}

async function assertRejectedUnchanged(harness, execute, expectedCode, label) {
  const before = harness.store.getSnapshot();
  const beforeValue = cloneValue(before);
  const revision = harness.store.revision;
  const commitCount = harness.store.commitCount;
  const metadata = harness.store.getCommandMetadata();
  const signals = harness.bus.getSignalSnapshot();
  const result = await execute();
  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), beforeValue), `${label}: state가 변경됐습니다.`);
  assert(harness.store.revision === revision, `${label}: revision이 변경됐습니다.`);
  assert(harness.store.commitCount === commitCount, `${label}: commit이 발생했습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadata), `${label}: command metadata가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signals), `${label}: event/effect journal이 변경됐습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 실패 signal이 발행됐습니다.`);
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

/** PLAYER/STAFF/DOMAIN은 동일 allocation과 판정을 거친다.
 * **Validates: Requirements 11.1, 11.3, 11.4, 12.6, 12.7** */
async function triggerOriginEquivalence(configuration) {
  const snapshots = [];
  for (const trigger of Object.values(COOK_TRIGGER)) {
    const harness = createHarness(configuration);
    const timingCook = await startPrimaryCook(harness, `origin.${trigger}`, trigger);
    assert(timingCook.trigger === trigger, `${trigger}: origin이 Timing_Cook에 보존되지 않았습니다.`);
    const completed = await completePrimaryCook(harness, `origin.${trigger}`, COOK_JUDGMENT.SUCCESS);
    snapshots.push({
      trigger,
      timingCook: { ...completed.service.timingCook, trigger: "NORMALIZED" },
      inventory: completed.inventory,
      accounting: completed.inventoryAccounting,
      carriedDishId: completed.service.carriedDishId,
    });
  }
  for (let index = 1; index < snapshots.length; index += 1) {
    assert(equivalent(snapshots[0].timingCook, snapshots[index].timingCook),
      `${snapshots[index].trigger}: Timing_Cook 결과가 PLAYER와 다릅니다.`);
    assert(equivalent(snapshots[0].inventory, snapshots[index].inventory),
      `${snapshots[index].trigger}: inventory 결과가 PLAYER와 다릅니다.`);
    assert(equivalent(snapshots[0].accounting, snapshots[index].accounting),
      `${snapshots[index].trigger}: accounting 결과가 PLAYER와 다릅니다.`);
  }
  return { origins: snapshots.map((snapshot) => snapshot.trigger), equivalentResults: true };
}

/** reservation source를 먼저 소비하고 부족분은 `(acquiredDay, lotId)` FIFO로 채운다.
 * **Validates: Requirements 8.7, 8.8, 9.8, 11.6** */
async function reservationFirstFifoAndShortage(configuration) {
  const mixed = createHarness(configuration, { mixedAllocation: true });
  const firstRequirement = mixed.primaryRecipe.ingredientRequirements[0];
  const timingCook = await startPrimaryCook(mixed, "allocation.mixed");
  const lines = timingCook.escrow.filter((line) => line.ingredientId === firstRequirement.ingredientId);
  assert(lines.length >= 2, "mixed allocation이 reservation+unreserved line을 만들지 않았습니다.");
  assert(lines[0].reservationId !== null && lines[0].saleSlotId === mixed.aliases.primarySlot0,
    "reservation source가 먼저 소비되지 않았습니다.");
  assert(lines.some((line) => line.reservationId === null), "unreserved FIFO 보충 line이 없습니다.");
  const unreserved = lines.find((line) => line.reservationId === null);
  const fifoLotId = mixed.store.getSnapshot().inventoryAccounting.costMovements[0].sourceReferences
    ?.find?.((reference) => reference.ingredientId === firstRequirement.ingredientId)?.lotId;
  assert(unreserved.lotId.endsWith(".a"), "unreserved allocation이 acquiredDay/lotId FIFO 첫 lot을 사용하지 않았습니다.");
  assert(fifoLotId === undefined || fifoLotId === unreserved.lotId,
    "cost movement source와 FIFO line이 불일치합니다.");

  const shortage = createHarness(configuration, { shortage: true });
  await assertRejectedUnchanged(
    shortage,
    () => shortage.directService.startCook(commandInput(
      shortage,
      "qa.direct.allocation.shortage",
      {
        recipeId: shortage.aliases.primaryRecipeId,
        saleSlotId: shortage.aliases.primarySlot0,
        sourceOrderId: shortage.aliases.primaryOrder0,
        trigger: COOK_TRIGGER.PLAYER,
      },
      1_000,
    )),
    "INVENTORY_SHORTAGE",
    "재료 부족 조리",
  );
  return { reservationFirst: true, fifoFallback: true, shortagePartialMutations: 0 };
}

/** SUCCESS/NORMAL/FAILURE 및 무입력 deadline을 실제 completion command로 검증한다.
 * **Validates: Requirements 11.3, 11.5, 11.7, 11.8** */
async function timingCookOutcomeExamples(configuration) {
  const outcomes = {};
  for (const judgment of [COOK_JUDGMENT.SUCCESS, COOK_JUDGMENT.NORMAL, COOK_JUDGMENT.FAILURE]) {
    const harness = createHarness(configuration);
    const started = await startPrimaryCook(harness, `timing.${judgment}`);
    const snapshot = await completePrimaryCook(harness, `timing.${judgment}`, judgment);
    assert(snapshot.service.timingCook.judgment === judgment, `${judgment}: 판정이 다릅니다.`);
    if (judgment === COOK_JUDGMENT.FAILURE) {
      assert(snapshot.service.timingCook.state === TIMING_COOK_STATE.FAILED_WASTE,
        "FAILURE가 FAILED_WASTE가 아닙니다.");
      assert(snapshot.service.carriedDishId === null && snapshot.inventory.completedDishes.length === 0,
        "FAILURE가 carried dish를 생성했습니다.");
      assert(snapshot.inventoryAccounting.cookingWasteExpenseG === started.totalBookCostG,
        "FAILURE Waste가 CookEscrow Book_Cost와 다릅니다.");
      await assertRejectedUnchanged(
        harness,
        () => harness.directService.completeCook(commandInput(
          harness,
          "qa.direct.timing.failure.duplicate",
          { inputAtMs: snapshot.service.timingCook.failureAtMs },
          snapshot.service.timingCook.failureAtMs,
        )),
        "TIMING_COOK_NOT_FOUND",
        "FAILURE Waste 중복 완료",
      );
    } else {
      const dish = snapshot.inventory.completedDishes.find(
        (candidate) => candidate.dishId === snapshot.service.carriedDishId,
      );
      assert(dish?.state === COMPLETED_DISH_STATE.CARRIED, `${judgment}: carried dish가 없습니다.`);
      const expectedQuality = judgment === COOK_JUDGMENT.SUCCESS
        ? Math.min(100, started.quality + 10)
        : started.quality;
      assert(dish.quality === expectedQuality, `${judgment}: Quality 결과가 다릅니다.`);
    }
    assert(reconcileInventoryAccounting(snapshot.inventory, snapshot.inventoryAccounting).ok,
      `${judgment}: 재고 대사가 실패했습니다.`);
    outcomes[judgment] = snapshot.service.timingCook.state;
  }

  const noInput = createHarness(configuration);
  const running = await startPrimaryCook(noInput, "timing.no-input");
  await assertRejectedUnchanged(
    noInput,
    () => noInput.directService.completeCook(commandInput(
      noInput,
      "qa.direct.timing.no-input.early",
      { inputAtMs: null },
      running.failureAtMs - 1,
    )),
    "COOK_FAILURE_DEADLINE_NOT_REACHED",
    "무입력 failure deadline 이전 완료",
  );
  const failed = await completePrimaryCook(
    noInput,
    "timing.no-input.deadline",
    COOK_JUDGMENT.FAILURE,
    { noInput: true },
  );
  assert(failed.service.timingCook.judgment === COOK_JUDGMENT.FAILURE,
    "deadline 무입력이 FAILURE가 아닙니다.");
  return { outcomes, noInputDeadline: running.failureAtMs, wasteRecognitions: 2 };
}

/** matching serve는 결과 영향을 한 revision/commit에 함께 반영한다.
 * **Validates: Requirements 5.2, 5.3, 9.9, 9.10, 11.9, 11.10, 11.11, 11.13** */
async function matchingSaleAtomicCommit(configuration) {
  const harness = createHarness(configuration);
  await startPrimaryCook(harness, "sale.atomic");
  await completePrimaryCook(harness, "sale.atomic", COOK_JUDGMENT.SUCCESS);
  const before = harness.store.getSnapshot();
  const beforeRevision = harness.store.revision;
  const beforeCommits = harness.store.commitCount;
  const carried = before.inventory.completedDishes.find(
    (dish) => dish.dishId === before.service.carriedDishId,
  );
  const menuEntry = before.menu.confirmedEntries.find(
    (entry) => entry.recipeId === harness.aliases.primaryRecipeId,
  );
  const result = await harness.directService.serve(commandInput(
    harness,
    "qa.direct.sale.atomic.serve",
    { targetOrderId: harness.aliases.primaryOrder0 },
    5_000,
  ));
  assert(result.ok, `원자 판매 실패: ${result.code}`);
  const after = harness.store.getSnapshot();
  assert(harness.store.revision === beforeRevision + 1 && harness.store.commitCount === beforeCommits + 1,
    "판매가 정확히 한 commit/revision으로 처리되지 않았습니다.");
  const order = after.service.orders.find((candidate) => candidate.orderId === harness.aliases.primaryOrder0);
  const guest = after.service.guests.find((candidate) => candidate.guestId === order.guestId);
  const slot = after.saleSlots.slots.find((candidate) => candidate.saleSlotId === order.saleSlotId);
  const soldDish = after.inventory.completedDishes.find((dish) => dish.dishId === carried.dishId);
  const sale = after.sales.sales[0];
  const ledger = after.economy.ledger.at(-1);
  const cogsMovement = after.inventoryAccounting.costMovements.at(-1);
  assert(order.state === ACTIVE_ORDER_STATE.COMPLETED, "order가 COMPLETED가 아닙니다.");
  assert(guest.state === ORDER_GUEST_STATE.MEAL_REACTION &&
    guest.reaction.kind === ORDER_REACTION_KIND.SUCCESS, "guest 성공 반응이 없습니다.");
  assert(slot.state === SALE_SLOT_STATE.SOLD && slot.activeOrderId === null, "SaleSlot이 SOLD가 아닙니다.");
  assert(soldDish.state === COMPLETED_DISH_STATE.SOLD && soldDish.bookCostG === 0 &&
    soldDish.recognizedBookCostG === carried.bookCostG, "dish COGS 상태가 잘못됐습니다.");
  assert(after.economy.cashG === before.economy.cashG + menuEntry.priceG,
    "판매 Cash inflow가 가격과 다릅니다.");
  assert(after.sales.revenueG === menuEntry.priceG && after.sales.soldQuantity === 1,
    "Revenue/판매 수량 집계가 잘못됐습니다.");
  assert(after.inventoryAccounting.cogsG === before.inventoryAccounting.cogsG + carried.bookCostG,
    "COGS 인식이 dish Book_Cost와 다릅니다.");
  assert(after.campaign.reputation === before.campaign.reputation + 1,
    "판매 reputation Cause가 적용되지 않았습니다.");
  assert(sale.saleId === ledger.transactionId && sale.causeId === ledger.causeId &&
    sale.causeId === cogsMovement.causeId, "sale/ledger/COGS Cause 연결이 끊겼습니다.");
  assert(after.service.carriedDishId === null && after.untouched === before.untouched,
    "판매와 overlay 제거가 동시 처리되지 않았거나 write-set 밖 slice가 교체됐습니다.");
  assert(result.events.length === 1 && result.events[0].payload.saleId === sale.saleId,
    "판매 committed event가 정확히 하나가 아닙니다.");
  assert(reconcileInventoryAccounting(after.inventory, after.inventoryAccounting).ok,
    "판매 뒤 재고 대사가 실패했습니다.");
  await assertRejectedUnchanged(
    harness,
    () => harness.directService.serve(commandInput(
      harness,
      "qa.direct.sale.atomic.duplicate",
      { targetOrderId: harness.aliases.primaryOrder0 },
      5_020,
    )),
    "CARRIED_DISH_NOT_FOUND",
    "판매 결과 중복 적용",
  );
  return {
    commits: 1,
    priceG: sale.priceG,
    cogsG: sale.bookCostG,
    reputationDelta: sale.reputationDelta,
    partialMutationsOnDuplicate: 0,
  };
}

/** mismatch는 patience만 -3000ms하고 dish/economy/reputation을 보존한다.
 * **Validates: Requirements 11.10, 11.11, 11.14** */
async function wrongServeExamples(configuration) {
  const harness = createHarness(configuration);
  await startPrimaryCook(harness, "wrong.preserve");
  await completePrimaryCook(harness, "wrong.preserve", COOK_JUDGMENT.NORMAL);
  const before = harness.store.getSnapshot();
  const result = await harness.directService.serve(commandInput(
    harness,
    "qa.direct.wrong.preserve.serve",
    { targetOrderId: harness.aliases.alternateOrder0 },
    5_000,
  ));
  assert(result.ok && result.events[0].type === "direct-service.wrong-served",
    `오서빙 처리 실패: ${result.code}`);
  const after = harness.store.getSnapshot();
  const beforeOrder = before.service.orders.find((order) => order.orderId === harness.aliases.alternateOrder0);
  const afterOrder = after.service.orders.find((order) => order.orderId === harness.aliases.alternateOrder0);
  assert(afterOrder.patienceRemainingMs === beforeOrder.patienceRemainingMs - 3_000,
    "오서빙 patience가 정확히 3000ms 감소하지 않았습니다.");
  assert(after.service.carriedDishId === before.service.carriedDishId &&
    after.inventory === before.inventory && after.economy === before.economy &&
    after.campaign === before.campaign && after.sales === before.sales &&
    after.inventoryAccounting === before.inventoryAccounting && after.idCounters === before.idCounters,
  "오서빙이 dish/economy/reputation/accounting/ID를 변경했습니다.");

  const timeout = createHarness(configuration, { alternatePatienceMs: 2_500 });
  await startPrimaryCook(timeout, "wrong.timeout");
  await completePrimaryCook(timeout, "wrong.timeout", COOK_JUDGMENT.SUCCESS);
  const timeoutBefore = timeout.store.getSnapshot();
  const timeoutResult = await timeout.directService.serve(commandInput(
    timeout,
    "qa.direct.wrong.timeout.serve",
    { targetOrderId: timeout.aliases.alternateOrder0 },
    5_000,
  ));
  assert(timeoutResult.ok && timeoutResult.events[0].type === "direct-service.wrong-serve-timeout",
    `오서빙 timeout 처리 실패: ${timeoutResult.code}`);
  const timeoutAfter = timeout.store.getSnapshot();
  const timedOutOrder = timeoutAfter.service.orders.find(
    (order) => order.orderId === timeout.aliases.alternateOrder0,
  );
  const releasedSlot = timeoutAfter.saleSlots.slots.find(
    (slot) => slot.saleSlotId === timeout.aliases.alternateSlot0,
  );
  assert(timedOutOrder.state === ACTIVE_ORDER_STATE.TIMED_OUT &&
    timedOutOrder.patienceRemainingMs === -500, "patience<=0 오서빙이 order timeout을 만들지 않았습니다.");
  assert(releasedSlot.state === SALE_SLOT_STATE.AVAILABLE && releasedSlot.activeOrderId === null,
    "오서빙 timeout이 ASSIGNED slot을 반환하지 않았습니다.");
  assert(timeoutAfter.service.carriedDishId === timeoutBefore.service.carriedDishId &&
    timeoutAfter.inventory === timeoutBefore.inventory && timeoutAfter.economy === timeoutBefore.economy &&
    timeoutAfter.campaign === timeoutBefore.campaign,
  "오서빙 timeout이 carried dish 또는 경제/평판을 변경했습니다.");
  return { exactPenaltyMs: 3_000, timeoutAtOrBelowZero: true, dishPreserved: true };
}

/** source order timeout 뒤에도 동일 Recipe의 다른 ACTIVE order에 dish를 판매할 수 있다.
 * **Validates: Requirements 9.8, 9.9, 11.12** */
async function sourceTimeoutDishReuse(configuration) {
  const harness = createHarness(configuration, { sourcePatienceMs: 0 });
  await startPrimaryCook(harness, "reuse");
  const timedOut = await harness.orderSystem.timeoutOrder(commandInput(
    harness,
    "qa.direct.reuse.source-timeout",
    { orderId: harness.aliases.primaryOrder0 },
    1_020,
  ));
  assert(timedOut.ok, `source order timeout 실패: ${timedOut.code}`);
  const afterTimeout = harness.store.getSnapshot();
  assert(afterTimeout.saleSlots.slots.find(
    (slot) => slot.saleSlotId === harness.aliases.primarySlot0,
  ).state === SALE_SLOT_STATE.AVAILABLE, "source timeout slot이 AVAILABLE이 아닙니다.");
  await completePrimaryCook(harness, "reuse", COOK_JUDGMENT.SUCCESS);
  const dishBeforeSale = harness.store.getSnapshot().inventory.completedDishes.find(
    (dish) => dish.dishId === harness.store.getSnapshot().service.carriedDishId,
  );
  assert(dishBeforeSale.createdOrderId === harness.aliases.primaryOrder0,
    "dish가 source order audit reference를 잃었습니다.");
  const sold = await harness.directService.serve(commandInput(
    harness,
    "qa.direct.reuse.serve-other-order",
    { targetOrderId: harness.aliases.primaryOrder1 },
    5_000,
  ));
  assert(sold.ok, `동일 Recipe 다른 order 판매 실패: ${sold.code}`);
  const after = harness.store.getSnapshot();
  const sale = after.sales.sales[0];
  assert(sale.orderId === harness.aliases.primaryOrder1 && sale.dishId === dishBeforeSale.dishId,
    "판매가 target order와 재사용 dish를 연결하지 않았습니다.");
  assert(after.saleSlots.slots.find(
    (slot) => slot.saleSlotId === harness.aliases.primarySlot0,
  ).state === SALE_SLOT_STATE.AVAILABLE, "source slot 상태가 판매로 다시 변경됐습니다.");
  return { sourceOrderId: dishBeforeSale.createdOrderId, targetOrderId: sale.orderId, reused: true };
}

/** 미서빙 dish Waste와 timer-zero rollback은 overlay 및 source line을 같은 commit에서 정리한다.
 * **Validates: Requirements 5.4, 8.7, 8.8, 11.6, 11.7, 11.13** */
async function wasteAndTimerZeroCleanup(configuration) {
  const waste = createHarness(configuration);
  await startPrimaryCook(waste, "waste");
  await completePrimaryCook(waste, "waste", COOK_JUDGMENT.NORMAL);
  const beforeWaste = waste.store.getSnapshot();
  const carried = beforeWaste.inventory.completedDishes.find(
    (dish) => dish.dishId === beforeWaste.service.carriedDishId,
  );
  const wasted = await waste.directService.wasteCarriedDish(commandInput(
    waste,
    "qa.direct.waste.commit",
    { dishId: carried.dishId },
    5_000,
  ));
  assert(wasted.ok, `carried dish Waste 실패: ${wasted.code}`);
  const afterWaste = waste.store.getSnapshot();
  const wasteDish = afterWaste.inventory.completedDishes.find((dish) => dish.dishId === carried.dishId);
  assert(wasteDish.state === COMPLETED_DISH_STATE.WASTED &&
    afterWaste.inventoryAccounting.cookingWasteExpenseG === carried.bookCostG,
  "미서빙 dish Waste 원가 인식이 잘못됐습니다.");
  assert(afterWaste.service.carriedDishId === null &&
    equivalent(afterWaste.service.completedDishes, afterWaste.inventory.completedDishes),
  "Waste와 carried overlay 제거가 동시에 반영되지 않았습니다.");
  await assertRejectedUnchanged(
    waste,
    () => waste.directService.wasteCarriedDish(commandInput(
      waste,
      "qa.direct.waste.duplicate",
      { dishId: carried.dishId },
      5_020,
    )),
    "CARRIED_DISH_NOT_FOUND",
    "carried dish Waste 중복",
  );

  const running = createHarness(configuration, { mixedAllocation: true });
  const exactInventoryBefore = cloneValue(running.store.getSnapshot().inventory);
  await startPrimaryCook(running, "timer-zero");
  const runningSnapshot = running.store.getSnapshot();
  const closed = closeServiceResultsState(runningSnapshot.service, SERVICE_END_REASON.TIMER_ZERO);
  assert(closed.ok, `timer-zero cleanup fixture 생성 실패: ${closed.code}`);
  const cleanupState = cloneValue(runningSnapshot);
  cleanupState.service = closed.state;
  const cleanup = createHarness(
    configuration,
    { aliases: running.aliases },
    cleanupState,
  );
  const cancelled = await cleanup.directService.cancelCookAtZero(commandInput(
    cleanup,
    "qa.direct.timer-zero.cancel",
    {},
    5_000,
  ));
  assert(cancelled.ok, `timer-zero CookEscrow restore 실패: ${cancelled.code}`);
  const afterCancel = cleanup.store.getSnapshot();
  assert(equivalent(afterCancel.inventory, exactInventoryBefore),
    "timer-zero rollback이 lot/reservation/Book_Cost source line을 exact restore하지 않았습니다.");
  assert(afterCancel.service.timingCook.state === TIMING_COOK_STATE.CANCELLED_RESTORED,
    "timer-zero Timing_Cook terminal state가 잘못됐습니다.");
  assert(reconcileInventoryAccounting(afterCancel.inventory, afterCancel.inventoryAccounting).ok,
    "timer-zero rollback 뒤 재고 대사가 실패했습니다.");
  return { wasteRecognitions: 1, duplicateWasteMutations: 0, exactTimerZeroRestore: true };
}

/**
 * Property 14: Timing_Cook 판정 구간과 terminal destination은 모든 생성 입력에서 완전·배타적이다.
 * Feature: dungeon-restaurant-management-mvp, Property 14: DirectService timing and destination invariants
 * **Validates: Requirements 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 12.6**
 */
function directServiceProperty14(configuration) {
  const recipes = createRecipeState({
    recipes: configuration.canonicalRecipes,
    ingredientIds: [...new Set(configuration.canonicalRecipes.flatMap((recipe) =>
      recipe.ingredientRequirements.map((requirement) => requirement.ingredientId)))]
  });
  const [recipe] = startingDefinitions(recipes);
  const counts = { SUCCESS: 0, NORMAL: 0, FAILURE: 0, NO_INPUT_FAILURE: 0 };
  for (let sample = 0; sample < PROPERTY_SAMPLE_COUNT; sample += 1) {
    const quantity = sample % 4 + 1;
    const bookCostG = sample * 7 % 23;
    const quality = sample * 13 % 101;
    const startedAtMs = sample * 100;
    const timingWindowBonusMs = sample % 11;
    const timingCook = createTimingCook({
      cookId: `qa.direct.property.cook.${sample}`,
      escrowId: `qa.direct.property.escrow.${sample}`,
      sourceOrderId: sample % 2 === 0 ? `qa.direct.property.order.${sample}` : null,
      sourceSaleSlotId: `qa.direct.property.slot.${sample}`,
      recipeId: recipe.recipeId,
      causeId: `qa.direct.property.cause.${sample}`,
      trigger: Object.values(COOK_TRIGGER)[sample % Object.values(COOK_TRIGGER).length],
      escrow: [{
        lotId: `qa.direct.property.lot.${sample}`,
        reservationId: null,
        saleSlotId: null,
        ingredientId: recipe.ingredientRequirements[0].ingredientId,
        quantity,
        bookCostG,
        quality,
      }],
      totalBookCostG: bookCostG,
      quality,
      startedAtMs,
      timing: recipe.timing,
      timingWindowBonusMs,
    });
    const noInput = sample % 8 === 0;
    let inputAtMs;
    let observedAtMs;
    let expected;
    if (noInput) {
      inputAtMs = null;
      observedAtMs = timingCook.failureAtMs;
      expected = COOK_JUDGMENT.FAILURE;
      counts.NO_INPUT_FAILURE += 1;
    } else {
      const span = timingCook.normalWindowMs + 80;
      const signedError = sample * 73 % (span * 2 + 1) - span;
      inputAtMs = timingCook.targetAtMs + signedError;
      observedAtMs = inputAtMs;
      const absoluteError = Math.abs(signedError);
      expected = absoluteError <= timingCook.successWindowMs
        ? COOK_JUDGMENT.SUCCESS
        : absoluteError <= timingCook.normalWindowMs
          ? COOK_JUDGMENT.NORMAL
          : COOK_JUDGMENT.FAILURE;
    }
    const judged = judgeTimingCook(timingCook, { inputAtMs, observedAtMs });
    assert(judged.ok, `Property 14 sample ${sample} 판정 실패: ${judged.code}`);
    assert(judged.plan.judgment === expected,
      `Property 14 sample ${sample} 구간 판정 불일치: ${judged.plan.judgment}/${expected}`);
    counts[expected] += 1;
    const resultDishId = expected === COOK_JUDGMENT.FAILURE
      ? null
      : `qa.direct.property.dish.${sample}`;
    const completed = completeTimingCook(timingCook, {
      inputAtMs,
      observedAtMs,
      resultDishId,
    });
    assert(completed.ok, `Property 14 sample ${sample} terminal 전이 실패: ${completed.code}`);
    const terminal = completed.plan.timingCook;
    if (expected === COOK_JUDGMENT.FAILURE) {
      assert(terminal.state === TIMING_COOK_STATE.FAILED_WASTE &&
        terminal.resultDishId === null && terminal.outputQuality === null,
      `Property 14 sample ${sample} FAILURE destination이 배타적이지 않습니다.`);
    } else {
      assert(terminal.state === TIMING_COOK_STATE.COMPLETED_DISH &&
        terminal.resultDishId === resultDishId && Number.isSafeInteger(terminal.outputQuality),
      `Property 14 sample ${sample} dish destination이 배타적이지 않습니다.`);
    }
  }
  assert(PROPERTY_SAMPLE_COUNT >= PROPERTY_MINIMUM_SAMPLES,
    `Property 14 sample 수가 ${PROPERTY_SAMPLE_COUNT}로 100 미만입니다.`);
  assert(counts.SUCCESS > 0 && counts.NORMAL > 0 && counts.FAILURE > 0 && counts.NO_INPUT_FAILURE > 0,
    "Property 14 생성기가 모든 판정/destination을 탐색하지 못했습니다.");
  return { samples: PROPERTY_SAMPLE_COUNT, counts };
}

export async function runDirectServiceProbe({ recipes, facilities, balance }) {
  const configuration = {
    canonicalRecipes: recipes,
    canonicalFacilities: facilities,
    balance,
  };
  const results = [];
  const definitions = [
    [
      "trigger-origin-equivalence",
      "PLAYER/STAFF/DOMAIN이 같은 production cooking command와 결과를 사용한다",
      "Requirements 11.1, 11.3, 11.4, 12.6, 12.7",
      () => triggerOriginEquivalence(configuration),
    ],
    [
      "reservation-first-fifo-shortage",
      "reservation-first+unreserved FIFO allocation과 shortage full rejection",
      "Requirements 8.7, 8.8, 9.8, 11.6",
      () => reservationFirstFifoAndShortage(configuration),
    ],
    [
      "timing-cook-outcomes",
      "SUCCESS/NORMAL/FAILURE/무입력 deadline과 Waste once",
      "Requirements 5.4, 11.3, 11.5, 11.7, 11.8",
      () => timingCookOutcomeExamples(configuration),
    ],
    [
      "matching-sale-atomic-commit",
      "matching order sale의 order/dish/SOLD/cash/Revenue/COGS/reputation 단일 commit",
      "Requirements 5.2, 5.3, 9.9, 9.10, 11.9, 11.10, 11.11, 11.13",
      () => matchingSaleAtomicCommit(configuration),
    ],
    [
      "wrong-serve-preservation-timeout",
      "mismatch -3000ms, dish/경제/평판 보존, patience<=0 timeout+slot release",
      "Requirements 11.10, 11.11, 11.14",
      () => wrongServeExamples(configuration),
    ],
    [
      "source-timeout-dish-reuse",
      "source order timeout 뒤 같은 Recipe 다른 ACTIVE order에 dish 재사용",
      "Requirements 9.8, 9.9, 11.12",
      () => sourceTimeoutDishReuse(configuration),
    ],
    [
      "waste-overlay-and-timer-zero-restore",
      "sale/Waste overlay 동시 제거와 timer-zero CookEscrow exact restore",
      "Requirements 5.4, 8.7, 8.8, 11.6, 11.7, 11.13",
      () => wasteAndTimerZeroCleanup(configuration),
    ],
    [
      "property-14-direct-service",
      "128개 생성 Timing_Cook 입력에서 판정 구간과 terminal destination 완전·배타성",
      "Requirements 11.3-11.13, 12.6",
      () => directServiceProperty14(configuration),
    ],
  ];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const property = results.find((result) => result.id === "property-14-direct-service")?.details ?? {};
  const report = {
    qaId: "task-22-direct-service",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    propertySampleCount: property.samples ?? 0,
    results,
  };
  const finalSnapshot = createHarness(configuration).store.getSnapshot();
  const stateValidation = validateDirectServiceState({
    runtimePhase: finalSnapshot.runtimePhase,
    service: finalSnapshot.service,
    saleSlots: finalSnapshot.saleSlots,
    inventory: finalSnapshot.inventory,
  });
  assert(stateValidation.ok, `Task 22 baseline invariant 실패: ${stateValidation.code}`);
  const reconciliation = validateMenuPlanReconciliation(
    finalSnapshot.menu,
    finalSnapshot.recipes,
    finalSnapshot.saleSlots,
    finalSnapshot.inventory,
    { requireFullReservations: true },
  );
  assert(reconciliation.ok, `Task 22 baseline menu reconciliation 실패: ${reconciliation.code}`);
  return freezeDeep(report);
}
