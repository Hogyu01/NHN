#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runContractProbe } from "../js/qa/contract-probe.js";

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
    contract: resolve(repositoryRoot, "js/domain/contract.js"),
    qa: resolve(repositoryRoot, "js/qa/contract-probe.js"),
    bootstrap: resolve(repositoryRoot, "js/app/bootstrap.js"),
    cash: resolve(repositoryRoot, "js/domain/cash-transaction-api.js"),
    accounting: resolve(repositoryRoot, "js/domain/inventory-accounting.js"),
    transaction: resolve(repositoryRoot, "js/core/transaction.js"),
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")]),
  );
  const source = Object.fromEntries(entries);
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "crypto.randomUUID(",
  ];
  const forbiddenViolations = forbidden.filter((token) => source.contract.includes(token));
  const drawCalls = [...source.contract.matchAll(/registry\.(?:percentage|nextInt|nextUint32)\(\s*([^,\)]+)/g)]
    .map((match) => match[1].trim());
  const invalidDrawCalls = drawCalls.filter((argument) =>
    argument !== "CONTRACT_OFFER_RNG_STREAM" && argument !== "CONTRACT_RESOLUTION_RNG_STREAM");
  const resolutionDrawCallCount = drawCalls.filter((argument) =>
    argument === "CONTRACT_RESOLUTION_RNG_STREAM").length;
  const directCashWrites = [...source.contract.matchAll(/\.cashG\s*(?:=|\+=|-=|\+\+|--)/g)]
    .map((match) => match[0]);
  const directLotWrites = [...source.contract.matchAll(/\.lots\.(?:push|splice|pop|shift|unshift)\(/g)]
    .map((match) => match[0]);
  const payloadGuardIndex = source.transaction.indexOf("invokeGuard(this.validatePayload");
  const draftCreationIndex = source.transaction.indexOf("new DraftContext(");
  const expectedRiskTiers = [
    ["LOW", 90, 5],
    ["MEDIUM", 70, 15],
    ["HIGH", 50, 30],
  ];
  const canonicalRiskFailures = expectedRiskTiers.filter(([risk, successRate, discountPercent]) => {
    const actual = balanceDocument.contract.riskTiers.find((tier) => tier.risk === risk);
    return !actual || actual.successRate !== successRate || actual.discountPercent !== discountPercent;
  });
  const ingredientFailures = ingredientsDocument.ingredients.flatMap((ingredient) => {
    const failures = [];
    const weight = ingredient.qualityDistribution.reduce((sum, bucket) => sum + bucket.weight, 0);
    if (!Number.isSafeInteger(ingredient.basePriceG) || ingredient.basePriceG <= 0) {
      failures.push(`${ingredient.ingredientId}:basePriceG`);
    }
    if (!Number.isSafeInteger(ingredient.marketStockRange?.minimum) ||
        !Number.isSafeInteger(ingredient.marketStockRange?.maximum) ||
        ingredient.marketStockRange.minimum < 1 ||
        ingredient.marketStockRange.maximum < ingredient.marketStockRange.minimum) {
      failures.push(`${ingredient.ingredientId}:marketStockRange`);
    }
    if (Math.abs(weight - 1) > 0.000_001) failures.push(`${ingredient.ingredientId}:qualityDistribution`);
    return failures;
  });

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "ContractSystem은 browser·wall-clock·nondeterministic primitive를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-separated-rng-streams",
      "offer와 resolution generator는 각각 contractOffer/contractResolution만 소비하고 resolution은 한 logical draw call을 사용한다",
      source.contract.includes("CONTRACT_OFFER_RNG_STREAM = \"contractOffer\"") &&
        source.contract.includes("CONTRACT_RESOLUTION_RNG_STREAM = \"contractResolution\"") &&
        source.contract.includes("RngRegistry.fromState(rngState)") &&
        source.contract.includes("const finalRngState = registry.snapshot()") &&
        drawCalls.length >= 4 && invalidDrawCalls.length === 0 && resolutionDrawCallCount === 1,
      { drawCalls, invalidDrawCalls, resolutionDrawCallCount },
    ),
    staticResult(
      "static-risk-formula-offer-contract",
      "Planning offer≥2, LOW/MEDIUM/HIGH 90/70/50·5/15/30, Half-Up total과 exact prepaid20+balance를 강제한다",
      source.contract.includes("CONTRACT_MINIMUM_OFFER_COUNT = 2") &&
        source.contract.includes("[CONTRACT_RISK.LOW]: { successRate: 90, discountPercent: 5 }") &&
        source.contract.includes("[CONTRACT_RISK.MEDIUM]: { successRate: 70, discountPercent: 15 }") &&
        source.contract.includes("[CONTRACT_RISK.HIGH]: { successRate: 50, discountPercent: 30 }") &&
        source.contract.includes("multiplyDivideHalfUp(marketExpectedCostG, 100 - policy.discountPercent, 100)") &&
        source.contract.includes("multiplyDivideHalfUp(totalPriceG, CONTRACT_PREPAID_PERCENT, 100)") &&
        source.contract.includes("checkedSubtractG(totalPriceG, prepaidG, \"contract balance\")"),
    ),
    staticResult(
      "static-state-projection",
      "ContractState는 current-day acceptance/resolution index를 검증하고 projection은 D+1·loss·liquidity·Fixed Cost risk를 파생한다",
      source.contract.includes("CURRENT_DAY_ACCEPTED_CONTRACT_INDEX_MISMATCH") &&
        source.contract.includes("RESOLVED_CONTRACT_MISSING_INDEX") &&
        source.contract.includes("ORPHAN_PROCESSED_RESOLUTION_ID") &&
        source.contract.includes("export function projectContracts") &&
        source.contract.includes("fixedCostRiskConfirmationRequired") &&
        source.contract.includes("availableAfterAcceptanceG") &&
        source.contract.includes("lossExposureG"),
    ),
    staticResult(
      "static-pre-draft-full-rejection-guards",
      "invalid payload와 daily duplicate·D+1>14·Available_Cash·Fixed Cost confirmation·duplicate resolution을 draft 전 전면 거절한다",
      source.contract.includes("validateAcceptContractPayload(ctx.command.payload)") &&
        source.contract.includes("validateResolveContractPayload(ctx.command.payload)") &&
        source.contract.includes("CONTRACT_ALREADY_ACCEPTED_FOR_DAY") &&
        source.contract.includes("CONTRACT_ARRIVAL_AFTER_CAMPAIGN") &&
        source.contract.includes("INSUFFICIENT_AVAILABLE_CASH") &&
        source.contract.includes("FIXED_COST_RISK_CONFIRMATION_REQUIRED") &&
        source.contract.includes("DUPLICATE_CONTRACT_RESOLUTION") &&
        payloadGuardIndex >= 0 && draftCreationIndex > payloadGuardIndex,
      { payloadGuardIndex, draftCreationIndex },
    ),
    staticResult(
      "static-task13-task14-delegation",
      "계약은 Task 13 cash/reserve와 Task 14 prepaid/loss/lot helper를 재사용하고 중복 cash/lot writer를 만들지 않는다",
      source.contract.includes("applyCashTransactionToDraft(economyCandidate") &&
        source.contract.includes("applyContractReserveChangeToDraft(economyCandidate") &&
        source.contract.includes("applyContractPrepaidCapitalizationToDraft(economyCandidate, accountingCandidate") &&
        source.contract.includes("applyContractPrepaidApplicationToDraft(economyCandidate, accountingCandidate") &&
        source.contract.includes("applyContractFailureLossToDraft(economyCandidate, accountingCandidate") &&
        source.contract.includes("applyLotAcquisitionToDraft(inventoryCandidate, accountingCandidate") &&
        source.cash.includes("export function applyCashTransactionToDraft") &&
        source.accounting.includes("export function applyLotAcquisitionToDraft") &&
        directCashWrites.length === 0 && directLotWrites.length === 0,
      { directCashWrites, directLotWrites },
    ),
    staticResult(
      "static-accept-atomic-reconciliation",
      "AcceptContract는 prepaid ledger+asset+balance reserve+pending state+IDs를 single AtomicTransaction에서 append-only 대사한다",
      source.contract.includes("createAcceptContractAtomicTransaction") &&
        source.contract.includes("CONTRACT_ACCEPT_WRITE_SET") &&
        source.contract.includes("validateEconomyTransition(before.economy, after.economy)") &&
        source.contract.includes("validateCostMovementAppendOnly(") &&
        source.contract.includes("reconcileCashWithLedger(") &&
        source.contract.includes("reconcileInventoryAccounting(") &&
        source.contract.includes("CONTRACT_ACCEPT_CONSIDERATION_MISMATCH") &&
        source.contract.includes("for (const slice of CONTRACT_ACCEPT_WRITE_SET) draft.replace(slice, planned.plan[slice])"),
    ),
    staticResult(
      "static-resolution-branches-allocation",
      "ResolveContract는 success balance/prepaid/lot과 failure reserve/loss/no-cash를 배타 처리하고 lexical 1G remainder 합을 검증한다",
      source.contract.includes("createResolveContractAtomicTransaction") &&
        source.contract.includes("generated.result.outcome === CONTRACT_RESOLUTION_OUTCOME.SUCCESS") &&
        source.contract.includes("category: LEDGER_CATEGORY.CONTRACT_BALANCE") &&
        source.contract.includes("operation: CONTRACT_RESERVE_OPERATION.RELEASE") &&
        source.contract.includes("FAILED_CONTRACT_CASH_CHANGED") &&
        source.contract.includes("export function allocateContractBookCost") &&
        source.contract.includes("sort((left, right) => compareStableIdentifiers(left.ingredientId, right.ingredientId))") &&
        source.contract.includes("while (difference !== 0)") &&
        source.contract.includes("allocatedG !== planned.contractBefore.totalPriceG") &&
        source.contract.includes("CONTRACT_FAILURE_DISPOSITION_MISMATCH"),
    ),
    staticResult(
      "static-production-composition",
      "AppBootstrap은 Market final RNG에서 canonical contract offers/state를 만들고 production CommandBus에 ContractSystem을 등록한다",
      source.bootstrap.includes("import(\"../domain/contract.js\")") &&
        source.bootstrap.includes("contractModule.generateDailyContractOffers({") &&
        source.bootstrap.includes("const marketGenerationCheckpoint = Object.freeze({") &&
        source.bootstrap.includes("rng: marketGeneration.rngState") &&
        source.bootstrap.includes("rngState: marketGenerationCheckpoint.rng") &&
        source.bootstrap.includes("configuration: balanceDocument.contract") &&
        source.bootstrap.includes("fixedCostG: balanceDocument.economy.fixedCostG") &&
        source.bootstrap.includes("contracts: contractGeneration.contracts") &&
        source.bootstrap.includes("rng: contractGeneration.rngState") &&
        source.bootstrap.includes("this.contractSystem = contractModule.registerContractSystem(this.commandBus)") &&
        source.bootstrap.includes("contractSystem: this.contractSystem"),
    ),
    staticResult(
      "static-canonical-and-requirement-linked-qa",
      "canonical contract/ingredient 입력과 Requirement-linked QA가 결정론·guard·success/failure 대사 집계를 제공한다",
      balanceDocument.contract.prepaidPercent === 20 &&
        balanceDocument.contract.arrivalDayOffset === 1 &&
        canonicalRiskFailures.length === 0 && ingredientFailures.length === 0 &&
        Number.isSafeInteger(balanceDocument.economy.fixedCostG) &&
        source.qa.includes("export async function runContractProbe") &&
        source.qa.includes("**Validates: Requirements 4.12, 6.1, 6.2, 6.3, 6.4, 6.5, 6.13, 6.14, 20.2, 20.3, 23.4**") &&
        source.qa.includes("deterministicOfferRiskFormulaSweep") &&
        source.qa.includes("deterministicResolutionAndStreamIsolation") &&
        source.qa.includes("assertRejectedUnchanged") &&
        source.qa.includes("successfulResolutionReconciliation") &&
        source.qa.includes("failedResolutionAndDuplicateGuard") &&
        source.qa.includes("partialMutationCount"),
      {
        ingredientCount: ingredientsDocument.ingredients.length,
        ingredientFailures,
        canonicalRiskFailures,
        fixedCostG: balanceDocument.economy.fixedCostG,
      },
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

export async function runContractValidation() {
  const [ingredientsDocument, balanceDocument] = await Promise.all([
    readJson("data/ingredients.json"),
    readJson("data/balance.json"),
  ]);
  const [contract, staticAudit] = await Promise.all([
    runContractProbe({
      ingredients: ingredientsDocument.ingredients,
      configuration: balanceDocument.contract,
      fixedCostG: balanceDocument.economy.fixedCostG,
    }),
    runStaticAudit({ ingredientsDocument, balanceDocument }),
  ]);
  return Object.freeze({
    status: contract.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    contract,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runContractValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Risk Contract validation: ${report.status}`);
    console.log(`Task 16 examples/invariants: ${report.contract.status} (${report.contract.passed}/${report.contract.total})`);
    console.log(`  offer replay/formula/allocation: ${report.contract.offerReplayCount}/${report.contract.offerFormulaCheckCount}/${report.contract.allocationCheckCount}`);
    console.log(`  resolution replay/final cursor: ${report.contract.resolutionReplayCount}/${report.contract.finalCursorCheckCount}`);
    console.log(`  stream isolation checks: ${report.contract.streamIsolationCheckCount}`);
    console.log(`  full rejection groups / partial mutations: ${report.contract.fullRejectionGuardGroups}/${report.contract.partialMutationCount}`);
    console.log(`  accept commits: ${report.contract.acceptCommitCount}`);
    console.log(`  accepted prepaid+balance=total: ${report.contract.acceptedPrepaidG}+${report.contract.acceptedBalanceG}=${report.contract.acceptedTotalPriceG}`);
    console.log(`  success balance outflow / allocated Book_Cost / total: ${report.contract.successBalanceOutflowG}/${report.contract.successAllocatedBookCostG}/${report.contract.successTotalPriceG}`);
    console.log(`  failure extra cash / prepaid loss / lots: ${report.contract.failureAdditionalCashOutflowG}/${report.contract.failurePrepaidLossG}/${report.contract.failureLotsCreated}`);
    for (const result of report.contract.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 16 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
