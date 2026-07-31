import { freezeDeep } from "../core/result.js";
import {
  MAP_LIMITS,
  mapTileIndex,
  mapWorldSize,
  navigationPointToWorld,
} from "./map-schema.js";

export const PASSABILITY_GRID_KIND = Object.freeze({
  GUEST: "GUEST",
  PLAYER: "PLAYER_20X12",
});

function assertDefinition(definition) {
  const area = definition?.width * definition?.height;
  if (!definition || !Number.isSafeInteger(definition.width) || definition.width < 1 ||
      !Number.isSafeInteger(definition.height) || definition.height < 1 ||
      !Number.isSafeInteger(area) || !Array.isArray(definition.layers?.collision) ||
      definition.layers.collision.length !== area) {
    throw new TypeError("passability grid에는 구조 검증이 끝난 Map definition이 필요합니다.");
  }
  return area;
}

function blockingRects(definition) {
  const objectRects = Array.isArray(definition.objects)
    ? definition.objects.filter((object) => object?.blocksMovement === true).map((object) => object.rect)
    : [];
  const closedRegionRects = Array.isArray(definition.expansionRegions)
    ? definition.expansionRegions
      .filter((region) => region?.openByDefault === false && region?.collisionWhenClosed === true)
      .map((region) => region.rect)
    : [];
  return [...objectRects, ...closedRegionRects];
}

function pointInsideRect(point, rect) {
  return point.x >= rect.x && point.y >= rect.y &&
    point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function aabbIntersectsRect(aabb, rect) {
  return aabb.left < rect.x + rect.width && aabb.right > rect.x &&
    aabb.top < rect.y + rect.height && aabb.bottom > rect.y;
}

function collisionAt(definition, tileX, tileY) {
  const index = mapTileIndex(definition, tileX, tileY);
  return index < 0 ? 1 : definition.layers.collision[index];
}

function pointInsideWorld(definition, point) {
  const world = mapWorldSize(definition);
  return world !== null && Number.isFinite(point?.x) && Number.isFinite(point?.y) &&
    point.x >= 0 && point.y >= 0 && point.x < world.width && point.y < world.height;
}

export function isGuestWorldPointPassable(definition, worldPoint) {
  assertDefinition(definition);
  if (!pointInsideWorld(definition, worldPoint)) return false;
  const tileX = Math.floor(worldPoint.x / MAP_LIMITS.tileSize);
  const tileY = Math.floor(worldPoint.y / MAP_LIMITS.tileSize);
  if (collisionAt(definition, tileX, tileY) !== 0) return false;
  return !blockingRects(definition).some((rect) => pointInsideRect(worldPoint, rect));
}

export function isPlayerFootPassable(definition, worldPoint, {
  collisionWidth = MAP_LIMITS.playerCollisionWidth,
  collisionHeight = MAP_LIMITS.playerCollisionHeight,
} = {}) {
  assertDefinition(definition);
  if (!Number.isSafeInteger(collisionWidth) || collisionWidth < 1 ||
      !Number.isSafeInteger(collisionHeight) || collisionHeight < 1) {
    throw new RangeError("Player collision 크기는 양의 safe integer여야 합니다.");
  }
  if (!Number.isFinite(worldPoint?.x) || !Number.isFinite(worldPoint?.y)) return false;
  const halfWidth = collisionWidth / 2;
  const halfHeight = collisionHeight / 2;
  const aabb = {
    left: worldPoint.x - halfWidth,
    right: worldPoint.x + halfWidth,
    top: worldPoint.y - halfHeight,
    bottom: worldPoint.y + halfHeight,
  };
  const world = mapWorldSize(definition);
  if (!world || aabb.left < 0 || aabb.top < 0 || aabb.right > world.width || aabb.bottom > world.height) {
    return false;
  }

  const minimumTileX = Math.floor(aabb.left / MAP_LIMITS.tileSize);
  const maximumTileX = Math.ceil(aabb.right / MAP_LIMITS.tileSize) - 1;
  const minimumTileY = Math.floor(aabb.top / MAP_LIMITS.tileSize);
  const maximumTileY = Math.ceil(aabb.bottom / MAP_LIMITS.tileSize) - 1;
  for (let tileY = minimumTileY; tileY <= maximumTileY; tileY += 1) {
    for (let tileX = minimumTileX; tileX <= maximumTileX; tileX += 1) {
      if (collisionAt(definition, tileX, tileY) !== 0) return false;
    }
  }
  return !blockingRects(definition).some((rect) => aabbIntersectsRect(aabb, rect));
}

export function isGuestNavigationPointPassable(definition, navigationPoint) {
  const worldPoint = navigationPointToWorld(navigationPoint);
  return worldPoint !== null && isGuestWorldPointPassable(definition, worldPoint);
}

export function isPlayerNavigationPointPassable(definition, navigationPoint, options = undefined) {
  const worldPoint = navigationPointToWorld(navigationPoint);
  return worldPoint !== null && isPlayerFootPassable(definition, worldPoint, options);
}

function createGrid(definition, kind, isNodePassable, metadata = {}) {
  const area = assertDefinition(definition);
  const cells = new Array(area);
  for (let tileY = 0; tileY < definition.height; tileY += 1) {
    for (let tileX = 0; tileX < definition.width; tileX += 1) {
      const worldPoint = {
        x: tileX * MAP_LIMITS.tileSize + MAP_LIMITS.tileSize / 2,
        y: tileY * MAP_LIMITS.tileSize + MAP_LIMITS.tileSize / 2,
      };
      cells[tileY * definition.width + tileX] = isNodePassable(worldPoint) ? 1 : 0;
    }
  }
  Object.freeze(cells);
  return freezeDeep({
    mapId: definition.mapId,
    kind,
    width: definition.width,
    height: definition.height,
    tileSize: MAP_LIMITS.tileSize,
    anchorOffsetX: MAP_LIMITS.tileSize / 2,
    anchorOffsetY: MAP_LIMITS.tileSize / 2,
    cells,
    ...metadata,
  });
}

/** Guest nodes are point anchors over authored static collision only; entities never body-block. */
export function createGuestPassabilityGrid(definition) {
  return createGrid(
    definition,
    PASSABILITY_GRID_KIND.GUEST,
    (worldPoint) => isGuestWorldPointPassable(definition, worldPoint),
    { bodyBlocking: false },
  );
}

/** Player nodes are the 20×12 foot AABB erosion of authored static collision. */
export function createPlayerPassabilityGrid(definition, {
  collisionWidth = MAP_LIMITS.playerCollisionWidth,
  collisionHeight = MAP_LIMITS.playerCollisionHeight,
} = {}) {
  return createGrid(
    definition,
    PASSABILITY_GRID_KIND.PLAYER,
    (worldPoint) => isPlayerFootPassable(definition, worldPoint, { collisionWidth, collisionHeight }),
    { collisionWidth, collisionHeight, bodyBlocking: false },
  );
}

export function isPassabilityGridNodePassable(grid, tileX, tileY) {
  if (!grid || !Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY) ||
      tileX < 0 || tileY < 0 || tileX >= grid.width || tileY >= grid.height) return false;
  return Boolean(grid.cells[tileY * grid.width + tileX]);
}
