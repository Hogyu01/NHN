#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./asset-gen/canonical-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "assets/asset-manifest.json"), "utf8"));
const visual = JSON.parse(await readFile(resolve(root, "reports/evidence/visual-review.json"), "utf8"));

if (visual.buildId !== manifest.buildId) {
  console.error(`FAIL: evidence buildId(${visual.buildId}) != manifest buildId(${manifest.buildId})`);
  process.exit(1);
}
if (visual.status !== "PASS" || typeof visual.reviewer !== "string" || visual.reviewer.trim() === "") {
  console.error("FAIL: evidence is not an authenticated PASS (status/reviewer missing).");
  process.exit(1);
}
const evidenceById = new Map(visual.assets.map((entry) => [entry.assetId, entry]));

let promoted = 0;
for (const asset of manifest.assets) {
  const evidence = evidenceById.get(asset.assetId);
  if (!evidence || evidence.outcome !== "PASS" || evidence.outputHash !== asset.outputHash) {
    console.error(`FAIL: ${asset.assetId} lacks matching PASS evidence for its current outputHash.`);
    process.exit(1);
  }
  if (asset.gates.hash !== "PASS" || asset.gates.provenance !== "PASS") {
    console.error(`FAIL: ${asset.assetId} hash/provenance gate not PASS; refusing to promote quality.`);
    process.exit(1);
  }
  asset.gates.quality = "PASS";
  promoted += 1;
}

await writeFile(resolve(root, "assets/asset-manifest.json"), canonicalJson(manifest));
console.log(`Promoted quality gate to PASS for ${promoted} assets (evidence-backed, buildId ${manifest.buildId}).`);
