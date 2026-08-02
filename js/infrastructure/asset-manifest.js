const REQUIRED_FIELDS = Object.freeze([
  "assetId", "tier", "maturity", "status", "sourceKind", "target", "creator", "source",
  "license", "approval", "runtime", "generator", "canonicalFormat", "publicPath", "width",
  "height", "outputHash", "gates", "fallback",
]);

export function validateAssetManifest(input) {
  const diagnostics = [];
  const ids = new Set();
  const paths = new Set();
  if (!input || typeof input !== "object" || input.schemaVersion !== 1 || !Array.isArray(input.assets)) {
    return { ok: false, code: "ASSET_MANIFEST_INVALID", diagnostics: ["MANIFEST_SHAPE_INVALID"] };
  }
  for (const asset of input.assets) {
    for (const field of REQUIRED_FIELDS) if (!(field in asset)) diagnostics.push(`${asset.assetId ?? "unknown"}:MISSING_${field}`);
    if (ids.has(asset.assetId)) diagnostics.push(`${asset.assetId}:DUPLICATE_ID`);
    if (paths.has(asset.publicPath)) diagnostics.push(`${asset.publicPath}:DUPLICATE_PATH`);
    ids.add(asset.assetId);
    paths.add(asset.publicPath);
    if (asset.tier === "A" && asset.sourceKind !== "PROJECT_GENERATED") diagnostics.push(`${asset.assetId}:EXTERNAL_A_FORBIDDEN`);
    if (!/^assets\/generated\/[a-z0-9/_-]+\.png$/.test(asset.publicPath)) diagnostics.push(`${asset.assetId}:PUBLIC_PATH_INVALID`);
    if (!/^[0-9a-f]{64}$/.test(asset.outputHash)) diagnostics.push(`${asset.assetId}:HASH_INVALID`);
    if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width < 1 || asset.height < 1) diagnostics.push(`${asset.assetId}:DIMENSIONS_INVALID`);
  }
  return diagnostics.length > 0
    ? { ok: false, code: "ASSET_MANIFEST_INVALID", diagnostics }
    : { ok: true, code: "ASSET_MANIFEST_VALID", manifest: Object.freeze(input), byId: new Map(input.assets.map((asset) => [asset.assetId, Object.freeze(asset)])) };
}

export async function loadAssetManifest(baseUrl, fetchImpl = (...args) => window.fetch.call(window, ...args)) {
  const response = await fetchImpl(new URL("assets/asset-manifest.json", baseUrl));
  if (!response.ok) throw new Error(`ASSET_MANIFEST_FETCH_FAILED:${response.status}`);
  const result = validateAssetManifest(await response.json());
  if (!result.ok) throw new Error(`${result.code}:${result.diagnostics.join("|")}`);
  return result;
}
