#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DataLoader } from "../js/infrastructure/data-loader.js";
import { runCanonicalMapProbe } from "../js/qa/canonical-map-probe.js";
import { runMapAccessibilityProbe } from "../js/qa/map-accessibility-probe.js";
import { runMapValidationProbe } from "../js/qa/map-validation-probe.js";
import {
  CANONICAL_MAP_TILE_IDS,
  MapManifestLoader,
} from "../js/world/map-manifest.js";
import { MapLoader } from "../js/world/map-loader.js";
import { MapValidator } from "../js/world/map-validator.js";
import { migrateMapData } from "./migrate-map-data.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function failureResult(error) {
  return Object.freeze({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function runMapValidationSuite() {
  const task7 = await runMapValidationProbe();
  const task8 = await runMapAccessibilityProbe();

  let migration;
  try {
    migration = await migrateMapData({ write: false });
  } catch (error) {
    migration = failureResult(error);
  }

  let manifestReport;
  let mapLoadReport = null;
  let canonical = failureResult("canonical Map load가 실행되지 않았습니다.");
  try {
    const loadText = async ({ filename }) => readFile(resolve(repositoryRoot, filename), "utf8");
    const manifestLoader = new MapManifestLoader({
      loadText,
      resolveMapUrl: (filename) => filename,
    });
    manifestReport = await manifestLoader.load();
    if (manifestReport.ok) {
      const mapValidator = new MapValidator({ knownTileIds: CANONICAL_MAP_TILE_IDS });
      const mapDataLoader = new DataLoader({
        validator: mapValidator.schemaValidator,
        loadText,
      });
      const mapLoader = new MapLoader({ mapValidator, dataLoader: mapDataLoader });
      mapLoadReport = await mapLoader.load(manifestReport.specifications, {
        activeMapId: manifestReport.manifest.activeMapId,
        requireBase: true,
      });
      canonical = await runCanonicalMapProbe({
        manifestReport,
        mapLoadReport,
        mapValidator,
        mapLoader,
      });
    }
  } catch (error) {
    manifestReport = manifestReport ?? failureResult(error);
    canonical = failureResult(error);
  }

  const manifestStatus = manifestReport?.ok ? "PASS" : "FAIL";
  const canonicalLoadStatus = mapLoadReport?.ok ? "PASS" : "FAIL";
  const status = task7.status === "PASS" &&
    task8.status === "PASS" &&
    migration.status === "PASS" &&
    manifestStatus === "PASS" &&
    canonicalLoadStatus === "PASS" &&
    canonical.status === "PASS"
    ? "PASS"
    : "FAIL";

  return Object.freeze({
    status,
    task7,
    task8,
    migration,
    manifest: Object.freeze({
      status: manifestStatus,
      code: manifestReport?.code ?? "MAP_MANIFEST_NOT_RUN",
      diagnostics: manifestReport?.diagnostics ?? [],
    }),
    canonicalLoad: Object.freeze({
      status: canonicalLoadStatus,
      code: mapLoadReport?.code ?? "MAP_LOAD_NOT_RUN",
      registered: mapLoadReport?.registryConformance.registeredCount ?? 0,
      quarantined: mapLoadReport?.quarantined.length ?? 0,
      activeValidity: mapLoadReport?.activeMapValidity.code ?? "NOT_RUN",
      accessibility: mapLoadReport?.activeMapValidity.details?.accessibility ?? "NOT_RUN",
      diagnostics: mapLoadReport?.diagnostics ?? [],
    }),
    canonical,
  });
}

async function main() {
  const supportedArguments = new Set(["--json"]);
  const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));
  if (unknownArguments.length > 0) {
    console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const report = await runMapValidationSuite();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Map validation: ${report.status}`);
    console.log(`Task 7 schema/registry/loader: ${report.task7.status} (${report.task7.passed}/${report.task7.total})`);
    console.log(`Task 8 BFS/accessibility: ${report.task8.status} (${report.task8.passed}/${report.task8.total})`);
    console.log(`Canonical migration: ${report.migration.status}${report.migration.mode ? ` (${report.migration.mode})` : ""}`);
    console.log(`Canonical manifest: ${report.manifest.status} (${report.manifest.code})`);
    console.log(`Canonical loader: ${report.canonicalLoad.status} (${report.canonicalLoad.registered} registered, ${report.canonicalLoad.quarantined} quarantined)`);
    console.log(`Base active/accessibility: ${report.canonicalLoad.activeValidity}/${report.canonicalLoad.accessibility}`);
    console.log(`Task 9 canonical fixtures: ${report.canonical.status}${report.canonical.passed === undefined ? "" : ` (${report.canonical.passed}/${report.canonical.total})`}`);
    for (const result of [
      ...report.task7.results,
      ...report.task8.results,
      ...(report.canonical.results ?? []),
    ]) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    if (report.migration.error) console.log(`FAIL  map-migration-check — ${report.migration.error}`);
    if (report.canonical.error) console.log(`FAIL  canonical-map-check — ${report.canonical.error}`);
  }
  if (report.status !== "PASS") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
