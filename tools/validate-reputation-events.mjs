#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runReputationEventsProbe } from "../js/qa/reputation-events-probe.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supportedArguments = new Set(["--json"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));

function staticResult(id, description, condition, details = undefined) {
  return Object.freeze({
    id,
    description,
    status: condition ? "PASS" : "FAIL",
    ...(details === undefined ? {} : { details }),
    ...(!condition ? { error: description } : {}),
  });
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(repositoryRoot, relativePath), "utf8"));
}

async function readSources() {
  const paths = {
    reputation: "js/domain/reputation.js",
    unlocks: "js/domain/unlocks.js",
    events: "js/domain/events.js",
    qa: "js/qa/reputation-events-probe.js",
    bootstrap: "js/app/bootstrap.js",
    recipe: "js/domain/recipe.js",
    menu: "js/domain/menu.js",
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, relativePath]) => [
    name,
    await readFile(resolve(repositoryRoot, relativePath), "utf8"),
  ]));
  return Object.fromEntries(entries);
}

async function reputationWriterAudit() {
  const domainDirectory = resolve(repositoryRoot, "js/domain");
  const filenames = (await readdir(domainDirectory)).filter((filename) => filename.endsWith(".js")).sort();
  const sources = await Promise.all(filenames.map(async (filename) => ({
    filename,
    text: await readFile(resolve(domainDirectory, filename), "utf8"),
  })));
  const writers = sources.flatMap(({ filename, text }) => [
    ...text.matchAll(/\.reputation\s*(?:=|\+=|-=|\+\+|--)/g),
  ].map((match) => ({ filename, expression: match[0] })));
  return { filenames, writers };
}

async function runStaticAudit({ recipesDocument, facilitiesDocument, eventsDocument, balanceDocument }) {
  const [source, writerAudit] = await Promise.all([readSources(), reputationWriterAudit()]);
  const productionSources = [source.reputation, source.unlocks, source.events];
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "crypto.randomUUID(",
  ];
  const forbiddenViolations = forbidden.filter((token) =>
    productionSources.some((text) => text.includes(token)));
  const recipeThresholds = recipesDocument.recipes
    .filter((recipe) => recipe.unlock?.type === "REPUTATION")
    .map((recipe) => recipe.unlock.reputationThreshold);
  const facilityThresholds = facilitiesDocument.facilities.map((facility) => facility.unlockReputation);
  const allThresholds = [...recipeThresholds, ...facilityThresholds].sort((left, right) => left - right);
  const fixedEvents = eventsDocument.events.filter((event) => event.selection === "FIXED_DAY_1");
  const randomEvents = eventsDocument.events.filter((event) => event.selection === "RANDOM_DAY_2_14");
  const invalidEventModifiers = eventsDocument.events.flatMap((event) => {
    const expectedFields = [
      "guestCountDelta",
      "patienceDeltaMs",
      "timingWindowBonusMs",
      "marketPurchaseLimitBonusQuantity",
    ].sort();
    const actualFields = Object.keys(event.modifiers ?? {}).sort();
    return JSON.stringify(expectedFields) === JSON.stringify(actualFields) &&
      actualFields.every((field) => Number.isSafeInteger(event.modifiers[field]))
      ? []
      : [event.eventId];
  });

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "Reputation/Unlock/Event domain은 browser·wall-clock·nondeterministic primitive를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-reputation-single-writer",
      "campaign reputation의 유일한 mutation writer는 ReputationSystem draft helper다",
      writerAudit.writers.length === 1 && writerAudit.writers[0].filename === "reputation.js" &&
        source.reputation.includes("export function applyReputationCauseToDraft") &&
        source.reputation.includes("campaignDraft.reputation = reputation") &&
        source.reputation.includes("processedCauseIds.push(payload.causeId)"),
      { writers: writerAudit.writers },
    ),
    staticResult(
      "static-canonical-threshold-registry",
      "canonical Recipe/facility threshold를 stable unlock catalog로 결합하고 새 progression은 비어 있다",
      recipesDocument.recipes.length === 6 && facilitiesDocument.facilities.length === 3 &&
        JSON.stringify(allThresholds) === JSON.stringify([36, 40, 42, 48, 48, 56, 64]) &&
        source.unlocks.includes("export function createUnlockCatalog") &&
        source.unlocks.includes("pendingUnlocks: []") &&
        source.unlocks.includes("publishedUnlockIds: []") &&
        source.unlocks.includes("unlockedFacilityIds: []"),
      { recipeThresholds, facilityThresholds, allThresholds },
    ),
    staticResult(
      "static-actual-crossing-once",
      "strict previous<threshold<=next와 pending/published handled set만 unlock qualification event를 만든다",
      source.unlocks.includes("previousReputation < descriptor.threshold && nextReputation >= descriptor.threshold") &&
        source.unlocks.includes("!handled.has(descriptor.unlockId)") &&
        source.reputation.includes("DUPLICATE_REPUTATION_CAUSE") &&
        source.reputation.includes("type: \"progression.unlock-qualified\"") &&
        source.reputation.includes("qualifiedUnlocks.map"),
    ),
    staticResult(
      "static-next-planning-publication",
      "qualified unlock은 crossedDay+1 이후 Planning transaction에서 Recipe/menu/facility에 원자 게시된다",
      source.unlocks.includes("availablePlanningDay: crossedDay + 1") &&
        source.unlocks.includes("allowedPhases: [\"PLANNING\"]") &&
        source.unlocks.includes("entry.availablePlanningDay <= campaign.day") &&
        source.unlocks.includes("addRecipeUnlocksForPlanning") &&
        source.unlocks.includes("synchronizeMenuForPlanning") &&
        source.unlocks.includes("UNLOCK_PUBLISH_WRITE_SET") &&
        source.unlocks.includes("[\"progression\", \"recipes\", \"menu\"]") &&
        source.unlocks.includes("NO_UNLOCKS_DUE"),
    ),
    staticResult(
      "static-reputation-unlock-atomic-registration",
      "Reputation cause와 unlock publisher는 declared write-set AtomicTransaction으로 production CommandBus에 등록된다",
      source.reputation.includes("defineAtomicTransaction({") &&
        source.unlocks.includes("defineAtomicTransaction({") &&
        /commandBus\.register\([\s\S]*REPUTATION_COMMAND\.APPLY_CAUSE/.test(source.reputation) &&
        /commandBus\.register\([\s\S]*UNLOCK_COMMAND\.PUBLISH_FOR_PLANNING/.test(source.unlocks) &&
        source.reputation.includes("REPUTATION_APPLY_WRITE_SET = Object.freeze([\"campaign\", \"progression\"])") &&
        source.reputation.includes("allowedPhases: REPUTATION_PHASES"),
    ),
    staticResult(
      "static-must-event-catalog",
      "canonical Must events는 Day 1 fixed 정확히 1개와 Day 2..14 random pool 및 1-day integer modifier를 제공한다",
      fixedEvents.length === 1 && randomEvents.length === 4 && invalidEventModifiers.length === 0 &&
        eventsDocument.events.every((event) => event.durationDays === 1) &&
        source.events.includes("fixedCount !== 1") &&
        source.events.includes("randomCount < 1"),
      { fixedCount: fixedEvents.length, randomCount: randomEvents.length, invalidEventModifiers },
    ),
    staticResult(
      "static-event-rng-isolation-cardinality",
      "Day 1은 draw 없이 fixed event, Day 2..14는 event stream만 사용하고 active event 하나를 exact 교체한다",
      source.events.includes("export const EVENT_RNG_STREAM = \"event\"") &&
        source.events.includes("if (day === 1)") &&
        source.events.includes("registry.nextInt(EVENT_RNG_STREAM, candidates.length)") &&
        !source.events.includes("nextInt(\"market\"") &&
        !source.events.includes("nextInt(\"contract") &&
        !source.events.includes("nextInt(\"demand\"") &&
        source.events.includes("activeEventCount: activeIsNull ? 0 : 1") &&
        source.events.includes("activeEvent: normalizedActive") &&
        source.events.includes("EVENT_ALREADY_ACTIVE_FOR_DAY") &&
        source.events.includes("unchangedNonEventStreams"),
    ),
    staticResult(
      "static-stale-modifier-projection",
      "next day에는 이전 modifier를 누적하지 않고 campaign day가 다르면 zero modifier를 projection한다",
      source.events.includes("activeModifiers: normalizedActive === null") &&
        source.events.includes("snapshot.events.activeEvent?.generatedDay === snapshot.campaign?.day") &&
        source.events.includes("cloneValue(ZERO_EVENT_MODIFIERS)") &&
        source.events.includes("draft.replace(\"events\", planned.plan.events)") &&
        source.events.includes("draft.replace(\"rng\", planned.plan.rng)"),
    ),
    staticResult(
      "static-production-composition",
      "AppBootstrap은 canonical start reputation, progression, fixed Day 1 event와 세 facade를 production store/bus에 배선한다",
      source.bootstrap.includes("reputationModule.createReputationCampaignFields(") &&
        source.bootstrap.includes("balanceDocument.campaign.startReputation") &&
        source.bootstrap.includes("unlocksModule.createUnlockCatalog({") &&
        source.bootstrap.includes("eventModule.generateDailyEvent({") &&
        source.bootstrap.includes("const contractGenerationCheckpoint = Object.freeze({") &&
        source.bootstrap.includes("rng: contractGeneration.rngState") &&
        source.bootstrap.includes("rngState: contractGenerationCheckpoint.rng") &&
        source.bootstrap.includes("rngState: rngModule.createRngRegistryState(masterSeed)") &&
        source.bootstrap.includes("rng: eventGeneration.rngState") &&
        source.bootstrap.includes("this.reputationSystem = reputationModule.registerReputationSystem(this.commandBus)") &&
        source.bootstrap.includes("this.unlockPublisher = unlocksModule.registerUnlockPublisher(this.commandBus)") &&
        source.bootstrap.includes("this.eventSystem = eventModule.registerEventSystem(this.commandBus, eventDocument.events)") &&
        balanceDocument.campaign.startReputation === 30,
    ),
    staticResult(
      "static-requirement-linked-qa",
      "Task 18 QA는 Property 16 requirement links, boundary/crossing/publication/replay/isolation/rejection 계측을 제공한다",
      source.qa.includes("export async function runReputationEventsProbe") &&
        source.qa.includes("**Validates: Requirements 14.2, 14.3, 14.4, 16.5**") &&
        source.qa.includes("**Validates: Requirements 15.2, 15.3, 15.5, 15.6, 23.4**") &&
        source.qa.includes("const EVENT_SEED_SAMPLES = 128") &&
        source.qa.includes("reputationBoundaryChecks") &&
        source.qa.includes("deterministicReplayChecks") &&
        source.qa.includes("rngStreamIsolationChecks") &&
        source.qa.includes("modifierReplacementChecks") &&
        source.qa.includes("partialMutationCount"),
    ),
  ]);
  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}

export async function runReputationEventsValidation() {
  const [recipesDocument, facilitiesDocument, eventsDocument, balanceDocument] = await Promise.all([
    readJson("data/recipes.json"),
    readJson("data/upgrades.json"),
    readJson("data/events.json"),
    readJson("data/balance.json"),
  ]);
  const [reputationEvents, staticAudit] = await Promise.all([
    runReputationEventsProbe({
      recipes: recipesDocument.recipes,
      facilities: facilitiesDocument.facilities,
      events: eventsDocument.events,
    }),
    runStaticAudit({ recipesDocument, facilitiesDocument, eventsDocument, balanceDocument }),
  ]);
  return Object.freeze({
    status: reputationEvents.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    reputationEvents,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runReputationEventsValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Reputation/Unlock/Event validation: ${report.status}`);
    console.log(`Task 18 examples/properties: ${report.reputationEvents.status} (${report.reputationEvents.passed}/${report.reputationEvents.total})`);
    console.log(`  reputation boundary checks: ${report.reputationEvents.reputationBoundaryChecks}`);
    console.log(`  threshold unlock checks: ${report.reputationEvents.thresholdUnlockChecks}`);
    console.log(`  exact rejection checks: ${report.reputationEvents.exactRejectionChecks}`);
    console.log(`  event seed samples/day selections: ${report.reputationEvents.eventSeedSamples}/${report.reputationEvents.eventDaySelections}`);
    console.log(`  deterministic replay checks: ${report.reputationEvents.deterministicReplayChecks}`);
    console.log(`  RNG stream isolation checks: ${report.reputationEvents.rngStreamIsolationChecks}`);
    console.log(`  modifier replacement checks: ${report.reputationEvents.modifierReplacementChecks}`);
    console.log(`  partial mutations: ${report.reputationEvents.partialMutationCount}`);
    for (const result of report.reputationEvents.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 18 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
