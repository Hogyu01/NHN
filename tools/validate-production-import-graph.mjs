#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 35 — "public import graph의 raw Canvas/L0 0" 회귀 감시. `js/main.js`에서 시작해
 * *static* `import ... from "..."` edge만 따라가고(동적 `import()`는 QA 전용 경로이므로 의도적으로
 * 무시한다) `js/ui/canvas-scene.js`(raw Canvas2D/L0)에 도달하는지 검사한다. 도달하면 production
 * bootstrap이 다시 raw Canvas/L0을 끌고 들어온 것이므로 FAIL한다.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(REPO_ROOT, "js/main.js");
const FORBIDDEN = resolve(REPO_ROOT, "js/ui/canvas-scene.js");

const STATIC_IMPORT_RE = /\bimport\s+(?:[\s\S]*?\bfrom\s+)?["']([^"']+)["']/g;

function extractStaticImportSpecifiers(source) {
  const specifiers = [];
  let match;
  while ((match = STATIC_IMPORT_RE.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null; // bare/npm specifier: 이 저장소에는 없지만 방어적으로 무시한다.
  return resolve(dirname(fromFile), specifier);
}

function walk(entry) {
  const visited = new Set();
  const path = new Map(); // file -> parent (경로 재구성용)
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    let source;
    try {
      source = readFileSync(current, "utf8");
    } catch (error) {
      throw new Error(`import graph 추적 중 파일을 읽을 수 없습니다: ${current} (${error.message})`);
    }
    if (current === FORBIDDEN) {
      const chain = [current];
      let cursor = current;
      while (path.has(cursor)) {
        cursor = path.get(cursor);
        chain.unshift(cursor);
      }
      return { hit: true, chain, visitedCount: visited.size };
    }
    for (const specifier of extractStaticImportSpecifiers(source)) {
      const resolved = resolveSpecifier(current, specifier);
      if (!resolved || visited.has(resolved)) continue;
      if (!path.has(resolved)) path.set(resolved, current);
      queue.push(resolved);
    }
  }
  return { hit: false, chain: [], visitedCount: visited.size };
}

function main() {
  const result = walk(ENTRY);
  const rel = (absolute) => absolute.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
  if (result.hit) {
    console.log("Production import graph validation: FAIL");
    console.log(`raw Canvas/L0(${rel(FORBIDDEN)})이 production 진입점에서 static import로 도달 가능합니다:`);
    console.log(result.chain.map(rel).join("\n  -> "));
    process.exit(1);
  }
  console.log(`Production import graph validation: PASS (${result.visitedCount}개 module 방문, raw Canvas/L0 도달 0)`);
  process.exit(0);
}

main();
