#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runWorldInteractionProbe } from "../js/qa/world-interaction-probe.js";

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
    resolver: resolve(repositoryRoot, "js/world/dynamic-target-resolver.js"),
    interactionRouter: resolve(repositoryRoot, "js/world/interaction-router.js"),
    inputRouter: resolve(repositoryRoot, "js/ui/input-router.js"),
    runtimeHub: resolve(repositoryRoot, "js/ui/prototype-hub-adapter.js"),
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")]));
  const source = Object.fromEntries(entries);
  const deterministicSources = [source.resolver, source.interactionRouter, source.inputRouter];
  const forbidden = ["Math.random(", "Date.now(", "performance.now(", "crypto.randomUUID("];
  const violations = forbidden.flatMap((token) => deterministicSources.some((text) => text.includes(token)) ? [token] : []);

  const results = Object.freeze([
    staticResult(
      "static-no-nondeterministic-primitive",
      "resolver/router/input source는 Math.random·wall-clock·random UUID를 사용하지 않는다",
      violations.length === 0,
      { violations },
    ),
    staticResult(
      "static-exact-ordering-contract",
      "resolver는 squared World milli-pixel distance, fixed priority, Entity_ID lexical 순서를 선언한다",
      source.resolver.includes("distanceSquaredMilliPx") &&
        source.resolver.includes("DYNAMIC_SERVICE_TARGET_PRIORITY") &&
        source.resolver.includes("left.target.entityId") &&
        source.resolver.includes("BigInt"),
    ),
    staticResult(
      "static-target-id-only-command",
      "dynamic interaction command payload source는 targetId만 구성한다",
      source.interactionRouter.includes("payload: { targetId: target.targetId }") &&
        !source.interactionRouter.includes("payload: { targetId: target.targetId,"),
    ),
    staticResult(
      "static-production-runtime-wiring",
      "production hub가 InputRouter와 WorldInteractionRouter를 생성하고 downstream command event를 발행한다",
      source.runtimeHub.includes("new InputRouter({") &&
        source.runtimeHub.includes("new WorldInteractionRouter({") &&
        source.runtimeHub.includes("world:interaction-command") &&
        !source.runtimeHub.includes("addEventListener(\"keydown\", this.handleKeyDown)"),
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

async function run() {
  const baseMap = JSON.parse(await readFile(resolve(repositoryRoot, "data/maps/base-restaurant.json"), "utf8"));
  const [worldInteraction, staticAudit] = await Promise.all([
    runWorldInteractionProbe({ baseMap }),
    runStaticAudit(),
  ]);
  return Object.freeze({
    status: worldInteraction.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    worldInteraction,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await run();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`World interaction validation: ${report.status}`);
    console.log(`Task 12 Router/Resolver/Input: ${report.worldInteraction.status} (${report.worldInteraction.passed}/${report.worldInteraction.total})`);
    for (const result of report.worldInteraction.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 12 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
