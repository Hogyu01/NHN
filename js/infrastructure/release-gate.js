import { validateAssetManifest } from "./asset-manifest.js";
import { validateRuntimeDependencies } from "./runtime-dependency-registry.js";

export function evaluateReleaseGate({
  manifest, dependencies, requiredAssetIds, visualEvidence = null, readyAssetIds = null,
  textureRequiredAssetIds = null, publicImports = [], resourceLeaks = 0,
}) {
  const checks = [];
  const manifestResult = validateAssetManifest(manifest);
  const dependencyResult = validateRuntimeDependencies(dependencies);
  checks.push({ id: "manifest", status: manifestResult.ok ? "PASS" : "FAIL" });
  checks.push({ id: "pixi-dependency", status: dependencyResult.ok ? "PASS" : "FAIL" });
  const byId = manifestResult.ok ? manifestResult.byId : new Map();
  const evidenceById = new Map((visualEvidence?.assets ?? []).map((entry) => [entry.assetId, entry]));
  const readyIds = readyAssetIds === null ? null : new Set(readyAssetIds);
  // texture-ready는 PixiJS World canvas가 실제로 로드하는 asset에만 의미가 있다. 시장/메뉴 패널의
  // HTML <img> 전용 asset(예: ingredient 아이콘)은 Pixi를 아예 거치지 않으므로, 그 asset들까지
  // texture-ready NOT_RUN/FAIL로 묶어 게이트를 영원히 막지 않게 별도 집합으로 범위를 좁힌다.
  const textureRequiredIds = textureRequiredAssetIds === null ? null : new Set(textureRequiredAssetIds);
  for (const assetId of requiredAssetIds) {
    const asset = byId.get(assetId);
    checks.push({ id: `required:${assetId}`, status: asset && asset.tier === "A" && asset.sourceKind === "PROJECT_GENERATED" && asset.gates.provenance === "PASS" && asset.gates.hash === "PASS" ? "PASS" : "FAIL" });
    const declaredQuality = asset?.gates?.quality ?? "NOT_RUN";
    const evidence = evidenceById.get(assetId);
    const evidencePass = visualEvidence?.buildId === manifest?.buildId && visualEvidence?.status === "PASS" && typeof visualEvidence?.reviewer === "string" && visualEvidence.reviewer.trim() !== "" && evidence?.outputHash === asset?.outputHash && evidence?.outcome === "PASS";
    const qualityStatus = declaredQuality === "FAIL" ? "FAIL"
      : declaredQuality === "PASS" ? (evidencePass ? "PASS" : "FAIL")
        : declaredQuality === "NOT_RUN" ? "NOT_RUN"
          : "FAIL";
    checks.push({ id: `quality:${assetId}`, status: qualityStatus });
    if (textureRequiredIds === null || textureRequiredIds.has(assetId)) {
      checks.push({ id: `texture-ready:${assetId}`, status: readyIds === null ? "NOT_RUN" : readyIds.has(assetId) ? "PASS" : "FAIL" });
    }
  }
  checks.push({ id: "remote-imports", status: publicImports.some((path) => /^https?:/.test(path)) ? "FAIL" : "PASS" });
  checks.push({ id: "raw-canvas-imports", status: publicImports.some((path) => path.includes("raw-canvas-fixture")) ? "FAIL" : "PASS" });
  checks.push({ id: "resource-leaks", status: resourceLeaks === 0 ? "PASS" : "FAIL" });
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "NOT_RUN") ? "NOT_RUN" : "PASS";
  return Object.freeze({ status, checks: Object.freeze(checks.map(Object.freeze)) });
}
