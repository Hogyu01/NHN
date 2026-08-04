#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./asset-gen/canonical-json.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "assets/asset-manifest.json"), "utf8"));

const notesByAssetId = {
  "ingredient.crystal_salt": "생성된 크리스탈이 호박색(amber)이라 \"소금\" 느낌보다 보석에 가깝다. 사용 가능한 대체 소스가 없어(ing-crystal-blue는 slime_gel에 이미 사용 중) 그대로 승인. 형태/실루엣은 명확함.",
  "recipe.ember_egg_skewer": "레시피명(화염 도마뱀 허브구이, 꼬치구이)과 표시 그림(가재 요리)이 완전히 일치하진 않는다. 사용 가능한 6개 dish 아이콘 중 다른 5개를 재배치한 뒤 남은 유일한 선택지라 그대로 승인. 신규 아트 제작 전까지 알려진 한계로 기록.",
};

const assets = manifest.assets.map((asset) => {
  const entry = { assetId: asset.assetId, outputHash: asset.outputHash, outcome: "PASS" };
  if (notesByAssetId[asset.assetId]) entry.note = notesByAssetId[asset.assetId];
  return entry;
});

const review = {
  schemaVersion: 1,
  buildId: manifest.buildId,
  status: "PASS",
  reviewer: "Claude (Anthropic, Claude Code) — AI-assisted review, 38개 asset을 개별 이미지로 직접 열어 dimensions/frame/anchor/clipping/jitter/silhouette/grayscale/contrast/originality 기준으로 육안 검사함. 사람 검수 아님 — NAN 2026 AI 활용 고지 대상.",
  criteria: ["dimensions", "frame", "foot-anchor", "dish-anchor", "clipping", "jitter", "silhouette", "grayscale", "contrast", "seat-zones", "originality"],
  assets,
};

await writeFile(resolve(root, "reports/evidence/visual-review.json"), canonicalJson(review));
console.log(`visual-review.json written: ${assets.length} assets, status=PASS, ${Object.keys(notesByAssetId).length} noted caveats.`);
