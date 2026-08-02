#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "qa" && entry.name !== "libs") output.push(...await files(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) output.push(path);
  }
  return output;
}
const failures = [];
for (const path of await files(resolve(root, "js"))) {
  const source = await readFile(path, "utf8");
  if (/from\s+["']https?:|import\s*\(\s*["']https?:/.test(source)) failures.push(`${path}:REMOTE_IMPORT`);
  const rawCanvasImports = source.match(/(?:from\s+|import\s*\()\s*["'][^"']*raw-canvas-fixture[^"']*["']/g) ?? [];
  const qaOnlyImport = path.endsWith("js\\app\\bootstrap.js") && rawCanvasImports.length === 1 && source.includes("PROTOTYPE_QA_ROUTE");
  if (rawCanvasImports.length > 0 && !qaOnlyImport) failures.push(`${path}:RAW_CANVAS_IMPORT`);
}
console.log(`Runtime import scan: ${failures.length === 0 ? "PASS" : "FAIL"}`);
if (failures.length > 0) console.log(failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
