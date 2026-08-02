#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./asset-gen/canonical-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "reports/evidence"), { recursive: true });
await writeFile(resolve(root, "reports/evidence/audio-review.json"), canonicalJson({
  schemaVersion: 1,
  buildId: "dungeon-restaurant-management-mvp.task-44",
  status: "DEFERRED",
  reason: "Audio content intentionally deferred by product decision; AudioSystem remains UNAVAILABLE/degraded.",
  reviewer: null,
  criteria: ["three-loops", "clicks", "clipping", "sfx-distinction", "three-timbres", "phase-bus"],
  assets: [],
}));
console.log("Audio listening evidence recorded as DEFERRED; no WAV files generated.");

