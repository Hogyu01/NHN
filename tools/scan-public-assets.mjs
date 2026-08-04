#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "assets/asset-manifest.json"), "utf8"));
const allowlist = JSON.parse(await readFile(resolve(root, "assets/public-asset-allowlist.json"), "utf8"));
const registered = new Set(manifest.assets.map((asset) => asset.publicPath));
const failures = allowlist.paths.filter((path) => path.startsWith("assets/") && !registered.has(path));
for (const asset of manifest.assets) if (!allowlist.paths.includes(asset.publicPath)) failures.push(`UNLISTED:${asset.publicPath}`);
console.log(`Public asset scan: ${failures.length === 0 ? "PASS" : "FAIL"} (${registered.size} registered)`);
if (failures.length > 0) console.log(failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);

