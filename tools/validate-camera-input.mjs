#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCameraInputProbe } from "../js/qa/camera-input-probe.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supportedArguments = new Set(["--json"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));

async function run() {
  const baseMap = JSON.parse(await readFile(resolve(repositoryRoot, "data/maps/base-restaurant.json"), "utf8"));
  const cameraInput = await runCameraInputProbe({ baseMap });
  return Object.freeze({ status: cameraInput.status, cameraInput });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await run();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Camera/Input validation: ${report.status}`);
    console.log(`Task 11 Camera/CSS inverse transform: ${report.cameraInput.status} (${report.cameraInput.passed}/${report.cameraInput.total})`);
    for (const result of report.cameraInput.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
