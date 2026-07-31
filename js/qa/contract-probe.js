import { CommandBus } from "../core/command-bus.js";
import { createCampaignId, createIdServiceState } from "../core/ids.js";
import { multiplyDivideHalfUp, sumG } from "../core/money.js";
import { cloneValue } from "../core/result.js";
import {
  CORE_RNG_STREAMS,
  createRngRegistryState,
  RngRegistry,
} from "../core/rng.js";
import { GameStore } from "../core/store.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";
import {
  allocateContractBookCost,
  CONTRACT_OFFER_RNG_STREAM,
  CONTRACT_RESOLUTION_OUTCOME,
  CONTRACT_RESOLUTION_RNG_STREAM,
  CONTRACT_RISK_ORDER,
  CONTRACT_RISK_TABLE,
  CONTRACT_STATUS,
  createContractState,
  generateContractResolution,
  generateDailyContractOffers,
  projectContracts,
  registerContractSystem,
} from "../domain/contract.js";
import { createEconomyState } from "../domain/economy.js";
import { reconcileCashWithLedger } from "../domain/economy-ledger.js";
import {
  createInventoryAccountingState,
  reconcileInventoryAccounting,
  registerInventoryAccounting,
} from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";

const QA_GENERATION_ID = 16;
const QA_GENERATION_SAMPLES = 64;

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

function sampleSeed(sample, salt = 0) {
  return (Math.imul(sample + 1, 0x9e3779b9) ^ 0x16c0ffee ^ salt) >>> 0;
}

function acceptedRecord(offer) {
  return {
    ...cloneValue(offer),
    status: CONTRACT_STATUS.ACCEPTED_PENDING,
    acceptedDay: offer.generatedDay,
    resolutionDay: offer.arrivalDay,
    acceptTransactionId: "qa.contract.accept.tx",
    acceptCauseId: "qa.contract.accept.cause",
    prepaidMovementId: "qa.contract.accept.prepaid",
    resolution: null,
  };
}

function generateDay({ seed, day, ingredients, configuration, fixedCostG, rngState = null }) {
  return generateDailyContractOffers({
    rngState: rngState ?? createRngRegistryState(seed),
    day,
    ingredients,
    configuration,
    fixedCostG,
  });
}

function createHarness({
  ingredients,
  configuration,
  fixedCostG,
  seed = 0x16a11ce,
  day = 1,
  cashG = 2_000,
  contractReserveG = 0,
} = {}) {
  const campaignId = createCampaignId(seed, 0);
  const generation = generateDay({ seed, day, ingredients, configuration, fixedCostG });
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
    contracts: generation.contracts,
    inventory: createInventoryState(),
    inventoryAccounting: createInventoryAccountingState(),
    idCounters: createIdServiceState({
      campaignId,
      day,
      generationId: QA_GENERATION_ID,
    }),
    rng: generation.rngState,
    untouched: { marker: "task-16-structural-sharing" },
  });
  const bus = new CommandBus({ store });
  registerCashTransactionAPI(bus);
  registerInventoryAccounting(bus);
  const contractSystem = registerContractSystem(bus);
  return { store, bus, contractSystem, generation, ingredients, configuration, fixedCostG, seed };
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

function acceptInput(harness, risk, commandId, fixedCostRiskConfirmed = false, overrides = {}) {
  const offer = harness.store.getSnapshot().contracts.offers.find((candidate) => candidate.risk === risk);
  return commandInput(harness, commandId, {
    day: harness.store.getSnapshot().contracts.day,
    offerId: offer.offerId,
    fixedCostRiskConfirmed,
  }, overrides);
}

function resolveInput(harness, contractId, commandId, overrides = {}) {
  return commandInput(harness, commandId, {
    day: harness.store.getSnapshot().contracts.day,
    contractId,
  }, overrides);
}

async function assertRejectedUnchanged(harness, execute, expectedCode, label) {
  const before = harness.store.getSnapshot();
  const beforeValue = cloneValue(before);
  const metadataBefore = harness.store.getCommandMetadata();
  const signalsBefore = harness.bus.getSignalSnapshot();
  const revisionBefore = harness.store.revision;
  const commitsBefore = harness.store.commitCount;
  const result = await execute();
  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), beforeValue), `${label}: state가 변경됐습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadataBefore), `${label}: command metadata가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signalsBefore), `${label}: signal journal이 변경됐습니다.`);
  assert(harness.store.revision === revisionBefore, `${label}: revision이 변경됐습니다.`);
  assert(harness.store.commitCount === commitsBefore, `${label}: commit이 발생했습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 실패 signal이 비어 있지 않습니다.`);
  return { code: result.code, partialMutations: 0 };
}

function advanceToResolutionPlanning(harness) {
  const prior = harness.store.getSnapshot();
  const pending = prior.contracts.contracts.find((contract) => contract.status === CONTRACT_STATUS.ACCEPTED_PENDING);
  assert(pending, "D+1 advance 대상 pending contract가 없습니다.");
  const day = pending.resolutionDay;
  const generation = generateDay({
    seed: harness.seed,
    day,
    ingredients: harness.ingredients,
    configuration: harness.configuration,
    fixedCostG: harness.fixedCostG,
    rngState: prior.rng,
  });
  const next = cloneValue(prior);
  next.campaign.day = day;
  next.contracts = createContractState({
    day,
    fixedCostG: harness.fixedCostG,
    offers: generation.contracts.offers,
    contracts: prior.contracts.contracts,
    acceptedContractIdForDay: null,
    processedResolutionIds: prior.contracts.processedResolutionIds,
  });
  next.rng = generation.rngState;
  next.idCounters.day = day;
  const store = new GameStore(next, {
    processedCommandIds: harness.store.getCommandMetadata().processedCommandIds,
  });
  const bus = new CommandBus({ store });
  registerCashTransactionAPI(bus);
  registerInventoryAccounting(bus);
  const contractSystem = registerContractSystem(bus);
  return {
    ...harness,
    store,
    bus,
    contractSystem,
    dayGeneration: generation,
    pendingContractId: pending.contractId,
  };
}

function findSeedForOutcome(outcome, successRate = 50) {
  for (let seed = 1; seed < 100_000; seed += 1) {
    const registry = new RngRegistry(seed);
    const roll = registry.nextInt(CONTRACT_RESOLUTION_RNG_STREAM, 1_000_000);
    const actual = roll < successRate * 10_000
      ? CONTRACT_RESOLUTION_OUTCOME.SUCCESS
      : CONTRACT_RESOLUTION_OUTCOME.FAILURE;
    if (actual === outcome) return seed;
  }
  throw new Error(`${outcome} resolution seed를 찾지 못했습니다.`);
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

/** Deterministic offers, exact risk table/formulas, safe integers, and stable remainder.
 * **Validates: Requirements 4.12, 6.1, 6.2, 6.3, 6.4, 6.5, 6.13, 6.14, 20.2, 20.3, 23.4** */
function deterministicOfferRiskFormulaSweep(inputs) {
  let replayChecks = 0;
  let formulaChecks = 0;
  let allocationChecks = 0;
  let streamIsolationChecks = 0;
  for (let sample = 0; sample < QA_GENERATION_SAMPLES; sample += 1) {
    const seed = sampleSeed(sample);
    const registry = new RngRegistry(seed);
    for (const stream of CORE_RNG_STREAMS) {
      for (let draw = 0; draw < (sample + stream.length) % 3; draw += 1) {
        registry.nextUint32(stream);
      }
    }
    const initial = registry.snapshot();
    const initialValue = cloneValue(initial);
    const day = sample % 14 + 1;
    const first = generateDay({ ...inputs, seed, day, rngState: initial });
    const replay = generateDay({ ...inputs, seed, day, rngState: initial });
    const reordered = generateDay({
      ...inputs,
      seed,
      day,
      rngState: initial,
      ingredients: [...inputs.ingredients].reverse(),
    });
    assert(equivalent(initial, initialValue), `offer sample ${sample}: 입력 RNG state가 변경됐습니다.`);
    assert(equivalent(first.contracts, replay.contracts), `offer sample ${sample}: replay offer가 다릅니다.`);
    assert(equivalent(first.rngState, replay.rngState), `offer sample ${sample}: replay final RNG가 다릅니다.`);
    assert(equivalent(first.contracts, reordered.contracts), `offer sample ${sample}: ingredient 입력 순서가 결과를 바꿨습니다.`);
    assert(first.contracts.offers.length === 3 && first.contracts.offers.length >= 2,
      `offer sample ${sample}: Planning offer가 최소 2개가 아닙니다.`);
    assert(equivalent(first.contracts.offers.map((offer) => offer.risk), CONTRACT_RISK_ORDER),
      `offer sample ${sample}: risk ordering이 다릅니다.`);
    replayChecks += 1;
    for (const stream of CORE_RNG_STREAMS) {
      if (stream === CONTRACT_OFFER_RNG_STREAM) continue;
      assert(equivalent(first.rngState.streams[stream], initial.streams[stream]),
        `offer sample ${sample}: ${stream} stream이 오염됐습니다.`);
      streamIsolationChecks += 1;
    }
    for (const offer of first.contracts.offers) {
      const policy = CONTRACT_RISK_TABLE[offer.risk];
      const expectedTotalG = multiplyDivideHalfUp(
        offer.marketExpectedCostG,
        100 - policy.discountPercent,
        100,
      );
      const expectedPrepaidG = multiplyDivideHalfUp(expectedTotalG, 20, 100);
      assert(offer.successRate === policy.successRate && offer.discountPercent === policy.discountPercent,
        `offer sample ${sample}: ${offer.risk} policy가 다릅니다.`);
      assert(offer.totalPriceG === expectedTotalG && offer.prepaidG === expectedPrepaidG,
        `offer sample ${sample}: ${offer.risk} Half-Up 계산이 다릅니다.`);
      assert(offer.prepaidG + offer.balanceG === offer.totalPriceG,
        `offer sample ${sample}: prepaid+balance가 total과 다릅니다.`);
      assert([offer.marketExpectedCostG, offer.totalPriceG, offer.prepaidG, offer.balanceG]
        .every((value) => Number.isSafeInteger(value) && value >= 0),
      `offer sample ${sample}: money가 non-negative safe integer가 아닙니다.`);
      const allocation = allocateContractBookCost(offer);
      assert(sumG(allocation.map((line) => line.bookCostG)) === offer.totalPriceG,
        `offer sample ${sample}: allocation 합이 total과 다릅니다.`);
      assert(equivalent(allocation.map((line) => line.ingredientId),
        [...allocation.map((line) => line.ingredientId)].sort()),
      `offer sample ${sample}: remainder ordering이 stable하지 않습니다.`);
      formulaChecks += 1;
      allocationChecks += 1;
    }
  }
  return { samples: QA_GENERATION_SAMPLES, replayChecks, formulaChecks, allocationChecks, streamIsolationChecks };
}

/** Resolution result/Quality/final cursor replay and named-stream isolation.
 * **Validates: Requirements 6.10, 6.11, 6.12, 6.14, 23.4** */
function deterministicResolutionAndStreamIsolation(inputs) {
  let replayChecks = 0;
  let finalCursorChecks = 0;
  let streamIsolationChecks = 0;
  let qualityChecks = 0;
  for (let sample = 0; sample < QA_GENERATION_SAMPLES; sample += 1) {
    const seed = sampleSeed(sample, 0x600d);
    const dayGeneration = generateDay({ ...inputs, seed, day: 1 });
    const offer = dayGeneration.contracts.offers[sample % dayGeneration.contracts.offers.length];
    const contract = acceptedRecord(offer);
    const initial = dayGeneration.rngState;
    const first = generateContractResolution({ rngState: initial, contract });
    const replay = generateContractResolution({ rngState: initial, contract });
    assert(equivalent(first.result, replay.result), `resolution sample ${sample}: result replay가 다릅니다.`);
    assert(equivalent(first.rngState, replay.rngState), `resolution sample ${sample}: final RNG replay가 다릅니다.`);
    assert(equivalent(first.contractResolutionStreamAfter, replay.contractResolutionStreamAfter),
      `resolution sample ${sample}: final cursor가 다릅니다.`);
    assert(first.drawsConsumed === first.contractResolutionStreamAfter.drawCount -
      first.contractResolutionStreamBefore.drawCount,
    `resolution sample ${sample}: draw delta가 다릅니다.`);
    replayChecks += 1;
    finalCursorChecks += 1;
    for (const stream of CORE_RNG_STREAMS) {
      if (stream === CONTRACT_RESOLUTION_RNG_STREAM) continue;
      assert(equivalent(first.rngState.streams[stream], initial.streams[stream]),
        `resolution sample ${sample}: ${stream} stream이 오염됐습니다.`);
      streamIsolationChecks += 1;
    }
    const perturbed = RngRegistry.fromState(initial);
    for (const stream of CORE_RNG_STREAMS) {
      if (stream !== CONTRACT_RESOLUTION_RNG_STREAM) perturbed.nextUint32(stream);
    }
    const isolated = generateContractResolution({ rngState: perturbed.snapshot(), contract });
    assert(equivalent(first.result, isolated.result),
      `resolution sample ${sample}: 타 stream draw가 result/Quality를 변경했습니다.`);
    assert(equivalent(first.contractResolutionStreamAfter, isolated.contractResolutionStreamAfter),
      `resolution sample ${sample}: 타 stream draw가 final cursor를 변경했습니다.`);
    streamIsolationChecks += 1;
    for (const line of first.result.lineResults) {
      assert(Number.isInteger(line.quality) && line.quality >= 0 && line.quality <= 100,
        `resolution sample ${sample}: Quality가 0..100 정수가 아닙니다.`);
      qualityChecks += 1;
    }
  }
  return { replayChecks, finalCursorChecks, streamIsolationChecks, qualityChecks };
}

/** Projection exposes risk, liquidity, loss, D+1, and confirmation without mutation.
 * **Validates: Requirements 4.4, 6.1, 6.2, 6.8** */
function contractProjectionExample(inputs) {
  const harness = createHarness({ ...inputs, cashG: 300 });
  const beforeContracts = cloneValue(harness.store.getSnapshot().contracts);
  const beforeEconomy = cloneValue(harness.store.getSnapshot().economy);
  const projection = projectContracts(
    harness.store.getSnapshot().contracts,
    harness.store.getSnapshot().economy,
  );
  assert(projection.offers.length >= 2, "projection offer가 2개 미만입니다.");
  assert(projection.offers.every((offer) => offer.arrivalDay === projection.day + 1),
    "projection D+1 도착이 다릅니다.");
  assert(projection.offers.every((offer) => offer.lossExposureG === offer.prepaidG),
    "projection loss exposure가 prepaid와 다릅니다.");
  assert(equivalent(beforeContracts, harness.store.getSnapshot().contracts) &&
    equivalent(beforeEconomy, harness.store.getSnapshot().economy), "projection이 source state를 변경했습니다.");
  return {
    offerCount: projection.offers.length,
    availableCashG: projection.availableCashG,
    fixedCostRiskOfferCount: projection.offers.filter((offer) =>
      offer.fixedCostRiskConfirmationRequired).length,
    mutations: 0,
  };
}

/** Acceptance single-commits prepaid cash, prepaid asset, balance reserve, state, ledger and movement.
 * **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 4.6, 5.7, 6.6, 6.7, 6.9** */
async function acceptAtomicReconciliation(inputs) {
  const harness = createHarness({ ...inputs, cashG: 2_000 });
  const before = harness.store.getSnapshot();
  const result = await harness.contractSystem.acceptContract(
    acceptInput(harness, "LOW", "qa:contract:accept:approved"),
  );
  assert(result.ok, `승인 계약 수락이 실패했습니다: ${result.code}`);
  const after = harness.store.getSnapshot();
  const contract = after.contracts.contracts[0];
  const ledger = after.economy.ledger[0];
  const movement = after.inventoryAccounting.costMovements[0];
  assert(harness.store.revision === 1 && harness.store.commitCount === 1,
    "계약 수락이 single commit이 아닙니다.");
  assert(after.economy.cashG === before.economy.cashG - contract.prepaidG,
    "수락 prepaid cash outflow가 다릅니다.");
  assert(after.economy.contractPrepaidAssetG === contract.prepaidG,
    "수락 prepaid asset이 다릅니다.");
  assert(after.economy.contractReserveG === contract.balanceG,
    "수락 balance reserve가 다릅니다.");
  assert(contract.prepaidG + contract.balanceG === contract.totalPriceG,
    "수락 prepaid+balance 합이 total과 다릅니다.");
  assert(ledger.category === "CONTRACT_PREPAID" && ledger.amountG === contract.prepaidG,
    "수락 ledger 분류/금액이 다릅니다.");
  assert(movement.amountG === contract.prepaidG && movement.causeId === ledger.causeId,
    "수락 prepaid movement/Cause ID가 ledger와 다릅니다.");
  assert(after.contracts.acceptedContractIdForDay === contract.contractId &&
    contract.status === CONTRACT_STATUS.ACCEPTED_PENDING, "수락 contract state가 pending이 아닙니다.");
  assert(reconcileInventoryAccounting(after.inventory, after.inventoryAccounting, { economy: after.economy }).ok,
    "수락 prepaid 대사가 실패했습니다.");
  assert(reconcileCashWithLedger(before.economy.cashG, after.economy.cashG, [ledger]).ok,
    "수락 cash 대사가 실패했습니다.");
  assert(after.untouched === before.untouched, "수락 write-set 밖 structural sharing이 깨졌습니다.");
  return {
    commits: harness.store.commitCount,
    prepaidG: contract.prepaidG,
    balanceG: contract.balanceG,
    totalPriceG: contract.totalPriceG,
    ledgerOutflowG: ledger.amountG,
    prepaidAssetG: after.economy.contractPrepaidAssetG,
    reserveG: after.economy.contractReserveG,
    partialMutations: 0,
  };
}

/** Day 14 cannot create a D+1 arrival and is fully rejected.
 * **Validates: Requirements 4.6, 6.7** */
async function day14FullRejection(inputs) {
  const harness = createHarness({ ...inputs, day: 14, cashG: 2_000 });
  const details = await assertRejectedUnchanged(
    harness,
    () => harness.contractSystem.acceptContract(
      acceptInput(harness, "LOW", "qa:contract:day14"),
    ),
    "CONTRACT_ARRIVAL_AFTER_CAMPAIGN",
    "Day14 contract",
  );
  return { ...details, arrivalDay: 15 };
}

/** Available_Cash must cover the whole consideration, not only prepaid.
 * **Validates: Requirements 4.4, 4.6, 6.7** */
async function insufficientCashFullRejection(inputs) {
  const seed = 0x1600cafe;
  const generated = generateDay({ ...inputs, seed, day: 1 });
  const offer = generated.contracts.offers.find((candidate) => candidate.risk === "MEDIUM");
  const harness = createHarness({ ...inputs, seed, cashG: offer.totalPriceG - 1 });
  const details = await assertRejectedUnchanged(
    harness,
    () => harness.contractSystem.acceptContract(
      acceptInput(harness, "MEDIUM", "qa:contract:cash-reject"),
    ),
    "INSUFFICIENT_AVAILABLE_CASH",
    "contract total Available_Cash guard",
  );
  return { ...details, requiredG: offer.totalPriceG, availableCashG: offer.totalPriceG - 1 };
}

/** Fixed Cost liquidity warning requires explicit confirmation before any mutation.
 * **Validates: Requirements 4.6, 6.8, 6.9** */
async function fixedCostRiskConfirmation(inputs) {
  const seed = 0x1600f1ce;
  const generated = generateDay({ ...inputs, seed, day: 1 });
  const offer = generated.contracts.offers.find((candidate) => candidate.risk === "HIGH");
  const cashG = offer.totalPriceG + inputs.fixedCostG - 1;
  const harness = createHarness({ ...inputs, seed, cashG });
  await assertRejectedUnchanged(
    harness,
    () => harness.contractSystem.acceptContract(
      acceptInput(harness, "HIGH", "qa:contract:fixed-cost:unconfirmed", false),
    ),
    "FIXED_COST_RISK_CONFIRMATION_REQUIRED",
    "fixed cost risk unconfirmed",
  );
  const accepted = await harness.contractSystem.acceptContract(
    acceptInput(harness, "HIGH", "qa:contract:fixed-cost:confirmed", true),
  );
  assert(accepted.ok, `fixed cost 확인 뒤 수락이 실패했습니다: ${accepted.code}`);
  const projection = projectContracts(harness.store.getSnapshot().contracts, harness.store.getSnapshot().economy);
  assert(projection.availableCashG === inputs.fixedCostG - 1,
    "확인 뒤 Available_Cash가 예상 Fixed Cost risk 값과 다릅니다.");
  return {
    confirmationRejections: 1,
    confirmedCommits: 1,
    availableAfterAcceptanceG: projection.availableCashG,
    fixedCostG: inputs.fixedCostG,
    partialMutations: 0,
  };
}

/** Invalid/stale/duplicate accept requests preserve every state and signal.
 * **Validates: Requirements 4.6, 4.7, 6.6, 6.15** */
async function invalidStaleDuplicateAccept(inputs) {
  const harness = createHarness({ ...inputs, cashG: 2_000 });
  await assertRejectedUnchanged(
    harness,
    () => harness.contractSystem.acceptContract(commandInput(
      harness,
      "qa:contract:invalid-offer",
      { day: 1, offerId: "contract.offer:1:UNKNOWN", fixedCostRiskConfirmed: false },
    )),
    "CONTRACT_OFFER_NOT_FOUND",
    "invalid offer",
  );
  const first = await harness.contractSystem.acceptContract(
    acceptInput(harness, "LOW", "qa:contract:accept-once"),
  );
  assert(first.ok, `duplicate fixture 수락이 실패했습니다: ${first.code}`);
  await assertRejectedUnchanged(
    harness,
    () => harness.contractSystem.acceptContract(
      acceptInput(harness, "MEDIUM", "qa:contract:accept-second"),
    ),
    "CONTRACT_ALREADY_ACCEPTED_FOR_DAY",
    "second daily acceptance",
  );
  await assertRejectedUnchanged(
    harness,
    () => harness.contractSystem.acceptContract(
      acceptInput(harness, "LOW", "qa:contract:accept-stale", false, { expectedRevision: 0 }),
    ),
    "STALE_REVISION",
    "stale acceptance",
  );
  const duplicateCommandInput = acceptInput(harness, "LOW", "qa:contract:accept-once");
  duplicateCommandInput.expectedRevision = 0;
  await assertRejectedUnchanged(
    harness,
    () => harness.contractSystem.acceptContract(duplicateCommandInput),
    "DUPLICATE_COMMAND",
    "duplicate acceptance command",
  );
  return { successfulAccepts: 1, invalidRejections: 1, dailyDuplicateRejections: 1, staleRejections: 1, duplicateCommandRejections: 1, partialMutations: 0 };
}

/** Successful D+1 resolution pays balance, releases reserve/prepaid, and capitalizes exact lots.
 * **Validates: Requirements 4.2, 4.5, 4.6, 5.1, 5.7, 5.10, 6.10, 6.11, 6.13, 6.14** */
async function successfulResolutionReconciliation(inputs) {
  const seed = findSeedForOutcome(CONTRACT_RESOLUTION_OUTCOME.SUCCESS, 50);
  const harness = createHarness({ ...inputs, seed, cashG: 2_000 });
  const accepted = await harness.contractSystem.acceptContract(
    acceptInput(harness, "HIGH", "qa:contract:success:accept"),
  );
  assert(accepted.ok, `success fixture 수락이 실패했습니다: ${accepted.code}`);
  const dayTwo = advanceToResolutionPlanning(harness);
  const before = dayTwo.store.getSnapshot();
  const pending = before.contracts.contracts[0];
  const result = await dayTwo.contractSystem.resolveContract(
    resolveInput(dayTwo, pending.contractId, "qa:contract:success:resolve"),
  );
  assert(result.ok, `success resolution이 실패했습니다: ${result.code}`);
  const after = dayTwo.store.getSnapshot();
  const resolved = after.contracts.contracts[0];
  const newLots = after.inventory.lots.slice(before.inventory.lots.length);
  const allocatedG = sumG(newLots.map((lot) => lot.bookCostG));
  const appendedLedger = after.economy.ledger.slice(before.economy.ledger.length);
  const appendedMovements = after.inventoryAccounting.costMovements.slice(
    before.inventoryAccounting.costMovements.length,
  );
  assert(dayTwo.store.commitCount === 1 && after.revision === before.revision + 1,
    "success resolution이 single commit이 아닙니다.");
  assert(resolved.status === CONTRACT_STATUS.RESOLVED_SUCCESS &&
    resolved.resolution.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS,
  "success resolution status가 다릅니다.");
  assert(after.economy.cashG === before.economy.cashG - pending.balanceG,
    "success balance cash outflow가 다릅니다.");
  assert(after.economy.contractReserveG === before.economy.contractReserveG - pending.balanceG,
    "success reserve release가 다릅니다.");
  assert(after.economy.contractPrepaidAssetG === 0,
    "success prepaid asset이 0이 아닙니다.");
  assert(appendedLedger.length === 1 && appendedLedger[0].category === "CONTRACT_BALANCE" &&
    appendedLedger[0].amountG === pending.balanceG,
  "success balance ledger가 다릅니다.");
  assert(newLots.length === pending.lines.length && allocatedG === pending.totalPriceG,
    "success lot cardinality/allocation 합이 다릅니다.");
  assert(newLots.every((lot) => Number.isInteger(lot.quality) && lot.quality >= 0 && lot.quality <= 100),
    "success lot Quality가 0..100 정수가 아닙니다.");
  assert(after.inventoryAccounting.successfulContractAcquisitionG === pending.totalPriceG,
    "success acquisition 총액이 total과 다릅니다.");
  assert(appendedMovements.length === pending.lines.length + 1,
    "success prepaid application+lot movement 수가 다릅니다.");
  assert(appendedMovements.every((movement) => movement.causeId === resolved.resolution.causeId) &&
    appendedLedger[0].causeId === resolved.resolution.causeId,
  "success Cause ID가 ledger/cost movement에서 일치하지 않습니다.");
  assert(reconcileCashWithLedger(before.economy.cashG, after.economy.cashG, appendedLedger).ok,
    "success cash 대사가 실패했습니다.");
  assert(reconcileInventoryAccounting(after.inventory, after.inventoryAccounting, { economy: after.economy }).ok,
    "success inventory/prepaid 대사가 실패했습니다.");
  return {
    outcome: resolved.resolution.outcome,
    commits: dayTwo.store.commitCount,
    balanceOutflowG: pending.balanceG,
    reserveReleasedG: pending.balanceG,
    prepaidAppliedG: pending.prepaidG,
    lotCount: newLots.length,
    allocatedBookCostG: allocatedG,
    totalPriceG: pending.totalPriceG,
    ledgerAppends: appendedLedger.length,
    costMovementAppends: appendedMovements.length,
    reconciliation: "INVENTORY_RECONCILIATION_PASS",
  };
}

/** Failure has no second cash outflow, releases reserve, recognizes prepaid loss once, and rejects reprocessing.
 * **Validates: Requirements 4.6, 5.5, 6.10, 6.12, 6.15** */
async function failedResolutionAndDuplicateGuard(inputs) {
  const seed = findSeedForOutcome(CONTRACT_RESOLUTION_OUTCOME.FAILURE, 50);
  const harness = createHarness({ ...inputs, seed, cashG: 2_000 });
  const accepted = await harness.contractSystem.acceptContract(
    acceptInput(harness, "HIGH", "qa:contract:failure:accept"),
  );
  assert(accepted.ok, `failure fixture 수락이 실패했습니다: ${accepted.code}`);
  const dayTwo = advanceToResolutionPlanning(harness);
  const before = dayTwo.store.getSnapshot();
  const pending = before.contracts.contracts[0];
  const result = await dayTwo.contractSystem.resolveContract(
    resolveInput(dayTwo, pending.contractId, "qa:contract:failure:resolve"),
  );
  assert(result.ok, `failure resolution이 실패했습니다: ${result.code}`);
  const after = dayTwo.store.getSnapshot();
  const resolved = after.contracts.contracts[0];
  assert(resolved.status === CONTRACT_STATUS.RESOLVED_FAILURE &&
    resolved.resolution.outcome === CONTRACT_RESOLUTION_OUTCOME.FAILURE,
  "failure resolution status가 다릅니다.");
  assert(after.economy.cashG === before.economy.cashG &&
    after.economy.ledger.length === before.economy.ledger.length,
  "failure resolution이 추가 cash outflow/ledger를 만들었습니다.");
  assert(after.economy.contractReserveG === 0 && after.economy.contractPrepaidAssetG === 0,
    "failure reserve/prepaid가 해제되지 않았습니다.");
  assert(after.inventory.lots.length === before.inventory.lots.length,
    "failure resolution이 lot을 만들었습니다.");
  assert(after.inventoryAccounting.contractFailureLossG -
    before.inventoryAccounting.contractFailureLossG === pending.prepaidG,
  "failure loss가 prepaid와 다릅니다.");
  assert(after.inventoryAccounting.costMovements.length -
    before.inventoryAccounting.costMovements.length === 1,
  "failure loss movement가 정확히 한 번 추가되지 않았습니다.");
  assert(reconcileInventoryAccounting(after.inventory, after.inventoryAccounting, { economy: after.economy }).ok,
    "failure inventory/prepaid 대사가 실패했습니다.");
  await assertRejectedUnchanged(
    dayTwo,
    () => dayTwo.contractSystem.resolveContract(
      resolveInput(dayTwo, pending.contractId, "qa:contract:failure:resolve-again"),
    ),
    "DUPLICATE_CONTRACT_RESOLUTION",
    "duplicate contract resolution",
  );
  await assertRejectedUnchanged(
    dayTwo,
    () => dayTwo.contractSystem.resolveContract(
      resolveInput(dayTwo, "contract:1:UNKNOWN", "qa:contract:failure:invalid"),
    ),
    "CONTRACT_NOT_FOUND",
    "invalid contract resolution",
  );
  await assertRejectedUnchanged(
    dayTwo,
    () => dayTwo.contractSystem.resolveContract(
      resolveInput(dayTwo, pending.contractId, "qa:contract:failure:stale", { expectedRevision: before.revision }),
    ),
    "STALE_REVISION",
    "stale contract resolution",
  );
  return {
    outcome: resolved.resolution.outcome,
    additionalCashOutflowG: 0,
    reserveReleasedG: pending.balanceG,
    prepaidLossG: pending.prepaidG,
    lotsCreated: 0,
    lossMovements: 1,
    duplicateResolutionRejections: 1,
    invalidResolutionRejections: 1,
    staleResolutionRejections: 1,
    partialMutations: 0,
  };
}

export async function runContractProbe({ ingredients, configuration, fixedCostG } = {}) {
  assert(Array.isArray(ingredients) && ingredients.length >= 2, "canonical contract ingredient 입력이 없습니다.");
  assert(configuration && typeof configuration === "object", "canonical contract configuration이 없습니다.");
  assert(Number.isSafeInteger(fixedCostG) && fixedCostG >= 0, "canonical Fixed Cost가 유효하지 않습니다.");
  const inputs = { ingredients, configuration, fixedCostG };
  const definitions = [
    ["deterministic-offer-risk-formulas", "64 seeds의 offer/final cursor replay, risk table, Half-Up, stable allocation", ["4.12", "6.1", "6.2", "6.3", "6.4", "6.5", "6.13", "6.14", "20.2", "20.3", "23.4"], () => deterministicOfferRiskFormulaSweep(inputs)],
    ["deterministic-resolution-stream-isolation", "64 seeds의 result/Quality/final cursor replay와 타 stream 격리", ["6.10", "6.11", "6.12", "6.14", "23.4"], () => deterministicResolutionAndStreamIsolation(inputs)],
    ["contract-projection", "risk/liquidity/loss/D+1/Fixed Cost confirmation read-only projection", ["4.4", "6.1", "6.2", "6.8"], () => contractProjectionExample(inputs)],
    ["accept-atomic-reconciliation", "prepaid cash+asset+balance reserve+pending state single commit 대사", ["4.1", "4.2", "4.4", "4.5", "4.6", "5.7", "6.6", "6.7", "6.9"], () => acceptAtomicReconciliation(inputs)],
    ["day14-full-rejection", "D+1>14 계약 수락 full rejection", ["4.6", "6.7"], () => day14FullRejection(inputs)],
    ["insufficient-cash-full-rejection", "Available_Cash<total 계약 수락 full rejection", ["4.4", "4.6", "6.7"], () => insufficientCashFullRejection(inputs)],
    ["fixed-cost-risk-confirmation", "수락 후 Available_Cash<Fixed Cost confirmation 전 full rejection", ["4.6", "6.8", "6.9"], () => fixedCostRiskConfirmation(inputs)],
    ["invalid-stale-duplicate-accept", "invalid/stale/duplicate/day-second acceptance exact preservation", ["4.6", "4.7", "6.6", "6.15"], () => invalidStaleDuplicateAccept(inputs)],
    ["successful-resolution-reconciliation", "D+1 success balance/reserve/prepaid/Quality/lot/cost exact 대사", ["4.2", "4.5", "4.6", "5.1", "5.7", "5.10", "6.10", "6.11", "6.13", "6.14"], () => successfulResolutionReconciliation(inputs)],
    ["failed-resolution-duplicate-guard", "failure no extra cash, reserve release, prepaid loss once, lot 0, 재처리 거절", ["4.6", "5.5", "6.10", "6.12", "6.15"], () => failedResolutionAndDuplicateGuard(inputs)],
  ];
  const results = [];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const detailsFor = (id) => results.find((result) => result.id === id)?.details ?? {};
  const rejectionIds = [
    "day14-full-rejection",
    "insufficient-cash-full-rejection",
    "fixed-cost-risk-confirmation",
    "invalid-stale-duplicate-accept",
    "failed-resolution-duplicate-guard",
  ];
  return Object.freeze({
    qaId: "task-16-risk-contract-dplus1-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    offerReplayCount: detailsFor("deterministic-offer-risk-formulas").replayChecks ?? 0,
    offerFormulaCheckCount: detailsFor("deterministic-offer-risk-formulas").formulaChecks ?? 0,
    allocationCheckCount: detailsFor("deterministic-offer-risk-formulas").allocationChecks ?? 0,
    resolutionReplayCount: detailsFor("deterministic-resolution-stream-isolation").replayChecks ?? 0,
    finalCursorCheckCount: detailsFor("deterministic-resolution-stream-isolation").finalCursorChecks ?? 0,
    streamIsolationCheckCount:
      (detailsFor("deterministic-offer-risk-formulas").streamIsolationChecks ?? 0) +
      (detailsFor("deterministic-resolution-stream-isolation").streamIsolationChecks ?? 0),
    fullRejectionGuardGroups: rejectionIds.length,
    partialMutationCount: rejectionIds.reduce(
      (total, id) => total + (detailsFor(id).partialMutations ?? 0),
      0,
    ),
    acceptCommitCount: detailsFor("accept-atomic-reconciliation").commits ?? 0,
    acceptedPrepaidG: detailsFor("accept-atomic-reconciliation").prepaidG ?? null,
    acceptedBalanceG: detailsFor("accept-atomic-reconciliation").balanceG ?? null,
    acceptedTotalPriceG: detailsFor("accept-atomic-reconciliation").totalPriceG ?? null,
    successBalanceOutflowG: detailsFor("successful-resolution-reconciliation").balanceOutflowG ?? null,
    successAllocatedBookCostG: detailsFor("successful-resolution-reconciliation").allocatedBookCostG ?? null,
    successTotalPriceG: detailsFor("successful-resolution-reconciliation").totalPriceG ?? null,
    failureAdditionalCashOutflowG: detailsFor("failed-resolution-duplicate-guard").additionalCashOutflowG ?? null,
    failurePrepaidLossG: detailsFor("failed-resolution-duplicate-guard").prepaidLossG ?? null,
    failureLotsCreated: detailsFor("failed-resolution-duplicate-guard").lotsCreated ?? null,
    results: Object.freeze(results),
  });
}
