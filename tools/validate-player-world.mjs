#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPlayerWorldProbe } from "../js/qa/player-world-probe.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supportedArguments = new Set(["--json"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));

async function run() {
  const baseMap = JSON.parse(await readFile(resolve(repositoryRoot, "data/maps/base-restaurant.json"), "utf8"));
  const playerWorld = await runPlayerWorldProbe({ baseMap });
  return Object.freeze({
    status: playerWorld.status,
    playerWorld,
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
    console.log(`Player World validation: ${report.status}`);
    console.log(`Task 10 Player/Static interaction: ${report.playerWorld.status} (${report.playerWorld.passed}/${report.playerWorld.total})`);
    for (const result of report.playerWorld.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
