import { freezeDeep } from "../core/result.js";
import { mapWorldSize } from "./map-schema.js";

export const CAMERA_VIEWPORT_SIZE = freezeDeep({ width: 480, height: 480 });

function requireFiniteNumber(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field}는 finite number여야 합니다.`);
  return value;
}

function requirePositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field}는 양의 safe integer여야 합니다.`);
  }
  return value;
}

function normalizePoint(point, field) {
  if (!point || typeof point !== "object") throw new TypeError(`${field}가 필요합니다.`);
  return freezeDeep({
    x: requireFiniteNumber(point.x, `${field}.x`),
    y: requireFiniteNumber(point.y, `${field}.y`),
  });
}

function normalizeViewport(viewport) {
  if (!viewport || typeof viewport !== "object") throw new TypeError("Camera viewport가 필요합니다.");
  return freezeDeep({
    width: requirePositiveSafeInteger(viewport.width, "Camera viewport width"),
    height: requirePositiveSafeInteger(viewport.height, "Camera viewport height"),
  });
}

function normalizeRoundedOrigin(value) {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Derives one camera axis in the normative order: center target, large-map clamp or
 * small-map centering, then integer origin. There is deliberately no dead-zone.
 */
export function cameraAxis(footLogicalPx, worldSize, viewportSize = 480) {
  requireFiniteNumber(footLogicalPx, "Camera foot axis");
  requirePositiveSafeInteger(worldSize, "Camera World axis size");
  requirePositiveSafeInteger(viewportSize, "Camera viewport axis size");

  const centered = footLogicalPx - viewportSize / 2;
  const clampedOrCentered = worldSize >= viewportSize
    ? Math.min(Math.max(centered, 0), worldSize - viewportSize)
    : (worldSize - viewportSize) / 2;
  return normalizeRoundedOrigin(clampedOrCentered);
}

/**
 * Camera is a derived presentation transform. It reads Map and Player World state but is never
 * written back into either state or a checkpoint.
 */
export function deriveCameraTransform({
  mapDefinition,
  playerFootLogicalPx,
  viewport = CAMERA_VIEWPORT_SIZE,
}) {
  const worldSize = mapWorldSize(mapDefinition);
  if (!worldSize || worldSize.width < 1 || worldSize.height < 1) {
    throw new TypeError("Camera에는 유효한 Map definition이 필요합니다.");
  }
  const target = normalizePoint(playerFootLogicalPx, "Camera Player foot target");
  const resolvedViewport = normalizeViewport(viewport);
  const origin = freezeDeep({
    x: cameraAxis(target.x, worldSize.width, resolvedViewport.width),
    y: cameraAxis(target.y, worldSize.height, resolvedViewport.height),
  });

  return freezeDeep({
    origin,
    target,
    viewport: resolvedViewport,
    worldSize,
    smallMapCentered: {
      x: worldSize.width < resolvedViewport.width,
      y: worldSize.height < resolvedViewport.height,
    },
    deadZone: null,
  });
}

function cameraOrigin(camera) {
  const origin = camera?.origin ?? camera;
  if (!origin || !Number.isSafeInteger(origin.x) || !Number.isSafeInteger(origin.y)) {
    throw new TypeError("Camera origin은 x/y safe integer여야 합니다.");
  }
  return origin;
}

/** World_Coordinate → 480×480 viewport logical coordinate. */
export function worldToViewport(point, camera) {
  const world = normalizePoint(point, "World point");
  const origin = cameraOrigin(camera);
  return freezeDeep({ x: world.x - origin.x, y: world.y - origin.y });
}

/** 480×480 viewport logical coordinate → World_Coordinate. */
export function viewportToWorld(point, camera) {
  const viewport = normalizePoint(point, "Viewport point");
  const origin = cameraOrigin(camera);
  return freezeDeep({ x: viewport.x + origin.x, y: viewport.y + origin.y });
}
