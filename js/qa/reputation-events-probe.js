import { CommandBus } from "../core/command-bus.js";
import { createCampaignId } from "../core/ids.js";
import { cloneValue } from "../core/result.js";
import { CORE_RNG_STREAMS, createRngRegistryState, RngRegistry } from "../core/rng.js";
import { GameStore } from "../core/store.js";
import {
  createEventState,
  EVENT_RNG_STREAM,
  EVENT_SELECTION,
  generateDailyEvent,
  planDailyEventInitialization,
  registerEventSystem,
  validateEventState,
  ZERO_EVENT_MODIFIERS,
} from "../domain/events.js";
import { createMenuState } from "../domain/menu.js";
import { createRecipeState } from "../domain/recipe.js";
import {
  createReputationCampaignFields,
  planReputationCause,
  registerReputationSystem,
} from "../domain/reputation.js";
import {
  createProgressionState,
  createUnlockCatalog,
  registerUnlockPublisher,
  UNLOCK_KIND,
} from "../domain/unlocks.js";

const QA_GENERATION_ID = 18;
const EVENT_SEED_SAMPLES = 128;
const CAMPAIGN_DAY_COUNT = 14;

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
  return (Math.imul(sample + 1, 0x9e3779b9) ^ 0x18a11ce5 ^ salt) >>> 0;
}

function campaignState(seed, day, reputation) {
  return {
    campaignId: createCampaignId(seed, 0),
    masterSeed: seed,
    day,
    consecutiveArrearsCount: 0,
    ...createReputationCampaignFields(reputation),
  };
}

function createHarness({
  recipes: canonicalRecipes,
  facilities,
  eventDefinitions,
  seed = 0x18a11ce,
  day = 1,
  reputation = 30,
  runtimePhase = "PLANNING",
  snapshot = null,
  eventState = null,
  rngState = null,
} = {}) {
  const unlockCatalog = createUnlockCatalog({ recipes: canonicalRecipes, facilities });
  let initialState;
  if (snapshot !== null) {
    initialState = cloneValue(snapshot);
    initialState.runtimePhase = runtimePhase;
    initialState.campaign.day = day;
    initialState.menu.day = day;
  } else {
    const recipeState = createRecipeState({ recipes: canonicalRecipes });
    initialState = {
      formatVersion: 1,
      revision: 0,
      runtimePhase,
      checkpointPhase: runtimePhase === "PLANNING" ? "PLANNING_READY" : null,
      generationId: QA_GENERATION_ID,
      campaign: campaignState(seed, day, reputation),
      progression: createProgressionState({ unlockCatalog }),
      recipes: recipeState,
      menu: createMenuState({ day, recipes: recipeState }),
      events: eventState ?? createEventState(),
      rng: rngState ?? createRngRegistryState(seed),
      untouched: { marker: "task-18-structural-sharing" },
    };
  }
  const store = new GameStore(initialState);
  const bus = new CommandBus({ store });
  const reputationSystem = registerReputationSystem(bus);
  const unlockPublisher = registerUnlockPublisher(bus);
  const eventSystem = registerEventSystem(bus, eventDefinitions);
  return { store, bus, reputationSystem, unlockPublisher, eventSystem };
}

function commandInput(harness, commandId, payload, overrides = {}) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: harness.store.revision * 20,
    payload,
    ...overrides,
  };
}

async function assertRejectedUnchanged(harness, execute, expectedCode, label) {
  const before = harness.store.getSnapshot();
  const beforeValue = cloneValue(before);
  const signalsBefore = harness.bus.getSignalSnapshot();
  const metadataBefore = harness.store.getCommandMetadata();
  const revisionBefore = harness.store.revision;
  const commitsBefore = harness.store.commitCount;
  const result = await execute();
  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), beforeValue), `${label}: state가 변경됐습니다.`);
  assert(harness.store.revision === revisionBefore, `${label}: revision이 변경됐습니다.`);
  assert(harness.store.commitCount === commitsBefore, `${label}: commit이 발생했습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadataBefore), `${label}: command metadata가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signalsBefore), `${label}: event/effect journal이 변경됐습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 실패 결과에 signal이 있습니다.`);
  return 1;
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

/** Canonical thresholds and a new campaign begin with no carried progression.
 * **Validates: Requirements 14.5, 14.6, 16.1** */
function canonicalCatalogAndCampaignReset(recipes, facilities, eventDefinitions) {
  const catalog = createUnlockCatalog({ recipes, facilities });
  assert(catalog.length === 7, `canonical unlock 수가 7이 아닙니다: ${catalog.length}`);
  assert(equivalent(catalog.map((entry) => entry.threshold), [36, 40, 42, 48, 48, 56, 64]),
    "canonical unlock threshold가 예상과 다릅니다.");
  const first = createHarness({ recipes, facilities, eventDefinitions, reputation: 30 });
  const second = createHarness({ recipes, facilities, eventDefinitions, seed: 0x18a11cf, reputation: 30 });
  for (const harness of [first, second]) {
    const snapshot = harness.store.getSnapshot();
    assert(snapshot.campaign.reputation === 30, "새 캠페인 시작 reputation이 30이 아닙니다.");
    assert(snapshot.campaign.processedCauseIds.length === 0, "새 캠페인에 Cause_Id가 이월됐습니다.");
    assert(snapshot.progression.pendingUnlocks.length === 0, "새 캠페인에 pending unlock이 이월됐습니다.");
    assert(snapshot.progression.publishedUnlockIds.length === 0, "새 캠페인에 published unlock이 이월됐습니다.");
    assert(snapshot.progression.unlockedFacilityIds.length === 0, "새 캠페인에 facility unlock이 이월됐습니다.");
  }
  return { catalogCount: catalog.length, resetCampaignCount: 2, thresholdCount: catalog.length };
}

/** Integer starts and safe-integer deltas always clamp into integer 0..100.
 * **Validates: Requirements 16.1, 16.2, 16.6** */
function reputationClampBoundarySweep(recipes, facilities) {
  const catalog = createUnlockCatalog({ recipes, facilities });
  const starts = Array.from({ length: 101 }, (_, index) => index);
  const deltas = [Number.MIN_SAFE_INTEGER, -1000, -101, -100, -1, 0, 1, 100, 101, 1000, Number.MAX_SAFE_INTEGER];
  let checks = 0;
  for (const reputation of starts) {
    for (let deltaIndex = 0; deltaIndex < deltas.length; deltaIndex += 1) {
      const delta = deltas[deltaIndex];
      const campaign = {
        campaignId: `campaign.qa-clamp-${reputation}-${deltaIndex}`,
        day: 1,
        ...createReputationCampaignFields(reputation),
      };
      const progression = createProgressionState({ unlockCatalog: catalog });
      const result = planReputationCause({ campaign, progression }, {
        causeId: `cause.qa-clamp-${reputation}-${deltaIndex}`,
        delta,
      });
      assert(result.ok, `clamp plan이 실패했습니다: ${result.code}`);
      const expected = delta >= 0
        ? Math.min(100, reputation + Math.min(delta, 100))
        : Math.max(0, reputation + Math.max(delta, -100));
      assert(Number.isInteger(result.plan.reputation), "clamp 결과가 정수가 아닙니다.");
      assert(result.plan.reputation === expected, `clamp 결과 ${result.plan.reputation} !== ${expected}`);
      assert(result.plan.appliedDelta === expected - reputation, "applied delta가 clamp 결과와 다릅니다.");
      checks += 1;
    }
  }
  return { boundaryChecks: checks, minimumResult: 0, maximumResult: 100 };
}

/** Duplicate/invalid Cause_Id, invalid delta, stale command, and illegal phase reject exactly.
 * **Validates: Requirements 16.1, 16.2, 16.3, 23.4** */
async function reputationAtomicRejection(recipes, facilities, eventDefinitions) {
  const harness = createHarness({ recipes, facilities, eventDefinitions });
  const firstInput = commandInput(harness, "qa:reputation:atomic:first", {
    causeId: "cause.qa.atomic",
    delta: 1,
  });
  const first = await harness.reputationSystem.applyCause(firstInput);
  assert(first.ok, `baseline reputation apply가 실패했습니다: ${first.code}`);
  assert(first.events.length === 1, `non-crossing cause가 event ${first.events.length}개를 발행했습니다.`);
  let exactRejections = 0;
  exactRejections += await assertRejectedUnchanged(
    harness,
    () => harness.reputationSystem.applyCause(firstInput),
    "DUPLICATE_COMMAND",
    "duplicate command",
  );
  exactRejections += await assertRejectedUnchanged(
    harness,
    () => harness.reputationSystem.applyCause(commandInput(harness, "qa:reputation:atomic:cause", {
      causeId: "cause.qa.atomic",
      delta: 9,
    })),
    "DUPLICATE_REPUTATION_CAUSE",
    "duplicate Cause_Id",
  );
  exactRejections += await assertRejectedUnchanged(
    harness,
    () => harness.reputationSystem.applyCause(commandInput(harness, "qa:reputation:atomic:delta", {
      causeId: "cause.qa.invalid-delta",
      delta: 1.5,
    })),
    "INVALID_REPUTATION_DELTA",
    "fractional reputation delta",
  );
  exactRejections += await assertRejectedUnchanged(
    harness,
    () => harness.reputationSystem.applyCause(commandInput(harness, "qa:reputation:atomic:id", {
      causeId: "bad cause id",
      delta: 1,
    })),
    "INVALID_REPUTATION_CAUSE_ID",
    "invalid Cause_Id",
  );
  exactRejections += await assertRejectedUnchanged(
    harness,
    () => harness.reputationSystem.applyCause(commandInput(
      harness,
      "qa:reputation:atomic:stale",
      { causeId: "cause.qa.stale", delta: 1 },
      { expectedRevision: 0 },
    )),
    "STALE_REVISION",
    "stale reputation command",
  );
  const titleHarness = createHarness({ recipes, facilities, eventDefinitions, runtimePhase: "TITLE" });
  exactRejections += await assertRejectedUnchanged(
    titleHarness,
    () => titleHarness.reputationSystem.applyCause(commandInput(titleHarness, "qa:reputation:atomic:phase", {
      causeId: "cause.qa.phase",
      delta: 1,
    })),
    "ILLEGAL_PHASE",
    "illegal reputation phase",
  );
  return { successfulCommits: 1, exactRejections, partialMutations: 0 };
}

/** Only strict previous<threshold<=next crossings qualify, including co-located thresholds once.
 * **Validates: Requirements 14.2, 14.3, 16.5, 16.6** */
async function thresholdCrossingCardinality(recipes, facilities, eventDefinitions) {
  const noCross = createHarness({ recipes, facilities, eventDefinitions, reputation: 30 });
  const noCrossResult = await noCross.reputationSystem.applyCause(commandInput(noCross, "qa:cross:none", {
    causeId: "cause.qa.cross.none",
    delta: 5,
  }));
  assert(noCrossResult.ok, `no-cross apply가 실패했습니다: ${noCrossResult.code}`);
  assert(noCrossResult.events.filter((event) => event.type === "progression.unlock-qualified").length === 0,
    "threshold 미교차에서 unlock event가 발행됐습니다.");

  const multi = createHarness({ recipes, facilities, eventDefinitions, reputation: 35 });
  const multiResult = await multi.reputationSystem.applyCause(commandInput(multi, "qa:cross:multi", {
    causeId: "cause.qa.cross.multi",
    delta: 14,
  }));
  assert(multiResult.ok, `multi-cross apply가 실패했습니다: ${multiResult.code}`);
  const qualified = multiResult.events.filter((event) => event.type === "progression.unlock-qualified");
  assert(qualified.length === 5, `35→49 crossing unlock이 5개가 아닙니다: ${qualified.length}`);
  assert(multi.store.getSnapshot().progression.pendingUnlocks.length === 5, "pending crossing 수가 5가 아닙니다.");
  assert(qualified.filter((event) => event.payload.threshold === 48).length === 2,
    "동일 threshold 48의 Recipe/facility가 각각 발행되지 않았습니다.");

  const equality = createHarness({ recipes, facilities, eventDefinitions, reputation: 47 });
  const equalityResult = await equality.reputationSystem.applyCause(commandInput(equality, "qa:cross:equality", {
    causeId: "cause.qa.cross.equality",
    delta: 1,
  }));
  assert(equalityResult.ok, `equality crossing이 실패했습니다: ${equalityResult.code}`);
  assert(equalityResult.events.filter((event) => event.type === "progression.unlock-qualified").length === 2,
    "47→48 exact threshold crossing이 두 대상을 발행하지 않았습니다.");

  const recross = createHarness({ recipes, facilities, eventDefinitions, reputation: 35 });
  const steps = [
    ["qa:cross:recross-up-1", "cause.qa.recross-up-1", 2],
    ["qa:cross:recross-down", "cause.qa.recross-down", -2],
    ["qa:cross:recross-up-2", "cause.qa.recross-up-2", 2],
  ];
  const unlockCounts = [];
  for (const [commandId, causeId, delta] of steps) {
    const result = await recross.reputationSystem.applyCause(commandInput(recross, commandId, { causeId, delta }));
    assert(result.ok, `recross step이 실패했습니다: ${result.code}`);
    unlockCounts.push(result.events.filter((event) => event.type === "progression.unlock-qualified").length);
  }
  assert(equivalent(unlockCounts, [1, 0, 0]), `재교차 unlock cardinality가 [1,0,0]이 아닙니다: ${unlockCounts}`);
  return {
    noCrossUnlocks: 0,
    multiCrossUnlocks: qualified.length,
    equalThresholdUnlocks: 2,
    recrossUnlocks: unlockCounts.reduce((total, count) => total + count, 0),
  };
}

/** Qualified targets remain unavailable until the next Planning and publish atomically once.
 * **Validates: Requirements 14.2, 14.3, 14.4, 16.5** */
async function nextPlanningUnlockPublication(recipes, facilities, eventDefinitions) {
  const dayOne = createHarness({ recipes, facilities, eventDefinitions, reputation: 35, day: 1 });
  const applied = await dayOne.reputationSystem.applyCause(commandInput(dayOne, "qa:publish:cross", {
    causeId: "cause.qa.publish",
    delta: 14,
  }));
  assert(applied.ok, `publish crossing이 실패했습니다: ${applied.code}`);
  const lockedBefore = dayOne.store.getSnapshot().recipes.unlockedRecipeIds.length;
  assert(lockedBefore === 2, "crossing 당일 Recipe가 즉시 해금됐습니다.");
  let exactRejections = 0;
  exactRejections += await assertRejectedUnchanged(
    dayOne,
    () => dayOne.unlockPublisher.publishForPlanning(commandInput(dayOne, "qa:publish:same-day", { day: 1 })),
    "NO_UNLOCKS_DUE",
    "same-day unlock publication",
  );

  const dayTwo = createHarness({
    recipes,
    facilities,
    eventDefinitions,
    snapshot: dayOne.store.getSnapshot(),
    day: 2,
    runtimePhase: "PLANNING",
  });
  const reputationBefore = dayTwo.store.getSnapshot().campaign.reputation;
  const published = await dayTwo.unlockPublisher.publishForPlanning(commandInput(dayTwo, "qa:publish:next-day", { day: 2 }));
  assert(published.ok, `next Planning publication이 실패했습니다: ${published.code}`);
  assert(published.events.length === 5, `published event 수가 5가 아닙니다: ${published.events.length}`);
  const after = dayTwo.store.getSnapshot();
  assert(after.campaign.reputation === reputationBefore, "unlock publisher가 reputation을 변경했습니다.");
  assert(after.progression.pendingUnlocks.length === 0, "게시 후 due unlock이 남았습니다.");
  assert(after.progression.publishedUnlockIds.length === 5, "published unlock 수가 5가 아닙니다.");
  assert(after.progression.unlockedFacilityIds.length === 3, "facility unlock 수가 3이 아닙니다.");
  assert(after.recipes.unlockedRecipeIds.length === 4, "두 Recipe가 Planning에 추가되지 않았습니다.");
  assert(after.menu.draftEntries.length === 4 && after.menu.confirmedEntries.length === 4,
    "Recipe unlock과 menu가 같은 transaction에서 동기화되지 않았습니다.");
  const facilityKinds = after.progression.unlockCatalog
    .filter((entry) => after.progression.publishedUnlockIds.includes(entry.unlockId))
    .filter((entry) => entry.kind === UNLOCK_KIND.FACILITY).length;
  assert(facilityKinds === 3, "게시된 facility target 수가 3이 아닙니다.");
  exactRejections += await assertRejectedUnchanged(
    dayTwo,
    () => dayTwo.unlockPublisher.publishForPlanning(commandInput(dayTwo, "qa:publish:duplicate", { day: 2 })),
    "NO_UNLOCKS_DUE",
    "second unlock publication",
  );
  return {
    qualifiedCount: 5,
    publishedCount: published.events.length,
    recipeAdditions: after.recipes.unlockedRecipeIds.length - lockedBefore,
    facilityAdditions: after.progression.unlockedFacilityIds.length,
    exactRejections,
    partialMutations: 0,
  };
}

/** Day 1 always selects the sole fixed intro and consumes zero RNG draws.
 * **Validates: Requirements 15.1, 15.3, 15.6** */
function fixedDayOneEvent(eventDefinitions) {
  const fixed = eventDefinitions.find((event) => event.selection === EVENT_SELECTION.FIXED_DAY_1);
  assert(fixed, "canonical fixed Day 1 event가 없습니다.");
  let checks = 0;
  for (let sample = 0; sample < EVENT_SEED_SAMPLES; sample += 1) {
    const rngState = createRngRegistryState(sampleSeed(sample));
    const generated = generateDailyEvent({ rngState, day: 1, eventDefinitions });
    assert(generated.event.eventId === fixed.eventId, "Day 1이 fixed intro를 선택하지 않았습니다.");
    assert(generated.drawsConsumed === 0, "Day 1 fixed event가 RNG를 소비했습니다.");
    assert(equivalent(generated.rngState, rngState), "Day 1 fixed event가 RNG registry를 변경했습니다.");
    const state = createEventState({ activeEvent: generated.event });
    const validation = validateEventState(state);
    assert(validation.ok && validation.details.activeEventCount === 1, "Day 1 active event cardinality가 1이 아닙니다.");
    checks += 1;
  }
  return { fixedEventId: fixed.eventId, zeroDrawChecks: checks, activeCardinalityChecks: checks };
}

function perturbNonEventStreams(rngState, sample) {
  const registry = RngRegistry.fromState(rngState);
  let draws = 0;
  for (let index = 0; index < CORE_RNG_STREAMS.length; index += 1) {
    const stream = CORE_RNG_STREAMS[index];
    if (stream === EVENT_RNG_STREAM) continue;
    const count = (sample + index) % 5 + 1;
    for (let draw = 0; draw < count; draw += 1) {
      registry.nextUint32(stream);
      draws += 1;
    }
  }
  return { rngState: registry.snapshot(), draws };
}

function simulateEventCampaign(eventDefinitions, seed, initialRngState = createRngRegistryState(seed)) {
  let rng = initialRngState;
  let events = createEventState();
  const selections = [];
  const drawCounts = [];
  let modifierReplacementChecks = 0;
  for (let day = 1; day <= CAMPAIGN_DAY_COUNT; day += 1) {
    const previousModifiers = cloneValue(events.activeModifiers);
    const planned = planDailyEventInitialization(
      { campaign: { day }, events, rng },
      { day },
      eventDefinitions,
    );
    assert(planned.ok, `Day ${day} event plan이 실패했습니다: ${planned.code}`);
    events = planned.plan.events;
    rng = planned.plan.rng;
    const validation = validateEventState(events);
    assert(validation.ok && validation.details.activeEventCount === 1,
      `Day ${day} active event cardinality가 1이 아닙니다.`);
    assert(events.activeEvent.generatedDay === day, `Day ${day} active event generatedDay가 다릅니다.`);
    assert(equivalent(events.activeModifiers, events.activeEvent.modifiers),
      `Day ${day} active modifier가 선택 event와 다릅니다.`);
    assert(events.history.length === day, `Day ${day} history cardinality가 다릅니다.`);
    assert(day === 1 ? planned.plan.drawsConsumed === 0 : planned.plan.drawsConsumed >= 1,
      `Day ${day} Event stream draw 계약이 다릅니다.`);
    if (day > 1) {
      assert(events.activeEvent.generatedDay !== day - 1, "이전 day event가 active로 남았습니다.");
      assert(!Object.prototype.hasOwnProperty.call(events, "activeEvents"),
        "active event가 collection 누적으로 저장됐습니다.");
      // The new object is an exact replacement, never an arithmetic merge with prior modifiers.
      for (const field of Object.keys(events.activeModifiers)) {
        const merged = previousModifiers[field] + events.activeEvent.modifiers[field];
        if (previousModifiers[field] !== 0) {
          assert(events.activeModifiers[field] !== merged || events.activeEvent.modifiers[field] === 0,
            `Day ${day} modifier ${field}가 이전 값에 누적됐습니다.`);
        }
      }
      modifierReplacementChecks += 1;
    }
    selections.push(events.activeEvent.eventId);
    drawCounts.push(planned.plan.drawsConsumed);
  }
  return { events, rng, selections, drawCounts, modifierReplacementChecks };
}

/** 128 seeds replay identically for all 14 days; non-event draws cannot perturb Event output/state.
 * **Validates: Requirements 15.2, 15.3, 15.5, 15.6, 23.4** */
function deterministicEventReplayAndStreamIsolation(eventDefinitions) {
  const randomIds = new Set(eventDefinitions
    .filter((event) => event.selection === EVENT_SELECTION.RANDOM_DAY_2_14)
    .map((event) => event.eventId));
  let daySelections = 0;
  let replayChecks = 0;
  let streamIsolationChecks = 0;
  let modifierReplacementChecks = 0;
  let nonEventPerturbationDraws = 0;
  for (let sample = 0; sample < EVENT_SEED_SAMPLES; sample += 1) {
    const seed = sampleSeed(sample, 0x51515151);
    const baseline = simulateEventCampaign(eventDefinitions, seed);
    const replay = simulateEventCampaign(eventDefinitions, seed);
    assert(equivalent(baseline.selections, replay.selections), `seed ${seed}: event replay output 불일치`);
    assert(equivalent(baseline.rng, replay.rng), `seed ${seed}: event replay cursor 불일치`);
    for (let dayIndex = 1; dayIndex < CAMPAIGN_DAY_COUNT; dayIndex += 1) {
      assert(randomIds.has(baseline.selections[dayIndex]),
        `seed ${seed} Day ${dayIndex + 1}: random Must pool 밖 event가 선택됐습니다.`);
    }
    const perturbed = perturbNonEventStreams(createRngRegistryState(seed), sample);
    const isolated = simulateEventCampaign(eventDefinitions, seed, perturbed.rngState);
    assert(equivalent(baseline.selections, isolated.selections), `seed ${seed}: non-event draw가 event 선택을 변경했습니다.`);
    assert(equivalent(
      baseline.rng.streams[EVENT_RNG_STREAM],
      isolated.rng.streams[EVENT_RNG_STREAM],
    ), `seed ${seed}: Event stream final state가 non-event draw에 영향받았습니다.`);
    for (const stream of CORE_RNG_STREAMS) {
      if (stream === EVENT_RNG_STREAM) continue;
      assert(equivalent(perturbed.rngState.streams[stream], isolated.rng.streams[stream]),
        `seed ${seed}: EventSystem이 ${stream} stream을 소비했습니다.`);
    }
    daySelections += baseline.selections.length;
    replayChecks += CAMPAIGN_DAY_COUNT;
    streamIsolationChecks += CAMPAIGN_DAY_COUNT;
    modifierReplacementChecks += baseline.modifierReplacementChecks;
    nonEventPerturbationDraws += perturbed.draws;
  }
  return {
    seedSamples: EVENT_SEED_SAMPLES,
    daySelections,
    replayChecks,
    streamIsolationChecks,
    modifierReplacementChecks,
    nonEventPerturbationDraws,
  };
}

/** Daily initialization replaces prior state atomically and rejects a second active event exactly.
 * **Validates: Requirements 15.2, 15.4, 15.5, 15.6** */
async function eventTransactionAtomicity(recipes, facilities, eventDefinitions) {
  const seed = 0x18e7e17;
  const initialRng = createRngRegistryState(seed);
  const dayOneGeneration = generateDailyEvent({ rngState: initialRng, day: 1, eventDefinitions });
  const dayOneState = createEventState({ activeEvent: dayOneGeneration.event });
  const dayOne = createHarness({
    recipes,
    facilities,
    eventDefinitions,
    seed,
    day: 1,
    eventState: dayOneState,
    rngState: dayOneGeneration.rngState,
  });
  let exactRejections = 0;
  exactRejections += await assertRejectedUnchanged(
    dayOne,
    () => dayOne.eventSystem.initializeDay(commandInput(dayOne, "qa:event:same-day-1", { day: 1 })),
    "EVENT_ALREADY_ACTIVE_FOR_DAY",
    "second Day 1 event",
  );

  const dayTwo = createHarness({
    recipes,
    facilities,
    eventDefinitions,
    snapshot: dayOne.store.getSnapshot(),
    day: 2,
    runtimePhase: "PLANNING",
  });
  const before = dayTwo.store.getSnapshot();
  const priorEventId = before.events.activeEvent.eventId;
  const priorModifiers = cloneValue(before.events.activeModifiers);
  const initialized = await dayTwo.eventSystem.initializeDay(commandInput(dayTwo, "qa:event:day-2", { day: 2 }));
  assert(initialized.ok, `Day 2 transaction이 실패했습니다: ${initialized.code}`);
  assert(initialized.events.length === 1, "Day 2가 정확히 한 event signal을 만들지 않았습니다.");
  const after = dayTwo.store.getSnapshot();
  assert(after.events.activeEvent.generatedDay === 2, "Day 2 active event가 교체되지 않았습니다.");
  assert(after.events.history.length === 2, "Day 2 history가 정확히 하나 append되지 않았습니다.");
  assert(after.events.history[0].eventId === priorEventId, "이전 event history가 손실됐습니다.");
  assert(equivalent(after.events.activeModifiers, after.events.activeEvent.modifiers),
    "Day 2 modifier가 새 event의 exact modifier가 아닙니다.");
  assert(!equivalent(after.events.activeModifiers, Object.fromEntries(
    Object.keys(priorModifiers).map((field) => [field, priorModifiers[field] + after.events.activeEvent.modifiers[field]]),
  )) || equivalent(priorModifiers, ZERO_EVENT_MODIFIERS), "Day 2 modifier가 이전 modifier와 누적됐습니다.");
  for (const stream of CORE_RNG_STREAMS) {
    if (stream === EVENT_RNG_STREAM) continue;
    assert(equivalent(before.rng.streams[stream], after.rng.streams[stream]),
      `event transaction이 ${stream} stream을 변경했습니다.`);
  }
  exactRejections += await assertRejectedUnchanged(
    dayTwo,
    () => dayTwo.eventSystem.initializeDay(commandInput(dayTwo, "qa:event:same-day-2", { day: 2 })),
    "EVENT_ALREADY_ACTIVE_FOR_DAY",
    "second Day 2 event",
  );
  const service = createHarness({
    recipes,
    facilities,
    eventDefinitions,
    snapshot: dayOne.store.getSnapshot(),
    day: 2,
    runtimePhase: "SERVICE",
  });
  exactRejections += await assertRejectedUnchanged(
    service,
    () => service.eventSystem.initializeDay(commandInput(service, "qa:event:illegal-phase", { day: 2 })),
    "ILLEGAL_PHASE",
    "event initialization outside Planning",
  );
  return {
    successfulCommits: 1,
    exactRejections,
    activeEventCount: 1,
    historyCount: after.events.history.length,
    nonEventStreamsPreserved: CORE_RNG_STREAMS.length - 1,
    partialMutations: 0,
  };
}

export async function runReputationEventsProbe({ recipes, facilities, events } = {}) {
  assert(Array.isArray(recipes) && recipes.length >= 2, "canonical Recipe 입력이 없습니다.");
  assert(Array.isArray(facilities) && facilities.length > 0, "canonical facility 입력이 없습니다.");
  assert(Array.isArray(events) && events.length > 1, "canonical event 입력이 없습니다.");
  const definitions = [
    ["canonical-catalog-campaign-reset", "canonical threshold registry와 새 캠페인 progression reset", ["14.5", "14.6", "16.1"], () => canonicalCatalogAndCampaignReset(recipes, facilities, events)],
    ["reputation-clamp-boundary-sweep", "0..100 시작값과 safe-integer delta의 integer clamp sweep", ["16.1", "16.2", "16.6"], () => reputationClampBoundarySweep(recipes, facilities)],
    ["reputation-atomic-rejection", "duplicate Cause/command, invalid input, stale/phase exact full rejection", ["16.1", "16.2", "16.3", "23.4"], () => reputationAtomicRejection(recipes, facilities, events)],
    ["threshold-crossing-cardinality", "actual/equal/multiple/re-cross threshold unlock cardinality", ["14.2", "14.3", "16.5", "16.6"], () => thresholdCrossingCardinality(recipes, facilities, events)],
    ["next-planning-unlock-publication", "crossing 당일 비가용, 다음 Planning Recipe/menu/facility atomic publication", ["14.2", "14.3", "14.4", "16.5"], () => nextPlanningUnlockPublication(recipes, facilities, events)],
    ["fixed-day-one-event", "128 seeds Day 1 fixed intro, zero RNG draw, active cardinality 1", ["15.1", "15.3", "15.6"], () => fixedDayOneEvent(events)],
    ["deterministic-event-replay-isolation", "128 seeds × 14 days replay, replacement, Event stream isolation", ["15.2", "15.3", "15.5", "15.6", "23.4"], () => deterministicEventReplayAndStreamIsolation(events)],
    ["event-transaction-atomicity", "daily atomic replacement과 same-day/phase rejection exact preservation", ["15.2", "15.4", "15.5", "15.6"], () => eventTransactionAtomicity(recipes, facilities, events)],
  ];
  const results = [];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  const detailsFor = (id) => results.find((result) => result.id === id)?.details ?? {};
  return Object.freeze({
    qaId: "task-18-reputation-unlock-event-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    reputationBoundaryChecks: detailsFor("reputation-clamp-boundary-sweep").boundaryChecks ?? 0,
    thresholdUnlockChecks:
      (detailsFor("threshold-crossing-cardinality").multiCrossUnlocks ?? 0) +
      (detailsFor("threshold-crossing-cardinality").equalThresholdUnlocks ?? 0) +
      (detailsFor("threshold-crossing-cardinality").recrossUnlocks ?? 0),
    exactRejectionChecks:
      (detailsFor("reputation-atomic-rejection").exactRejections ?? 0) +
      (detailsFor("next-planning-unlock-publication").exactRejections ?? 0) +
      (detailsFor("event-transaction-atomicity").exactRejections ?? 0),
    eventSeedSamples: detailsFor("deterministic-event-replay-isolation").seedSamples ?? 0,
    eventDaySelections: detailsFor("deterministic-event-replay-isolation").daySelections ?? 0,
    deterministicReplayChecks: detailsFor("deterministic-event-replay-isolation").replayChecks ?? 0,
    rngStreamIsolationChecks: detailsFor("deterministic-event-replay-isolation").streamIsolationChecks ?? 0,
    modifierReplacementChecks: detailsFor("deterministic-event-replay-isolation").modifierReplacementChecks ?? 0,
    partialMutationCount:
      (detailsFor("reputation-atomic-rejection").partialMutations ?? 0) +
      (detailsFor("next-planning-unlock-publication").partialMutations ?? 0) +
      (detailsFor("event-transaction-atomicity").partialMutations ?? 0),
    results: Object.freeze(results),
  });
}
