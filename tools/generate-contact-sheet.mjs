#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./asset-gen/canonical-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "assets/asset-manifest.json"), "utf8"));
const rows = manifest.assets.map((asset) => `<figure><img src="../../${asset.publicPath}" alt="${asset.assetId}"><figcaption>${asset.assetId}<br>${asset.width}x${asset.height}</figcaption></figure>`).join("\n");
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Asset contact sheet</title><style>body{margin:24px;background:#18131d;color:#f5e8d0;font:14px system-ui}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}figure{margin:0;padding:10px;border:1px solid #795d45;background:#241d29}img{display:block;width:100%;height:150px;object-fit:contain;image-rendering:pixelated;background:#0d0b0f}figcaption{margin-top:8px;overflow-wrap:anywhere}</style><main>${rows}</main></html>\n`;
await mkdir(resolve(root, "reports/evidence"), { recursive: true });
await writeFile(resolve(root, "reports/evidence/visual-contact-sheet.html"), html);
await writeFile(resolve(root, "reports/evidence/visual-review.json"), canonicalJson({ schemaVersion: 1, buildId: manifest.buildId, status: "NOT_RUN", reviewer: null, criteria: ["dimensions", "frame", "foot-anchor", "dish-anchor", "clipping", "jitter", "silhouette", "grayscale", "contrast", "seat-zones", "originality"], assets: manifest.assets.map((asset) => ({ assetId: asset.assetId, outputHash: asset.outputHash, outcome: "NOT_RUN" })) }));
console.log(`Contact sheet generated for ${manifest.assets.length} assets; review remains NOT_RUN.`);
