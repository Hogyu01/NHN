import { CommandBus } from "../core/command-bus.js";
import { cloneValue } from "../core/result.js";
import { GameStore } from "../core/store.js";
import { createEconomyState } from "../domain/economy.js";
import {
  buildCostMovementGraph,
  createInventoryAccountingState,
  INVENTORY_ACQUISITION_SOURCE,
  planDishToCogs,
  planDishToWaste,
  planEscrowRestore,
  planEscrowToDish,
  planEscrowToWaste,
  planIngredientsToEscrow,
  planLotAcquisition,
  projectCostLocations,
  reconcileInventoryAccounting,
  registerInventoryAccounting,
} from "../domain/inventory-accounting.js";
import {
  createInventoryState,
  projectInventory,
  validateInventoryState,
} from "../domain/inventory.js";
import {
  calculateBookCostTaken,
  planHardReservations,
} from "../domain/reservation-planner.js";

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

function lot(lotId, ingredientId, quantity, bookCostG, acquiredDay, quality = 50) {
  return { lotId, ingredientId, quantity, quality, bookCostG, acquiredDay };
}

function createRootState({
  runtimePhase = "PLANNING",
  inventory = createInventoryState(),
  inventoryAccounting = createInventoryAccountingState(),
  economy = createEconomyState({ cashG: 300 }),
} = {}) {
  return {
    revision: 0,
    runtimePhase,
    generationId: 14,
    campaign: { day: 1, consecutiveArrearsCount: 0 },
    economy,
    inventory,
    inventoryAccounting,
    idCounters: { lot: 0, reservation: 0, cook: 0, dish: 0 },
    rng: { market: { drawCount: 0 } },
    untouched: { marker: "task-14-structural-sharing" },
  };
}

function createHarness(options = {}) {
  const store = new GameStore(createRootState(options));
  const bus = new CommandBus({ store });
  const api = registerInventoryAccounting(bus);
  return { store, bus, api };
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

function movementPayload(id, extra = {}) {
  return {
    movementId: `qa:movement:${id}`,
    day: 1,
    causeId: `qa:cause:${id}`,
    ...extra,
  };
}

async function assertRejectedUnchanged(harness, execute, expectedCode, label) {
  const before = harness.store.getSnapshot();
  const signals = harness.bus.getSignalSnapshot();
  const metadata = harness.store.getCommandMetadata();
  const result = await execute();
  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), before), `${label}: touched state가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signals), `${label}: event/effect journal이 변경됐습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadata), `${label}: command metadata가 변경됐습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 실패 결과에 signal이 있습니다.`);
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

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((tail) => [value, ...tail]));
}

/** Deterministic Ingredient_Lot and projection examples. **Validates: Requirements 8.1, 8.2, 8.6** */
function ingredientLotProjectionExample() {
  const inventory = createInventoryState({
    lots: [
      lot("lot:b", "ingredient.shared", 4, 9, 2, 70),
      lot("lot:a", "ingredient.shared", 3, 7, 1, 40),
    ],
    reservations: [{
      reservationId: "reservation:one",
      saleSlotId: "slot:one",
      lotId: "lot:a",
      ingredientId: "ingredient.shared",
      quantity: 2,
    }],
  });
  const projection = projectInventory(inventory);
  assert(projection.lots.map((item) => item.lotId).join(",") === "lot:a,lot:b", "FIFO projection 순서가 잘못됐습니다.");
  assert(projection.lots[0].reservedQuantity === 2 && projection.lots[0].unreservedQuantity === 1, "lot 수량식이 잘못됐습니다.");
  assert(projection.byIngredient["ingredient.shared"].quantity === 7, "ingredient 수량 합계가 잘못됐습니다.");
  assert(projection.endingInventoryBookCostG === 16, "ending inventory Book_Cost가 잘못됐습니다.");
  return { lots: projection.lots.length, quantity: 7, bookCostG: 16 };
}

/** FIFO is independent of source lot permutation. **Validates: Requirements 8.3, 8.4, 8.6** */
function fifoReservationPermutationExample() {
  const sourceLots = [
    lot("lot:z", "ingredient.shared", 2, 5, 1),
    lot("lot:a", "ingredient.shared", 2, 5, 1),
    lot("lot:b", "ingredient.shared", 2, 5, 2),
  ];
  const outputs = permutations(sourceLots).map((lots) => {
    const inventory = createInventoryState({ lots });
    const result = planHardReservations(inventory, {
      reservationPlanId: "qa:reservation:permutation",
      requests: [{
        saleSlotId: "slot:permutation",
        recipeId: "recipe:permutation",
        requirements: [{ ingredientId: "ingredient.shared", quantity: 5 }],
      }],
    });
    assert(result.ok, `lot permutation reservation이 실패했습니다: ${result.code}`);
    return result.plan.reservations.map((reservation) => `${reservation.lotId}:${reservation.quantity}`).join("|");
  });
  assert(new Set(outputs).size === 1, "lot input permutation이 FIFO allocation을 변경했습니다.");
  assert(outputs[0] === "lot:a:2|lot:z:2|lot:b:1", `FIFO allocation이 잘못됐습니다: ${outputs[0]}`);
  return { permutations: outputs.length, allocation: outputs[0] };
}

/** Shared ingredient shortage is exact and atomic. **Validates: Requirements 8.4, 8.5, 8.8, 9.4** */
async function sharedIngredientShortageFullRejection() {
  const inventory = createInventoryState({ lots: [lot("lot:shared", "ingredient.shared", 3, 9, 1)] });
  const payload = {
    reservationPlanId: "qa:reservation:shortage",
    requests: [
      {
        saleSlotId: "slot:a",
        recipeId: "recipe:a",
        requirements: [{ ingredientId: "ingredient.shared", quantity: 2 }],
      },
      {
        saleSlotId: "slot:b",
        recipeId: "recipe:b",
        requirements: [{ ingredientId: "ingredient.shared", quantity: 2 }],
      },
    ],
  };
  const preview = planHardReservations(inventory, payload);
  assert(!preview.ok && preview.code === "INVENTORY_SHORTAGE", "shared shortage preview가 실패하지 않았습니다.");
  assert(preview.details.shortages.length === 1, "shortage list cardinality가 잘못됐습니다.");
  assert(equivalent(preview.details.shortages[0], {
    ingredientId: "ingredient.shared",
    requiredQuantity: 4,
    availableQuantity: 3,
    shortageQuantity: 1,
  }), "정확한 shared ingredient 부족 목록이 아닙니다.");

  const harness = createHarness({ inventory, inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 9 }) });
  await assertRejectedUnchanged(
    harness,
    () => harness.api.reserve(commandInput(harness, "qa:reservation:shortage:cmd", payload)),
    "INVENTORY_SHORTAGE",
    "shared ingredient reservation",
  );
  return { shortage: preview.details.shortages[0], partialMutations: 0 };
}

/** Acquisition capitalizes cost and duplicate movement is fully rejected. **Validates: Requirements 5.1, 5.10, 8.1** */
async function acquisitionAndDuplicateExample() {
  const harness = createHarness();
  const payload = movementPayload("acquire", {
    source: INVENTORY_ACQUISITION_SOURCE.MARKET,
    lot: lot("lot:acquired", "ingredient.market", 5, 13, 1, 81),
  });
  const first = await harness.api.acquireLot(commandInput(harness, "qa:acquire:cmd:1", payload));
  assert(first.ok, `lot acquisition이 실패했습니다: ${first.code}`);
  const snapshot = harness.store.getSnapshot();
  assert(snapshot.inventory.lots.length === 1 && snapshot.inventory.lots[0].bookCostG === 13, "lot Book_Cost가 자본화되지 않았습니다.");
  assert(snapshot.inventoryAccounting.marketAcquisitionG === 13, "market acquisition 합계가 잘못됐습니다.");
  assert(snapshot.economy.cashG === 300, "inventory acquisition helper가 CashTransactionAPI를 우회해 cash를 변경했습니다.");
  assert(reconcileInventoryAccounting(snapshot.inventory, snapshot.inventoryAccounting).ok, "acquisition 재고 대사가 실패했습니다.");
  await assertRejectedUnchanged(
    harness,
    () => harness.api.acquireLot(commandInput(harness, "qa:acquire:cmd:2", {
      ...payload,
      lot: lot("lot:another", "ingredient.market", 1, 1, 1),
    })),
    "DUPLICATE_COST_MOVEMENT_ID",
    "duplicate acquisition movement",
  );
  return { lotBookCostG: 13, acquisitionExpenseG: 0, movementCount: 1 };
}

/** Partial Half-Up and final remainder rule. **Validates: Requirements 8.7, 5.10** */
function partialAndLastBookCostExample() {
  let quantity = 3;
  let bookCostG = 10;
  const taken = [];
  while (quantity > 0) {
    const cost = calculateBookCostTaken(bookCostG, quantity, 1);
    taken.push(cost);
    quantity -= 1;
    bookCostG -= cost;
  }
  assert(taken.join(",") === "3,4,3", `10G/3 quantity cost sequence가 잘못됐습니다: ${taken.join(",")}`);
  assert(bookCostG === 0 && taken.reduce((sum, value) => sum + value, 0) === 10, "부분/마지막 소비 원가가 보존되지 않았습니다.");
  assert(calculateBookCostTaken(1, 2, 1) === 1, "0.5G Half-Up이 1G가 아닙니다.");
  assert(calculateBookCostTaken(7, 1, 1) === 7, "마지막 수량이 잔여 원가 전액을 가져가지 않았습니다.");
  return { sequence: taken, totalBookCostG: 10 };
}

/** lot→escrow→dish→COGS has one current location and reconciles. **Validates: Requirements 5.2, 5.3, 5.10, 8.7, 8.8** */
async function successfulDishCogsLifecycle() {
  const inventory = createInventoryState({ lots: [lot("lot:success", "ingredient.success", 4, 17, 1, 60)] });
  const harness = createHarness({
    runtimePhase: "SERVICE",
    inventory,
    inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 17 }),
  });
  const started = await harness.api.startCookEscrow(commandInput(harness, "qa:success:start:cmd", movementPayload("success:start", {
    escrowId: "escrow:success",
    recipeId: "recipe:success",
    requirements: [{ ingredientId: "ingredient.success", quantity: 3 }],
  })));
  assert(started.ok, `success escrow가 실패했습니다: ${started.code}`);
  const escrowCost = harness.store.getSnapshot().inventory.cookEscrows[0].totalBookCostG;
  const dishResult = await harness.api.completeCookToDish(commandInput(harness, "qa:success:dish:cmd", movementPayload("success:dish", {
    escrowId: "escrow:success",
    dishId: "dish:success",
    createdOrderId: "order:success",
  })));
  assert(dishResult.ok, `escrow→dish가 실패했습니다: ${dishResult.code}`);
  const sale = await harness.api.recognizeDishCogs(commandInput(harness, "qa:success:cogs:cmd", movementPayload("success:cogs", {
    dishId: "dish:success",
  })));
  assert(sale.ok, `dish→COGS가 실패했습니다: ${sale.code}`);
  const snapshot = harness.store.getSnapshot();
  assert(snapshot.inventoryAccounting.cogsG === escrowCost, "COGS가 dish Book_Cost와 다릅니다.");
  assert(snapshot.inventory.completedDishes[0].state === "SOLD" && snapshot.inventory.completedDishes[0].bookCostG === 0, "SOLD dish가 Book_Cost를 중복 보유합니다.");
  const reconciliation = reconcileInventoryAccounting(snapshot.inventory, snapshot.inventoryAccounting);
  assert(reconciliation.ok, `COGS lifecycle 재고 대사 실패: ${reconciliation.code}`);
  const locations = projectCostLocations(snapshot.inventory, snapshot.inventoryAccounting);
  assert(locations.escrowG === 0 && locations.dishG === 0 && locations.cogsG === escrowCost, "원가가 단일 destination에 있지 않습니다.");
  return { escrowCostG: escrowCost, cogsG: snapshot.inventoryAccounting.cogsG, movements: 3 };
}

/** Cook failure and unserved dish each recognize Waste exactly once. **Validates: Requirements 5.4, 5.10** */
async function wasteDestinationsExample() {
  const failureInventory = createInventoryState({ lots: [lot("lot:failure", "ingredient.failure", 2, 9, 1)] });
  const failure = createHarness({
    runtimePhase: "SERVICE",
    inventory: failureInventory,
    inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 9 }),
  });
  assert((await failure.api.startCookEscrow(commandInput(failure, "qa:failure:start:cmd", movementPayload("failure:start", {
    escrowId: "escrow:failure",
    recipeId: "recipe:failure",
    requirements: [{ ingredientId: "ingredient.failure", quantity: 2 }],
  })))).ok, "failure escrow start가 실패했습니다.");
  assert((await failure.api.completeCookToWaste(commandInput(failure, "qa:failure:waste:cmd", movementPayload("failure:waste", {
    escrowId: "escrow:failure",
  })))).ok, "escrow failure Waste가 실패했습니다.");
  const failureSnapshot = failure.store.getSnapshot();
  assert(failureSnapshot.inventoryAccounting.cookingWasteExpenseG === 9, "cook failure Waste가 잘못됐습니다.");

  const unservedInventory = createInventoryState({ lots: [lot("lot:unserved", "ingredient.unserved", 1, 7, 1)] });
  const unserved = createHarness({
    runtimePhase: "SERVICE",
    inventory: unservedInventory,
    inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 7 }),
  });
  assert((await unserved.api.startCookEscrow(commandInput(unserved, "qa:unserved:start:cmd", movementPayload("unserved:start", {
    escrowId: "escrow:unserved",
    recipeId: "recipe:unserved",
    requirements: [{ ingredientId: "ingredient.unserved", quantity: 1 }],
  })))).ok, "unserved escrow start가 실패했습니다.");
  assert((await unserved.api.completeCookToDish(commandInput(unserved, "qa:unserved:dish:cmd", movementPayload("unserved:dish", {
    escrowId: "escrow:unserved",
    dishId: "dish:unserved",
  })))).ok, "unserved dish 생성이 실패했습니다.");
  assert((await unserved.api.wasteDish(commandInput(unserved, "qa:unserved:waste:cmd", movementPayload("unserved:waste", {
    dishId: "dish:unserved",
  })))).ok, "unserved dish Waste가 실패했습니다.");
  const unservedSnapshot = unserved.store.getSnapshot();
  assert(unservedSnapshot.inventoryAccounting.cookingWasteExpenseG === 7, "unserved dish Waste가 잘못됐습니다.");
  await assertRejectedUnchanged(
    unserved,
    () => unserved.api.wasteDish(commandInput(unserved, "qa:unserved:waste-again:cmd", movementPayload("unserved:waste-again", {
      dishId: "dish:unserved",
    }))),
    "DISH_COST_ALREADY_RECOGNIZED",
    "dish Waste duplicate",
  );
  return { cookFailureWasteG: 9, unservedDishWasteG: 7, duplicateRecognitions: 0 };
}

/** Escrow rollback restores exact lot and reservation source lines. **Validates: Requirements 5.10, 8.6, 8.7, 8.8, 11.6** */
async function escrowExactRestoreExample() {
  const inventory = createInventoryState({
    lots: [lot("lot:restore", "ingredient.restore", 5, 11, 1, 72)],
    reservations: [{
      reservationId: "reservation:restore",
      saleSlotId: "slot:restore",
      lotId: "lot:restore",
      ingredientId: "ingredient.restore",
      quantity: 3,
    }],
  });
  const harness = createHarness({
    runtimePhase: "SERVICE",
    inventory,
    inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 11 }),
  });
  assert((await harness.api.startCookEscrow(commandInput(harness, "qa:restore:start:cmd", movementPayload("restore:start", {
    escrowId: "escrow:restore",
    recipeId: "recipe:restore",
    saleSlotId: "slot:restore",
    requirements: [{ ingredientId: "ingredient.restore", quantity: 2 }],
  })))).ok, "restore escrow start가 실패했습니다.");
  assert((await harness.api.restoreCookEscrow(commandInput(harness, "qa:restore:end:cmd", movementPayload("restore:end", {
    escrowId: "escrow:restore",
  })))).ok, "escrow restore가 실패했습니다.");
  const snapshot = harness.store.getSnapshot();
  assert(equivalent(snapshot.inventory, inventory), "escrow rollback이 source lot/reservation을 exact restore하지 않았습니다.");
  assert(snapshot.inventoryAccounting.costMovements.length === 2, "rollback cost movement audit가 누락됐습니다.");
  assert(reconcileInventoryAccounting(snapshot.inventory, snapshot.inventoryAccounting).ok, "restore 뒤 재고 대사가 실패했습니다.");
  return { exactRestore: true, movementAuditEdges: 2 };
}

/** Contract prepaid moves once to loss without cash flow. **Validates: Requirements 5.5, 17.7** */
async function contractPrepaidLossExample() {
  const harness = createHarness({
    economy: createEconomyState({ cashG: 100, contractPrepaidAssetG: 20 }),
    inventoryAccounting: createInventoryAccountingState({ openingContractPrepaidAssetG: 20 }),
  });
  const result = await harness.api.recognizeContractFailureLoss(commandInput(
    harness,
    "qa:contract-loss:cmd",
    movementPayload("contract-loss", { amountG: 7, contractId: "contract:loss" }),
  ));
  assert(result.ok, `prepaid→loss가 실패했습니다: ${result.code}`);
  const snapshot = harness.store.getSnapshot();
  assert(snapshot.economy.contractPrepaidAssetG === 13, "prepaid asset 감소가 잘못됐습니다.");
  assert(snapshot.inventoryAccounting.contractFailureLossG === 7, "contract failure loss가 잘못됐습니다.");
  assert(snapshot.economy.cashG === 100 && snapshot.economy.ledger.length === 0, "failure loss가 추가 cash outflow를 만들었습니다.");
  const reconciliation = reconcileInventoryAccounting(snapshot.inventory, snapshot.inventoryAccounting, { economy: snapshot.economy });
  assert(reconciliation.ok && reconciliation.prepaid.status === "PASS", "prepaid/loss 대사가 실패했습니다.");
  return { prepaidAssetG: 13, contractFailureLossG: 7, additionalCashOutflowG: 0 };
}

/** Invalid operations preserve all touched slices. **Validates: Requirements 8.5, 8.8, 11.7** */
async function failureRollbackMatrix() {
  const insufficient = createHarness({
    runtimePhase: "SERVICE",
    inventory: createInventoryState({ lots: [lot("lot:small", "ingredient.small", 1, 2, 1)] }),
    inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 2 }),
  });
  await assertRejectedUnchanged(
    insufficient,
    () => insufficient.api.startCookEscrow(commandInput(insufficient, "qa:reject:shortage:cmd", movementPayload("reject:shortage", {
      escrowId: "escrow:shortage",
      recipeId: "recipe:shortage",
      requirements: [{ ingredientId: "ingredient.small", quantity: 2 }],
    }))),
    "INVENTORY_SHORTAGE",
    "cook shortage",
  );

  const invalidQuality = createHarness({
    runtimePhase: "SERVICE",
    inventory: createInventoryState({ lots: [lot("lot:quality", "ingredient.quality", 1, 3, 1)] }),
    inventoryAccounting: createInventoryAccountingState({ openingInventoryBookCostG: 3 }),
  });
  assert((await invalidQuality.api.startCookEscrow(commandInput(invalidQuality, "qa:reject:quality-start:cmd", movementPayload("reject:quality-start", {
    escrowId: "escrow:quality",
    recipeId: "recipe:quality",
    requirements: [{ ingredientId: "ingredient.quality", quantity: 1 }],
  })))).ok, "invalid quality setup escrow가 실패했습니다.");
  await assertRejectedUnchanged(
    invalidQuality,
    () => invalidQuality.api.completeCookToDish(commandInput(invalidQuality, "qa:reject:quality:cmd", movementPayload("reject:quality", {
      escrowId: "escrow:quality",
      dishId: "dish:quality",
      quality: 101,
    }))),
    "INVALID_INGREDIENT_QUALITY",
    "invalid dish quality",
  );

  const prepaid = createHarness({
    economy: createEconomyState({ cashG: 100, contractPrepaidAssetG: 5 }),
    inventoryAccounting: createInventoryAccountingState({ openingContractPrepaidAssetG: 5 }),
  });
  await assertRejectedUnchanged(
    prepaid,
    () => prepaid.api.recognizeContractFailureLoss(commandInput(prepaid, "qa:reject:prepaid:cmd", movementPayload("reject:prepaid", {
      amountG: 6,
      contractId: "contract:reject",
    }))),
    "INSUFFICIENT_CONTRACT_PREPAID_ASSET",
    "prepaid overdraw",
  );
  return { rejectedOperations: 3, partialMutations: 0 };
}

/** Append-only graph links every cost destination. **Validates: Requirements 5.14** */
function costMovementGraphExample() {
  let inventory = createInventoryState();
  let accounting = createInventoryAccountingState();
  const acquired = planLotAcquisition(inventory, accounting, movementPayload("graph:acquire", {
    source: INVENTORY_ACQUISITION_SOURCE.MARKET,
    lot: lot("lot:graph", "ingredient.graph", 1, 6, 1),
  }));
  assert(acquired.ok, "graph acquisition이 실패했습니다.");
  inventory = acquired.plan.inventory;
  accounting = acquired.plan.accounting;
  const escrow = planIngredientsToEscrow(inventory, accounting, movementPayload("graph:escrow", {
    escrowId: "escrow:graph",
    recipeId: "recipe:graph",
    requirements: [{ ingredientId: "ingredient.graph", quantity: 1 }],
  }));
  assert(escrow.ok, "graph escrow가 실패했습니다.");
  inventory = escrow.plan.inventory;
  accounting = escrow.plan.accounting;
  const dish = planEscrowToDish(inventory, accounting, movementPayload("graph:dish", {
    escrowId: "escrow:graph",
    dishId: "dish:graph",
  }));
  assert(dish.ok, "graph dish가 실패했습니다.");
  inventory = dish.plan.inventory;
  accounting = dish.plan.accounting;
  const cogs = planDishToCogs(inventory, accounting, movementPayload("graph:cogs", { dishId: "dish:graph" }));
  assert(cogs.ok, "graph COGS가 실패했습니다.");
  const graph = buildCostMovementGraph(cogs.plan.accounting);
  assert(graph.edges.length === 4, "cost movement edge 수가 잘못됐습니다.");
  assert(graph.byCauseId["qa:cause:graph:cogs"].length === 1, "Cause_Id cost movement 연결이 잘못됐습니다.");
  assert(graph.byDestination.COGS.length === 1, "COGS destination index가 잘못됐습니다.");
  assert(
    graph.byMovementId["qa:movement:graph:cogs"].references.dishId === "dish:graph",
    "movement ID drill-down이 dish reference를 보존하지 않았습니다.",
  );
  return {
    edges: graph.edges.length,
    causeLinks: graph.byCauseId["qa:cause:graph:cogs"].length,
    destinations: Object.keys(graph.byDestination).sort(),
  };
}

function exactBookCostTaken(bookCostBefore, quantityBefore, takeQuantity) {
  if (takeQuantity === quantityBefore) return bookCostBefore;
  const numerator = BigInt(bookCostBefore) * BigInt(takeQuantity);
  const denominator = BigInt(quantityBefore);
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/** Design Property 4 broad partial/last-cost sweep. **Validates: Requirements 5.10, 8.7** */
function bookCostConservationSweep() {
  let sequences = 0;
  let consumptionSteps = 0;
  for (let originalQuantity = 1; originalQuantity <= 32; originalQuantity += 1) {
    for (let originalBookCostG = 0; originalBookCostG < 64; originalBookCostG += 1) {
      for (let strategy = 0; strategy < 2; strategy += 1) {
        let quantity = originalQuantity;
        let bookCostG = originalBookCostG;
        let recognizedBookCostG = 0;
        let step = 0;
        while (quantity > 0) {
          const maximumChunk = Math.min(quantity, 5);
          const takeQuantity = strategy === 0
            ? 1
            : 1 + ((step * 7 + originalQuantity * 3 + originalBookCostG) % maximumChunk);
          const expected = exactBookCostTaken(bookCostG, quantity, takeQuantity);
          const actual = calculateBookCostTaken(bookCostG, quantity, takeQuantity);
          assert(actual === expected, `Book_Cost Half-Up sweep가 불일치합니다: q=${quantity}, cost=${bookCostG}, take=${takeQuantity}`);
          assert(actual >= 0 && actual <= bookCostG, "소비 Book_Cost가 source cost 범위를 벗어났습니다.");
          quantity -= takeQuantity;
          bookCostG -= actual;
          recognizedBookCostG += actual;
          assert(Number.isSafeInteger(recognizedBookCostG), "누적 Book_Cost가 safe integer가 아닙니다.");
          step += 1;
          consumptionSteps += 1;
        }
        assert(bookCostG === 0, "마지막 수량 소비 후 lot Book_Cost가 남았습니다.");
        assert(recognizedBookCostG === originalBookCostG, "부분/마지막 소비 누적 Book_Cost가 보존되지 않았습니다.");
        sequences += 1;
      }
    }
  }
  return { sequences, consumptionSteps };
}

function sumLotQuantity(inventory) {
  return inventory.lots.reduce((total, item) => total + item.quantity, 0);
}

function sumEscrowQuantity(inventory) {
  return inventory.cookEscrows.reduce((total, escrow) => total + escrow.totalQuantity, 0);
}

function assertCostConservation(inventory, accounting, expectedTotalBookCostG, label) {
  const state = validateInventoryState(inventory);
  assert(state.ok, `${label}: inventory invariant가 실패했습니다: ${state.code}`);
  const reconciliation = reconcileInventoryAccounting(inventory, accounting);
  assert(reconciliation.ok, `${label}: 재고 대사가 실패했습니다: ${reconciliation.code}`);
  const locations = projectCostLocations(inventory, accounting);
  const locatedBookCostG = locations.lotG + locations.escrowG + locations.dishG + locations.cogsG + locations.wasteG;
  assert(locatedBookCostG === expectedTotalBookCostG, `${label}: Book_Cost가 단일 위치 합계에서 보존되지 않았습니다.`);
  return reconciliation;
}

/** Design Property 4 lot→escrow→dish/COGS/Waste/restore sweep. **Validates: Requirements 5.2, 5.3, 5.4, 5.10, 8.6, 8.7, 8.8** */
function costMovementConservationSweep() {
  const scenarioCount = 160;
  let reconciliationChecks = 0;
  let movementEdges = 0;
  const branchCounts = { restore: 0, cogs: 0, escrowWaste: 0, dishWaste: 0 };

  for (let sample = 0; sample < scenarioCount; sample += 1) {
    const firstQuantity = sample % 5 + 1;
    const secondQuantity = (sample * 3) % 5 + 1;
    const firstCostG = (sample * 7) % 19;
    const secondCostG = (sample * 11 + 3) % 23;
    const openingQuantity = firstQuantity + secondQuantity;
    const openingBookCostG = firstCostG + secondCostG;
    const takeQuantity = sample * 5 % openingQuantity + 1;
    const openingInventory = createInventoryState({
      lots: [
        lot(`lot:sweep:${sample}:b`, "ingredient.sweep", secondQuantity, secondCostG, 2, 70),
        lot(`lot:sweep:${sample}:a`, "ingredient.sweep", firstQuantity, firstCostG, 1, 40),
      ],
    });
    let inventory = openingInventory;
    let accounting = createInventoryAccountingState({ openingInventoryBookCostG: openingBookCostG });
    const started = planIngredientsToEscrow(inventory, accounting, movementPayload(`sweep:${sample}:start`, {
      escrowId: `escrow:sweep:${sample}`,
      recipeId: "recipe:sweep",
      requirements: [{ ingredientId: "ingredient.sweep", quantity: takeQuantity }],
    }));
    assert(started.ok, `cost movement sweep ${sample} escrow가 실패했습니다: ${started.code}`);
    inventory = started.plan.inventory;
    accounting = started.plan.accounting;
    assert(sumLotQuantity(inventory) + sumEscrowQuantity(inventory) === openingQuantity, `sweep ${sample}: escrow quantity가 보존되지 않았습니다.`);
    assertCostConservation(inventory, accounting, openingBookCostG, `sweep ${sample} escrow`);
    reconciliationChecks += 1;

    const branch = sample % 4;
    if (branch === 0) {
      const restored = planEscrowRestore(inventory, accounting, movementPayload(`sweep:${sample}:restore`, {
        escrowId: `escrow:sweep:${sample}`,
      }));
      assert(restored.ok, `cost movement sweep ${sample} restore가 실패했습니다: ${restored.code}`);
      inventory = restored.plan.inventory;
      accounting = restored.plan.accounting;
      assert(equivalent(inventory, openingInventory), `sweep ${sample}: rollback이 source inventory를 exact restore하지 않았습니다.`);
      assert(sumLotQuantity(inventory) === openingQuantity, `sweep ${sample}: restore quantity가 보존되지 않았습니다.`);
      branchCounts.restore += 1;
    } else if (branch === 1) {
      const dish = planEscrowToDish(inventory, accounting, movementPayload(`sweep:${sample}:dish`, {
        escrowId: `escrow:sweep:${sample}`,
        dishId: `dish:sweep:${sample}`,
      }));
      assert(dish.ok, `cost movement sweep ${sample} dish가 실패했습니다: ${dish.code}`);
      const cogs = planDishToCogs(dish.plan.inventory, dish.plan.accounting, movementPayload(`sweep:${sample}:cogs`, {
        dishId: `dish:sweep:${sample}`,
      }));
      assert(cogs.ok, `cost movement sweep ${sample} COGS가 실패했습니다: ${cogs.code}`);
      inventory = cogs.plan.inventory;
      accounting = cogs.plan.accounting;
      assert(sumLotQuantity(inventory) + takeQuantity === openingQuantity, `sweep ${sample}: COGS quantity가 보존되지 않았습니다.`);
      branchCounts.cogs += 1;
    } else if (branch === 2) {
      const waste = planEscrowToWaste(inventory, accounting, movementPayload(`sweep:${sample}:escrow-waste`, {
        escrowId: `escrow:sweep:${sample}`,
      }));
      assert(waste.ok, `cost movement sweep ${sample} escrow Waste가 실패했습니다: ${waste.code}`);
      inventory = waste.plan.inventory;
      accounting = waste.plan.accounting;
      assert(sumLotQuantity(inventory) + takeQuantity === openingQuantity, `sweep ${sample}: escrow Waste quantity가 보존되지 않았습니다.`);
      branchCounts.escrowWaste += 1;
    } else {
      const dish = planEscrowToDish(inventory, accounting, movementPayload(`sweep:${sample}:dish`, {
        escrowId: `escrow:sweep:${sample}`,
        dishId: `dish:sweep:${sample}`,
      }));
      assert(dish.ok, `cost movement sweep ${sample} dish가 실패했습니다: ${dish.code}`);
      const waste = planDishToWaste(dish.plan.inventory, dish.plan.accounting, movementPayload(`sweep:${sample}:dish-waste`, {
        dishId: `dish:sweep:${sample}`,
      }));
      assert(waste.ok, `cost movement sweep ${sample} dish Waste가 실패했습니다: ${waste.code}`);
      inventory = waste.plan.inventory;
      accounting = waste.plan.accounting;
      assert(sumLotQuantity(inventory) + takeQuantity === openingQuantity, `sweep ${sample}: dish Waste quantity가 보존되지 않았습니다.`);
      branchCounts.dishWaste += 1;
    }

    assert(sumEscrowQuantity(inventory) === 0, `sweep ${sample}: terminal branch에 escrow가 남았습니다.`);
    assertCostConservation(inventory, accounting, openingBookCostG, `sweep ${sample} terminal`);
    reconciliationChecks += 1;
    movementEdges += accounting.costMovements.length;
  }

  return { scenarioCount, reconciliationChecks, movementEdges, branchCounts };
}

/** Validator mutation examples. **Validates: Requirements 8.1, 8.2, 8.6** */
function inventoryStateContractMutationExample() {
  const valid = createInventoryState({ lots: [lot("lot:contract", "ingredient.contract", 2, 3, 1, 50)] });

  const emptyWithCost = cloneValue(valid);
  emptyWithCost.lots[0].quantity = 0;
  const emptyResult = validateInventoryState(emptyWithCost);
  assert(!emptyResult.ok && emptyResult.code === "EMPTY_LOT_HAS_BOOK_COST", "빈 lot의 잔여 Book_Cost를 탐지하지 못했습니다.");

  const invalidQuality = cloneValue(valid);
  invalidQuality.lots[0].quality = 101;
  const qualityResult = validateInventoryState(invalidQuality);
  assert(!qualityResult.ok && qualityResult.code === "INVALID_INGREDIENT_QUALITY", "Quality 101을 탐지하지 못했습니다.");

  const overReserved = cloneValue(valid);
  overReserved.reservations.push({
    reservationId: "reservation:contract",
    saleSlotId: "slot:contract",
    lotId: "lot:contract",
    ingredientId: "ingredient.contract",
    quantity: 3,
  });
  const reservationResult = validateInventoryState(overReserved);
  assert(!reservationResult.ok && reservationResult.code === "LOT_OVER_RESERVED", "lot over-reservation을 탐지하지 못했습니다.");

  return { invalidStatesDetected: 3 };
}

/** Reconciliation detects a mismatch without mutating inputs. **Validates: Requirements 5.10, 5.11** */
function reconciliationMismatchDetectionExample() {
  const inventory = createInventoryState({ lots: [lot("lot:mismatch", "ingredient.mismatch", 1, 9, 1)] });
  const accounting = createInventoryAccountingState({ openingInventoryBookCostG: 8 });
  const inventoryBefore = cloneValue(inventory);
  const accountingBefore = cloneValue(accounting);
  const result = reconcileInventoryAccounting(inventory, accounting);
  assert(!result.ok && result.code === "INVENTORY_RECONCILIATION_FAILED", "재고 대사 mismatch를 탐지하지 못했습니다.");
  assert(result.inventory.deltaG === 1, `재고 대사 delta가 1G가 아닙니다: ${result.inventory.deltaG}`);
  assert(equivalent(inventory, inventoryBefore) && equivalent(accounting, accountingBefore), "대사 실패가 입력 state를 변경했습니다.");
  return { expectedEndingInventoryBookCostG: 8, actualEndingInventoryBookCostG: 9, deltaG: 1, mutations: 0 };
}

export async function runInventoryAccountingProbe() {
  const definitions = [
    ["ingredient-lot-projection", "Ingredient_Lot 필드·FIFO projection·lot 수량식", ["8.1", "8.2", "8.6"], ingredientLotProjectionExample],
    ["fifo-lot-permutations", "lot input permutation과 무관한 acquiredDay/lotId FIFO", ["8.3", "8.4", "8.6"], fifoReservationPermutationExample],
    ["shared-ingredient-shortage-full-rejection", "multi-Recipe 공유 재료 shortage 목록과 partial mutation 0", ["8.4", "8.5", "8.8", "9.4"], sharedIngredientShortageFullRejection],
    ["acquisition-capitalization-duplicate", "lot Book_Cost 자본화와 duplicate movement 전면 거절", ["5.1", "5.10", "8.1"], acquisitionAndDuplicateExample],
    ["partial-last-book-cost-example", "partial Half-Up과 마지막 수량 잔여 원가 전액", ["5.10", "8.7"], partialAndLastBookCostExample],
    ["book-cost-conservation-sweep", "4,096 partial/last Book_Cost 보존 sequence", ["5.10", "8.7"], bookCostConservationSweep],
    ["successful-dish-cogs-lifecycle", "lot→escrow→dish→COGS 단일 destination", ["5.2", "5.3", "5.10", "8.7", "8.8"], successfulDishCogsLifecycle],
    ["waste-destinations-once", "cook failure와 미서빙 dish Waste 단일 인식", ["5.4", "5.10"], wasteDestinationsExample],
    ["escrow-exact-restore", "CookEscrow lot/reservation/Book_Cost exact rollback", ["5.10", "8.6", "8.7", "8.8", "11.6"], escrowExactRestoreExample],
    ["contract-prepaid-loss", "prepaid→loss 단일 이동과 추가 cash outflow 0", ["5.5", "17.7"], contractPrepaidLossExample],
    ["failure-rollback-matrix", "shortage·invalid quality·prepaid overdraw partial mutation 0", ["8.5", "8.8", "11.7"], failureRollbackMatrix],
    ["cost-movement-graph", "append-only cost movement drill-down graph", ["5.14"], costMovementGraphExample],
    ["cost-movement-conservation-sweep", "160개 restore/COGS/Waste 수량·Book_Cost·대사 sequence", ["5.2", "5.3", "5.4", "5.10", "8.6", "8.7", "8.8"], costMovementConservationSweep],
    ["inventory-state-contract-mutations", "lot Quality·empty cost·reservation invariant mutation 탐지", ["8.1", "8.2", "8.6"], inventoryStateContractMutationExample],
    ["reconciliation-mismatch-detection", "재고 대사 mismatch 탐지와 입력 mutation 0", ["5.10", "5.11"], reconciliationMismatchDetectionExample],
  ];
  const results = [];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const detailsFor = (id) => results.find((result) => result.id === id)?.details ?? {};
  const rejectionIds = [
    "shared-ingredient-shortage-full-rejection",
    "acquisition-capitalization-duplicate",
    "waste-destinations-once",
    "failure-rollback-matrix",
  ];
  const rejectedOperationCount = rejectionIds.reduce(
    (total, id) => total + (detailsFor(id).rejectedOperations ?? 0),
    0,
  );
  const partialMutationCount = [
    "shared-ingredient-shortage-full-rejection",
    "failure-rollback-matrix",
  ].reduce((total, id) => total + (detailsFor(id).partialMutations ?? 0), 0);
  return Object.freeze({
    qaId: "task-14-inventory-accounting-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    lotPermutationCount: detailsFor("fifo-lot-permutations").permutations ?? 0,
    bookCostInvariantSequenceCount: detailsFor("book-cost-conservation-sweep").sequences ?? 0,
    bookCostConsumptionStepCount: detailsFor("book-cost-conservation-sweep").consumptionSteps ?? 0,
    costMovementInvariantSequenceCount: detailsFor("cost-movement-conservation-sweep").scenarioCount ?? 0,
    reconciliationCheckCount: detailsFor("cost-movement-conservation-sweep").reconciliationChecks ?? 0,
    rejectedOperationCount,
    partialMutationCount,
    results: Object.freeze(results),
  });
}
