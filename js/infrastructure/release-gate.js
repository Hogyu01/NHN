import { validateAssetManifest } from "./asset-manifest.js";
import { validateRuntimeDependencies } from "./runtime-dependency-registry.js";

export function evaluateReleaseGate({ manifest, dependencies, requiredAssetIds, publicImports = [], resourceLeaks = 0 }) {
  const checks = [];
  const manifestResult = validateAssetManifest(manifest);
  const dependencyResult = validateRuntimeDependencies(dependencies);
  checks.push({ id: "manifest", status: manifestResult.ok ? "PASS" : "FAIL" });
  checks.push({ id: "pixi-dependency", status: dependencyResult.ok ? "PASS" : "FAIL" });
  const byId = manifestResult.ok ? manifestResult.byId : new Map();
  for (const assetId of requiredAssetIds) {
    const asset = byId.get(assetId);
    checks.push({ id: `required:${assetId}`, status: asset && asset.tier === "A" && asset.sourceKind === "PROJECT_GENERATED" && asset.gates.provenance === "PASS" && asset.gates.hash === "PASS" ? "PASS" : "FAIL" });
    checks.push({ id: `quality:${assetId}`, status: asset?.gates?.quality ?? "NOT_RUN" });
  }
  checks.push({ id: "remote-imports", status: publicImports.some((path) => /^https?:/.test(path)) ? "FAIL" : "PASS" });
  checks.push({ id: "raw-canvas-imports", status: publicImports.some((path) => path.includes("raw-canvas-fixture")) ? "FAIL" : "PASS" });
  checks.push({ id: "resource-leaks", status: resourceLeaks === 0 ? "PASS" : "FAIL" });
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "NOT_RUN") ? "NOT_RUN" : "PASS";
  return Object.freeze({ status, checks: Object.freeze(checks.map(Object.freeze)) });
}
