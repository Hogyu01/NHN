import { freezeDeep } from "../core/result.js";
import {
  resolveDirectionRow,
  resolveSpriteFrameRect,
  resolveWalkColumnNoIdle,
  resolveWalkColumnWithIdle,
  WALK_FRAME_CADENCE_MS,
} from "../render/sprite-animator.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id, description, validates, status: "FAIL", error: error instanceof Error ? error.message : String(error),
    });
  }
}

const PLAYER_ROWS = ["UP", "LEFT", "DOWN", "RIGHT"];
const GUEST_ROWS = ["DOWN", "LEFT", "RIGHT", "UP"];

export async function runSpriteAnimatorProbe() {
  const results = [];

  results.push(await runCase(
    "direction-row-resolves-per-sheet-order",
    "같은 방향이라도 시트별 행 순서(주인장 UP/LEFT/DOWN/RIGHT, 손님 DOWN/LEFT/RIGHT/UP)에 맞는 다른 row를 돌려준다",
    "design 4.4, 10.2",
    () => {
      assert(resolveDirectionRow(PLAYER_ROWS, "down") === 2, "player down row가 다릅니다.");
      assert(resolveDirectionRow(GUEST_ROWS, "down") === 0, "guest down row가 다릅니다.");
      assert(resolveDirectionRow(PLAYER_ROWS, "unknown") === 0, "알 수 없는 방향은 0으로 방어해야 합니다.");
      return { playerDown: 2, guestDown: 0 };
    },
  ));

  results.push(await runCase(
    "idle-sheet-uses-idle-column-when-not-moving",
    "9열 idle+8프레임 시트는 moving=false면 항상 idleColumn을 돌려준다",
    "design 10.2, canvas-scene.js PLAYER_SPRITE_CONTRACT",
    () => {
      const column = resolveWalkColumnWithIdle({ moving: false, animationElapsedMs: 999, idleColumn: 0 });
      assert(column === 0, `idle column이 아닙니다: ${column}`);
      return { column };
    },
  ));

  results.push(await runCase(
    "idle-sheet-cycles-8-walk-columns-at-120ms",
    "moving=true면 120ms마다 walk 8프레임(1..8)을 순환한다",
    "design 10.2",
    () => {
      const samples = [0, 119, 120, 240, 960, 961].map((ms) =>
        resolveWalkColumnWithIdle({ moving: true, animationElapsedMs: ms, idleColumn: 0, walkColumnCount: 8 }));
      assert(samples[0] === 1, `0ms는 walk frame 1이어야 합니다: ${samples[0]}`);
      assert(samples[1] === 1, `119ms는 아직 frame 1이어야 합니다: ${samples[1]}`);
      assert(samples[2] === 2, `120ms 정각에는 frame 2여야 합니다: ${samples[2]}`);
      assert(samples[3] === 3, `240ms는 frame 3이어야 합니다: ${samples[3]}`);
      assert(samples[4] === 1, `960ms(8프레임 정확히 순환)는 다시 frame 1이어야 합니다: ${samples[4]}`);
      return { samples };
    },
  ));

  results.push(await runCase(
    "no-idle-sheet-reuses-frame-0-when-not-moving",
    "4열(걷기만) 시트는 idle 프레임이 없어 moving=false일 때 frame 0을 재사용한다",
    "design 10.2, guests_v2 4-frame walk sheet",
    () => {
      const column = resolveWalkColumnNoIdle({ moving: false, animationElapsedMs: 500 });
      assert(column === 0, `idle 대체 frame이 0이 아닙니다: ${column}`);
      return { column };
    },
  ));

  results.push(await runCase(
    "no-idle-sheet-cycles-4-columns-at-120ms",
    "손님 4프레임 시트는 120ms마다 0..3을 순환한다",
    "design 10.2",
    () => {
      const samples = [0, 120, 240, 360, 480].map((ms) => resolveWalkColumnNoIdle({ moving: true, animationElapsedMs: ms }));
      assert(JSON.stringify(samples) === JSON.stringify([0, 1, 2, 3, 0]), `4프레임 순환이 다릅니다: ${samples}`);
      return { samples };
    },
  ));

  results.push(await runCase(
    "frame-rect-matches-player-sprite-contract-geometry",
    "resolveSpriteFrameRect가 canvas-scene.js의 PLAYER_SPRITE_CONTRACT(64x64, 9x4)와 같은 위치를 계산한다",
    "design 10.5, canvas-scene.js",
    () => {
      const sheet = { frameWidth: 64, frameHeight: 64, directionRowOrder: PLAYER_ROWS, hasIdleColumn: true, idleColumn: 0, walkColumnCount: 8 };
      const idleRect = resolveSpriteFrameRect(sheet, { direction: "down", moving: false, animationElapsedMs: 0 });
      assert(idleRect.x === 0 && idleRect.y === 128, `idle rect가 다릅니다: ${JSON.stringify(idleRect)}`);
      const walkRect = resolveSpriteFrameRect(sheet, { direction: "right", moving: true, animationElapsedMs: 130 });
      assert(walkRect.x === 128 && walkRect.y === 192, `walk rect가 다릅니다: ${JSON.stringify(walkRect)}`);
      return { idleRect, walkRect };
    },
  ));

  results.push(await runCase(
    "frame-rect-matches-guest-sheet-geometry",
    "resolveSpriteFrameRect가 guests_v2(314x314, 4x4, DOWN/LEFT/RIGHT/UP)와 맞는 위치를 계산한다",
    "design 10.2, guests_v2 guest-sprites-v2.json",
    () => {
      const sheet = { frameWidth: 314, frameHeight: 314, directionRowOrder: GUEST_ROWS, hasIdleColumn: false, walkColumnCount: 4 };
      const rect = resolveSpriteFrameRect(sheet, { direction: "up", moving: true, animationElapsedMs: 250 });
      assert(rect.y === 314 * 3, `up row가 다릅니다: ${JSON.stringify(rect)}`);
      assert(rect.x === 314 * 2, `250ms/120ms=2 프레임이어야 합니다: ${JSON.stringify(rect)}`);
      return { rect };
    },
  ));

  results.push(await runCase(
    "cadence-constant-is-120ms",
    "walk frame cadence 상수가 design 10.2가 요구하는 120ms와 정확히 일치한다",
    "design 10.2",
    () => {
      assert(WALK_FRAME_CADENCE_MS === 120, `cadence가 120ms가 아닙니다: ${WALK_FRAME_CADENCE_MS}`);
      return { cadence: WALK_FRAME_CADENCE_MS };
    },
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}
