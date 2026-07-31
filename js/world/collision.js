import {
  checkedAdd,
  integerUnitsToFixed,
  MILLI_LOGICAL_PIXEL_SCALE,
} from "../core/fixed-point.js";
import { freezeDeep } from "../core/result.js";
import { MAP_LIMITS, mapWorldSize } from "./map-schema.js";

export const PLAYER_COLLISION_WIDTH = MAP_LIMITS.playerCollisionWidth;
export const PLAYER_COLLISION_HEIGHT = MAP_LIMITS.playerCollisionHeight;

function requireSafeInteger(value, field) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field}는 safe integer여야 합니다.`);
  return value;
}

function requireMapDefinition(definition) {
  const area = definition?.width * definition?.height;
  if (!definition || !Number.isSafeInteger(definition.width) || definition.width < 1 ||
      !Number.isSafeInteger(definition.height) || definition.height < 1 ||
      !Number.isSafeInteger(area) || !Array.isArray(definition.layers?.collision) ||
      definition.layers.collision.length !== area) {
    throw new TypeError("Player collision에는 구조 검증이 끝난 Map definition이 필요합니다.");
  }
  return definition;
}

function fixedRect(rect, blockerId, source) {
  if (!rect || !Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) ||
      !Number.isSafeInteger(rect.width) || rect.width < 1 ||
      !Number.isSafeInteger(rect.height) || rect.height < 1) {
    throw new TypeError(`정적 collision rect가 잘못됐습니다: ${blockerId}`);
  }
  const left = integerUnitsToFixed(rect.x);
  const top = integerUnitsToFixed(rect.y);
  const right = integerUnitsToFixed(rect.x + rect.width);
  const bottom = integerUnitsToFixed(rect.y + rect.height);
  return Object.freeze({ blockerId, source, left, right, top, bottom });
}

function collisionTileRects(definition) {
  const blockers = [];
  for (let tileY = 0; tileY < definition.height; tileY += 1) {
    for (let tileX = 0; tileX < definition.width; tileX += 1) {
      if (definition.layers.collision[tileY * definition.width + tileX] !== 1) continue;
      blockers.push(fixedRect({
        x: tileX * MAP_LIMITS.tileSize,
        y: tileY * MAP_LIMITS.tileSize,
        width: MAP_LIMITS.tileSize,
        height: MAP_LIMITS.tileSize,
      }, `collision-tile:${tileX}:${tileY}`, "TILE"));
    }
  }
  return blockers;
}

/**
 * Builds immutable static collision geometry. Guest/entity bodies are deliberately absent:
 * Requirements 34.6 makes player↔guest and guest↔guest body blocking non-authoritative.
 */
export function createPlayerCollisionGeometry(definition) {
  requireMapDefinition(definition);
  const world = mapWorldSize(definition);
  const blockers = collisionTileRects(definition);

  for (const object of definition.objects ?? []) {
    if (object?.blocksMovement !== true) continue;
    blockers.push(fixedRect(object.rect, `object:${object.objectId}`, "OBJECT"));
  }
  for (const region of definition.expansionRegions ?? []) {
    if (region?.openByDefault !== false || region?.collisionWhenClosed !== true) continue;
    blockers.push(fixedRect(region.rect, `closed-region:${region.regionId}`, "CLOSED_REGION"));
  }

  return freezeDeep({
    kind: "PLAYER_STATIC_COLLISION",
    mapId: definition.mapId,
    worldWidthMilliPx: integerUnitsToFixed(world.width),
    worldHeightMilliPx: integerUnitsToFixed(world.height),
    collisionWidth: PLAYER_COLLISION_WIDTH,
    collisionHeight: PLAYER_COLLISION_HEIGHT,
    bodyBlocking: false,
    blockers,
  });
}

function requireGeometry(input) {
  return input?.kind === "PLAYER_STATIC_COLLISION"
    ? input
    : createPlayerCollisionGeometry(input);
}

function requireFoot(footMilliPx) {
  if (!footMilliPx || !Number.isSafeInteger(footMilliPx.x) || !Number.isSafeInteger(footMilliPx.y)) {
    throw new TypeError("Player footMilliPx는 x/y safe integer여야 합니다.");
  }
  return footMilliPx;
}

export function playerAabbFixed(footMilliPx, {
  collisionWidth = PLAYER_COLLISION_WIDTH,
  collisionHeight = PLAYER_COLLISION_HEIGHT,
} = {}) {
  requireFoot(footMilliPx);
  if (!Number.isSafeInteger(collisionWidth) || collisionWidth < 1 || collisionWidth % 2 !== 0 ||
      !Number.isSafeInteger(collisionHeight) || collisionHeight < 1 || collisionHeight % 2 !== 0) {
    throw new RangeError("Player collision width/height는 양의 짝수 safe integer여야 합니다.");
  }
  const halfWidth = integerUnitsToFixed(collisionWidth / 2);
  const halfHeight = integerUnitsToFixed(collisionHeight / 2);
  return Object.freeze({
    left: footMilliPx.x - halfWidth,
    right: footMilliPx.x + halfWidth,
    top: footMilliPx.y - halfHeight,
    bottom: footMilliPx.y + halfHeight,
  });
}

function rangesOverlapStrict(firstStart, firstEnd, secondStart, secondEnd) {
  return firstStart < secondEnd && firstEnd > secondStart;
}

function aabbIntersectsBlocker(aabb, blocker) {
  return rangesOverlapStrict(aabb.left, aabb.right, blocker.left, blocker.right) &&
    rangesOverlapStrict(aabb.top, aabb.bottom, blocker.top, blocker.bottom);
}

export function isPlayerFootFixedPassable(geometryOrDefinition, footMilliPx) {
  const geometry = requireGeometry(geometryOrDefinition);
  const aabb = playerAabbFixed(requireFoot(footMilliPx), {
    collisionWidth: geometry.collisionWidth,
    collisionHeight: geometry.collisionHeight,
  });
  if (aabb.left < 0 || aabb.top < 0 ||
      aabb.right > geometry.worldWidthMilliPx || aabb.bottom > geometry.worldHeightMilliPx) {
    return false;
  }
  return !geometry.blockers.some((blocker) => aabbIntersectsBlocker(aabb, blocker));
}

function unique(values) {
  return Object.freeze([...new Set(values)]);
}

function sweepAxis(geometry, footMilliPx, deltaMilliPx, axis) {
  requireSafeInteger(deltaMilliPx, `deltaMilliPx.${axis}`);
  if (deltaMilliPx === 0) return Object.freeze({ value: footMilliPx[axis], collisions: Object.freeze([]) });

  const horizontal = axis === "x";
  const half = integerUnitsToFixed(
    (horizontal ? geometry.collisionWidth : geometry.collisionHeight) / 2,
  );
  const worldLimit = horizontal ? geometry.worldWidthMilliPx : geometry.worldHeightMilliPx;
  const current = footMilliPx[axis];
  const requested = checkedAdd(current, deltaMilliPx);
  let resolved = Math.min(Math.max(requested, half), worldLimit - half);
  const collisions = [];
  if (resolved !== requested) collisions.push(deltaMilliPx > 0 ? `world:${axis}:max` : `world:${axis}:min`);

  const currentAabb = playerAabbFixed(footMilliPx, {
    collisionWidth: geometry.collisionWidth,
    collisionHeight: geometry.collisionHeight,
  });
  for (const blocker of geometry.blockers) {
    const perpendicularOverlap = horizontal
      ? rangesOverlapStrict(currentAabb.top, currentAabb.bottom, blocker.top, blocker.bottom)
      : rangesOverlapStrict(currentAabb.left, currentAabb.right, blocker.left, blocker.right);
    if (!perpendicularOverlap) continue;

    const currentMinimum = horizontal ? currentAabb.left : currentAabb.top;
    const currentMaximum = horizontal ? currentAabb.right : currentAabb.bottom;
    const blockerMinimum = horizontal ? blocker.left : blocker.top;
    const blockerMaximum = horizontal ? blocker.right : blocker.bottom;

    if (deltaMilliPx > 0) {
      const desiredMaximum = resolved + half;
      if (currentMaximum <= blockerMinimum && desiredMaximum > blockerMinimum) {
        const limit = blockerMinimum - half;
        if (limit < resolved) {
          resolved = limit;
          collisions.length = 0;
          collisions.push(blocker.blockerId);
        } else if (limit === resolved) {
          collisions.push(blocker.blockerId);
        }
      }
    } else {
      const desiredMinimum = resolved - half;
      if (currentMinimum >= blockerMaximum && desiredMinimum < blockerMaximum) {
        const limit = blockerMaximum + half;
        if (limit > resolved) {
          resolved = limit;
          collisions.length = 0;
          collisions.push(blocker.blockerId);
        } else if (limit === resolved) {
          collisions.push(blocker.blockerId);
        }
      }
    }
  }

  return Object.freeze({ value: resolved, collisions: unique(collisions) });
}

/** Resolves authored static collision in the required deterministic X sweep → Y sweep order. */
export function sweepPlayerMovement(geometryOrDefinition, footMilliPx, deltaMilliPx) {
  const geometry = requireGeometry(geometryOrDefinition);
  requireFoot(footMilliPx);
  if (!deltaMilliPx || !Number.isSafeInteger(deltaMilliPx.x) || !Number.isSafeInteger(deltaMilliPx.y)) {
    throw new TypeError("Player movement delta는 x/y safe integer milli-pixel이어야 합니다.");
  }
  if (!isPlayerFootFixedPassable(geometry, footMilliPx)) {
    throw new RangeError("PLAYER_START_BLOCKED: movement 시작 foot가 passable하지 않습니다.");
  }

  const xResult = sweepAxis(geometry, footMilliPx, deltaMilliPx.x, "x");
  const afterX = Object.freeze({ x: xResult.value, y: footMilliPx.y });
  const yResult = sweepAxis(geometry, afterX, deltaMilliPx.y, "y");
  const foot = Object.freeze({ x: afterX.x, y: yResult.value });
  if (!isPlayerFootFixedPassable(geometry, foot)) {
    throw new Error("PLAYER_SWEEP_POSTCONDITION_FAILED: resolved foot가 static collision과 교차합니다.");
  }

  return freezeDeep({
    footMilliPx: foot,
    requestedDeltaMilliPx: { ...deltaMilliPx },
    appliedDeltaMilliPx: {
      x: foot.x - footMilliPx.x,
      y: foot.y - footMilliPx.y,
    },
    collisions: {
      x: xResult.collisions,
      y: yResult.collisions,
    },
    sweepOrder: Object.freeze(["X", "Y"]),
    scale: MILLI_LOGICAL_PIXEL_SCALE,
  });
}
