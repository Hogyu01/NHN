#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDayLoopProbe } from "../js/qa/day-loop-probe.js";

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
    dayLoop: "js/domain/day-loop.js",
    timer: "js/domain/timer-state.js",
    bootstrap: "js/app/bootstrap.js",
    panel: "js/ui/panel-manager.js",
    zone: "js/world/static-zone-controller.js",
    menu: "js/domain/menu.js",
    qa: "js/qa/day-loop-probe.js",
    browserSmoke: "tools/browser-smoke.mjs",
  };
  const sourceEntries = await Promise.all(Object.entries(paths).map(async ([name, relativePath]) => [
    name,
    await readFile(resolve(repositoryRoot, relativePath), "utf8"),
  ]));
  const source = Object.fromEntries(sourceEntries);
  const forbidden = [
    "document.", "window.", "localStorage", "AudioContext", "Math.random(",
    "Date.now(", "performance.now(", "requestAnimationFrame(", "PIXI", "pixi.js",
  ];
  const forbiddenViolations = forbidden.flatMap((token) => ["dayLoop", "timer"]
    .filter((name) => source[name].includes(token))
    .map((name) => `${name}:${token}`));
  const startBinding = source.bootstrap.slice(
    source.bootstrap.indexOf("this.enterPrototype = async"),
    source.bootstrap.indexOf("this.closePanel ="),
  );
  const forbiddenStartCoupling = [source.panel, source.zone, source.menu]
    .flatMap((text, index) => ["day-loop.service-start.confirm", "confirmServiceStart"]
      .filter((token) => text.includes(token))
      .map((token) => `${["panel", "zone", "menu"][index]}:${token}`));

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "DayLoop/timer-state는 browser·wall-clock·nondeterministic·PixiJS authority를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-runtime-phase-and-lifecycle",
      "TITLE/PLANNING/SERVICE/PAUSED/SETTLEMENT/TERMINAL과 INACTIVE/RUNNING/RESULTS_CLOSED_CLEANUP을 명시한다",
      ["TITLE", "PLANNING", "SERVICE", "PAUSED", "SETTLEMENT", "TERMINAL"]
        .every((phase) => source.timer.includes(`${phase}: \"${phase}\"`)) &&
        ["INACTIVE", "RUNNING", "RESULTS_CLOSED_CLEANUP"]
          .every((lifecycle) => source.timer.includes(`${lifecycle}: \"${lifecycle}\"`)),
    ),
    staticResult(
      "static-explicit-service-start-command",
      "Planning→Service는 별도 ConfirmServiceStart transaction만 수행하고 일반 transition 우회를 거절한다",
      source.dayLoop.includes("CONFIRM_SERVICE_START: \"day-loop.service-start.confirm\"") &&
        source.dayLoop.includes("createConfirmServiceStartAtomicTransaction") &&
        source.dayLoop.includes("SERVICE_START_REQUIRES_EXPLICIT_CONFIRM_COMMAND") &&
        source.dayLoop.includes("prepareMenuForServiceDraft") &&
        source.dayLoop.includes("draft.replace(\"runtimePhase\", RUNTIME_PHASE.SERVICE)"),
    ),
    staticResult(
      "static-service-start-invariants",
      "enabled/unlocked Recipe, AVAILABLE-only slots, confirmed plan, full reservation, event/facility/transient를 시작 전에 검사한다",
      source.dayLoop.includes("SERVICE_START_ENABLED_RECIPE_REQUIRED") &&
        source.dayLoop.includes("SERVICE_START_AVAILABLE_SLOT_REQUIRED") &&
        source.dayLoop.includes("SERVICE_START_REQUIRES_ALL_SLOTS_AVAILABLE") &&
        source.dayLoop.includes("SERVICE_START_UNCONFIRMED_MENU_EDITS") &&
        source.dayLoop.includes("requireFullReservations: true") &&
        source.dayLoop.includes("validateEventState(events)") &&
        source.dayLoop.includes("validateFacilityState(facilities)") &&
        source.dayLoop.includes("SERVICE_START_TRANSIENTS_NOT_EMPTY"),
    ),
    staticResult(
      "static-early-end-and-single-token",
      "조기 종료 네 조건과 compare-and-set Settlement token을 명시한다",
      source.dayLoop.includes("scheduledPlansComplete") &&
        source.dayLoop.includes("activeOrderCount === 0") &&
        source.dayLoop.includes("carriedDishId === null") &&
        source.dayLoop.includes("nonExitedGuestCount === 0") &&
        source.timer.includes("SETTLEMENT_TRANSITION_ALREADY_ISSUED") &&
        source.timer.includes("SETTLEMENT_TRANSITION_TOKEN_MISMATCH") &&
        source.dayLoop.includes("day-loop.settlement-transition-issued"),
    ),
    staticResult(
      "static-full-rejection-atomic-path",
      "모든 phase 전이는 AtomicTransaction preflight→touched draft→postcondition→event 경로를 사용한다",
      source.dayLoop.includes("defineAtomicTransaction({") &&
        source.dayLoop.includes("preflight(ctx)") &&
        source.dayLoop.includes("postconditions(before, after, ctx)") &&
        source.dayLoop.includes("DAY_LOOP_TRANSITION_WRITE_SET") &&
        source.dayLoop.includes("SERVICE_START_WRITE_SET") &&
        source.dayLoop.includes("ILLEGAL_PHASE_TRANSITION"),
    ),
    staticResult(
      "static-panel-zone-menu-no-auto-start",
      "PanelManager·StaticZoneController·MenuSystem은 Service Start command/validator를 호출하지 않는다",
      forbiddenStartCoupling.length === 0 &&
        !startBinding.includes("confirmServiceStart") &&
        startBinding.includes("DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY"),
      { forbiddenStartCoupling },
    ),
    staticResult(
      "static-production-composition",
      "AppBootstrap STORE stage가 canonical timer state와 DayLoopController를 production bus에 배선한다",
      source.bootstrap.includes("createServiceTimerState({") &&
        source.bootstrap.includes("durationMs: balanceDocument.service.durationMs") &&
        source.bootstrap.includes("cleanupOvertimeMs: balanceDocument.service.cleanupOvertimeMs") &&
        source.bootstrap.includes("this.dayLoopController = registerDayLoopController(this.commandBus, {") &&
        source.bootstrap.includes("guestArchetypes: guestDocument.guestArchetypes") &&
        source.bootstrap.includes("dayLoopController: this.dayLoopController") &&
        source.bootstrap.includes("get dayLoopController()"),
    ),
    staticResult(
      "static-korean-diagnostics",
      "Task 20 command failures expose Korean diagnostic details while retaining stable codes",
      /[가-힣]/.test(source.dayLoop) && /[가-힣]/.test(source.timer) &&
        source.dayLoop.includes("message: MESSAGE_BY_CODE[code]") &&
        source.timer.includes("message: MESSAGE_BY_CODE[code]"),
    ),
    staticResult(
      "static-property-1-runtime-qa",
      "QA는 Property 1 requirement links, 100+ phase/lifecycle×trigger samples, invalid menu, no-auto-start, duplicate end를 계측한다",
      source.qa.includes("Property 1: 합법 phase 전이와 명시 Service Start") &&
        source.qa.includes("**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.11, 2.12, 2.13**") &&
        source.qa.includes("PROPERTY_MINIMUM_SAMPLES = 100") &&
        source.qa.includes("invalidMenuAndEditIsolation") &&
        source.qa.includes("runDayLoopBrowserProbe") &&
        source.qa.includes("duplicateEndSignalSingleSettlement"),
    ),
    staticResult(
      "static-browser-route",
      "기존 browser QA route가 실제 authored zone/panel/menu no-auto-start 검증을 실행한다",
      source.bootstrap.includes("DAY_LOOP_QA_ROUTE = \"day-loop\"") &&
        source.bootstrap.includes("runDayLoopBrowserProbe") &&
        source.browserSmoke.includes("\"day-loop\": Object.freeze"),
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

export async function runDayLoopValidation() {
  const [recipesDocument, facilitiesDocument, balanceDocument, guestsDocument] = await Promise.all([
    readJson("data/recipes.json"),
    readJson("data/upgrades.json"),
    readJson("data/balance.json"),
    readJson("data/guests.json"),
  ]);
  const [dayLoop, staticAudit] = await Promise.all([
    runDayLoopProbe({
      recipes: recipesDocument.recipes,
      facilities: facilitiesDocument.facilities,
      balance: balanceDocument,
      guestArchetypes: guestsDocument.guestArchetypes,
    }),
    runStaticAudit(),
  ]);
  return Object.freeze({
    status: dayLoop.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    dayLoop,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await runDayLoopValidation();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Day loop validation: ${report.status}`);
    console.log(`Task 20 examples/Property 1: ${report.dayLoop.status} (${report.dayLoop.passed}/${report.dayLoop.total})`);
    console.log(`  Property 1 samples: ${report.dayLoop.propertySampleCount}`);
    console.log(`  rejected phase/lifecycle samples: ${report.dayLoop.propertyRejectedSampleCount}`);
    for (const result of report.dayLoop.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 20 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
