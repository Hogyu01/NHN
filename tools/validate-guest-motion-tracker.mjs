#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGuestMotionTrackerProbe } from "../js/qa/guest-motion-tracker-probe.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

async function main() {
  const map = JSON.parse(await readFile(resolve(repositoryRoot, "data/maps/base-restaurant.json"), "utf8"));
  const report = await runGuestMotionTrackerProbe({ map });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`GuestMotionTracker validation: ${report.status} (${report.passed}/${report.total})`);
    for (const result of report.results) {
      console.log(`${result.status === "PASS" ? "PASS" : "FAIL"}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  process.exit(report.status === "PASS" ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
