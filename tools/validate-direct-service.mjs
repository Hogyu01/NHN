#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDirectServiceProbe } from "../js/qa/direct-service-probe.js";

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

async function runStaticAudit() {
  const paths = {
    direct: "js/domain/direct-service.js",
    timing: "js/domain/timing-cook.js",
    sales: "js/domain/sales.js",
    orders: "js/domain/orders.js",
    bootstrap: "js/app/bootstrap.js",
    qa: "js/qa/direct-service-probe.js",
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, relativePath]) => [
    name,
    await readFile(resolve(repositoryRoot, relativePath), "utf8"),
  ]));
  const source = Object.fromEntries(entries);
  const domainSources = [source.direct, source.timing, source.sales];
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "requestAnimationFrame(", "PIXI", "pixi.js",
  ];
  const forbiddenViolations = forbidden.flatMap((token) => domainSources
    .map((text, index) => ({ text, name: ["direct", "timing", "sales"][index] }))
    .filter(({ text }) => text.includes(token))
    .map(({ name }) => `${name}:${token}`));
  const requiredCommands = [
    "START_COOK", "COMPLETE_COOK", "CANCEL_COOK_AT_ZERO",
    "SERVE", "WRONG_SERVE", "WASTE_CARRIED_DISH",
  ];
  const missingCommands = requiredCommands.filter((command) =>
    !new RegExp(`commandBus\\.register\\([\\s\\S]{0,120}DIRECT_SERVICE_COMMAND\\.${command}`).test(source.direct));
  const rawIngredientCarryTokens = [
    "CARRY_RAW_INGREDIENT", "carryRawIngredient(", "carriedIngredientId", "rawIngredientCarry: true",
  ];
  const rawIngredientCarryViolations = rawIngredientCarryTokens.filter((token) => source.direct.includes(token));

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "DirectService/TimingCook/Sales는 browser·wall-clock·nondeterministic·PixiJS authority를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-atomic-command-registration",
      "조리 시작/완료/zero 취소/판매/오서빙/Waste가 모두 AtomicTransaction으로 production bus에 등록된다",
      source.direct.includes("defineAtomicTransaction({") && missingCommands.length === 0 &&
        source.direct.includes("preflight(ctx)") && source.direct.includes("postconditions(before, after, ctx)"),
      { missingCommands },
    ),
    staticResult(
      "static-declared-read-write-sets",
      "완료·zero 취소·Waste가 validation에 필요한 saleSlots read를 선언하고 matching/mismatch write-set을 분리한다",
      source.direct.includes("COMPLETE_COOK_READ_SET = Object.freeze([\"campaign\", \"saleSlots\"])") &&
        source.direct.includes("CANCEL_COOK_READ_SET = Object.freeze([\"campaign\", \"saleSlots\"])") &&
        source.direct.includes("WASTE_DISH_READ_SET = Object.freeze([\"campaign\", \"saleSlots\"])") &&
        source.direct.includes("COMMIT_SALE_WRITE_SET") && source.direct.includes("WRONG_SERVE_WRITE_SET"),
    ),
    staticResult(
      "static-reservation-timing-carried-dish",
      "조리는 reservation-first allocation, SUCCESS/NORMAL/FAILURE 판정, singular carried overlay와 exact restore를 사용한다",
      source.direct.includes("applyIngredientsToEscrowDraft") &&
        source.direct.includes("judgeTimingCook") && source.direct.includes("completeTimingCook") &&
        source.direct.includes("applyEscrowRestoreToDraft") &&
        source.direct.includes("carried.length > 1") &&
        source.timing.includes("COOK_JUDGMENT") && source.timing.includes("COOK_FAILURE_DEADLINE_NOT_REACHED"),
    ),
    staticResult(
      "static-atomic-sale-composition",
      "matching sale가 order/dish/SOLD/Cash/Revenue/COGS/reputation Cause를 하나의 계획과 write-set에 조합한다",
      source.direct.includes("applyCashTransactionToDraft") &&
        source.direct.includes("applyDishToCogsDraft") &&
        source.direct.includes("applySaleSlotSoldToDraft") &&
        source.direct.includes("applyReputationCauseToDraft") &&
        source.direct.includes("applySaleRecordToDraft") &&
        source.direct.includes("order.state = ACTIVE_ORDER_STATE.COMPLETED") &&
        source.direct.includes("kind: ORDER_REACTION_KIND.SUCCESS") &&
        source.orders.includes("SUCCESS: \"SUCCESS\"") &&
        source.sales.includes("validateSalesAppendOnly"),
    ),
    staticResult(
      "static-wrong-serve-and-reuse",
      "오서빙은 정확히 3000ms patience와 optional timeout만 변경하고 판매는 dish Recipe로 target ACTIVE order를 매칭한다",
      source.direct.includes("wrongServePenaltyMs: 3_000") &&
        source.direct.includes("orderWithPenalty.patienceRemainingMs - config.wrongServePenaltyMs") &&
        source.direct.includes("if (reduced <= 0)") &&
        source.direct.includes("carried.plan.dish.recipeId !== target.plan.order.recipeId") &&
        !source.direct.includes("carried.plan.dish.createdOrderId !== target.plan.order.orderId"),
    ),
    staticResult(
      "static-overlay-and-raw-carry-boundary",
      "sale/Waste가 carried overlay를 같은 plan에서 제거하며 raw ingredient carry command/state를 만들지 않는다",
      source.direct.includes("service.carriedDishId = null") &&
        source.direct.includes("applyDishToWasteDraft") &&
        source.direct.includes("rawIngredientCarry: false") &&
        rawIngredientCarryViolations.length === 0,
      { rawIngredientCarryViolations },
    ),
    staticResult(
      "static-production-bootstrap",
      "AppBootstrap이 SalesState를 생성하고 canonical balance로 DirectServiceSystem을 production CommandBus에 배선한다",
      source.bootstrap.includes("import { createSalesState } from \"../domain/sales.js\"") &&
        source.bootstrap.includes("import { registerDirectServiceSystem } from \"../domain/direct-service.js\"") &&
        source.bootstrap.includes("sales: createSalesState({ day })") &&
        source.bootstrap.includes("this.directServiceSystem = registerDirectServiceSystem(this.commandBus") &&
        source.bootstrap.includes("wrongServePenaltyMs: balanceDocument.service.wrongServePenaltyMs") &&
        source.bootstrap.includes("balanceDocument.service.reactionFrameCount") &&
        source.bootstrap.includes("get directServiceSystem()"),
    ),
    staticResult(
      "static-property-14-runtime-qa",
      "QA가 정확한 Requirement 링크와 100개 이상 생성 사례로 Property 14 및 실제 production command 경로를 검증한다",
      source.qa.includes("Property 14: Timing_Cook 판정 구간과 terminal destination") &&
        source.qa.includes("**Validates: Requirements 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 12.6**") &&
        source.qa.includes("PROPERTY_MINIMUM_SAMPLES = 100") &&
        source.qa.includes("PROPERTY_SAMPLE_COUNT = 128") &&
        source.qa.includes("new GameStore") && source.qa.includes("registerDirectServiceSystem") &&
        source.qa.includes("assertRejectedUnchanged"),
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

export async function runDirectServiceValidation() {
  const [recipesDocument, facilitiesDocument, balanceDocument] = await Promise.all([
    readJson("data/recipes.json"),
    readJson("data/upgrades.json"),
    readJson("data/balance.json"),
  ]);
  const [directService, staticAudit] = await Promise.all([
    runDirectServiceProbe({
      recipes: recipesDocument.recipes,
      facilities: facilitiesDocument.facilities,
      balance: balanceDocument,
    }),
    runStaticAudit(),
  ]);
  return Object.freeze({
    status: directService.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    directService,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runDirectServiceValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Direct service validation: ${report.status}`);
    console.log(`Task 22 examples/Property 14: ${report.directService.status} (${report.directService.passed}/${report.directService.total})`);
    console.log(`  Property 14 samples: ${report.directService.propertySampleCount}`);
    for (const result of report.directService.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 22 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
