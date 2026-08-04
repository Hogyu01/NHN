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
const visualEvidence = await readJson("reports/evidence/visual-review.json");
// texture-ready 검증은 아직 실제 브라우저 실행 리포트가 없어 NOT_RUN이 정상이다(quality가 evidence로
// PASS 승격된 뒤에도 마찬가지). evidence 없이 부르면 manifest가 quality:PASS를 선언해도 gate는
// 반드시 FAIL로 거절해야 한다 — declared PASS를 evidence 증빙 없이는 신뢰하지 않는다는 계약이다.
const gate = evaluateReleaseGate({ manifest, dependencies, requiredAssetIds, visualEvidence });
if (gate.status !== "NOT_RUN") failures.push(`RELEASE_GATE_TRUTH_EXPECTED_NOT_RUN:${gate.status}`);
const gateWithoutEvidence = evaluateReleaseGate({ manifest, dependencies, requiredAssetIds });
if (gateWithoutEvidence.status !== "FAIL") failures.push(`RELEASE_GATE_WITHOUT_EVIDENCE_NOT_REJECTED:${gateWithoutEvidence.status}`);
const invalidQualityManifest = structuredClone(manifest);
invalidQualityManifest.assets[0].gates.quality = "PENDING";
if (evaluateReleaseGate({ manifest: invalidQualityManifest, dependencies, requiredAssetIds }).status !== "FAIL") failures.push("INVALID_QUALITY_STATUS_NOT_REJECTED");
const forgedQualityManifest = structuredClone(manifest);
forgedQualityManifest.assets[0].gates.quality = "PASS";
if (evaluateReleaseGate({ manifest: forgedQualityManifest, dependencies, requiredAssetIds }).status !== "FAIL") failures.push("QUALITY_PASS_WITHOUT_EVIDENCE_NOT_REJECTED");
console.log(`Asset pipeline: ${failures.length === 0 ? "PASS" : "FAIL"} (${manifest.assets.length} canonical assets, release gate ${gate.status})`);
if (failures.length > 0) console.log(failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
