#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTimerSystemProbe } from "../js/qa/timer-system-probe.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(repositoryRoot, relativePath), "utf8"));
}

async function main() {
  const [recipesDocument, facilitiesDocument, balanceDocument, guestsDocument] = await Promise.all([
    readJson("data/recipes.json"),
    readJson("data/upgrades.json"),
    readJson("data/balance.json"),
    readJson("data/guests.json"),
  ]);
  const report = await runTimerSystemProbe({
    recipes: recipesDocument.recipes,
    facilities: facilitiesDocument.facilities,
    balance: balanceDocument,
    guestArchetypes: guestsDocument.guestArchetypes,
  });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Timer system validation: ${report.status} (${report.passed}/${report.total})`);
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
