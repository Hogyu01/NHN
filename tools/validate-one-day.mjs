#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runOneDayProbe } from "../js/qa/one-day-probe.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(repositoryRoot, relativePath), "utf8"));
}

async function loadCanonicalDocuments() {
  const [ingredients, recipes, upgrades, events, balance, guests] = await Promise.all([
    readJson("data/ingredients.json"),
    readJson("data/recipes.json"),
    readJson("data/upgrades.json"),
    readJson("data/events.json"),
    readJson("data/balance.json"),
    readJson("data/guests.json"),
  ]);
  return { ingredients, recipes, upgrades, events, balance, guests };
}

async function main() {
  const documents = await loadCanonicalDocuments();
  const report = await runOneDayProbe(documents);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`One-day scenario validation: ${report.status} (${report.passed}/${report.total})`);
    for (const result of report.results) {
      console.log(`${result.status === "PASS" ? "PASS" : "FAIL"}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
      if (result.status !== "PASS" && result.details) {
        console.log(`  details: ${JSON.stringify(result.details)}`);
      }
    }
  }
  process.exit(report.status === "PASS" ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
