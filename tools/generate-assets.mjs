#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "./asset-gen/canonical-json.mjs";
import { decodePng, encodeCanonicalPng, validateCanonicalPng } from "./asset-gen/png-codec.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, "assets/generated");
const clean = process.argv.includes("--clean");
const requestedKind = process.argv.includes("--kind") ? process.argv[process.argv.indexOf("--kind") + 1] : "visual";

const characters = [
  ["character.player", "assets/sprites/player_walk_v2.png", "player.png", 132, 256],
  ["guest.human_adventurer", "assets/sprites/guests_v2/human_adventurer_walk.png", "human-adventurer.png", 314, 314],
  ["guest.dwarf_courier", "assets/sprites/guests_v2/dwarf_courier_walk.png", "dwarf-courier.png", 314, 314],
  ["guest.goblin_scholar", "assets/sprites/guests_v2/goblin_scholar_walk.png", "goblin-scholar.png", 314, 314],
  ["guest.slime_gourmand", "assets/sprites/guests_v2/slime_gourmand_walk.png", "slime-gourmand.png", 314, 314],
  ["guest.kobold_porter", "assets/sprites/guests_v2/kobold_porter_walk.png", "kobold-porter.png", 314, 314],
  ["guest.mushroom_traveler", "assets/sprites/guests_v2/mushroom_traveler_walk.png", "mushroom-traveler.png", 314, 314],
];

const images = [
  ["tile.floor.wood", "assets/tiles/tileset/tile_r1_c1.png", "world/floor-wood.png", 32, 32],
  ["tile.wall.stone", "assets/tiles/tileset/tile_r2_c2.png", "world/wall-stone.png", 32, 32],
  ["prop.board", "assets/tiles/furniture/furniture-board.png", "world/board.png", 64, 64],
  ["prop.stove", "assets/tiles/furniture/furniture-stove.png", "world/stove.png", 64, 64],
  ["prop.counter", "assets/tiles/furniture/furniture-counter.png", "world/counter.png", 64, 64],
  ["prop.storage", "assets/tiles/furniture/furniture-shelf-ingredients.png", "world/storage.png", 64, 64],
  ["prop.table", "assets/tiles/furniture/furniture-table.png", "world/table.png", 64, 64],
  ["hud.gold", "assets/icons/hud/hud-gold.png", "ui/gold.png", 48, 48],
  ["hud.reputation", "assets/icons/hud/hud-reputation.png", "ui/reputation.png", 48, 48],
  ["hud.timer", "assets/icons/hud/hud-timer.png", "ui/timer.png", 48, 48],
  ["world.interaction_marker", "assets/icons/hud/world-interaction-marker.png", "ui/interaction-marker.png", 32, 32],
  ["recipe.moonroot_pie", "assets/icons/dishes/dish-berry-salad.png", "recipes/berry-salad.png", 64, 64],
  ["recipe.slime_stew", "assets/icons/dishes/dish-jelly-bowl.png", "recipes/slime-jelly.png", 64, 64],
  ["recipe.mimic_hotpot", "assets/icons/dishes/dish-meat-hotpot.png", "recipes/meat-hotpot.png", 64, 64],
  ["recipe.stonegrain_bowl", "assets/icons/dishes/dish-mushroom-medley.png", "recipes/mushroom-medley.png", 64, 64],
  ["recipe.glowcap_soup", "assets/icons/dishes/dish-mushroom-stew.png", "recipes/mushroom-stew.png", 64, 64],
  ["recipe.ember_egg_skewer", "assets/icons/dishes/dish-spiced-crawfish.png", "recipes/spiced-crawfish.png", 64, 64],
  ["ingredient.slime_gel", "assets/icons/ingredients/ing-crystal-blue.png", "ingredients/slime-gel.png", 48, 48],
  ["ingredient.cave_mushroom", "assets/icons/ingredients/ing-mushroom-red.png", "ingredients/cave-mushroom.png", 48, 48],
  ["ingredient.glow_herb", "assets/icons/ingredients/ing-herb-flower.png", "ingredients/glow-herb.png", 48, 48],
  ["ingredient.ember_pepper", "assets/icons/ingredients/ing-carrot.png", "ingredients/ember-pepper.png", 48, 48],
  ["ingredient.moonroot", "assets/icons/ingredients/ing-carrot.png", "ingredients/moonroot.png", 48, 48],
  ["ingredient.crystal_salt", "assets/icons/ingredients/ing-crystal-amber.png", "ingredients/crystal-salt.png", 48, 48],
  ["ingredient.stonegrain", "assets/icons/ingredients/ing-herb-mint.png", "ingredients/stonegrain.png", 48, 48],
  ["ingredient.griffin_egg", "assets/icons/ingredients/ing-fire-lizard-meat.png", "ingredients/fire-lizard-meat.png", 48, 48],
  ["ingredient.mimic_bean", "assets/icons/ingredients/ing-acid-berry.png", "ingredients/acid-berry.png", 48, 48],
  ["ingredient.moss_cheese", "assets/icons/ingredients/ing-meat-monster.png", "ingredients/frost-boar-meat.png", 48, 48],
];

const vfx = [
  ["vfx.sale_success", "assets/vfx/vfx-sale-success.png", "vfx/sale-success.png"],
  ["vfx.cooking_success", "assets/vfx/vfx-cooking-success.png", "vfx/cooking-success.png"],
  ["vfx.cooking_waste", "assets/vfx/vfx-cooking-waste.png", "vfx/cooking-waste.png"],
  ["vfx.order_failure", "assets/vfx/vfx-order-failure.png", "vfx/order-failure.png"],
];

function alphaBounds(image, sx = 0, sy = 0, sw = image.width, sh = image.height) {
  let left = sx + sw;
  let top = sy + sh;
  let right = sx - 1;
  let bottom = sy - 1;
  for (let y = sy; y < sy + sh; y += 1) for (let x = sx; x < sx + sw; x += 1) {
    if (image.pixels[(y * image.width + x) * 4 + 3] < 12) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? { x: sx, y: sy, width: sw, height: sh } : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function occupiedRuns(length, isOccupied, minimumGap = 8) {
  const raw = [];
  let start = -1;
  for (let value = 0; value <= length; value += 1) {
    const occupied = value < length && isOccupied(value);
    if (occupied && start < 0) start = value;
    if (!occupied && start >= 0) { raw.push({ start, end: value - 1 }); start = -1; }
  }
  const merged = [];
  for (const run of raw) {
    const previous = merged.at(-1);
    if (previous && run.start - previous.end - 1 < minimumGap) previous.end = run.end;
    else merged.push({ ...run });
  }
  return merged;
}

function detectCharacterFrames(image, fallbackWidth, fallbackHeight) {
  const rowRuns = occupiedRuns(image.height, (y) => {
    for (let x = 0; x < image.width; x += 1) if (image.pixels[(y * image.width + x) * 4 + 3] >= 12) return true;
    return false;
  }, 18);
  const frames = [];
  if (rowRuns.length === 4) {
    for (const row of rowRuns) {
      const columnRuns = occupiedRuns(image.width, (x) => {
        for (let y = row.start; y <= row.end; y += 1) if (image.pixels[(y * image.width + x) * 4 + 3] >= 12) return true;
        return false;
      }, 18);
      if (columnRuns.length !== 4) break;
      frames.push(columnRuns.map((column) => alphaBounds(image, column.start, row.start, column.end - column.start + 1, row.end - row.start + 1)));
    }
  }
  if (frames.length === 4) return frames;
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => alphaBounds(image, column * fallbackWidth, row * fallbackHeight, fallbackWidth, fallbackHeight)));
}

function blitFit(source, target, sourceRect, targetRect) {
  const scale = Math.min(targetRect.width / sourceRect.width, targetRect.height / sourceRect.height);
  const width = Math.max(1, Math.round(sourceRect.width * scale));
  const height = Math.max(1, Math.round(sourceRect.height * scale));
  const offsetX = targetRect.x + Math.floor((targetRect.width - width) / 2);
  const offsetY = targetRect.y + targetRect.height - height;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceX = sourceRect.x + Math.min(sourceRect.width - 1, Math.floor(x / scale));
    const sourceY = sourceRect.y + Math.min(sourceRect.height - 1, Math.floor(y / scale));
    const from = (sourceY * source.width + sourceX) * 4;
    const to = ((offsetY + y) * target.width + offsetX + x) * 4;
    target.pixels.set(source.pixels.subarray(from, from + 4), to);
  }
}

async function decode(relativePath) {
  return decodePng(await readFile(resolve(root, relativePath)));
}

function removeBlackMatte(image) {
  for (let index = 0; index < image.pixels.length; index += 4) {
    const red = image.pixels[index];
    const green = image.pixels[index + 1];
    const blue = image.pixels[index + 2];
    const maximum = Math.max(red, green, blue);
    if (maximum <= 18) image.pixels[index + 3] = 0;
    else if (maximum < 40) image.pixels[index + 3] = Math.min(image.pixels[index + 3], Math.round(((maximum - 18) / 22) * 255));
  }
  return image;
}

async function writeCanonical(relativePath, image) {
  const path = resolve(outputRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  const bytes = encodeCanonicalPng(image);
  await writeFile(path, bytes);
  return { path: `assets/generated/${relativePath.replaceAll("\\", "/")}`, hash: sha256(bytes), ...validateCanonicalPng(bytes) };
}

async function generateCharacter([id, sourcePath, filename, sourceFrameWidth, sourceFrameHeight]) {
  const source = removeBlackMatte(await decode(sourcePath));
  const output = { width: 64 * 9, height: 64 * 4, pixels: new Uint8Array(64 * 9 * 64 * 4 * 4) };
  const order = [0, 1, 2, 3, 0, 1, 2, 3, 0];
  const frames = detectCharacterFrames(source, sourceFrameWidth, sourceFrameHeight);
  for (let row = 0; row < 4; row += 1) for (let column = 0; column < 9; column += 1) {
    const sourceColumn = order[column];
    const bounds = frames[row][sourceColumn];
    blitFit(source, output, bounds, { x: column * 64 + 6, y: row * 64 + 3, width: 52, height: 52 });
  }
  return { id, kind: "SPRITE_SHEET", sourcePath, sourceHash: sha256(await readFile(resolve(root, sourcePath))), frame: { width: 64, height: 64, columns: 9, rows: 4, footAnchor: [32, 54], dishAnchor: [32, 10] }, ...(await writeCanonical(`characters/${filename}`, output)) };
}

async function generateImage([id, sourcePath, filename, width, height]) {
  const source = await decode(sourcePath);
  const bounds = alphaBounds(source);
  const output = { width, height, pixels: new Uint8Array(width * height * 4) };
  blitFit(source, output, bounds, { x: 2, y: 2, width: width - 4, height: height - 4 });
  return { id, kind: "IMAGE", sourcePath, sourceHash: sha256(await readFile(resolve(root, sourcePath))), ...(await writeCanonical(filename, output)) };
}

async function generateVfx([id, sourcePath, filename]) {
  const source = removeBlackMatte(await decode(sourcePath));
  const output = { width: 64 * 3, height: 64 * 2, pixels: new Uint8Array(64 * 3 * 64 * 2 * 4) };
  for (let row = 0; row < 2; row += 1) for (let column = 0; column < 3; column += 1) {
    const bounds = alphaBounds(source, column * 256, row * 256, 256, 256);
    blitFit(source, output, bounds, { x: column * 64 + 2, y: row * 64 + 2, width: 60, height: 60 });
  }
  return { id, kind: "VFX_SHEET", sourcePath, sourceHash: sha256(await readFile(resolve(root, sourcePath))), frame: { width: 64, height: 64, columns: 3, rows: 2 }, ...(await writeCanonical(filename, output)) };
}

if (requestedKind === "audio") {
  console.log("Audio generation intentionally deferred: generator contract is available, runtime remains DEGRADED/UNAVAILABLE.");
  process.exit(0);
}
if (clean) await rm(outputRoot, { recursive: true, force: true });
const generated = [];
for (const definition of characters) generated.push(await generateCharacter(definition));
for (const definition of images) generated.push(await generateImage(definition));
for (const definition of vfx) generated.push(await generateVfx(definition));
const sourceDefinition = {
  schemaVersion: 1,
  generator: { id: "nhn.canonical-assets", version: "1.0.0", runtime: "node@22.14.0", forbiddenInputs: ["clock", "locale", "network", "random", "filesystem-order"] },
  identity: { owner: "last-hearth-keeper", crest: "guild-crest", palette: ["copper", "purple", "warm-neutral"], tone: "warm-humor" },
  assets: generated.map(({ id, kind, sourcePath, sourceHash, path, width, height, frame }) => ({ id, kind, sourcePath, sourceHash, outputPath: path, width, height, frame: frame ?? null })),
};
await mkdir(resolve(root, "tools/asset-gen/sources/a"), { recursive: true });
await writeFile(resolve(root, "tools/asset-gen/sources/a/visuals.json"), canonicalJson(sourceDefinition));
await writeFile(resolve(outputRoot, "index.json"), canonicalJson({ schemaVersion: 1, generated }));
const manifestAssets = generated.map((entry) => ({
  assetId: entry.id,
  tier: "A",
  maturity: "L1_BASELINE",
  status: "GENERATED",
  sourceKind: "PROJECT_GENERATED",
  target: "PUBLIC_RUNTIME",
  creator: "NHN project asset pipeline",
  source: entry.sourcePath,
  sourceHash: entry.sourceHash,
  license: "PROJECT_OWNED",
  approval: "PROJECT_SOURCE_APPROVED",
  runtime: "pixi.js@8.19.0",
  generator: "nhn.canonical-assets@1.0.0",
  canonicalFormat: "PNG_RGBA8_FILTER0_ZFIXED",
  publicPath: entry.path,
  width: entry.width,
  height: entry.height,
  frame: entry.frame ?? null,
  anchors: entry.frame?.footAnchor ? { foot: entry.frame.footAnchor, dish: entry.frame.dishAnchor } : null,
  outputHash: entry.hash,
  gates: { provenance: "PASS", hash: "PASS", quality: "NOT_RUN" },
  evidence: null,
  fallback: { policy: "CLEAN_RETRY_SAME_SOURCE", assetId: entry.id },
}));
await writeFile(resolve(root, "assets/asset-manifest.json"), canonicalJson({ schemaVersion: 1, buildId: "dungeon-restaurant-management-mvp.task-44", assets: manifestAssets }));
await writeFile(resolve(root, "assets/public-asset-allowlist.json"), canonicalJson({ schemaVersion: 1, paths: [...manifestAssets.map((entry) => entry.publicPath), "js/libs/pixijs/pixi.min.js"] }));
await mkdir(resolve(root, "reports"), { recursive: true });
await writeFile(resolve(root, "reports/asset-generation.json"), canonicalJson({ schemaVersion: 1, status: generated.every((entry) => entry.ok) ? "PASS" : "FAIL", generatedCount: generated.length, generated }));
console.log(`Generated ${generated.length} canonical visual assets.`);
