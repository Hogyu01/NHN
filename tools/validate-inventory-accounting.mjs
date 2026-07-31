#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInventoryAccountingProbe } from "../js/qa/inventory-accounting-probe.js";

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

async function runStaticAudit() {
  const paths = {
    inventory: resolve(repositoryRoot, "js/domain/inventory.js"),
    accounting: resolve(repositoryRoot, "js/domain/inventory-accounting.js"),
    planner: resolve(repositoryRoot, "js/domain/reservation-planner.js"),
    qa: resolve(repositoryRoot, "js/qa/inventory-accounting-probe.js"),
    bootstrap: resolve(repositoryRoot, "js/app/bootstrap.js"),
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")]));
  const source = Object.fromEntries(entries);
  const domainSources = [source.inventory, source.accounting, source.planner];
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "crypto.randomUUID(",
  ];
  const forbiddenViolations = forbidden.filter((token) => domainSources.some((text) => text.includes(token)));
  const requiredCommands = [
    "ACQUIRE_LOT", "RESERVE", "RELEASE_RESERVATIONS", "START_COOK_ESCROW",
    "RESTORE_COOK_ESCROW", "COMPLETE_COOK_TO_DISH", "COMPLETE_COOK_TO_WASTE",
    "RECOGNIZE_DISH_COGS", "WASTE_DISH", "RECOGNIZE_CONTRACT_FAILURE_LOSS",
  ];
  const missingCommandRegistrations = requiredCommands.filter(
    (command) => !new RegExp(`commandBus\\.register\\(\\s*INVENTORY_COMMAND\\.${command}\\b`).test(source.accounting),
  );
  const destructiveHistoryTokens = [".splice(", ".shift(", ".pop(", ".reverse("];
  const destructiveHistoryViolations = destructiveHistoryTokens.filter((token) => source.accounting.includes(token));

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "inventory/accounting/reservation planner는 browser·wall-clock·nondeterministic primitive를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-ingredient-lot-contract",
      "Ingredient_Lot은 ID·ingredient·quantity·Quality·Book_Cost·acquired day를 검증하고 lot 수량식을 검사한다",
      source.inventory.includes("const required = [\"lotId\", \"ingredientId\", \"quantity\", \"quality\", \"bookCostG\", \"acquiredDay\"]") &&
        source.inventory.includes("LOT_OVER_RESERVED") &&
        source.inventory.includes("lot.quantity - reservedQuantity"),
    ),
    staticResult(
      "static-fifo-half-up-final-remainder",
      "allocation은 acquiredDay/lotId FIFO이고 partial Half-Up·last full remainder 규칙을 사용한다",
      source.inventory.includes("left.acquiredDay - right.acquiredDay") &&
        source.inventory.includes("left.lotId.localeCompare(right.lotId") &&
        source.planner.includes("takeQuantity === quantityBefore") &&
        source.planner.includes("multiplyDivideHalfUp(bookCostBefore, takeQuantity, quantityBefore)"),
    ),
    staticResult(
      "static-all-or-nothing-planning",
      "reservation/cook allocation은 전체 shortage를 먼저 계산하고 detached candidate만 반환한다",
      source.planner.includes("const shortages = buildShortages(required, available)") &&
        source.planner.includes("if (shortages.length > 0)") &&
        source.planner.includes("const working = cloneValue(inventory)") &&
        source.accounting.includes("preflight(ctx)") &&
        source.accounting.includes("postconditions(before, after, ctx)"),
    ),
    staticResult(
      "static-append-only-cost-movement",
      "cost movement는 processed ID·prefix 검증·destination graph를 사용하고 destructive history API를 사용하지 않는다",
      source.accounting.includes("validateCostMovementAppendOnly") &&
        source.accounting.includes("processedCostMovementIds") &&
        source.accounting.includes("buildCostMovementGraph") &&
        destructiveHistoryViolations.length === 0,
      { destructiveHistoryViolations },
    ),
    staticResult(
      "static-atomic-production-wiring",
      "Task 14 command 전체가 AtomicTransaction으로 등록되고 AppBootstrap production CommandBus에 배선된다",
      source.accounting.includes("defineAtomicTransaction({") &&
        missingCommandRegistrations.length === 0 &&
        source.bootstrap.includes("registerInventoryAccounting") &&
        source.bootstrap.includes("this.inventoryAccountingAPI = registerInventoryAccounting(this.commandBus)"),
      { missingCommandRegistrations },
    ),
    staticResult(
      "static-requirement-linked-runner",
      "Task 14 QA는 exported runner, Requirement links, Property 4 보존 sweep와 partial mutation 집계를 제공한다",
      source.qa.includes("export async function runInventoryAccountingProbe()") &&
        source.qa.includes("Design Property 4") &&
        source.qa.includes("**Validates: Requirements 5.10, 8.7**") &&
        source.qa.includes("costMovementConservationSweep") &&
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

export async function runInventoryAccountingValidation() {
  const [inventoryAccounting, staticAudit] = await Promise.all([
    runInventoryAccountingProbe(),
    runStaticAudit(),
  ]);
  return Object.freeze({
    status: inventoryAccounting.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    inventoryAccounting,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runInventoryAccountingValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Inventory accounting validation: ${report.status}`);
    console.log(`Task 14 examples/invariants: ${report.inventoryAccounting.status} (${report.inventoryAccounting.passed}/${report.inventoryAccounting.total})`);
    console.log(`  lot permutations: ${report.inventoryAccounting.lotPermutationCount}`);
    console.log(`  Book_Cost invariant sequences/steps: ${report.inventoryAccounting.bookCostInvariantSequenceCount}/${report.inventoryAccounting.bookCostConsumptionStepCount}`);
    console.log(`  cost movement invariant sequences: ${report.inventoryAccounting.costMovementInvariantSequenceCount}`);
    console.log(`  reconciliation checks: ${report.inventoryAccounting.reconciliationCheckCount}`);
    console.log(`  rejected operations: ${report.inventoryAccounting.rejectedOperationCount}`);
    console.log(`  partial mutations: ${report.inventoryAccounting.partialMutationCount}`);
    for (const result of report.inventoryAccounting.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 14 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
