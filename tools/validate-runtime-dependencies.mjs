#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUILD_METADATA } from "../js/app/build-metadata.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exactVersion = "8.19.0";
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));

const [manifest, lock, vendorManifest, rendererSource] = await Promise.all([
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("js/libs/pixijs/manifest.json"),
  readFile(resolve(root, "js/render/pixi-world-renderer.js"), "utf8"),
]);

const checks = [
  [manifest.dependencies?.["pixi.js"] === exactVersion, "package.json exact pin"],
  [lock.packages?.["node_modules/pixi.js"]?.version === exactVersion, "package-lock resolved version"],
  [vendorManifest.version === exactVersion, "vendor manifest version"],
  [DEFAULT_BUILD_METADATA.runtimeDependencies?.pixiJs === exactVersion, "build metadata version"],
  [vendorManifest.license === "MIT", "vendor license"],
  [rendererSource.includes('../libs/pixijs/pixi.min.js'), "local vendored runtime import"],
  [!rendererSource.includes("https://") && !rendererSource.includes("http://"), "runtime CDN import 0"],
];
const failed = checks.filter(([ok]) => !ok);
for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
console.log(`Runtime dependency parity: ${failed.length === 0 ? "PASS" : "FAIL"} (${checks.length - failed.length}/${checks.length})`);
process.exit(failed.length === 0 ? 0 : 1);
