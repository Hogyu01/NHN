#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runFacilityProbe } from "../js/qa/facility-probe.js";

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

function quotedValuesFromConstant(source, constantName) {
  const match = source.match(new RegExp(`${constantName}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`));
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]) : [];
}

async function runStaticAudit({ facilitiesDocument, balanceDocument }) {
  const paths = {
    facility: "js/domain/facility.js",
    qa: "js/qa/facility-probe.js",
    bootstrap: "js/app/bootstrap.js",
    unlocks: "js/domain/unlocks.js",
    cash: "js/domain/cash-transaction-api.js",
    ledger: "js/domain/economy-ledger.js",
    market: "js/domain/market.js",
  };
  const sourceEntries = await Promise.all(Object.entries(paths).map(async ([name, relativePath]) => [
    name,
    await readFile(resolve(repositoryRoot, relativePath), "utf8"),
  ]));
  const source = Object.fromEntries(sourceEntries);
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "crypto.randomUUID(",
  ];
  const forbiddenViolations = forbidden.filter((token) => source.facility.includes(token));
  const directCashWrites = [...source.facility.matchAll(/\.cashG\s*(?:=|\+=|-=|\+\+|--)/g)]
    .map((match) => match[0]);
  const readSet = quotedValuesFromConstant(source.facility, "FACILITY_PURCHASE_READ_SET");
  const writeSet = quotedValuesFromConstant(source.facility, "FACILITY_PURCHASE_WRITE_SET");
  const spatialWriteSlices = writeSet.filter((slice) => ["world", "map", "maps"].includes(slice));

  const expectedByKind = {
    KITCHEN: { costG: 90, effectType: "TIMING_WINDOW_BONUS_MS", value: 120, unit: "MILLISECONDS" },
    HALL: { costG: 110, effectType: "PATIENCE_BONUS_MS", value: 5_000, unit: "MILLISECONDS" },
    STORAGE: { costG: 100, effectType: "MARKET_PURCHASE_LIMIT_BONUS_QUANTITY", value: 12, unit: "QUANTITY" },
  };
  const canonicalFailures = [];
  for (const [kind, expected] of Object.entries(expectedByKind)) {
    const stages = facilitiesDocument.facilities.filter((facility) => facility.kind === kind);
    if (stages.length !== 1) {
      canonicalFailures.push(`${kind}:count=${stages.length}`);
      continue;
    }
    const stage = stages[0];
    if (stage.stage !== 1 || stage.costG !== expected.costG ||
        stage.effect?.type !== expected.effectType || stage.effect?.value !== expected.value ||
        stage.effect?.unit !== expected.unit || stage.effectiveTiming !== "SAME_DAY") {
      canonicalFailures.push(`${kind}:canonical-contract`);
    }
  }
  if (facilitiesDocument.facilities.length !== 3) {
    canonicalFailures.push(`total=${facilitiesDocument.facilities.length}`);
  }

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "FacilitySystem은 browser·wall-clock·nondeterministic primitive를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-canonical-must-stages",
      "canonical kitchen/hall/storage는 각각 정확히 한 stage 1과 exact cost/effect/SAME_DAY를 제공한다",
      canonicalFailures.length === 0,
      { canonicalFailures, stageCount: facilitiesDocument.facilities.length },
    ),
    staticResult(
      "static-state-and-planning-projection",
      "FacilityState와 Planning projection은 cost·condition·before/after/current·unpurchased zero를 명시한다",
      source.facility.includes("export function createFacilityState") &&
        source.facility.includes("export function validateFacilityState") &&
        source.facility.includes("export function projectFacilities") &&
        source.facility.includes("beforeValue") && source.facility.includes("afterValue") &&
        source.facility.includes("currentValue") && source.facility.includes("purchaseEnabled") &&
        source.facility.includes("FACILITY_PURCHASE_REQUIRES_PLANNING"),
    ),
    staticResult(
      "static-delegated-cash-writer",
      "시설 투자는 Task 13 CashTransactionAPI에 위임하며 FacilitySystem은 cash 직접 writer를 만들지 않는다",
      source.facility.includes("applyCashTransactionToDraft(economyCandidate") &&
        source.cash.includes("applyCashTransactionToDraft") &&
        source.ledger.includes("FACILITY_INVESTMENT") && directCashWrites.length === 0,
      { directCashWrites },
    ),
    staticResult(
      "static-atomic-write-set-ledger",
      "PurchaseFacility은 declared write-set 단일 transaction과 investment↔EconomyLedger 양방향 대사를 제공한다",
      JSON.stringify(readSet) === JSON.stringify(["campaign", "progression"]) &&
        JSON.stringify(writeSet) === JSON.stringify(["economy", "facilities", "market", "idCounters"]) &&
        source.facility.includes("defineAtomicTransaction({") &&
        source.facility.includes("validateFacilityLedgerLinks") &&
        source.facility.includes("FACILITY_INVESTMENT") &&
        source.facility.includes("validateEconomyTransition(before.economy, after.economy)") &&
        source.facility.includes("reconcileCashWithLedger("),
      { readSet, writeSet },
    ),
    staticResult(
      "static-same-day-exact-effects",
      "kitchen +120ms, hall +5000ms, storage +12가 당일 실제 projection/state에 합성된다",
      balanceDocument.service.basePatienceMs === 30_000 &&
        balanceDocument.market.defaultPurchaseLimitQuantity === 30 &&
        source.facility.includes("timingWindowProjection(snapshot.recipes") &&
        source.facility.includes("facilityEffects.patienceBonusMs") &&
        source.facility.includes("market.purchaseLimitQuantity") &&
        source.facility.includes("createMarketState({ ...marketCandidate, purchaseLimitQuantity })"),
      {
        basePatienceMs: balanceDocument.service.basePatienceMs,
        baseMarketPurchaseLimit: balanceDocument.market.defaultPurchaseLimitQuantity,
      },
    ),
    staticResult(
      "static-market-guard-integration",
      "storage 효과는 query-only 값이 아니라 MarketSystem의 실제 purchaseLimitQuantity guard를 변경한다",
      source.facility.includes("definition.kind === FACILITY_KIND.STORAGE") &&
        source.facility.includes("purchaseLimitQuantity = checkedAddNonNegative(") &&
        source.market.includes("const remainingPurchaseLimitQuantity = market.purchaseLimitQuantity - market.purchasedQuantity") &&
        source.market.includes("MARKET_PURCHASE_LIMIT_EXCEEDED"),
    ),
    staticResult(
      "static-next-planning-unlock-integration",
      "구매 가능 여부는 Task 18이 다음 Planning에 게시하는 progression.unlockedFacilityIds를 단일 기준으로 사용한다",
      source.facility.includes("progression.unlockedFacilityIds.includes(definition.facilityId)") &&
        source.unlocks.includes("availablePlanningDay: crossedDay + 1") &&
        source.unlocks.includes("progressionCandidate.unlockedFacilityIds = progressionCandidate.unlockCatalog") &&
        source.unlocks.includes("descriptor.kind === UNLOCK_KIND.FACILITY"),
    ),
    staticResult(
      "static-non-spatial-map-isolation",
      "Must facility write-set은 World/Map을 제외하고 spatial authored field를 거절한다",
      spatialWriteSlices.length === 0 &&
        source.facility.includes("MUST_FACILITY_SPATIAL_EFFECT_FORBIDDEN") &&
        source.facility.includes("opensRegionId") && source.facility.includes("activatesSeatIds"),
      { spatialWriteSlices },
    ),
    staticResult(
      "static-production-composition",
      "AppBootstrap STORE stage가 canonical facilities state와 FacilitySystem facade를 production bus에 배선한다",
      source.bootstrap.includes("import(\"../domain/facility.js\")") &&
        source.bootstrap.includes("facilityModule.createFacilityState({") &&
        source.bootstrap.includes("facilities: facilityDocument.facilities") &&
        source.bootstrap.includes("this.facilitySystem = facilityModule.registerFacilitySystem(this.commandBus") &&
        source.bootstrap.includes("facilitySystem: this.facilitySystem"),
    ),
    staticResult(
      "static-requirement-linked-property-qa",
      "Task 19 QA는 Property 25 requirement links, 128 samples, exact effects, ledger, unlock, rejection, Map deep-equal을 계측한다",
      source.qa.includes("export async function runFacilityProbe") &&
        source.qa.includes("**Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 28.5, 28.7**") &&
        source.qa.includes("const FACILITY_PROPERTY_SAMPLES = 128") &&
        source.qa.includes("storageLimitAffectsMarketPurchase") &&
        source.qa.includes("nextPlanningUnlockIntegration") &&
        source.qa.includes("purchaseAtomicRejections") &&
        source.qa.includes("mapDeepEqualCheckCount") &&
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

export async function runFacilityValidation() {
  const [recipesDocument, facilitiesDocument, balanceDocument, baseMap] = await Promise.all([
    readJson("data/recipes.json"),
    readJson("data/upgrades.json"),
    readJson("data/balance.json"),
    readJson("data/maps/base-restaurant.json"),
  ]);
  const [facility, staticAudit] = await Promise.all([
    runFacilityProbe({
      recipes: recipesDocument.recipes,
      facilities: facilitiesDocument.facilities,
      balance: balanceDocument,
      baseMap,
    }),
    runStaticAudit({ facilitiesDocument, balanceDocument }),
  ]);
  return Object.freeze({
    status: facility.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    facility,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runFacilityValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Facility validation: ${report.status}`);
    console.log(`Task 19 examples/property: ${report.facility.status} (${report.facility.passed}/${report.facility.total})`);
    console.log(`  canonical Must stages: ${report.facility.canonicalStageCount}`);
    console.log(`  approved facility commits: ${report.facility.approvedPurchaseCount}`);
    console.log(`  kitchen timing-window checks: ${report.facility.timingWindowCheckCount}`);
    console.log(`  investment ledger entries: ${report.facility.investmentLedgerEntryCount}`);
    console.log(`  storage-enabled market quantity: ${report.facility.storageMarketApprovedQuantity}`);
    console.log(`  next-Planning unlock publications: ${report.facility.unlockPublicationCount}`);
    console.log(`  exact rejection checks: ${report.facility.exactRejectionCount}`);
    console.log(`  Property 25 samples/exact effects: ${report.facility.propertySampleCount}/${report.facility.exactEffectCheckCount}`);
    console.log(`  authored Map deep-equal checks: ${report.facility.mapDeepEqualCheckCount}`);
    console.log(`  partial mutations: ${report.facility.partialMutationCount}`);
    for (const result of report.facility.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 19 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
