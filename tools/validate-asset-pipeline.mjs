#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAssetManifest } from "../js/infrastructure/asset-manifest.js";
import { evaluateReleaseGate } from "../js/infrastructure/release-gate.js";
import { validateRuntimeDependencies } from "../js/infrastructure/runtime-dependency-registry.js";
import { validateCanonicalPng } from "./asset-gen/png-codec.mjs";
import { canonicalJson } from "./asset-gen/canonical-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const manifest = await readJson("assets/asset-manifest.json");
const dependencies = await readJson("data/runtime-dependencies.json");
const source = await readJson("tools/asset-gen/sources/a/visuals.json");
const failures = [];
const manifestResult = validateAssetManifest(manifest);
if (!manifestResult.ok) failures.push(...manifestResult.diagnostics);
const dependencyResult = validateRuntimeDependencies(dependencies);
if (!dependencyResult.ok) failures.push(...dependencyResult.diagnostics);
if ((await readFile(resolve(root, "tools/asset-gen/sources/a/visuals.json"), "utf8")) !== canonicalJson(source)) failures.push("SOURCE_DEFINITION_NOT_CANONICAL");
for (const asset of manifest.assets) {
  const bytes = await readFile(resolve(root, asset.publicPath));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const png = validateCanonicalPng(bytes);
  if (hash !== asset.outputHash) failures.push(`${asset.assetId}:HASH_MISMATCH`);
  if (!png.ok || png.width !== asset.width || png.height !== asset.height) failures.push(`${asset.assetId}:PNG_CONTRACT_INVALID`);
}
const requiredAssetIds = manifest.assets.filter((asset) => asset.target === "PUBLIC_RUNTIME").map((asset) => asset.assetId);
const gate = evaluateReleaseGate({ manifest, dependencies, requiredAssetIds });
if (gate.status !== "NOT_RUN") failures.push(`RELEASE_GATE_TRUTH_EXPECTED_NOT_RUN:${gate.status}`);
console.log(`Asset pipeline: ${failures.length === 0 ? "PASS" : "FAIL"} (${manifest.assets.length} canonical assets, release gate ${gate.status})`);
if (failures.length > 0) console.log(failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
