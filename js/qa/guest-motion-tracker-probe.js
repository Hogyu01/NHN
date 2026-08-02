import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { freezeDeep } from "../core/result.js";
import { GuestMotionTracker } from "../render/guest-motion-tracker.js";
import { GUEST_STEP_MILLI_PX, SIMULATION_STEP_MS } from "../world/guest-flow.js";
import { createGuestPassabilityGrid } from "../world/passability-grid.js";

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

export async function runGuestMotionTrackerProbe({ map }) {
  const results = [];
  const grid = createGuestPassabilityGrid(map);
  const seatPoints = map.navigation.seatPoints;
  const spawnPoint = map.navigation.spawnPoint;
  const exitPoint = map.navigation.exitPoint;
  const firstSeat = [...seatPoints].sort((a, b) => (a.seatId < b.seatId ? -1 : 1))[0];

  results.push(await runCase(
    "no-motion-returns-null",
    "기록된 이동이 없는 guest는 positionAt이 null을 돌려준다(호출자가 고정 위치를 쓰게)",
    "design 10.2",
    () => {
      const tracker = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      const result = tracker.positionAt("no-such-guest", 1000);
      assert(result === null, "null이 아닙니다.");
      return { result };
    },
  ));

  results.push(await runCase(
    "start-and-end-match-spawn-and-seat",
    "이동 시작(0ms)은 spawnPoint, 완료(travelTimeMs)는 seat world point와 일치한다",
    "design 10.1, 10.2",
    () => {
      const tracker = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      const travelTimeMs = 2000;
      tracker.recordMovingToSeat({ guestId: "g1", seatId: firstSeat.seatId, startedAtMs: 1000, travelTimeMs });
      const atStart = tracker.positionAt("g1", 1000);
      const atEnd = tracker.positionAt("g1", 1000 + travelTimeMs);
      const spawnWorld = { x: spawnPoint.tileX * 32 + spawnPoint.offsetX, y: spawnPoint.tileY * 32 + spawnPoint.offsetY };
      const seatWorld = { x: firstSeat.tileX * 32 + firstSeat.offsetX, y: firstSeat.tileY * 32 + firstSeat.offsetY };
      assert(atStart.world.x === spawnWorld.x && atStart.world.y === spawnWorld.y, `시작 위치가 spawn과 다릅니다: ${JSON.stringify(atStart.world)}`);
      assert(atEnd.world.x === seatWorld.x && atEnd.world.y === seatWorld.y, `끝 위치가 seat와 다릅니다: ${JSON.stringify(atEnd.world)}`);
      assert(atStart.progress === 0, "시작 progress가 0이 아닙니다.");
      assert(atEnd.progress === 1, "끝 progress가 1이 아닙니다.");
      return { atStart: atStart.world, atEnd: atEnd.world };
    },
  ));

  results.push(await runCase(
    "position-is-monotonic-and-clamped-after-travel-time",
    "travelTimeMs 이후에도 계속 끝 위치에 고정되고(clamp), 이동 전(음수 elapsed)에도 시작 위치에 고정된다",
    "design 10.2",
    () => {
      const tracker = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      const travelTimeMs = 1000;
      tracker.recordMovingToSeat({ guestId: "g2", seatId: firstSeat.seatId, startedAtMs: 5000, travelTimeMs });
      const before = tracker.positionAt("g2", 4000);
      const after = tracker.positionAt("g2", 9000);
      const atEnd = tracker.positionAt("g2", 6000);
      assert(before.progress === 0, `이동 전 progress가 0이 아닙니다: ${before.progress}`);
      assert(after.progress === 1, `travelTimeMs 이후 progress가 1이 아닙니다: ${after.progress}`);
      assert(after.world.x === atEnd.world.x && after.world.y === atEnd.world.y, "clamp 뒤 위치가 끝 위치와 다릅니다.");
      return { before: before.world, after: after.world };
    },
  ));

  results.push(await runCase(
    "clear-removes-tracked-motion",
    "clear()를 호출하면 다시 null을 돌려준다(SEATED/EXITED 뒤 추적 중단)",
    "design 10.1",
    () => {
      const tracker = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      tracker.recordMovingToSeat({ guestId: "g3", seatId: firstSeat.seatId, startedAtMs: 0, travelTimeMs: 500 });
      assert(tracker.positionAt("g3", 100) !== null, "기록 직후에는 null이면 안 됩니다.");
      tracker.clear("g3");
      assert(tracker.positionAt("g3", 100) === null, "clear 뒤에도 계속 추적됩니다.");
      return { cleared: true };
    },
  ));

  results.push(await runCase(
    "exit-motion-ends-at-exit-point",
    "moving-to-exit 이동은 exitPoint에서 끝난다",
    "design 10.3",
    () => {
      const tracker = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      const travelTimeMs = 1500;
      tracker.recordMovingToExit({ guestId: "g4", seatId: firstSeat.seatId, startedAtMs: 0, travelTimeMs });
      const atEnd = tracker.positionAt("g4", travelTimeMs);
      const exitWorld = { x: exitPoint.tileX * 32 + exitPoint.offsetX, y: exitPoint.tileY * 32 + exitPoint.offsetY };
      assert(atEnd.world.x === exitWorld.x && atEnd.world.y === exitWorld.y, `exit 위치가 다릅니다: ${JSON.stringify(atEnd.world)}`);
      return { atEnd: atEnd.world };
    },
  ));

  results.push(await runCase(
    "fixed-step-quantization-and-exact-speed",
    "20ms 경계에서만 이동하고 각 full step은 정확히 1,920 milli-pixel 전진한다",
    "Task 30, design 10.2",
    () => {
      const tracker = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      tracker.recordMovingToSeat({ guestId: "g-step", seatId: firstSeat.seatId, startedAtMs: 0, travelTimeMs: 4000 });
      const at0 = tracker.positionAt("g-step", 0);
      const at19 = tracker.positionAt("g-step", SIMULATION_STEP_MS - 1);
      const at20 = tracker.positionAt("g-step", SIMULATION_STEP_MS);
      const at39 = tracker.positionAt("g-step", SIMULATION_STEP_MS * 2 - 1);
      const distance = Math.abs(at20.worldMilli.x - at0.worldMilli.x) +
        Math.abs(at20.worldMilli.y - at0.worldMilli.y);
      assert(JSON.stringify(at0) === JSON.stringify(at19), "20ms 전 위치가 바뀌었습니다.");
      assert(JSON.stringify(at20) === JSON.stringify(at39), "다음 20ms 경계 전에 위치가 바뀌었습니다.");
      assert(distance === GUEST_STEP_MILLI_PX, `한 step 이동량이 다릅니다: ${distance}`);
      assert(Number.isInteger(at20.world.x) && Number.isInteger(at20.world.y), "표시 좌표가 정수가 아닙니다.");
      return { distanceMilliPx: distance, world: at20.world, pathIndex: at20.pathIndex };
    },
  ));

  results.push(await runCase(
    "tick-partition-independent",
    "같은 simulationTimeMs의 위치는 중간 조회를 몇 번 했는지와 무관하다",
    "Task 30 deterministic tick partition",
    () => {
      const direct = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      const partitioned = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      direct.recordMovingToSeat({ guestId: "g-partition", seatId: firstSeat.seatId, startedAtMs: 0, travelTimeMs: 4000 });
      partitioned.recordMovingToSeat({ guestId: "g-partition", seatId: firstSeat.seatId, startedAtMs: 0, travelTimeMs: 4000 });
      for (const time of [20, 40, 60, 80]) partitioned.positionAt("g-partition", time);
      const oneJump = direct.positionAt("g-partition", 100);
      const manySteps = partitioned.positionAt("g-partition", 100);
      assert(JSON.stringify(oneJump) === JSON.stringify(manySteps), "tick partition에 따라 위치가 달라졌습니다.");
      return { position: oneJump };
    },
  ));

  results.push(await runCase(
    "deterministic-replay-same-inputs-same-output",
    "같은 입력이면 항상 같은 중간 위치를 돌려준다(결정론)",
    "design 11.1 render(snapshot) purity",
    () => {
      const tracker1 = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      const tracker2 = new GuestMotionTracker({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid: grid });
      tracker1.recordMovingToSeat({ guestId: "g5", seatId: firstSeat.seatId, startedAtMs: 0, travelTimeMs: 3000 });
      tracker2.recordMovingToSeat({ guestId: "g5", seatId: firstSeat.seatId, startedAtMs: 0, travelTimeMs: 3000 });
      const a = tracker1.positionAt("g5", 1234);
      const b = tracker2.positionAt("g5", 1234);
      assert(JSON.stringify(a) === JSON.stringify(b), "같은 입력인데 다른 결과가 나왔습니다.");
      return { position: a };
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
