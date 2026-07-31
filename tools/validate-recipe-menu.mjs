#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runRecipeMenuProbe } from "../js/qa/recipe-menu-probe.js";

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

async function runStaticAudit({ recipesDocument, ingredientsDocument }) {
  const paths = {
    recipe: resolve(repositoryRoot, "js/domain/recipe.js"),
    menu: resolve(repositoryRoot, "js/domain/menu.js"),
    slots: resolve(repositoryRoot, "js/domain/sale-slots.js"),
    qa: resolve(repositoryRoot, "js/qa/recipe-menu-probe.js"),
    bootstrap: resolve(repositoryRoot, "js/app/bootstrap.js"),
    accounting: resolve(repositoryRoot, "js/domain/inventory-accounting.js"),
    planner: resolve(repositoryRoot, "js/domain/reservation-planner.js"),
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")]),
  );
  const source = Object.fromEntries(entries);
  const domainSources = [source.recipe, source.menu, source.slots];
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "crypto.randomUUID(",
  ];
  const forbiddenViolations = forbidden.filter((token) => domainSources.some((text) => text.includes(token)));
  const directReservationWriters = [source.menu, source.slots].flatMap((text) => [
    ...text.matchAll(/\.reservations\s*=|\.reservations\.(?:push|splice|pop|shift|unshift)\(/g),
  ]).map((match) => match[0]);
  const requiredCommands = ["EDIT_ENTRY", "CONFIRM_PLAN", "ASSIGN_SLOT", "RELEASE_SLOT", "CLEANUP"];
  const missingCommandRegistrations = requiredCommands.filter(
    (command) => !new RegExp(`commandBus\\.register\\(MENU_COMMAND\\.${command}\\b`).test(source.menu),
  );
  const ingredientIds = new Set(ingredientsDocument.ingredients.map((ingredient) => ingredient.ingredientId));
  const canonicalRecipeFailures = recipesDocument.recipes.flatMap((recipe) => {
    const failures = [];
    if (!Number.isSafeInteger(recipe.basePriceG) || recipe.basePriceG <= 0) failures.push(`${recipe.recipeId}:basePriceG`);
    if (!Array.isArray(recipe.ingredientRequirements) || recipe.ingredientRequirements.length < 2) {
      failures.push(`${recipe.recipeId}:ingredientRequirements`);
    }
    for (const requirement of recipe.ingredientRequirements ?? []) {
      if (!ingredientIds.has(requirement.ingredientId)) failures.push(`${recipe.recipeId}:${requirement.ingredientId}`);
      if (!Number.isSafeInteger(requirement.quantity) || requirement.quantity <= 0) {
        failures.push(`${recipe.recipeId}:${requirement.ingredientId}:quantity`);
      }
    }
    return failures;
  });
  const startingRecipeCount = recipesDocument.recipes.filter((recipe) => recipe.unlock?.type === "STARTING").length;

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "Recipe/Menu/SaleSlot domain은 browser·wall-clock·nondeterministic primitive를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-recipe-canonical-unlock-reference",
      "canonical Recipe는 ingredient reference와 시작 unlock을 검증하고 Planning unlock projection을 제공한다",
      canonicalRecipeFailures.length === 0 && startingRecipeCount >= 2 &&
        source.recipe.includes("RECIPE_INGREDIENT_REFERENCE_NOT_FOUND") &&
        source.recipe.includes("STARTING_RECIPE_LOCKED") &&
        source.recipe.includes("addRecipeUnlocksForPlanning") &&
        source.recipe.includes("editable: unlocked.has(recipe.recipeId) && runtimePhase === \"PLANNING\""),
      { recipeCount: recipesDocument.recipes.length, startingRecipeCount, canonicalRecipeFailures },
    ),
    staticResult(
      "static-menu-edit-bounds",
      "unlocked Recipe만 편집하며 가격 50..200% integer G와 non-negative safe Planned_Quantity를 강제한다",
      source.menu.includes("if (!isRecipeUnlocked(recipes, entry.recipeId))") &&
        source.recipe.includes("minimumPriceG: Number((base + 1n) / 2n)") &&
        source.recipe.includes("maximumPriceG: Number(base * 2n)") &&
        source.menu.includes("!Number.isSafeInteger(entry.priceG)") &&
        source.menu.includes("!Number.isSafeInteger(entry.plannedQuantity) || entry.plannedQuantity < 0") &&
        source.menu.includes("runtimePhase !== \"PLANNING\" || menu.locked"),
    ),
    staticResult(
      "static-hard-reservation-delegation",
      "전체 menu hard reservation과 prior-plan restore는 Task 14 helper에 위임하고 중복 reservation writer를 만들지 않는다",
      source.menu.includes("applyReservationReleaseToDraft(inventoryDraft") &&
        source.menu.includes("applyReservationCreationToDraft(inventoryCandidate") &&
        source.accounting.includes("export function applyReservationCreationToDraft") &&
        source.accounting.includes("export function applyReservationReleaseToDraft") &&
        source.planner.includes("planHardReservations") &&
        directReservationWriters.length === 0,
      { directReservationWriters },
    ),
    staticResult(
      "static-detached-preview-full-rejection",
      "기존 plan을 detached inventory에 복원하고 전체 신규 menu를 preview한 뒤 AtomicTransaction single commit/full rejection한다",
      source.menu.includes("const inventoryCandidate = cloneValue(inventory)") &&
        source.menu.includes("releasePriorPlanReservations(inventoryCandidate, saleSlots)") &&
        source.menu.includes("const requestBySlot = ids.plan.slots.map") &&
        source.menu.includes("validateMenuPlanReconciliation(") &&
        source.menu.includes("defineAtomicTransaction({") &&
        source.menu.includes("for (const slice of MENU_CONFIRM_WRITE_SET) draft.replace(slice, planned.plan[slice])") &&
        source.qa.includes("assertRejectedUnchanged") &&
        source.qa.includes("sharedIngredientShortageExactPreservation"),
    ),
    staticResult(
      "static-deterministic-id-reconciliation",
      "stable SaleSlot/plan ID를 결정론적으로 할당하고 slot·reservation counter 및 menu promise를 대사한다",
      source.menu.includes("reservationPlanId = idService.next(\"reservation\")") &&
        source.menu.includes("saleSlotId: idService.next(\"slot\")") &&
        source.menu.includes("MENU_SLOT_ID_COUNTER_MISMATCH") &&
        source.menu.includes("MENU_RESERVATION_ID_COUNTER_MISMATCH") &&
        source.menu.includes("MENU_SLOT_COUNT_MISMATCH") &&
        source.menu.includes("MENU_RESERVATION_PROMISE_MISMATCH"),
    ),
    staticResult(
      "static-sale-slot-state-machine",
      "SaleSlot은 AVAILABLE→ASSIGNED→SOLD와 terminal SOLD를 강제하고 assigned_slots에는 ASSIGNED만 포함한다",
      source.slots.includes("AVAILABLE: \"AVAILABLE\"") &&
        source.slots.includes("ASSIGNED: \"ASSIGNED\"") &&
        source.slots.includes("SOLD: \"SOLD\"") &&
        source.slots.includes("candidate.state === SALE_SLOT_STATE.AVAILABLE") &&
        source.slots.includes("target.state = SALE_SLOT_STATE.ASSIGNED") &&
        source.slots.includes("target.state = SALE_SLOT_STATE.SOLD") &&
        source.slots.includes("SOLD_SALE_SLOT_TERMINAL") &&
        source.slots.includes("state.slots.filter((slot) => slot.state === SALE_SLOT_STATE.ASSIGNED)"),
    ),
    staticResult(
      "static-timeout-cleanup-retry",
      "timeout/technical cleanup은 ASSIGNED를 AVAILABLE로 돌리고 unused reservation 0 및 cook retry eligibility를 검사한다",
      source.slots.includes("SALE_SLOT_RELEASE_REASON.TIMEOUT") &&
        source.slots.includes("SALE_SLOT_RELEASE_REASON.TECHNICAL_CANCEL") &&
        source.slots.includes("target.state = SALE_SLOT_STATE.AVAILABLE") &&
        source.slots.includes("planSaleSlotCleanup") &&
        source.menu.includes("planCookFailureRetryEligibility") &&
        source.menu.includes("planCookAllocation(inventory") &&
        source.menu.includes("MENU_CLEANUP_LEAK") &&
        source.menu.includes("SOLD_EXCEEDS_PLANNED"),
    ),
    staticResult(
      "static-production-composition-projection",
      "AppBootstrap이 canonical Recipe/Menu/SaleSlot state와 systems를 production CommandBus에 배선하고 read-only UI projection을 노출한다",
      source.bootstrap.includes("createRecipeState({") &&
        source.bootstrap.includes("const menu = createMenuState({ day, recipes })") &&
        source.bootstrap.includes("const saleSlots = createSaleSlotsState({ day })") &&
        source.bootstrap.includes("this.recipeSystem = new RecipeSystem()") &&
        source.bootstrap.includes("this.menuSystem = registerMenuSystem(this.commandBus)") &&
        source.menu.includes("export function projectRecipeMenu(snapshot)") &&
        source.menu.includes("assigned_slots: slotProjection.assigned_slots") &&
        missingCommandRegistrations.length === 0,
      { missingCommandRegistrations },
    ),
    staticResult(
      "static-requirement-linked-runner",
      "Task 17 QA는 Requirement links, 64-plan sweep, shortage exact preservation, lifecycle/lock/cleanup/retry/idempotency 집계를 제공한다",
      source.qa.includes("export async function runRecipeMenuProbe") &&
        source.qa.includes("**Validates: Requirements 8.3, 8.4, 8.6, 9.2, 9.3, 9.9**") &&
        source.qa.includes("const PLAN_SWEEP_COUNT = 64") &&
        source.qa.includes("sharedShortageExactPreservationChecks") &&
        source.qa.includes("soldTerminalRejectionCount") &&
        source.qa.includes("cleanupUnusedReservationCount") &&
        source.qa.includes("duplicateStaleAndIdempotency") &&
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

export async function runRecipeMenuValidation() {
  const [recipesDocument, ingredientsDocument] = await Promise.all([
    readJson("data/recipes.json"),
    readJson("data/ingredients.json"),
  ]);
  const [recipeMenu, staticAudit] = await Promise.all([
    runRecipeMenuProbe({ recipes: recipesDocument.recipes }),
    runStaticAudit({ recipesDocument, ingredientsDocument }),
  ]);
  return Object.freeze({
    status: recipeMenu.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    recipeMenu,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runRecipeMenuValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Recipe/Menu/SaleSlot validation: ${report.status}`);
    console.log(`Task 17 examples/invariants: ${report.recipeMenu.status} (${report.recipeMenu.passed}/${report.recipeMenu.total})`);
    console.log(`  generated menu plans/reservation promises: ${report.recipeMenu.plannedQuantitySweepCount}/${report.recipeMenu.reservationPromiseCheckCount}`);
    console.log(`  deterministic replay checks: ${report.recipeMenu.deterministicReplayCheckCount}`);
    console.log(`  shared shortage exact preservation checks: ${report.recipeMenu.sharedShortageExactPreservationChecks}`);
    console.log(`  partial mutations: ${report.recipeMenu.partialMutationCount}`);
    console.log(`  SOLD terminal rejections: ${report.recipeMenu.soldTerminalRejectionCount}`);
    console.log(`  cleanup unused reservations/assigned slots: ${report.recipeMenu.cleanupUnusedReservationCount}/${report.recipeMenu.cleanupAssignedSlotCount}`);
    for (const result of report.recipeMenu.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 17 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
