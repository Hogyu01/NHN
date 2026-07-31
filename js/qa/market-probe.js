import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { multiplyDivideHalfUp } from "../core/money.js";
import { cloneValue } from "../core/result.js";
import {
  CORE_RNG_STREAMS,
  createRngRegistryState,
  RngRegistry,
} from "../core/rng.js";
import { GameStore } from "../core/store.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";
import { createEconomyState } from "../domain/economy.js";
import {
  createInventoryAccountingState,
  reconcileInventoryAccounting,
  registerInventoryAccounting,
} from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import {
  createMarketOfferId,
  createMarketState,
  generateDailyMarket,
  MARKET_PRICE_VARIANCE_PERCENT,
  MARKET_RNG_STREAM,
  projectMarket,
  registerMarketSystem,
  validateMarketState,
} from "../domain/market.js";

const QA_GENERATION_SAMPLES = 128;
const QA_BOUND_SAMPLES = 256;
const QA_GENERATION_ID = 15;

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

function requireProbeInputs(ingredients, purchaseLimitQuantity, priceVariancePercent) {
  assert(Array.isArray(ingredients) && ingredients.length > 0, "canonical ingredient 입력이 없습니다.");
  assert(
    Number.isSafeInteger(purchaseLimitQuantity) && purchaseLimitQuantity >= 0,
    "canonical Market_Purchase_Limit가 유효하지 않습니다.",
  );
  assert(
    priceVariancePercent === MARKET_PRICE_VARIANCE_PERCENT,
    `canonical price variance가 ${MARKET_PRICE_VARIANCE_PERCENT}%가 아닙니다.`,
  );
}

function createOffer({
  day = 1,
  ingredientId = "ingredient.qa_market",
  stock = 8,
  initialQuantity = stock,
  unitPriceG = 11,
  quality = 73,
} = {}) {
  return {
    offerId: createMarketOfferId(day, ingredientId),
    ingredientId,
    generatedDay: day,
    basePriceG: unitPriceG,
    priceDeltaPercent: 0,
    unitPriceG,
    initialQuantity,
    availableQuantity: stock,
    quality,
  };
}

function createHarness({
  seed = 0x15a11ce,
  day = 1,
  cashG = 100,
  contractReserveG = 0,
  stock = 8,
  initialQuantity = stock,
  unitPriceG = 11,
  quality = 73,
  purchaseLimitQuantity = 30,
  purchasedQuantity = initialQuantity - stock,
} = {}) {
  const campaignId = createCampaignId(seed, 0);
  const offer = createOffer({ day, stock, initialQuantity, unitPriceG, quality });
  const market = createMarketState({
    day,
    purchaseLimitQuantity,
    purchasedQuantity,
    offers: [offer],
  });
  const store = new GameStore({
    formatVersion: 1,
    revision: 0,
    runtimePhase: "PLANNING",
    checkpointPhase: "PLANNING_READY",
    generationId: QA_GENERATION_ID,
    campaign: {
      campaignId,
      masterSeed: seed,
      day,
      consecutiveArrearsCount: 0,
    },
    economy: createEconomyState({ cashG, contractReserveG }),
    market,
    inventory: createInventoryState(),
    inventoryAccounting: createInventoryAccountingState(),
    idCounters: createIdServiceState({
      campaignId,
      day,
      generationId: QA_GENERATION_ID,
    }),
    rng: createRngRegistryState(seed),
    untouched: { marker: "task-15-structural-sharing" },
  });
  const bus = new CommandBus({ store });
  registerCashTransactionAPI(bus);
  registerInventoryAccounting(bus);
  const marketSystem = registerMarketSystem(bus);
  return { store, bus, marketSystem, offerId: offer.offerId };
}

function purchaseInput(harness, commandId, quantity) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: harness.store.revision * 20,
    payload: {
      day: harness.store.getSnapshot().market.day,
      offerId: harness.offerId,
      quantity,
    },
  };
}

async function assertRejectedUnchanged(harness, quantity, expectedCode, label, commandId) {
  const before = harness.store.getSnapshot();
  const beforeValue = cloneValue(before);
  const signalsBefore = harness.bus.getSignalSnapshot();
  const metadataBefore = harness.store.getCommandMetadata();
  const revisionBefore = harness.store.revision;
  const commitsBefore = harness.store.commitCount;
  const result = await harness.marketSystem.purchaseOffer(
    purchaseInput(harness, commandId, quantity),
  );

  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), beforeValue), `${label}: state가 변경됐습니다.`);
  assert(harness.store.revision === revisionBefore, `${label}: revision이 변경됐습니다.`);
  assert(harness.store.commitCount === commitsBefore, `${label}: commit이 발생했습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadataBefore), `${label}: command metadata가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signalsBefore), `${label}: event/effect journal이 변경됐습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 실패 결과에 signal이 있습니다.`);
  return { code: result.code, partialMutations: 0 };
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

function sampleSeed(sample, salt = 0) {
  return (Math.imul(sample + 1, 0x9e3779b9) ^ 0xa5a5a5a5 ^ salt) >>> 0;
}

/** Same state replay and named-stream isolation sweep. **Validates: Requirements 7.7, 23.4** */
function deterministicGenerationAndStreamIsolation(ingredients, purchaseLimitQuantity) {
  let replayChecks = 0;
  let finalCursorChecks = 0;
  let streamIsolationChecks = 0;

  for (let sample = 0; sample < QA_GENERATION_SAMPLES; sample += 1) {
    const registry = new RngRegistry(sampleSeed(sample));
    for (let draw = 0; draw < sample % 7; draw += 1) registry.nextUint32(MARKET_RNG_STREAM);
    for (let streamIndex = 0; streamIndex < CORE_RNG_STREAMS.length; streamIndex += 1) {
      const stream = CORE_RNG_STREAMS[streamIndex];
      if (stream === MARKET_RNG_STREAM) continue;
      for (let draw = 0; draw < (sample + streamIndex) % 3; draw += 1) registry.nextUint32(stream);
    }
    const initialState = registry.snapshot();
    const initialValue = cloneValue(initialState);
    const day = sample % 14 + 1;
    const generationInput = {
      rngState: initialState,
      day,
      ingredients,
      purchaseLimitQuantity,
    };
    const first = generateDailyMarket(generationInput);
    const replay = generateDailyMarket(generationInput);
    const reordered = generateDailyMarket({
      ...generationInput,
      ingredients: [...ingredients].reverse(),
    });

    assert(equivalent(initialState, initialValue), `sample ${sample}: generator가 입력 RNG state를 변경했습니다.`);
    assert(equivalent(first.market, replay.market), `sample ${sample}: 동일 입력 market replay가 다릅니다.`);
    assert(equivalent(first.rngState, replay.rngState), `sample ${sample}: 동일 입력 최종 RNG state가 다릅니다.`);
    assert(equivalent(first.market, reordered.market), `sample ${sample}: canonical ingredient 순서가 offer 결과를 바꿨습니다.`);
    assert(
      equivalent(first.marketStreamAfter, replay.marketStreamAfter),
      `sample ${sample}: 동일 입력 최종 market cursor가 다릅니다.`,
    );
    assert(
      first.drawsConsumed === first.marketStreamAfter.drawCount - first.marketStreamBefore.drawCount,
      `sample ${sample}: drawCount delta가 보고값과 다릅니다.`,
    );
    replayChecks += 1;
    finalCursorChecks += 1;

    for (const stream of CORE_RNG_STREAMS) {
      if (stream === MARKET_RNG_STREAM) continue;
      assert(
        equivalent(first.rngState.streams[stream], initialState.streams[stream]),
        `sample ${sample}: market 생성이 ${stream} stream을 변경했습니다.`,
      );
      streamIsolationChecks += 1;
    }

    const perturbed = RngRegistry.fromState(initialState);
    for (let draw = 0; draw <= sample % 11; draw += 1) perturbed.nextUint32("demand");
    const isolated = generateDailyMarket({ ...generationInput, rngState: perturbed.snapshot() });
    assert(equivalent(first.market, isolated.market), `sample ${sample}: demand draw가 market offer를 변경했습니다.`);
    assert(
      equivalent(first.marketStreamAfter, isolated.marketStreamAfter),
      `sample ${sample}: demand draw가 market 최종 cursor를 변경했습니다.`,
    );
    streamIsolationChecks += 1;
  }

  return { replayChecks, finalCursorChecks, streamIsolationChecks };
}

/** Broad generator contract sweep. **Validates: Requirements 7.1, 7.2, 7.3, 7.7, 20.2, 20.3** */
function offerBoundsOrderingAndIdSweep(ingredients, purchaseLimitQuantity) {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.ingredientId, ingredient]));
  let offerInvariantChecks = 0;
  let safeIntegerPriceChecks = 0;
  let qualityChecks = 0;
  let stockChecks = 0;

  for (let sample = 0; sample < QA_BOUND_SAMPLES; sample += 1) {
    const day = sample % 14 + 1;
    const generated = generateDailyMarket({
      rngState: createRngRegistryState(sampleSeed(sample, 0x51f15e)),
      day,
      ingredients,
      purchaseLimitQuantity,
    });
    const validation = validateMarketState(generated.market);
    assert(validation.ok, `sample ${sample}: generated MarketState가 유효하지 않습니다: ${validation.code}`);
    assert(generated.market.offers.length === ingredients.length, `sample ${sample}: ingredient별 offer가 생성되지 않았습니다.`);
    const orderedIds = generated.market.offers.map((offer) => offer.ingredientId);
    assert(
      equivalent(orderedIds, [...orderedIds].sort()),
      `sample ${sample}: offer ordering이 ingredient ID ascending이 아닙니다.`,
    );
    assert(generated.drawsConsumed >= ingredients.length * 5, `sample ${sample}: ingredient별 고정 RNG operation이 누락됐습니다.`);

    for (const offer of generated.market.offers) {
      const ingredient = ingredientById.get(offer.ingredientId);
      assert(ingredient, `sample ${sample}: 알 수 없는 ingredient offer입니다: ${offer.ingredientId}`);
      const expectedPriceG = Math.max(
        1,
        multiplyDivideHalfUp(ingredient.basePriceG, 100 + offer.priceDeltaPercent, 100),
      );
      const minimumPriceG = Math.max(1, multiplyDivideHalfUp(ingredient.basePriceG, 80, 100));
      const maximumPriceG = Math.max(1, multiplyDivideHalfUp(ingredient.basePriceG, 120, 100));
      assert(
        Number.isSafeInteger(offer.unitPriceG) && offer.unitPriceG >= 1,
        `sample ${sample}: unit price가 1G 이상 safe integer가 아닙니다.`,
      );
      assert(
        offer.priceDeltaPercent >= -20 && offer.priceDeltaPercent <= 20 &&
          offer.unitPriceG === expectedPriceG &&
          offer.unitPriceG >= minimumPriceG && offer.unitPriceG <= maximumPriceG,
        `sample ${sample}: ${offer.ingredientId} 가격이 canonical ±20% 계약을 벗어났습니다.`,
      );
      assert(
        Number.isInteger(offer.quality) && offer.quality >= 0 && offer.quality <= 100,
        `sample ${sample}: ${offer.ingredientId} Quality가 integer 0..100이 아닙니다.`,
      );
      assert(
        Number.isSafeInteger(offer.availableQuantity) && offer.availableQuantity >= 0,
        `sample ${sample}: ${offer.ingredientId} stock이 non-negative safe integer가 아닙니다.`,
      );
      if (offer.availableQuantity > 0) {
        assert(
          offer.availableQuantity >= ingredient.marketStockRange.minimum &&
            offer.availableQuantity <= ingredient.marketStockRange.maximum,
          `sample ${sample}: ${offer.ingredientId} stock range를 벗어났습니다.`,
        );
      }
      assert(offer.initialQuantity === offer.availableQuantity, `sample ${sample}: 신규 offer stock baseline이 다릅니다.`);
      assert(
        offer.offerId === createMarketOfferId(day, offer.ingredientId),
        `sample ${sample}: stable offer ID가 day/ingredient에서 파생되지 않았습니다.`,
      );
      assert(offer.generatedDay === day, `sample ${sample}: generated day가 보존되지 않았습니다.`);
      safeIntegerPriceChecks += 1;
      qualityChecks += 1;
      stockChecks += 1;
      offerInvariantChecks += 1;
    }
  }

  return {
    generationSamples: QA_BOUND_SAMPLES,
    offerInvariantChecks,
    safeIntegerPriceChecks,
    qualityChecks,
    stockChecks,
  };
}

/** Read-only Available_Cash/stock/limit projection example. **Validates: Requirements 4.4, 7.1, 7.5** */
function marketProjectionExample() {
  const market = createMarketState({
    day: 1,
    purchaseLimitQuantity: 4,
    offers: [
      createOffer({ ingredientId: "ingredient.qa_a", stock: 10, unitPriceG: 7 }),
      createOffer({ ingredientId: "ingredient.qa_b", stock: 2, unitPriceG: 30 }),
    ],
  });
  const economy = createEconomyState({ cashG: 50, contractReserveG: 10 });
  const beforeMarket = cloneValue(market);
  const beforeEconomy = cloneValue(economy);
  const projection = projectMarket(market, economy);
  assert(projection.availableCashG === 40, "projection Available_Cash가 cash-reserve와 다릅니다.");
  assert(projection.remainingPurchaseLimitQuantity === 4, "projection remaining limit가 잘못됐습니다.");
  assert(projection.offers[0].maximumPurchasableQuantity === 4, "첫 offer projection이 limit을 적용하지 않았습니다.");
  assert(projection.offers[1].maximumPurchasableQuantity === 1, "둘째 offer projection이 Available_Cash를 적용하지 않았습니다.");
  assert(equivalent(market, beforeMarket) && equivalent(economy, beforeEconomy), "projection이 source state를 변경했습니다.");
  return { availableCashG: 40, maximumPurchasableQuantities: [4, 1], mutations: 0 };
}

/** Payload matrix is rejected before draft creation. **Validates: Requirements 4.6, 4.7, 7.4** */
async function invalidQuantityPreDraftRejection() {
  const invalidQuantities = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "1",
    null,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (let index = 0; index < invalidQuantities.length; index += 1) {
    const harness = createHarness();
    await assertRejectedUnchanged(
      harness,
      invalidQuantities[index],
      "INVALID_MARKET_PURCHASE_QUANTITY",
      `invalid quantity ${index}`,
      `qa:market:invalid-quantity:${index}`,
    );
  }
  return { rejectedInputs: invalidQuantities.length, partialMutations: 0 };
}

/** Full stock guard; partial purchase is forbidden. **Validates: Requirements 4.6, 7.5** */
async function stockFullRejection() {
  const harness = createHarness({ stock: 4, purchaseLimitQuantity: 30, cashG: 1_000 });
  const result = await assertRejectedUnchanged(
    harness,
    5,
    "INSUFFICIENT_MARKET_STOCK",
    "stock guard",
    "qa:market:stock-reject",
  );
  return { ...result, requestedQuantity: 5, availableQuantity: 4 };
}

/** Full Available_Cash guard including reserve. **Validates: Requirements 4.4, 4.6, 7.5** */
async function availableCashFullRejection() {
  const harness = createHarness({
    stock: 10,
    unitPriceG: 10,
    purchaseLimitQuantity: 30,
    cashG: 100,
    contractReserveG: 60,
  });
  const result = await assertRejectedUnchanged(
    harness,
    5,
    "INSUFFICIENT_AVAILABLE_CASH",
    "Available_Cash guard",
    "qa:market:cash-reject",
  );
  return { ...result, totalCostG: 50, availableCashG: 40 };
}

/** Full Market_Purchase_Limit guard. **Validates: Requirements 4.6, 7.5** */
async function purchaseLimitFullRejection() {
  const harness = createHarness({ stock: 10, purchaseLimitQuantity: 4, cashG: 1_000 });
  const result = await assertRejectedUnchanged(
    harness,
    5,
    "MARKET_PURCHASE_LIMIT_EXCEEDED",
    "Market_Purchase_Limit guard",
    "qa:market:limit-reject",
  );
  return { ...result, requestedQuantity: 5, remainingPurchaseLimitQuantity: 4 };
}

/** One successful AtomicTransaction reconciles cash, ledger, lot, and Book_Cost. **Validates: Requirements 4.1, 4.2, 4.4, 5.1, 5.10, 7.6** */
async function approvedPurchaseAtomicReconciliation() {
  const harness = createHarness({
    stock: 8,
    unitPriceG: 11,
    quality: 73,
    purchaseLimitQuantity: 10,
    cashG: 100,
    contractReserveG: 20,
  });
  const before = harness.store.getSnapshot();
  const result = await harness.marketSystem.purchaseOffer(
    purchaseInput(harness, "qa:market:approved", 3),
  );
  assert(result.ok, `승인 market purchase가 실패했습니다: ${result.code}`);
  const after = harness.store.getSnapshot();
  const offerAfter = after.market.offers[0];
  const ledgerEntry = after.economy.ledger[0];
  const lot = after.inventory.lots[0];
  const movement = after.inventoryAccounting.costMovements[0];

  assert(harness.store.revision === 1 && harness.store.commitCount === 1, "승인 구매가 single commit이 아닙니다.");
  assert(result.revision === 1 && result.events.length === 1 && result.effects.length === 0, "승인 signal/revision cardinality가 잘못됐습니다.");
  assert(result.events[0].type === "market.offer-purchased", "market committed event type이 잘못됐습니다.");
  assert(after.economy.cashG === 67 && after.economy.contractReserveG === 20, "cash/reserve 결과가 잘못됐습니다.");
  assert(ledgerEntry.category === "MARKET" && ledgerEntry.direction === "OUTFLOW", "market ledger 분류가 잘못됐습니다.");
  assert(ledgerEntry.amountG === 33, "ledger outflow가 unit price×quantity와 다릅니다.");
  assert(offerAfter.availableQuantity === 5 && after.market.purchasedQuantity === 3, "offer/limit 수량 감소가 잘못됐습니다.");
  assert(lot.ingredientId === before.market.offers[0].ingredientId, "lot ingredient가 offer와 다릅니다.");
  assert(lot.quantity === 3 && lot.quality === 73 && lot.acquiredDay === 1, "Ingredient_Lot 필드가 구매와 다릅니다.");
  assert(lot.bookCostG === 33 && lot.bookCostG === ledgerEntry.amountG, "ledger outflow와 lot Book_Cost가 다릅니다.");
  assert(movement.amountG === 33 && movement.quantity === 3, "market acquisition cost movement가 다릅니다.");
  assert(after.inventoryAccounting.marketAcquisitionG === 33, "market acquisition 총액이 자본화되지 않았습니다.");
  assert(reconcileInventoryAccounting(after.inventory, after.inventoryAccounting).ok, "승인 뒤 inventory accounting 대사가 실패했습니다.");
  for (const kind of ["tx", "cause", "lot"]) {
    assert(
      after.idCounters.counters[kind] === before.idCounters.counters[kind] + 1,
      `${kind} ID counter가 정확히 한 번 증가하지 않았습니다.`,
    );
  }
  for (const kind of Object.keys(before.idCounters.counters)) {
    if (["tx", "cause", "lot"].includes(kind)) continue;
    assert(after.idCounters.counters[kind] === before.idCounters.counters[kind], `${kind} ID counter가 오염됐습니다.`);
  }
  assert(equivalent(after.rng, before.rng), "구매 transaction이 RNG cursor를 변경했습니다.");
  assert(after.untouched === before.untouched, "구매 write-set 밖 slice가 structural sharing을 잃었습니다.");
  assert(harness.bus.getSignalSnapshot().events.length === 1, "committed event가 journal에 한 번 기록되지 않았습니다.");

  return {
    commits: harness.store.commitCount,
    ledgerOutflowG: ledgerEntry.amountG,
    lotBookCostG: lot.bookCostG,
    offerDecrement: before.market.offers[0].availableQuantity - offerAfter.availableQuantity,
    idCountersAdvanced: 3,
    rngCursorMutations: 0,
    reconciliation: "INVENTORY_RECONCILIATION_PASS",
  };
}

/** Identical purchase state/action replay produces identical IDs and state. **Validates: Requirements 7.6, 7.7, 23.4** */
async function deterministicPurchaseReplay() {
  const left = createHarness({ stock: 9, unitPriceG: 13, cashG: 200, contractReserveG: 20 });
  const right = createHarness({ stock: 9, unitPriceG: 13, cashG: 200, contractReserveG: 20 });
  const commandId = "qa:market:deterministic-purchase";
  const [leftResult, rightResult] = await Promise.all([
    left.marketSystem.purchaseOffer(purchaseInput(left, commandId, 4)),
    right.marketSystem.purchaseOffer(purchaseInput(right, commandId, 4)),
  ]);
  assert(leftResult.ok && rightResult.ok, "deterministic purchase replay 중 하나가 실패했습니다.");
  assert(equivalent(left.store.getSnapshot(), right.store.getSnapshot()), "동일 purchase replay state가 다릅니다.");
  assert(equivalent(leftResult.events, rightResult.events), "동일 purchase replay event/ID가 다릅니다.");
  assert(equivalent(left.bus.getSignalSnapshot(), right.bus.getSignalSnapshot()), "동일 purchase journal이 다릅니다.");
  const snapshot = left.store.getSnapshot();
  return {
    replayTransactions: 2,
    transactionId: snapshot.economy.ledger[0].transactionId,
    lotId: snapshot.inventory.lots[0].lotId,
    finalRevision: snapshot.revision,
  };
}

export async function runMarketProbe({
  ingredients,
  purchaseLimitQuantity,
  priceVariancePercent,
} = {}) {
  requireProbeInputs(ingredients, purchaseLimitQuantity, priceVariancePercent);
  const definitions = [
    [
      "deterministic-generation-stream-isolation",
      "동일 seed/market state/day/input offer·최종 cursor 재현과 다른 stream 격리",
      ["7.7", "23.4"],
      () => deterministicGenerationAndStreamIsolation(ingredients, purchaseLimitQuantity),
    ],
    [
      "offer-bounds-ordering-stable-ids",
      "256 seeds의 가격 ±20%·1G safe integer·Quality·stock·stable ordering/ID",
      ["7.1", "7.2", "7.3", "7.7", "20.2", "20.3"],
      () => offerBoundsOrderingAndIdSweep(ingredients, purchaseLimitQuantity),
    ],
    ["market-projection", "Available_Cash/stock/limit read-only projection", ["4.4", "7.1", "7.5"], marketProjectionExample],
    ["invalid-quantity-pre-draft", "0·invalid integer quantity draft 전 전면 거절", ["4.6", "4.7", "7.4"], invalidQuantityPreDraftRejection],
    ["stock-full-rejection", "부분 stock 요청의 state/signal/ID/RNG 전면 거절", ["4.6", "7.5"], stockFullRejection],
    ["available-cash-full-rejection", "reserve 반영 Available_Cash 부족 전면 거절", ["4.4", "4.6", "7.5"], availableCashFullRejection],
    ["purchase-limit-full-rejection", "Market_Purchase_Limit 부족 전면 거절", ["4.6", "7.5"], purchaseLimitFullRejection],
    ["approved-atomic-reconciliation", "cash·ledger·offer·lot·Book_Cost single commit 및 대사", ["4.1", "4.2", "5.1", "5.10", "7.6"], approvedPurchaseAtomicReconciliation],
    ["deterministic-purchase-replay", "동일 구매 입력의 state·ID·event 재현", ["7.6", "7.7", "23.4"], deterministicPurchaseReplay],
  ];
  const results = [];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const detailsFor = (id) => results.find((result) => result.id === id)?.details ?? {};
  const rejectionIds = [
    "invalid-quantity-pre-draft",
    "stock-full-rejection",
    "available-cash-full-rejection",
    "purchase-limit-full-rejection",
  ];
  const rejectedInputCount = rejectionIds.reduce((total, id) => {
    const details = detailsFor(id);
    return total + (details.rejectedInputs ?? (details.code ? 1 : 0));
  }, 0);
  const partialMutationCount = rejectionIds.reduce(
    (total, id) => total + (detailsFor(id).partialMutations ?? 0),
    0,
  );

  return Object.freeze({
    qaId: "task-15-deterministic-market-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    generationReplayCount: detailsFor("deterministic-generation-stream-isolation").replayChecks ?? 0,
    finalCursorCheckCount: detailsFor("deterministic-generation-stream-isolation").finalCursorChecks ?? 0,
    streamIsolationCheckCount: detailsFor("deterministic-generation-stream-isolation").streamIsolationChecks ?? 0,
    offerInvariantCheckCount: detailsFor("offer-bounds-ordering-stable-ids").offerInvariantChecks ?? 0,
    rejectedInputCount,
    fullRejectionGuardCount: rejectionIds.length,
    partialMutationCount,
    approvedCommitCount: detailsFor("approved-atomic-reconciliation").commits ?? 0,
    ledgerOutflowG: detailsFor("approved-atomic-reconciliation").ledgerOutflowG ?? null,
    lotBookCostG: detailsFor("approved-atomic-reconciliation").lotBookCostG ?? null,
    results: Object.freeze(results),
  });
}
