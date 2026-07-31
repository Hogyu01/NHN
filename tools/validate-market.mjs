#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runMarketProbe } from "../js/qa/market-probe.js";

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

async function runStaticAudit({ ingredientsDocument, balanceDocument }) {
  const paths = {
    market: resolve(repositoryRoot, "js/domain/market.js"),
    qa: resolve(repositoryRoot, "js/qa/market-probe.js"),
    bootstrap: resolve(repositoryRoot, "js/app/bootstrap.js"),
    transaction: resolve(repositoryRoot, "js/core/transaction.js"),
    cash: resolve(repositoryRoot, "js/domain/cash-transaction-api.js"),
    accounting: resolve(repositoryRoot, "js/domain/inventory-accounting.js"),
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")]),
  );
  const source = Object.fromEntries(entries);
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "crypto.randomUUID(",
  ];
  const forbiddenViolations = forbidden.filter((token) => source.market.includes(token));
  const drawCalls = [...source.market.matchAll(/registry\.(?:percentage|nextInt|nextUint32)\(\s*([^,\)]+)/g)]
    .map((match) => match[1].trim());
  const nonMarketDrawCalls = drawCalls.filter((argument) => argument !== "MARKET_RNG_STREAM");
  const directCashWrites = [...source.market.matchAll(/\.cashG\s*(?:=|\+=|-=|\+\+|--)/g)]
    .map((match) => match[0]);
  const duplicateLotWrites = [...source.market.matchAll(/\.lots\.(?:push|splice|pop|shift|unshift)\(/g)]
    .map((match) => match[0]);
  const payloadGuardIndex = source.transaction.indexOf("invokeGuard(this.validatePayload");
  const draftCreationIndex = source.transaction.indexOf("new DraftContext(");
  const ingredientContractFailures = ingredientsDocument.ingredients.flatMap((ingredient) => {
    const failures = [];
    const weightTotal = ingredient.qualityDistribution.reduce((sum, bucket) => sum + bucket.weight, 0);
    if (!Number.isSafeInteger(ingredient.basePriceG) || ingredient.basePriceG < 1) failures.push(`${ingredient.ingredientId}:basePriceG`);
    if (!Number.isInteger(ingredient.marketAvailabilityRate) || ingredient.marketAvailabilityRate < 0 || ingredient.marketAvailabilityRate > 100) {
      failures.push(`${ingredient.ingredientId}:marketAvailabilityRate`);
    }
    if (Math.abs(weightTotal - 1) > 0.000_001) failures.push(`${ingredient.ingredientId}:qualityDistribution`);
    return failures;
  });

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "MarketSystem은 browser·wall-clock·nondeterministic primitive를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-market-stream-only",
      "offer generator의 모든 RNG draw는 명시적 market stream만 소비한다",
      drawCalls.length === 5 && nonMarketDrawCalls.length === 0 &&
        source.market.includes("RngRegistry.fromState(rngState)") &&
        source.market.includes("const finalRngState = registry.snapshot()"),
      { drawCalls, nonMarketDrawCalls },
    ),
    staticResult(
      "static-offer-contract",
      "가격 Half-Up ±20%·최소 1G, Quality 0..100, stable ordering/ID와 final cursor를 명시한다",
      source.market.includes("MARKET_PRICE_VARIANCE_PERCENT = 20") &&
        source.market.includes("Math.max(1, rounded)") &&
        source.market.includes("offer.quality < 0 || offer.quality > 100") &&
        source.market.includes("normalized.sort(") &&
        source.market.includes("market:${day}:${ingredientId}") &&
        source.market.includes("marketStreamAfter") &&
        source.market.includes("drawsConsumed"),
    ),
    staticResult(
      "static-pre-draft-quantity-guard",
      "quantity 0·invalid integer는 AtomicTransaction draft 생성 전에 payload guard에서 거절된다",
      source.market.includes("!Number.isSafeInteger(payload.quantity) || payload.quantity <= 0") &&
        source.market.includes("validatePayload(ctx)") &&
        source.market.includes("return validateMarketPurchasePayload(ctx.command.payload)") &&
        payloadGuardIndex >= 0 && draftCreationIndex > payloadGuardIndex,
      { payloadGuardIndex, draftCreationIndex },
    ),
    staticResult(
      "static-all-or-nothing-guards",
      "stock·Available_Cash·Market_Purchase_Limit guard와 detached candidate planning으로 부분 구매를 금지한다",
      source.market.includes("INSUFFICIENT_MARKET_STOCK") &&
        source.market.includes("MARKET_PURCHASE_LIMIT_EXCEEDED") &&
        source.cash.includes("INSUFFICIENT_AVAILABLE_CASH") &&
        source.market.includes("const economyCandidate = cloneValue(economy)") &&
        source.market.includes("const inventoryCandidate = cloneValue(inventory)") &&
        source.market.includes("const marketCandidate = cloneValue(market)"),
    ),
    staticResult(
      "static-delegated-accounting-writers",
      "구매는 Task 13 cash 및 Task 14 lot acquisition draft helper를 위임 호출하고 중복 cash/lot writer를 만들지 않는다",
      source.market.includes("applyCashTransactionToDraft(economyCandidate") &&
        source.market.includes("applyLotAcquisitionToDraft(inventoryCandidate, accountingCandidate") &&
        source.cash.includes("export function applyCashTransactionToDraft") &&
        source.accounting.includes("export function applyLotAcquisitionToDraft") &&
        directCashWrites.length === 0 && duplicateLotWrites.length === 0,
      { directCashWrites, duplicateLotWrites },
    ),
    staticResult(
      "static-atomic-reconciliation",
      "PurchaseMarketOffer는 단일 AtomicTransaction에서 ledger·lot Book_Cost·offer·ID·inventory 대사를 사후 검증한다",
      source.market.includes("defineAtomicTransaction({") &&
        source.market.includes("MARKET_PURCHASE_WRITE_SET") &&
        source.market.includes("validateEconomyTransition(before.economy, after.economy)") &&
        source.market.includes("validateCostMovementAppendOnly(") &&
        source.market.includes("reconcileCashWithLedger(") &&
        source.market.includes("reconcileInventoryAccounting(") &&
        source.market.includes("planned.lot.bookCostG !== ledgerEntry.amountG") &&
        source.market.includes("after.idCounters.counters[kind] !== before.idCounters.counters[kind] + 1"),
    ),
    staticResult(
      "static-production-composition",
      "AppBootstrap STORE stage가 canonical inputs로 day-1 market/RNG/ID state를 만들고 production CommandBus에 MarketSystem을 등록한다",
      source.bootstrap.includes("import(\"../domain/market.js\")") &&
        source.bootstrap.includes("marketModule.generateDailyMarket({") &&
        source.bootstrap.includes("ingredientDocument.ingredients") &&
        source.bootstrap.includes("balanceDocument.market.defaultPurchaseLimitQuantity") &&
        source.bootstrap.includes("market: marketGeneration.market") &&
        source.bootstrap.includes("rng: marketGeneration.rngState") &&
        source.bootstrap.includes("idCounters: idModule.createIdServiceState({") &&
        source.bootstrap.includes("this.marketSystem = marketModule.registerMarketSystem(this.commandBus)") &&
        source.bootstrap.includes("marketSystem: this.marketSystem"),
    ),
    staticResult(
      "static-canonical-market-inputs",
      "canonical ingredient rate/Quality distribution과 balance ±20%/purchase limit 입력이 Task 15 계약을 만족한다",
      ingredientsDocument.ingredients.length > 0 &&
        ingredientContractFailures.length === 0 &&
        balanceDocument.market.priceVariancePercent === 20 &&
        Number.isSafeInteger(balanceDocument.market.defaultPurchaseLimitQuantity) &&
        balanceDocument.market.defaultPurchaseLimitQuantity >= 0,
      {
        ingredientCount: ingredientsDocument.ingredients.length,
        ingredientContractFailures,
        priceVariancePercent: balanceDocument.market.priceVariancePercent,
        purchaseLimitQuantity: balanceDocument.market.defaultPurchaseLimitQuantity,
      },
    ),
    staticResult(
      "static-requirement-linked-runner",
      "Task 15 QA는 Requirement links, deterministic/bounds sweep, full rejection, partial mutation 및 대사 집계를 제공한다",
      source.qa.includes("export async function runMarketProbe") &&
        source.qa.includes("**Validates: Requirements 7.7, 23.4**") &&
        source.qa.includes("deterministicGenerationAndStreamIsolation") &&
        source.qa.includes("offerBoundsOrderingAndIdSweep") &&
        source.qa.includes("invalidQuantityPreDraftRejection") &&
        source.qa.includes("approvedPurchaseAtomicReconciliation") &&
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

export async function runMarketValidation() {
  const [ingredientsDocument, balanceDocument] = await Promise.all([
    readJson("data/ingredients.json"),
    readJson("data/balance.json"),
  ]);
  const [market, staticAudit] = await Promise.all([
    runMarketProbe({
      ingredients: ingredientsDocument.ingredients,
      purchaseLimitQuantity: balanceDocument.market.defaultPurchaseLimitQuantity,
      priceVariancePercent: balanceDocument.market.priceVariancePercent,
    }),
    runStaticAudit({ ingredientsDocument, balanceDocument }),
  ]);
  return Object.freeze({
    status: market.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    market,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runMarketValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Market validation: ${report.status}`);
    console.log(`Task 15 examples/invariants: ${report.market.status} (${report.market.passed}/${report.market.total})`);
    console.log(`  deterministic replay/final cursor: ${report.market.generationReplayCount}/${report.market.finalCursorCheckCount}`);
    console.log(`  stream isolation checks: ${report.market.streamIsolationCheckCount}`);
    console.log(`  offer invariant checks: ${report.market.offerInvariantCheckCount}`);
    console.log(`  rejected inputs/guards: ${report.market.rejectedInputCount}`);
    console.log(`  full rejection groups: ${report.market.fullRejectionGuardCount}`);
    console.log(`  partial mutations: ${report.market.partialMutationCount}`);
    console.log(`  approved commits: ${report.market.approvedCommitCount}`);
    console.log(`  ledger outflow/lot Book_Cost: ${report.market.ledgerOutflowG}/${report.market.lotBookCostG}`);
    for (const result of report.market.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 15 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
