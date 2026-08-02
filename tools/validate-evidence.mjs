#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const manifest = await readJson("assets/asset-manifest.json");
const visual = await readJson("reports/evidence/visual-review.json");
const audio = await readJson("reports/evidence/audio-review.json");
const failures = [];
if (visual.buildId !== manifest.buildId) failures.push("VISUAL_EVIDENCE_BUILD_STALE");
if (!Array.isArray(visual.criteria) || visual.criteria.length < 10) failures.push("VISUAL_EVIDENCE_CRITERIA_MISSING");
const evidenceById = new Map(visual.assets.map((entry) => [entry.assetId, entry]));
for (const asset of manifest.assets) {
  const evidence = evidenceById.get(asset.assetId);
  if (!evidence || evidence.outputHash !== asset.outputHash) failures.push(`${asset.assetId}:EVIDENCE_HASH_STALE`);
  if (visual.status === "NOT_RUN" && evidence?.outcome !== "NOT_RUN") failures.push(`${asset.assetId}:FABRICATED_REVIEW_OUTCOME`);
}
if (audio.status !== "DEFERRED" || audio.assets.length !== 0 || audio.reviewer !== null) failures.push("AUDIO_DEFERRED_TRUTH_INVALID");
console.log(`Evidence truth: ${failures.length === 0 ? "PASS" : "FAIL"} (visual ${visual.status}, audio ${audio.status})`);
if (failures.length > 0) console.log(failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);

