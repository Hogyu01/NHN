#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetLoader } from "../js/infrastructure/asset-loader.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "assets/asset-manifest.json"), "utf8"));
const dependency = JSON.parse(await readFile(resolve(root, "data/runtime-dependencies.json"), "utf8"));
const assetId = "hud.gold";
const asset = manifest.assets.find((entry) => entry.assetId === assetId);
let corruptAsset = false;

async function fakeFetch(input) {
  const url = new URL(input);
  const relativePath = decodeURIComponent(url.pathname.slice(1));
  if (relativePath === "assets/asset-manifest.json") return new Response(JSON.stringify(manifest), { status: 200 });
  if (relativePath === "data/runtime-dependencies.json") return new Response(JSON.stringify(dependency), { status: 200 });
  try {
    const bytes = Buffer.from(await readFile(resolve(root, relativePath)));
    if (corruptAsset && relativePath === asset.publicPath) bytes[bytes.length - 1] ^= 0xff;
    return new Response(bytes, { status: 200 });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

const failures = [];
const loader = new AssetLoader({ baseUrl: new URL("http://local.test/"), fetchImpl: fakeFetch });
const ready = await loader.prepare([assetId]);
if (!ready.ready || loader.get(assetId).path !== asset.publicPath) failures.push("SUCCESS_HANDLE_NOT_READY");

corruptAsset = true;
try {
  await loader.prepare([assetId]);
  failures.push("CORRUPT_RETRY_NOT_REJECTED");
} catch (error) {
  if (!String(error.message).startsWith("ASSET_HASH_MISMATCH")) failures.push(`CORRUPT_RETRY_WRONG_ERROR:${error.message}`);
}
if (loader.handles.size !== 0 || loader.manifest !== null) failures.push("FAILED_RETRY_RETAINED_STALE_STATE");

corruptAsset = false;
try {
  await loader.prepare([assetId, assetId]);
  failures.push("DUPLICATE_REQUIRED_ID_NOT_REJECTED");
} catch (error) {
  if (error.message !== "REQUIRED_ASSET_ID_DUPLICATE") failures.push(`DUPLICATE_REQUIRED_ID_WRONG_ERROR:${error.message}`);
}

console.log(`AssetLoader validation: ${failures.length === 0 ? "PASS" : "FAIL"} (transactional retry, duplicate guard)`);
if (failures.length > 0) console.log(failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
