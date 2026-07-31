import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { cloneValue } from "../core/result.js";
import { GameStore } from "../core/store.js";
import { createInventoryState } from "../domain/inventory.js";
import {
  createMenuState,
  planCookFailureRetryEligibility,
  projectRecipeMenu,
  registerMenuSystem,
  validateMenuEntry,
  validateMenuPlanReconciliation,
} from "../domain/menu.js";
import {
  addRecipeUnlocksForPlanning,
  calculateRecipePriceRange,
  createRecipeState,
  projectRecipes,
} from "../domain/recipe.js";
import {
  countSaleSlots,
  createSaleSlotsState,
  deriveAssignedSlots,
  planSaleSlotRelease,
  planSaleSlotSold,
  SALE_SLOT_RELEASE_REASON,
  SALE_SLOT_STATE,
} from "../domain/sale-slots.js";

const QA_GENERATION_ID = 17;
const PLAN_SWEEP_COUNT = 64;

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

function createLots(recipes, { defaultQuantity = 40, quantities = {}, quality = 70 } = {}) {
  return allIngredientIds(recipes).flatMap((ingredientId, index) => {
    const quantity = Object.prototype.hasOwnProperty.call(quantities, ingredientId)
      ? quantities[ingredientId]
      : defaultQuantity;
    if (quantity === null) return [];
    return [{
      lotId: `qa.menu.lot.${String(index).padStart(3, "0")}`,
      ingredientId,
      quantity,
      quality,
      bookCostG: quantity * 2,
      acquiredDay: 1,
    }];
  });
}

function createHarness({
  canonicalRecipes,
  unlockedRecipeIds = [],
  lots = null,
  phase = "PLANNING",
  menuLocked = false,
  seed = 0x17a11ce,
} = {}) {
  const campaignId = createCampaignId(seed, 0);
  const recipes = createRecipeState({
    recipes: canonicalRecipes,
    ingredientIds: allIngredientIds(canonicalRecipes),
    unlockedRecipeIds,
  });
  const menu = createMenuState({ day: 1, recipes, locked: menuLocked });
  const store = new GameStore({
    formatVersion: 1,
    revision: 0,
    runtimePhase: phase,
    checkpointPhase: phase === "PLANNING" ? "PLANNING_READY" : null,
    generationId: QA_GENERATION_ID,
    campaign: { campaignId, masterSeed: seed, day: 1, consecutiveArrearsCount: 0 },
    recipes,
    menu,
    saleSlots: createSaleSlotsState({ day: 1 }),
    inventory: createInventoryState({ lots: lots ?? createLots(canonicalRecipes) }),
    idCounters: createIdServiceState({ campaignId, day: 1, generationId: QA_GENERATION_ID }),
    untouched: { marker: "task-17-structural-sharing" },
  });
  const bus = new CommandBus({ store });
  const menuSystem = registerMenuSystem(bus);
  return { store, bus, menuSystem, canonicalRecipes };
}

function serviceHarnessFrom(planningHarness) {
  const state = cloneValue(planningHarness.store.getSnapshot());
  state.runtimePhase = "SERVICE";
  state.checkpointPhase = null;
  state.menu.locked = true;
  state.menu.cleanupComplete = false;
  const store = new GameStore(state);
  const bus = new CommandBus({ store });
  const menuSystem = registerMenuSystem(bus);
  return { store, bus, menuSystem, canonicalRecipes: planningHarness.canonicalRecipes };
}

function commandInput(harness, commandId, payload, overrides = {}) {
  return {
    commandId,
    expectedRevision: overrides.expectedRevision ?? harness.store.revision,
    generationId: overrides.generationId ?? harness.store.generationId,
    issuedAtSimulationMs: overrides.issuedAtSimulationMs ?? harness.store.revision * 20,
    payload,
  };
}

async function editEntry(harness, recipeId, plannedQuantity, {
  enabled = true,
  priceG = null,
  commandId = null,
} = {}) {
  const recipe = harness.store.getSnapshot().recipes.definitions.find((item) => item.recipeId === recipeId);
  return harness.menuSystem.editEntry(commandInput(
    harness,
    commandId ?? `qa:menu:edit:${recipeId}:${harness.store.revision}`,
    { recipeId, enabled, priceG: priceG ?? recipe.basePriceG, plannedQuantity },
  ));
}

async function confirmPlan(harness, commandId = `qa:menu:confirm:${harness.store.revision}`) {
  return harness.menuSystem.confirmPlan(commandInput(harness, commandId, { day: 1 }));
}

async function assignSlot(harness, recipeId, orderId, commandId = `qa:menu:assign:${orderId}`) {
  return harness.menuSystem.assignSlot(commandInput(harness, commandId, { recipeId, orderId }));
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
  assert(equivalent(harness.store.getCommandMetadata(), metadataBefore), `${label}: command ID metadata가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signalsBefore), `${label}: event/effect journal이 변경됐습니다.`);
  assert(harness.store.revision === revisionBefore, `${label}: revision이 변경됐습니다.`);
  assert(harness.store.commitCount === commitCountBefore, `${label}: commit이 발생했습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 실패 결과 signal이 비어 있지 않습니다.`);
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

/** Canonical registry, starting unlocks, next-Planning unlock, and dangling reference guard.
 * **Validates: Requirements 14.1, 14.4, 14.5** */
function recipeRegistryUnlockProjection(canonicalRecipes) {
  const ingredientIds = allIngredientIds(canonicalRecipes);
  const state = createRecipeState({ recipes: canonicalRecipes, ingredientIds });
  const starting = canonicalRecipes.filter((recipe) => recipe.unlock.type === "STARTING");
  assert(starting.length >= 2, "시작 Recipe가 2개 미만입니다.");
  assert(equivalent(state.unlockedRecipeIds, starting.map((recipe) => recipe.recipeId).sort(compareIds)),
    "새 캠페인 starting unlock set이 canonical Recipe와 다릅니다.");
  const locked = canonicalRecipes.find((recipe) => recipe.unlock.type !== "STARTING");
  assert(locked, "threshold unlock Recipe fixture가 없습니다.");
  const added = addRecipeUnlocksForPlanning(state, [locked.recipeId]);
  assert(added.ok && added.addedRecipeIds.length === 1 && added.state.unlockedRecipeIds.includes(locked.recipeId),
    "다음 Planning Recipe unlock projection이 추가되지 않았습니다.");
  const projection = projectRecipes(added.state);
  assert(projection.recipes.find((recipe) => recipe.recipeId === locked.recipeId)?.editable,
    "해금 Recipe가 Planning에서 editable하지 않습니다.");

  const dangling = cloneValue(canonicalRecipes);
  dangling[0].ingredientRequirements[0].ingredientId = "ingredient.missing";
  let danglingCode = null;
  try {
    createRecipeState({ recipes: dangling, ingredientIds });
  } catch (error) {
    danglingCode = error.code;
  }
  assert(danglingCode === "RECIPE_INGREDIENT_REFERENCE_NOT_FOUND", "dangling Recipe ingredient를 차단하지 않았습니다.");
  return {
    recipeCount: canonicalRecipes.length,
    startingRecipeCount: starting.length,
    unlockedAfterPlanning: added.state.unlockedRecipeIds.length,
    danglingReferenceCode: danglingCode,
  };
}

/** Price/quantity domain sweep and locked Recipe command rejection.
 * **Validates: Requirements 9.1, 9.2, 14.1** */
async function menuEditBoundsAndLockedRecipe(canonicalRecipes) {
  const recipes = createRecipeState({
    recipes: canonicalRecipes,
    ingredientIds: allIngredientIds(canonicalRecipes),
    unlockedRecipeIds: canonicalRecipes.map((recipe) => recipe.recipeId),
  });
  let validPriceChecks = 0;
  let validQuantityChecks = 0;
  let invalidChecks = 0;
  for (const recipe of recipes.definitions) {
    const range = calculateRecipePriceRange(recipe);
    for (let priceG = range.minimumPriceG; priceG <= range.maximumPriceG; priceG += 1) {
      const validation = validateMenuEntry({
        recipeId: recipe.recipeId,
        enabled: true,
        priceG,
        plannedQuantity: priceG % 17,
      }, recipes);
      assert(validation.ok, `${recipe.recipeId}의 유효 가격/수량이 거절됐습니다: ${priceG}`);
      validPriceChecks += 1;
      validQuantityChecks += 1;
    }
    for (const priceG of [range.minimumPriceG - 1, range.maximumPriceG + 1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert(!validateMenuEntry({ recipeId: recipe.recipeId, enabled: true, priceG, plannedQuantity: 0 }, recipes).ok,
        `${recipe.recipeId} invalid price가 허용됐습니다.`);
      invalidChecks += 1;
    }
    for (const plannedQuantity of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert(!validateMenuEntry({
        recipeId: recipe.recipeId,
        enabled: true,
        priceG: recipe.basePriceG,
        plannedQuantity,
      }, recipes).ok, `${recipe.recipeId} invalid Planned_Quantity가 허용됐습니다.`);
      invalidChecks += 1;
    }
  }

  const harness = createHarness({ canonicalRecipes });
  const lockedRecipe = canonicalRecipes.find((recipe) => recipe.unlock.type !== "STARTING");
  await assertRejectedUnchanged(harness, () => editEntry(harness, lockedRecipe.recipeId, 1, {
    commandId: "qa:menu:locked-recipe",
  }), "RECIPE_LOCKED", "locked Recipe edit");
  return { validPriceChecks, validQuantityChecks, invalidChecks, lockedEditPartialMutations: 0 };
}

/** Deterministic property sweep: slots and full reservations equal every generated menu promise.
 * **Validates: Requirements 8.3, 8.4, 8.6, 9.2, 9.3, 9.9** */
async function planSlotReservationPropertySweep(canonicalRecipes) {
  const starting = canonicalRecipes.filter((recipe) => recipe.unlock.type === "STARTING").sort(
    (left, right) => compareIds(left.recipeId, right.recipeId),
  );
  let reservationPromiseChecks = 0;
  let stableReplayChecks = 0;
  let maximumPlanned = 0;
  for (let sample = 0; sample < PLAN_SWEEP_COUNT; sample += 1) {
    const quantities = [sample % 5, Math.floor(sample / 5) % 5];
    const run = async () => {
      const harness = createHarness({ canonicalRecipes });
      for (let index = 0; index < starting.length; index += 1) {
        const result = await editEntry(harness, starting[index].recipeId, quantities[index] ?? 0, {
          commandId: `qa:menu:sweep:${sample}:edit:${index}`,
        });
        assert(result.ok, `sample ${sample}: menu edit가 실패했습니다: ${result.code}`);
      }
      const beforeConfirm = harness.store.getSnapshot();
      const result = await confirmPlan(harness, `qa:menu:sweep:${sample}:confirm`);
      assert(result.ok, `sample ${sample}: menu confirm이 실패했습니다: ${result.code}`);
      const snapshot = harness.store.getSnapshot();
      const expectedPlanned = quantities.reduce((total, quantity) => total + quantity, 0);
      const reconciliation = validateMenuPlanReconciliation(
        snapshot.menu,
        snapshot.recipes,
        snapshot.saleSlots,
        snapshot.inventory,
        { requireFullReservations: true },
      );
      assert(reconciliation.ok, `sample ${sample}: menu promise 대사가 실패했습니다: ${reconciliation.code}`);
      assert(reconciliation.details.saleSlotCount === expectedPlanned,
        `sample ${sample}: slot count가 planned 합과 다릅니다.`);
      assert(reconciliation.details.assignedCount === 0 && reconciliation.details.soldCount === 0,
        `sample ${sample}: 신규 slot이 AVAILABLE이 아닙니다.`);
      assert(snapshot.idCounters.counters.slot === beforeConfirm.idCounters.counters.slot + expectedPlanned,
        `sample ${sample}: slot ID counter가 planned 합만큼 증가하지 않았습니다.`);
      assert(snapshot.idCounters.counters.reservation ===
        beforeConfirm.idCounters.counters.reservation + (expectedPlanned > 0 ? 1 : 0),
      `sample ${sample}: reservation plan ID counter가 정확하지 않습니다.`);
      return { harness, reconciliation, snapshot };
    };
    const left = await run();
    const right = await run();
    assert(equivalent(left.snapshot, right.snapshot), `sample ${sample}: 동일 menu plan state가 결정론적이지 않습니다.`);
    assert(equivalent(left.harness.bus.getSignalSnapshot(), right.harness.bus.getSignalSnapshot()),
      `sample ${sample}: 동일 menu plan signals가 결정론적이지 않습니다.`);
    reservationPromiseChecks += 1;
    stableReplayChecks += 1;
    maximumPlanned = Math.max(maximumPlanned, left.reconciliation.details.plannedQuantity);
  }
  return { sweepCount: PLAN_SWEEP_COUNT, reservationPromiseChecks, stableReplayChecks, maximumPlanned };
}

/** Shared shortage preserves menu/slots/reservations/ID/revision/signals exactly.
 * **Validates: Requirements 8.4, 8.5, 8.8, 9.3, 9.4** */
async function sharedIngredientShortageExactPreservation(canonicalRecipes) {
  const stone = canonicalRecipes.find((recipe) => recipe.recipeId === "recipe.stonegrain_bowl");
  const glow = canonicalRecipes.find((recipe) => recipe.recipeId === "recipe.glowcap_soup");
  assert(stone && glow, "shared ingredient Recipe fixtures가 없습니다.");
  const quantities = Object.fromEntries(allIngredientIds(canonicalRecipes).map((ingredientId) => [ingredientId, 20]));
  quantities["ingredient.cave_mushroom"] = 3;
  const harness = createHarness({
    canonicalRecipes,
    unlockedRecipeIds: [glow.recipeId],
    lots: createLots(canonicalRecipes, { quantities }),
  });
  assert((await editEntry(harness, stone.recipeId, 2, { commandId: "qa:menu:shortage:stone" })).ok,
    "shared shortage stone edit 실패");
  assert((await editEntry(harness, glow.recipeId, 2, { commandId: "qa:menu:shortage:glow" })).ok,
    "shared shortage glow edit 실패");
  const before = harness.store.getSnapshot();
  const result = await assertRejectedUnchanged(
    harness,
    () => confirmPlan(harness, "qa:menu:shortage:confirm"),
    "INVENTORY_SHORTAGE",
    "shared ingredient shortage",
  );
  const diagnosticText = JSON.stringify(result.diagnostics);
  assert(diagnosticText.includes("ingredient.cave_mushroom") && diagnosticText.includes("shortageQuantity"),
    "shared shortage diagnostic에 정확한 부족 ingredient가 없습니다.");
  assert(before.saleSlots.slots.length === 0 && before.inventory.reservations.length === 0,
    "shortage 이전 baseline fixture가 비어 있지 않습니다.");
  return {
    shortageIngredientId: "ingredient.cave_mushroom",
    requiredQuantity: 4,
    availableQuantity: 3,
    exactPreservationChecks: 8,
    partialMutations: 0,
  };
}

/** Existing hard reservations are restored in a detached draft before deterministic replan.
 * **Validates: Requirements 8.3, 8.4, 9.3, 9.4** */
async function deterministicPriorPlanRestore(canonicalRecipes) {
  const target = canonicalRecipes.find((recipe) => recipe.recipeId === "recipe.stonegrain_bowl");
  const quantities = Object.fromEntries(allIngredientIds(canonicalRecipes).map((ingredientId) => [ingredientId, null]));
  for (const requirement of target.ingredientRequirements) quantities[requirement.ingredientId] = requirement.quantity * 2;

  const execute = async () => {
    const harness = createHarness({
      canonicalRecipes,
      lots: createLots(canonicalRecipes, { defaultQuantity: 0, quantities }),
    });
    assert((await editEntry(harness, target.recipeId, 2, { commandId: "qa:menu:restore:edit-two" })).ok,
      "초기 replan edit 실패");
    assert((await confirmPlan(harness, "qa:menu:restore:confirm-two")).ok, "초기 replan confirm 실패");
    const first = cloneValue(harness.store.getSnapshot());
    assert(first.inventory.reservations.length > 0, "초기 plan reservation이 없습니다.");
    assert((await editEntry(harness, target.recipeId, 1, { commandId: "qa:menu:restore:edit-one" })).ok,
      "두 번째 replan edit 실패");
    const secondResult = await confirmPlan(harness, "qa:menu:restore:confirm-one");
    assert(secondResult.ok, `기존 reservation 복원 뒤 replan이 실패했습니다: ${secondResult.code}`);
    return { harness, first, second: harness.store.getSnapshot() };
  };
  const left = await execute();
  const right = await execute();
  assert(equivalent(left.second, right.second), "prior-plan restore/replan 결과가 결정론적이지 않습니다.");
  assert(left.second.saleSlots.slots.length === 1, "replan slot count가 새 planned quantity와 다릅니다.");
  assert(left.second.inventory.reservations.every((reservation) =>
    left.second.saleSlots.slots.some((slot) => slot.saleSlotId === reservation.saleSlotId)),
  "replan 후 old slot reservation이 남았습니다.");
  const oldSlotIds = new Set(left.first.saleSlots.slots.map((slot) => slot.saleSlotId));
  assert(left.second.inventory.reservations.every((reservation) => !oldSlotIds.has(reservation.saleSlotId)),
    "old plan reservation이 새 plan에 누출됐습니다.");
  return {
    priorSlotCount: left.first.saleSlots.slots.length,
    nextSlotCount: left.second.saleSlots.slots.length,
    remainingReservationCount: left.second.inventory.reservations.length,
    deterministicReplayChecks: 1,
  };
}

async function confirmedPlanningHarness(canonicalRecipes, recipeId, quantity) {
  const harness = createHarness({ canonicalRecipes });
  assert((await editEntry(harness, recipeId, quantity, { commandId: `qa:menu:setup:edit:${quantity}` })).ok,
    "service setup edit 실패");
  assert((await confirmPlan(harness, `qa:menu:setup:confirm:${quantity}`)).ok, "service setup confirm 실패");
  return harness;
}

/** AVAILABLE→ASSIGNED→SOLD, SOLD terminal, reservation release, and assigned_slots derivation.
 * **Validates: Requirements 9.6, 9.8, 9.9, 9.11, 10.5** */
async function saleSlotLifecycleAndSoldTerminal(canonicalRecipes) {
  const recipe = canonicalRecipes.find((item) => item.unlock.type === "STARTING");
  const planning = await confirmedPlanningHarness(canonicalRecipes, recipe.recipeId, 1);
  const service = serviceHarnessFrom(planning);
  const orderId = "order.qa.lifecycle";
  const assigned = await assignSlot(service, recipe.recipeId, orderId);
  assert(assigned.ok, `slot assignment가 실패했습니다: ${assigned.code}`);
  const assignedSnapshot = service.store.getSnapshot();
  assert(deriveAssignedSlots(assignedSnapshot.saleSlots).length === 1, "assigned_slots가 ASSIGNED 1개를 포함하지 않습니다.");
  const assignedSlot = deriveAssignedSlots(assignedSnapshot.saleSlots)[0];
  const slotsBeforeSale = cloneValue(assignedSnapshot.saleSlots);
  const inventoryBeforeSale = cloneValue(assignedSnapshot.inventory);
  const sold = planSaleSlotSold(assignedSnapshot.saleSlots, assignedSnapshot.inventory, {
    saleSlotId: assignedSlot.saleSlotId,
    orderId,
  });
  assert(sold.ok, `sale slot SOLD plan이 실패했습니다: ${sold.code}`);
  assert(equivalent(assignedSnapshot.saleSlots, slotsBeforeSale) &&
    equivalent(assignedSnapshot.inventory, inventoryBeforeSale), "SOLD planner가 source state를 변경했습니다.");
  const counts = countSaleSlots(sold.plan.saleSlots);
  assert(counts.byState.SOLD === 1 && counts.byState.ASSIGNED === 0,
    "SOLD transition 또는 assigned_slots 제외가 잘못됐습니다.");
  assert(sold.plan.inventory.reservations.length === 0, "SOLD slot의 잔여 reservation이 해제되지 않았습니다.");
  const releaseSold = planSaleSlotRelease(sold.plan.saleSlots, {
    saleSlotId: assignedSlot.saleSlotId,
    orderId,
    reason: SALE_SLOT_RELEASE_REASON.TIMEOUT,
  });
  const sellAgain = planSaleSlotSold(sold.plan.saleSlots, sold.plan.inventory, {
    saleSlotId: assignedSlot.saleSlotId,
    orderId,
  });
  assert(!releaseSold.ok && releaseSold.code === "SOLD_SALE_SLOT_TERMINAL", "SOLD slot이 timeout release됐습니다.");
  assert(!sellAgain.ok && sellAgain.code === "SOLD_SALE_SLOT_TERMINAL", "SOLD slot이 재판매됐습니다.");
  assert(counts.byState.SOLD <= 1, "SOLD count가 planned quantity를 초과했습니다.");
  return { availableToAssigned: 1, assignedToSold: 1, soldTerminalRejections: 2, assignedSlotsAfterSale: 0 };
}

/** Editing and confirmation are phase-locked throughout Service.
 * **Validates: Requirements 9.1, 9.5** */
async function serviceMenuLockExactRejection(canonicalRecipes) {
  const recipe = canonicalRecipes.find((item) => item.unlock.type === "STARTING");
  const planning = await confirmedPlanningHarness(canonicalRecipes, recipe.recipeId, 1);
  const service = serviceHarnessFrom(planning);
  await assertRejectedUnchanged(service, () => editEntry(service, recipe.recipeId, 2, {
    commandId: "qa:menu:service-lock:edit",
  }), "ILLEGAL_PHASE", "Service menu edit lock");
  await assertRejectedUnchanged(service, () => confirmPlan(service, "qa:menu:service-lock:confirm"),
    "ILLEGAL_PHASE", "Service menu confirm lock");
  const projection = projectRecipeMenu(service.store.getSnapshot());
  assert(projection.locked && !projection.editable, "Service UI projection이 menu lock을 표시하지 않습니다.");
  return { lockedCommands: 2, revisionMutations: 0, projectionEditable: projection.editable };
}

/** Timeout returns ASSIGNED to AVAILABLE; technical cleanup releases all unused reservation.
 * **Validates: Requirements 9.7, 9.9, 9.11, 10.8** */
async function timeoutAndTechnicalCleanup(canonicalRecipes) {
  const recipe = canonicalRecipes.find((item) => item.unlock.type === "STARTING");
  const planning = await confirmedPlanningHarness(canonicalRecipes, recipe.recipeId, 2);
  const service = serviceHarnessFrom(planning);
  const initialReservationCount = service.store.getSnapshot().inventory.reservations.length;
  assert((await assignSlot(service, recipe.recipeId, "order.qa.timeout")).ok, "timeout fixture assignment 실패");
  const assignedSlot = deriveAssignedSlots(service.store.getSnapshot().saleSlots)[0];
  const timeout = await service.menuSystem.releaseSlot(commandInput(service, "qa:menu:timeout", {
    saleSlotId: assignedSlot.saleSlotId,
    orderId: "order.qa.timeout",
    reason: SALE_SLOT_RELEASE_REASON.TIMEOUT,
  }));
  assert(timeout.ok, `timeout slot release가 실패했습니다: ${timeout.code}`);
  assert(service.store.getSnapshot().saleSlots.slots.find((slot) => slot.saleSlotId === assignedSlot.saleSlotId).state ===
    SALE_SLOT_STATE.AVAILABLE, "timeout slot이 AVAILABLE로 돌아오지 않았습니다.");
  assert(service.store.getSnapshot().inventory.reservations.length === initialReservationCount,
    "timeout이 hard reservation을 조기에 해제했습니다.");

  assert((await assignSlot(service, recipe.recipeId, "order.qa.cleanup.a")).ok, "cleanup assignment A 실패");
  assert((await assignSlot(service, recipe.recipeId, "order.qa.cleanup.b")).ok, "cleanup assignment B 실패");
  const cleanup = await service.menuSystem.cleanup(commandInput(service, "qa:menu:cleanup", {
    reason: SALE_SLOT_RELEASE_REASON.CLEANUP,
  }));
  assert(cleanup.ok, `technical cleanup이 실패했습니다: ${cleanup.code}`);
  const after = service.store.getSnapshot();
  const counts = countSaleSlots(after.saleSlots);
  assert(deriveAssignedSlots(after.saleSlots).length === 0, "cleanup 후 assigned_slots leak가 있습니다.");
  assert(after.inventory.reservations.length === 0, "cleanup 후 unused reservation이 남았습니다.");
  assert(counts.byState.SOLD <= after.menu.confirmedEntries.reduce((sum, entry) => sum + entry.plannedQuantity, 0),
    "cleanup 후 SOLD가 planned를 초과했습니다.");
  return {
    timeoutReturnedAvailable: 1,
    reservationsPreservedUntilCleanup: initialReservationCount,
    cleanupAssignedSlots: 0,
    cleanupUnusedReservations: after.inventory.reservations.length,
    soldCount: counts.byState.SOLD,
  };
}

/** Cook failure query preserves ASSIGNED and permits retry only from reservation or unreserved stock.
 * **Validates: Requirements 9.10, 11.6, 11.7** */
async function cookFailureRetryEligibility(canonicalRecipes) {
  const recipe = canonicalRecipes.find((item) => item.unlock.type === "STARTING");
  const planning = await confirmedPlanningHarness(canonicalRecipes, recipe.recipeId, 1);
  const service = serviceHarnessFrom(planning);
  assert((await assignSlot(service, recipe.recipeId, "order.qa.retry")).ok, "retry fixture assignment 실패");
  const snapshot = service.store.getSnapshot();
  const slot = deriveAssignedSlots(snapshot.saleSlots)[0];
  const before = cloneValue(snapshot.saleSlots);
  const reservedRetry = planCookFailureRetryEligibility(snapshot, slot.saleSlotId);
  assert(reservedRetry.ok && reservedRetry.eligible, "잔여 hard reservation으로 retry가 허용되지 않았습니다.");

  const unreservedInventory = createInventoryState({
    lots: snapshot.inventory.lots,
    reservations: [],
  });
  const unreservedRetry = planCookFailureRetryEligibility({ ...snapshot, inventory: unreservedInventory }, slot.saleSlotId);
  assert(unreservedRetry.ok && unreservedRetry.eligible, "미예약 재료로 retry가 허용되지 않았습니다.");

  const emptyInventory = createInventoryState({
    lots: snapshot.inventory.lots.map((lot) => ({ ...lot, quantity: 0, bookCostG: 0 })),
    reservations: [],
  });
  const rejectedRetry = planCookFailureRetryEligibility({ ...snapshot, inventory: emptyInventory }, slot.saleSlotId);
  assert(rejectedRetry.ok && !rejectedRetry.eligible && rejectedRetry.code === "INVENTORY_SHORTAGE",
    "재료 없는 cook retry가 차단되지 않았습니다.");
  assert(equivalent(service.store.getSnapshot().saleSlots, before) &&
    deriveAssignedSlots(service.store.getSnapshot().saleSlots).length === 1,
  "cook failure retry query가 ASSIGNED slot을 변경했습니다.");
  return { reservationRetryEligible: true, unreservedRetryEligible: true, shortageRetryEligible: false, assignedPreserved: 1 };
}

/** Command ID duplicate and stale revision rejection are exact and duplicate takes precedence.
 * **Validates: Requirements 4.6, 4.7, 9.3, 9.4** */
async function duplicateStaleAndIdempotency(canonicalRecipes) {
  const harness = createHarness({ canonicalRecipes });
  const recipe = harness.store.getSnapshot().recipes.definitions.find((item) => item.unlock.type === "STARTING");
  const input = commandInput(harness, "qa:menu:idempotency:edit", {
    recipeId: recipe.recipeId,
    enabled: true,
    priceG: recipe.basePriceG,
    plannedQuantity: 1,
  });
  const first = await harness.menuSystem.editEntry(input);
  assert(first.ok, `idempotency baseline edit가 실패했습니다: ${first.code}`);
  await assertRejectedUnchanged(harness, () => harness.menuSystem.editEntry(input),
    "DUPLICATE_COMMAND", "duplicate menu command");
  const stale = commandInput(harness, "qa:menu:idempotency:stale", input.payload, { expectedRevision: 0 });
  await assertRejectedUnchanged(harness, () => harness.menuSystem.editEntry(stale),
    "STALE_REVISION", "stale menu command");
  const confirmInput = commandInput(harness, "qa:menu:idempotency:confirm", { day: 1 });
  const confirmed = await harness.menuSystem.confirmPlan(confirmInput);
  assert(confirmed.ok, `idempotency baseline confirm이 실패했습니다: ${confirmed.code}`);
  await assertRejectedUnchanged(harness, () => harness.menuSystem.confirmPlan(confirmInput),
    "DUPLICATE_COMMAND", "duplicate confirm command");
  return { successfulCommits: 2, duplicateRejections: 2, staleRejections: 1, partialMutations: 0 };
}

export async function runRecipeMenuProbe({ recipes } = {}) {
  assert(Array.isArray(recipes) && recipes.length >= 2, "canonical Recipe 입력이 없습니다.");
  const definitions = [
    ["recipe-registry-unlock-projection", "Recipe registry, starting/Planning unlock, dangling reference", ["14.1", "14.4", "14.5"], () => recipeRegistryUnlockProjection(recipes)],
    ["menu-edit-bounds-locked-recipe", "50..200% integer G, non-negative safe Planned_Quantity, unlocked-only edit", ["9.1", "9.2", "14.1"], () => menuEditBoundsAndLockedRecipe(recipes)],
    ["plan-slot-reservation-property-sweep", "64 generated menu plans의 deterministic slot/full reservation 대사", ["8.3", "8.4", "8.6", "9.3", "9.9"], () => planSlotReservationPropertySweep(recipes)],
    ["shared-shortage-exact-preservation", "shared ingredient shortage의 menu/slots/reservation/ID/revision/signal exact 보존", ["8.4", "8.5", "8.8", "9.3", "9.4"], () => sharedIngredientShortageExactPreservation(recipes)],
    ["deterministic-prior-plan-restore", "기존 hard reservation detached restore 후 전체 menu deterministic replan", ["8.3", "8.4", "9.3", "9.4"], () => deterministicPriorPlanRestore(recipes)],
    ["sale-slot-lifecycle-sold-terminal", "AVAILABLE→ASSIGNED→SOLD, terminal SOLD, assigned_slots excludes SOLD", ["9.6", "9.8", "9.9", "9.11", "10.5"], () => saleSlotLifecycleAndSoldTerminal(recipes)],
    ["service-menu-lock", "Service에서 edit/confirm full rejection과 locked projection", ["9.1", "9.5"], () => serviceMenuLockExactRejection(recipes)],
    ["timeout-technical-cleanup", "timeout AVAILABLE 반환과 cleanup reservation/ASSIGNED leak 0", ["9.7", "9.9", "9.11", "10.8"], () => timeoutAndTechnicalCleanup(recipes)],
    ["cook-failure-retry", "cook failure 후 ASSIGNED 보존 및 reservation/unreserved 기반 retry eligibility", ["9.10", "11.6", "11.7"], () => cookFailureRetryEligibility(recipes)],
    ["duplicate-stale-idempotency", "duplicate/stale command exact rejection과 no second effect", ["4.6", "4.7", "9.3", "9.4"], () => duplicateStaleAndIdempotency(recipes)],
  ];
  const results = [];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const detailsFor = (id) => results.find((result) => result.id === id)?.details ?? {};
  return Object.freeze({
    qaId: "task-17-recipe-menu-sale-slot-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    plannedQuantitySweepCount: detailsFor("plan-slot-reservation-property-sweep").sweepCount ?? 0,
    reservationPromiseCheckCount: detailsFor("plan-slot-reservation-property-sweep").reservationPromiseChecks ?? 0,
    deterministicReplayCheckCount:
      (detailsFor("plan-slot-reservation-property-sweep").stableReplayChecks ?? 0) +
      (detailsFor("deterministic-prior-plan-restore").deterministicReplayChecks ?? 0),
    sharedShortageExactPreservationChecks:
      detailsFor("shared-shortage-exact-preservation").exactPreservationChecks ?? 0,
    partialMutationCount:
      (detailsFor("shared-shortage-exact-preservation").partialMutations ?? 0) +
      (detailsFor("duplicate-stale-idempotency").partialMutations ?? 0),
    soldTerminalRejectionCount:
      detailsFor("sale-slot-lifecycle-sold-terminal").soldTerminalRejections ?? 0,
    cleanupUnusedReservationCount:
      detailsFor("timeout-technical-cleanup").cleanupUnusedReservations ?? null,
    cleanupAssignedSlotCount:
      detailsFor("timeout-technical-cleanup").cleanupAssignedSlots ?? null,
    results: Object.freeze(results),
  });
}
