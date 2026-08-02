#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = resolve(root, "tools");
const validators = (await readdir(toolsDir))
  .filter((name) => /^validate-.*\.mjs$/.test(name) && name !== "validate-all.mjs")
  .sort();

function run(file) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [resolve(toolsDir, file)], { cwd: root, stdio: "inherit" });
    child.once("exit", (code) => resolveRun({ file, code: code ?? 1 }));
  });
}

const results = [];
for (const validator of validators) results.push(await run(validator));
const failed = results.filter((result) => result.code !== 0);
console.log(`\nAll validators: ${failed.length === 0 ? "PASS" : "FAIL"} (${results.length - failed.length}/${results.length})`);
if (failed.length > 0) console.log(`Failed: ${failed.map((result) => result.file).join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
