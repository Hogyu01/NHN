import { loadAssetManifest } from "./asset-manifest.js";
import { loadRuntimeDependencies } from "./runtime-dependency-registry.js";

async function digestHex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pngDimensions(bytes) {
  const view = new DataView(bytes);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, index) => view.getUint8(index) !== byte)) throw new Error("PNG_SIGNATURE_INVALID");
  if (String.fromCharCode(...new Uint8Array(bytes, 12, 4)) !== "IHDR") throw new Error("PNG_IHDR_MISSING");
  if (view.getUint8(24) !== 8 || view.getUint8(25) !== 6 || view.getUint8(28) !== 0) throw new Error("PNG_CANONICAL_CONTRACT_INVALID");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export class AssetLoader {
  constructor({ baseUrl, fetchImpl = (...args) => window.fetch.call(window, ...args) }) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.manifest = null;
    this.handles = new Map();
    this.diagnostics = [];
  }

  async prepare(requiredAssetIds) {
    this.manifest = null;
    this.handles = new Map();
    if (new Set(requiredAssetIds).size !== requiredAssetIds.length) throw new Error("REQUIRED_ASSET_ID_DUPLICATE");
    const stagedHandles = new Map();
    try {
      const dependency = await loadRuntimeDependencies(this.baseUrl, this.fetchImpl);
      await this.#verifyBytes(dependency.pixi.localEntry, dependency.pixi.localSha256);
      const manifestResult = await loadAssetManifest(this.baseUrl, this.fetchImpl);
      for (const assetId of requiredAssetIds) {
        const asset = manifestResult.byId.get(assetId);
        if (!asset) throw new Error(`REQUIRED_ASSET_UNREGISTERED:${assetId}`);
        if (asset.tier !== "A" || asset.sourceKind !== "PROJECT_GENERATED" || asset.status !== "GENERATED") throw new Error(`REQUIRED_ASSET_PROVENANCE_INVALID:${assetId}`);
        const bytes = await this.#verifyBytes(asset.publicPath, asset.outputHash);
        const dimensions = pngDimensions(bytes);
        if (dimensions.width !== asset.width || dimensions.height !== asset.height) throw new Error(`REQUIRED_ASSET_DIMENSION_MISMATCH:${assetId}`);
        stagedHandles.set(assetId, Object.freeze({ assetId, path: asset.publicPath, url: new URL(asset.publicPath, this.baseUrl).href, ...dimensions }));
      }
      this.manifest = manifestResult.manifest;
      this.handles = stagedHandles;
      return Object.freeze({ ready: true, requiredCount: this.handles.size, dependency: dependency.pixi, handles: this.handles });
    } catch (error) {
      this.manifest = null;
      this.handles = new Map();
      throw error;
    }
  }

  get(assetId) {
    const handle = this.handles.get(assetId);
    if (!handle) throw new Error(`ASSET_HANDLE_NOT_READY:${assetId}`);
    return handle;
  }

  async #verifyBytes(relativePath, expectedHash) {
    const url = new URL(relativePath, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new Error(`REMOTE_ASSET_FORBIDDEN:${relativePath}`);
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`ASSET_FETCH_FAILED:${relativePath}:${response.status}`);
    const bytes = await response.arrayBuffer();
    const actualHash = await digestHex(bytes);
    if (actualHash !== expectedHash) throw new Error(`ASSET_HASH_MISMATCH:${relativePath}`);
    return bytes;
  }
}
