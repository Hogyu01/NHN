#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DataLoader } from "../js/infrastructure/data-loader.js";
import { CANONICAL_VALIDATION_SPECIFICATIONS } from "../js/infrastructure/canonical-content.js";
import { runCanonicalContentProbe } from "../js/qa/canonical-content-probe.js";
import { runDataValidationProbe } from "../js/qa/data-validation-probe.js";
import { migrateCanonicalData } from "./migrate-canonical-data.mjs";

const supportedArguments = new Set(["--json"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function failureResult(error) {
  return Object.freeze({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  });
}

async function run() {
  const foundation = await runDataValidationProbe();

  let migration;
  try {
    migration = await migrateCanonicalData({ write: false });
  } catch (error) {
    migration = failureResult(error);
  }

  const loader = new DataLoader({
    loadText: async ({ filename }) => readFile(resolve(repositoryRoot, filename), "utf8"),
  });
  const loadReport = await loader.loadAll(CANONICAL_VALIDATION_SPECIFICATIONS);
  const canonical = await runCanonicalContentProbe(loadReport);
  const status = foundation.status === "PASS" &&
    migration.status === "PASS" &&
    loadReport.ok &&
    canonical.status === "PASS"
    ? "PASS"
    : "FAIL";

  return Object.freeze({
    status,
    foundation,
    migration,
    canonicalLoad: Object.freeze({
      status: loadReport.ok ? "PASS" : "FAIL",
      accepted: loadReport.accepted.length,
      rejected: loadReport.rejected.length,
      diagnostics: loadReport.diagnostics,
    }),
    canonical,
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
    console.log(`Data validation: ${report.status}`);
    console.log(`Foundation validator: ${report.foundation.status} (${report.foundation.passed}/${report.foundation.total})`);
    console.log(`Canonical migration: ${report.migration.status}${report.migration.mode ? ` (${report.migration.mode})` : ""}`);
    console.log(`Canonical loader: ${report.canonicalLoad.status} (${report.canonicalLoad.accepted} accepted, ${report.canonicalLoad.diagnostics.length} diagnostics)`);
    console.log(`Canonical acceptance: ${report.canonical.status} (${report.canonical.passed}/${report.canonical.total})`);
    for (const result of [...report.foundation.results, ...report.canonical.results]) {
      const suffix = result.status === "PASS" ? "" : ` — ${result.error}`;
      console.log(`${result.status}  ${result.id}${suffix}`);
    }
    if (report.migration.error) console.log(`FAIL  migration-check — ${report.migration.error}`);
    for (const diagnostic of report.canonicalLoad.diagnostics) {
      console.log(`FAIL  ${diagnostic.filename} | ${diagnostic.errorType} | ${diagnostic.fieldPath} | ${diagnostic.code}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
