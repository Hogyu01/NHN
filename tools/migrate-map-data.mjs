#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANONICAL_MAP_MANIFEST_ID,
  CANONICAL_MAP_TILE_IDS,
  CANONICAL_PROTOTYPE_MAP_ID,
  MAP_MANIFEST_SCHEMA_VERSION,
} from "../js/world/map-manifest.js";
import { BASE_MAP_ID, MAP_ROLE, MAP_SCHEMA_VERSION } from "../js/world/map-schema.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [BASE_FLOOR_TILE_ID, PROTOTYPE_FLOOR_TILE_ID] = CANONICAL_MAP_TILE_IDS;

function point(pointId, tileX, tileY, offsetX = 16, offsetY = 16) {
  return { pointId, tileX, tileY, offsetX, offsetY };
}

function layers(width, height, floorTileId) {
  const area = width * height;
  const collision = Array(area).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        collision[y * width + x] = 1;
      }
    }
  }
  return {
    ground: Array(area).fill(floorTileId),
    collision,
    below: Array(area).fill(null),
    above: Array(area).fill(null),
  };
}

export function createBaseRestaurantMap() {
  const width = 30;
  const height = 20;
  const objects = [];
  const zones = [];
  const approachPoints = [];
  const seatPoints = [];
  const tableServiceTargets = [];

  for (const [semantic, tileX, tileY, kind] of [
    ["board", 2, 2, "BOARD"],
    ["stove", 5, 2, "STOVE"],
    ["counter", 8, 2, "COUNTER"],
    ["storage", 11, 2, "STORAGE"],
  ]) {
    const approachId = `approach.zone.${semantic}`;
    objects.push({
      objectId: `fixture.${semantic}`,
      kind,
      rect: { x: tileX * 32, y: tileY * 32, width: 32, height: 32 },
      blocksMovement: true,
    });
    approachPoints.push(point(approachId, tileX, tileY + 1));
    zones.push({
      zoneId: `zone.${semantic}`,
      semantic,
      rect: { x: tileX * 32, y: tileY * 32, width: 32, height: 32 },
      approachTileIds: [approachId],
    });
  }

  const tableTiles = [
    [15, 6], [20, 6], [25, 6],
    [15, 11], [20, 11], [25, 11],
  ];
  tableTiles.forEach(([tileX, tileY], index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const tableId = `table.${ordinal}`;
    const approachId = `approach.table.${ordinal}`;
    objects.push({
      objectId: tableId,
      kind: "TABLE",
      rect: { x: tileX * 32, y: tileY * 32, width: 32, height: 32 },
      blocksMovement: true,
    });
    approachPoints.push(point(approachId, tileX, tileY + 1));
    tableServiceTargets.push({
      targetId: `service-target.${ordinal}`,
      tableId,
      tileX,
      tileY,
      offsetX: 16,
      offsetY: 16,
      proximityRadius: 48,
      approachTileIds: [approachId],
    });
    for (const [suffix, seatX, facing] of [
      ["a", tileX - 1, "RIGHT"],
      ["b", tileX + 1, "LEFT"],
    ]) {
      seatPoints.push({
        ...point(`point.seat.${ordinal}.${suffix}`, seatX, tileY),
        seatId: `seat.${ordinal}.${suffix}`,
        tableId,
        activeByDefault: true,
        facing,
      });
    }
  });

  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    mapId: BASE_MAP_ID,
    width,
    height,
    tileSize: 32,
    layers: layers(width, height, BASE_FLOOR_TILE_ID),
    objects,
    zones,
    navigation: {
      playerStart: point("point.player-start", 3, 15, 16, 24),
      spawnPoint: point("point.spawn", 2, 18),
      exitPoint: point("point.exit", 4, 18),
      approachPoints,
      seatPoints,
      tableServiceTargets,
      transitions: [],
    },
    expansionRegions: [{
      regionId: "region.expansion.closed",
      rect: { x: 26 * 32, y: 14 * 32, width: 3 * 32, height: 5 * 32 },
      openByDefault: false,
      collisionWhenClosed: true,
      seatIds: [],
    }],
  };
}

export function createPrototypeMapFixture() {
  const width = 15;
  const height = 15;
  const fixtures = [
    {
      semantic: "board",
      kind: "BOARD",
      rect: { x: 20, y: 20, width: 100, height: 80 },
      approach: point("approach.prototype.board", 3, 3),
    },
    {
      semantic: "stove",
      kind: "STOVE",
      rect: { x: 360, y: 20, width: 100, height: 80 },
      approach: point("approach.prototype.stove", 12, 3),
    },
    {
      semantic: "counter",
      kind: "COUNTER",
      rect: { x: 190, y: 380, width: 100, height: 80 },
      approach: point("approach.prototype.counter", 7, 11),
    },
  ];
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    mapId: CANONICAL_PROTOTYPE_MAP_ID,
    width,
    height,
    tileSize: 32,
    layers: layers(width, height, PROTOTYPE_FLOOR_TILE_ID),
    objects: fixtures.map((fixture) => ({
      objectId: `fixture.prototype.${fixture.semantic}`,
      kind: fixture.kind,
      rect: fixture.rect,
      blocksMovement: true,
    })),
    zones: fixtures.map((fixture) => ({
      zoneId: `zone.prototype.${fixture.semantic}`,
      semantic: fixture.semantic,
      rect: fixture.rect,
      approachTileIds: [fixture.approach.pointId],
    })),
    navigation: {
      playerStart: point("point.prototype.player-start", 7, 7, 16, 24),
      spawnPoint: point("point.prototype.spawn", 1, 13),
      exitPoint: point("point.prototype.exit", 2, 13),
      approachPoints: fixtures.map((fixture) => fixture.approach),
      seatPoints: [],
      tableServiceTargets: [],
      transitions: [],
    },
    expansionRegions: [],
  };
}

export function createCanonicalMapManifest() {
  return {
    schemaVersion: MAP_MANIFEST_SCHEMA_VERSION,
    manifestId: CANONICAL_MAP_MANIFEST_ID,
    activeMapId: BASE_MAP_ID,
    maps: [
      {
        mapId: BASE_MAP_ID,
        filename: "data/maps/base-restaurant.json",
        role: MAP_ROLE.BASE,
      },
      {
        mapId: CANONICAL_PROTOTYPE_MAP_ID,
        filename: "data/maps/prototype-fixture.json",
        role: MAP_ROLE.PROTOTYPE,
      },
    ],
  };
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createCanonicalMapFiles() {
  return Object.freeze([
    Object.freeze({ filename: "data/maps/base-restaurant.json", data: createBaseRestaurantMap() }),
    Object.freeze({ filename: "data/maps/prototype-fixture.json", data: createPrototypeMapFixture() }),
    Object.freeze({ filename: "data/maps/map-manifest.json", data: createCanonicalMapManifest() }),
  ]);
}

export async function migrateMapData({ write = false, root = repositoryRoot } = {}) {
  const files = [];
  for (const entry of createCanonicalMapFiles()) {
    const absolutePath = resolve(root, entry.filename);
    const expected = canonicalJson(entry.data);
    if (write) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, expected, "utf8");
      files.push(Object.freeze({ filename: entry.filename, status: "WRITTEN", bytes: Buffer.byteLength(expected) }));
      continue;
    }
    let actual = null;
    try {
      actual = await readFile(absolutePath, "utf8");
    } catch {
      // A missing file is reported as a deterministic mismatch below.
    }
    files.push(Object.freeze({
      filename: entry.filename,
      status: actual === expected ? "MATCH" : "MISMATCH",
      bytes: Buffer.byteLength(expected),
    }));
  }
  const status = files.every((entry) => entry.status === "MATCH" || entry.status === "WRITTEN") ? "PASS" : "FAIL";
  return Object.freeze({ status, mode: write ? "WRITE" : "CHECK", files: Object.freeze(files) });
}

async function main() {
  const supported = new Set(["--write", "--json"]);
  const unknown = process.argv.slice(2).filter((argument) => !supported.has(argument));
  if (unknown.length > 0) {
    console.error(`지원하지 않는 인자입니다: ${unknown.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const report = await migrateMapData({ write: process.argv.includes("--write") });
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Map data migration: ${report.status} (${report.mode})`);
    for (const file of report.files) console.log(`${file.status}  ${file.filename} (${file.bytes} bytes)`);
  }
  if (report.status !== "PASS") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
