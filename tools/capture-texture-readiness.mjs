#!/usr/bin/env node
/**
 * Task 44 texture-ready evidence capture. Boots the real production app in headless Chrome via the
 * `pixi-renderer` QA route (js/qa/pixi-renderer-browser-probe.js), reads which publicPath entries
 * actually became loaded Pixi textures (`document.body.dataset.pixiRendererReadyPaths`), maps them
 * back to asset IDs via the manifest, and writes reports/texture-readiness.json for
 * tools/release-gate.mjs to consume as `readyAssetIds`. Mirrors tools/browser-smoke.mjs's raw CDP
 * connection so no new project dependency is introduced.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_ASSET_IDS as PIXI_REQUIRED_ASSET_IDS } from "../js/render/pixi-world-renderer.js";
import { canonicalJson } from "./asset-gen/canonical-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = Number(argument("--port", "9333"));
const baseUrl = argument("--base-url", "http://127.0.0.1:8765/");
const timeoutMs = Number(argument("--timeout-ms", "15000"));

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function findPageTarget() {
  const endpoint = `http://127.0.0.1:${port}/json`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(endpoint)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      // Chrome may still be opening its DevTools endpoint.
    }
    await sleep(100);
  }
  throw new Error(`DevTools page target을 ${timeoutMs}ms 안에 찾지 못했습니다: ${endpoint}`);
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("open", () => {
      let nextId = 1;
      const pending = new Map();
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;
        const operation = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) operation.reject(new Error(message.error.message));
        else operation.resolve(message.result);
      });
      resolveConnect({
        socket,
        call(method, params = {}) {
          return new Promise((operationResolve, operationReject) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, { resolve: operationResolve, reject: operationReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
      });
    }, { once: true });
  });
}

async function evaluate(call, expression) {
  const response = await call("Runtime.evaluate", { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Browser evaluation failed");
  return response.result.value;
}

const manifest = JSON.parse(await readFile(resolve(root, "assets/asset-manifest.json"), "utf8"));
const publicPathToAssetId = new Map(manifest.assets.map((asset) => [asset.publicPath, asset.assetId]));
// PixiJS World canvas가 실제로 로드하는 asset만 텍스처 준비 대상이다. 시장/메뉴 패널의 HTML
// <img> 전용 asset(ingredient 아이콘 등)은 Pixi를 거치지 않으므로 이 범위 밖이다.
const requiredAssetIds = new Set(PIXI_REQUIRED_ASSET_IDS);

const target = await findPageTarget();
const connection = await connect(target.webSocketDebuggerUrl);
try {
  const url = new URL(baseUrl);
  url.searchParams.set("qa", "pixi-renderer");
  await connection.call("Page.navigate", { url: url.href });

  const deadline = Date.now() + timeoutMs;
  let marker = null;
  while (Date.now() < deadline) {
    try {
      marker = await evaluate(connection.call, "document.body?.dataset?.pixiRendererQa ?? null");
      if (marker) break;
    } catch {
      // Navigation can briefly destroy the execution context.
    }
    await sleep(100);
  }
  if (marker !== "pass") throw new Error(`pixi-renderer QA route가 pass가 아닙니다: ${marker}`);

  const readyPathsJson = await evaluate(connection.call, "document.body?.dataset?.pixiRendererReadyPaths ?? '[]'");
  const readyPaths = JSON.parse(readyPathsJson);
  const readyAssetIds = readyPaths
    .map((path) => publicPathToAssetId.get(path))
    .filter((assetId) => typeof assetId === "string");
  const missingRequired = [...requiredAssetIds].filter((assetId) => !readyAssetIds.includes(assetId));

  const report = {
    schemaVersion: 1,
    buildId: manifest.buildId,
    capturedVia: "pixi-renderer QA route, headless Chrome CDP",
    readyAssetIds: readyAssetIds.sort(),
    missingRequiredAssetIds: missingRequired.sort(),
  };
  await writeFile(resolve(root, "reports/texture-readiness.json"), canonicalJson(report));
  console.log(`texture-readiness.json written: ${readyAssetIds.length}/${requiredAssetIds.size} required assets confirmed texture-ready.`);
  if (missingRequired.length > 0) {
    console.log(`MISSING: ${missingRequired.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  connection.socket.close();
}
