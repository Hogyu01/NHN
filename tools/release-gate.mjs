#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReleaseGate } from "../js/infrastructure/release-gate.js";
import { REQUIRED_ASSET_IDS as PIXI_REQUIRED_ASSET_IDS } from "../js/render/pixi-world-renderer.js";
import { canonicalJson } from "./asset-gen/canonical-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJsonIfExists = async (path) => {
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
const manifest = JSON.parse(await readFile(resolve(root, "assets/asset-manifest.json"), "utf8"));
const dependencies = JSON.parse(await readFile(resolve(root, "data/runtime-dependencies.json"), "utf8"));
const visualEvidence = JSON.parse(await readFile(resolve(root, "reports/evidence/visual-review.json"), "utf8"));
const textureReadiness = await readJsonIfExists("reports/texture-readiness.json");
const requiredAssetIds = manifest.assets.filter((asset) => asset.target === "PUBLIC_RUNTIME").map((asset) => asset.assetId);
const readyAssetIds = textureReadiness?.buildId === manifest.buildId ? textureReadiness.readyAssetIds : null;
const result = evaluateReleaseGate({
  manifest, dependencies, requiredAssetIds, visualEvidence,
  readyAssetIds, textureRequiredAssetIds: PIXI_REQUIRED_ASSET_IDS,
});
await writeFile(resolve(root, "reports/asset-gate.json"), canonicalJson({ schemaVersion: 1, buildId: manifest.buildId, ...result }));
console.log(`Release gate: ${result.status}`);
process.exit(result.status === "PASS" ? 0 : 2);
