import { navigationPointToWorld } from "../world/map-schema.js";
import { findShortestPath } from "../world/pathfinder.js";
import {
  GUEST_STEP_MILLI_PX,
  SIMULATION_STEP_MS,
} from "../world/guest-flow.js";

/**
 * Task 32 — design.md 10.2. guest 연속 위치는 GameStore에 없다(Task 30 결정: render 전용).
 * 이 tracker는 guest-flow가 committed event로 알려준 "언제 출발해서 얼마나 걸리는지"만 갖고,
 * 매 프레임 renderer가 순수하게 재계산할 수 있는 presentation-only 캐시다 — domain state를
 * 전혀 읽거나 쓰지 않고, findShortestPath(이미 도메인이 쓰는 것과 같은 결정론적 BFS)를 그대로
 * 재사용해 render(snapshot)이 항상 같은 입력에 같은 위치를 돌려주게 한다.
 */
const TILE_SIZE = 32;

function tileCenterWorldPoint(tile) {
  return { x: tile.x * TILE_SIZE + TILE_SIZE / 2, y: tile.y * TILE_SIZE + TILE_SIZE / 2 };
}

function segmentLengthMilli(a, b) {
  return (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) * 1_000;
}

function polylineLengthMilli(polyline) {
  let total = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    total += segmentLengthMilli(polyline[i], polyline[i + 1]);
  }
  return total;
}

/** BFS tile path + 시작/끝 실제 world point로 world-space polyline을 만든다. */
function buildWorldPolyline(pathTiles, startWorldPoint, endWorldPoint) {
  if (pathTiles.length === 0) return [startWorldPoint, endWorldPoint];
  const points = pathTiles.map((tile, index) => {
    if (index === 0) return startWorldPoint;
    if (index === pathTiles.length - 1) return endWorldPoint;
    return tileCenterWorldPoint(tile);
  });
  return points;
}

/** polyline을 따라 distancePx만큼 걸었을 때의 world point. 끝에 도달하면 마지막 점에서 멈춘다. */
function pointAtDistanceMilli(polyline, distanceMilli) {
  let remaining = Math.max(0, distanceMilli);
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const length = segmentLengthMilli(a, b);
    if (remaining <= length || length === 0) {
      const directionX = Math.sign(b.x - a.x);
      const directionY = Math.sign(b.y - a.y);
      return {
        worldMilli: {
          x: a.x * 1_000 + directionX * remaining,
          y: a.y * 1_000 + directionY * remaining,
        },
        pathIndex: i,
      };
    }
    remaining -= length;
  }
  const final = polyline[polyline.length - 1];
  return {
    worldMilli: { x: final.x * 1_000, y: final.y * 1_000 },
    pathIndex: Math.max(0, polyline.length - 2),
  };
}

export class GuestMotionTracker {
  constructor({ seatPoints, spawnPoint, exitPoint, guestPassabilityGrid }) {
    this.seatPoints = seatPoints;
    this.spawnPoint = spawnPoint;
    this.exitPoint = exitPoint;
    this.guestPassabilityGrid = guestPassabilityGrid;
    this._motions = new Map();
  }

  _seatTile(seatId) {
    return this.seatPoints.find((point) => point.seatId === seatId);
  }

  /** guest-flow.moving-to-seat 이벤트를 받으면 호출한다. */
  recordMovingToSeat({ guestId, seatId, startedAtMs, travelTimeMs }) {
    const seat = this._seatTile(seatId);
    if (!seat) return;
    const startWorld = navigationPointToWorld(this.spawnPoint);
    const endWorld = navigationPointToWorld(seat);
    const path = findShortestPath(
      this.guestPassabilityGrid,
      { x: this.spawnPoint.tileX, y: this.spawnPoint.tileY },
      { x: seat.tileX, y: seat.tileY },
    );
    const polyline = path.ok ? buildWorldPolyline(path.path, startWorld, endWorld) : [startWorld, endWorld];
    this._motions.set(guestId, {
      polyline, startedAtMs, travelTimeMs, finalWorld: endWorld,
      totalLengthMilli: polylineLengthMilli(polyline), direction: "DOWN",
    });
  }

  /** guest-flow.moving-to-exit 이벤트를 받으면 호출한다. */
  recordMovingToExit({ guestId, seatId, startedAtMs, travelTimeMs }) {
    const seat = this._seatTile(seatId);
    if (!seat) return;
    const startWorld = navigationPointToWorld(seat);
    const endWorld = navigationPointToWorld(this.exitPoint);
    const path = findShortestPath(
      this.guestPassabilityGrid,
      { x: seat.tileX, y: seat.tileY },
      { x: this.exitPoint.tileX, y: this.exitPoint.tileY },
    );
    const polyline = path.ok ? buildWorldPolyline(path.path, startWorld, endWorld) : [startWorld, endWorld];
    this._motions.set(guestId, {
      polyline, startedAtMs, travelTimeMs, finalWorld: endWorld,
      totalLengthMilli: polylineLengthMilli(polyline), direction: "DOWN",
    });
  }

  /** guest가 SEATED/EXITED/제거됐을 때 호출해 다음 이동 전까지 추적을 멈춘다. */
  clear(guestId) {
    this._motions.delete(guestId);
  }

  /**
   * 지금 이 guest가 이동 중이 아니면 null을 돌려준다(호출자가 seat/spawn 등 고정 위치를 쓴다).
   * 실제 world 위치는 elapsed 시간이 아니라 progress(elapsed/travelTimeMs)를 polyline 총
   * 길이에 곱해 계산한다 — travelTimeMs는 96px/s 기준으로 반올림돼 있어(computeTravelTimeMs),
   * 시간*속도로 직접 걸으면 progress=1이어도 목적지에 정확히 도달하지 못할 수 있기 때문이다.
   */
  positionAt(guestId, simulationTimeMs) {
    const motion = this._motions.get(guestId);
    if (!motion) return null;
    const rawElapsedMs = Math.min(Math.max(0, simulationTimeMs - motion.startedAtMs), motion.travelTimeMs);
    const elapsedSteps = Math.floor(rawElapsedMs / SIMULATION_STEP_MS);
    const elapsedMs = elapsedSteps * SIMULATION_STEP_MS;
    const distanceMilli = rawElapsedMs >= motion.travelTimeMs
      ? motion.totalLengthMilli
      : Math.min(elapsedSteps * GUEST_STEP_MILLI_PX, motion.totalLengthMilli);
    const position = pointAtDistanceMilli(motion.polyline, distanceMilli);
    const world = {
      x: Math.round(position.worldMilli.x / 1_000),
      y: Math.round(position.worldMilli.y / 1_000),
    };
    const progress = motion.totalLengthMilli === 0 ? 1 : distanceMilli / motion.totalLengthMilli;
    const direction = resolveDominantDirection(motion.polyline, distanceMilli);
    return { world, worldMilli: position.worldMilli, pathIndex: position.pathIndex, progress, direction, elapsedMs };
  }
}

/** design 10.2: 현재 non-zero movement vector의 dominant axis, tie는 vertical 우선. */
function resolveDominantDirection(polyline, distanceMilli) {
  const here = pointAtDistanceMilli(polyline, distanceMilli).worldMilli;
  const ahead = pointAtDistanceMilli(polyline, distanceMilli + 1_000).worldMilli;
  const dx = ahead.x - here.x;
  const dy = ahead.y - here.y;
  if (dx === 0 && dy === 0) return "DOWN";
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? "DOWN" : "UP";
  return dx >= 0 ? "RIGHT" : "LEFT";
}
