import {
  integerUnitsToFixed,
  MILLI_LOGICAL_PIXEL_SCALE,
} from "../core/fixed-point.js";
import { freezeDeep } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";
import { navigationPointToWorld } from "./map-schema.js";

export const DYNAMIC_SERVICE_TARGET_KIND = Object.freeze({
  GUEST_ORDER: "GUEST_ORDER",
  TABLE_SERVICE: "TABLE_SERVICE",
});

export const DYNAMIC_SERVICE_TARGET_PRIORITY = Object.freeze({
  [DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER]: 0,
  [DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE]: 1,
});

export const DYNAMIC_TARGET_ORDERING = Object.freeze([
  "WORLD_DISTANCE_MILLI_PX",
  "TARGET_PRIORITY",
  "ENTITY_ID_LEXICAL",
]);

function requireStableId(value, field) {
  if (!isStableIdentifier(value)) throw new TypeError(`${field}는 stable ID여야 합니다.`);
  return value;
}

function requireFixedPoint(point, field) {
  if (!point || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) {
    throw new TypeError(`${field}는 x/y safe integer milli-pixel이어야 합니다.`);
  }
  return Object.freeze({ x: point.x, y: point.y });
}

function requirePositiveFixed(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field}는 양의 safe integer milli-pixel이어야 합니다.`);
  }
  return value;
}

function stableLexicalCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function safeSquaredDistance(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  const squared = dx * dx + dy * dy;
  if (squared > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Dynamic target World distance가 safe integer 범위를 초과했습니다.");
  }
  return Number(squared);
}

function safeSquaredRadius(radiusMilliPx) {
  const squared = BigInt(radiusMilliPx) * BigInt(radiusMilliPx);
  if (squared > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Dynamic target proximity radius가 safe integer 범위를 초과했습니다.");
  }
  return Number(squared);
}

function targetPoint(input) {
  return input.worldMilliPx ?? input.footMilliPx;
}

function targetRadius(input) {
  if (input.proximityRadiusMilliPx !== undefined) {
    return requirePositiveFixed(input.proximityRadiusMilliPx, "Dynamic target proximityRadiusMilliPx");
  }
  if (!Number.isSafeInteger(input.proximityRadius) || input.proximityRadius < 1) {
    throw new RangeError("Dynamic target proximityRadius는 양의 integer Logical_Pixel이어야 합니다.");
  }
  return integerUnitsToFixed(input.proximityRadius);
}

/**
 * Normalizes a runtime target to World milli-pixels only. Screen, viewport, client and camera
 * coordinates are deliberately not accepted or retained.
 */
export function normalizeDynamicServiceTarget(input, index = 0) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`Dynamic target ${index}는 object여야 합니다.`);
  }
  if (!Object.hasOwn(DYNAMIC_SERVICE_TARGET_PRIORITY, input.kind)) {
    throw new RangeError(`Dynamic target kind가 잘못됐습니다: ${input.kind}`);
  }
  const targetId = requireStableId(input.targetId, `Dynamic target ${index}.targetId`);
  const entityId = requireStableId(input.entityId, `Dynamic target ${targetId}.entityId`);
  const worldMilliPx = requireFixedPoint(targetPoint(input), `Dynamic target ${targetId}.worldMilliPx`);
  const proximityRadiusMilliPx = targetRadius(input);

  return freezeDeep({
    kind: input.kind,
    priority: DYNAMIC_SERVICE_TARGET_PRIORITY[input.kind],
    targetId,
    entityId,
    worldMilliPx,
    proximityRadiusMilliPx,
    ...(input.tableId === undefined ? {} : {
      tableId: requireStableId(input.tableId, `Dynamic target ${targetId}.tableId`),
    }),
    ...(input.orderId === undefined ? {} : {
      orderId: requireStableId(input.orderId, `Dynamic target ${targetId}.orderId`),
    }),
  });
}

export function createGuestOrderTarget({
  targetId,
  entityId,
  footMilliPx,
  proximityRadiusMilliPx,
  proximityRadius = undefined,
  orderId = undefined,
}) {
  return normalizeDynamicServiceTarget({
    kind: DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER,
    targetId,
    entityId,
    footMilliPx,
    ...(proximityRadiusMilliPx === undefined ? { proximityRadius } : { proximityRadiusMilliPx }),
    ...(orderId === undefined ? {} : { orderId }),
  });
}

/** Converts canonical authored table targets to the same resolver contract used by guests. */
export function createAuthoredTableServiceTargets(mapDefinition) {
  if (!mapDefinition || typeof mapDefinition !== "object") {
    throw new TypeError("authored table target에는 Map definition이 필요합니다.");
  }
  const targets = mapDefinition.navigation?.tableServiceTargets;
  if (!Array.isArray(targets)) {
    throw new TypeError("Map navigation.tableServiceTargets는 배열이어야 합니다.");
  }
  return Object.freeze(targets.map((target, index) => {
    const world = navigationPointToWorld(target);
    if (!world) throw new TypeError(`authored table service target ${index} World point가 잘못됐습니다.`);
    return normalizeDynamicServiceTarget({
      kind: DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE,
      targetId: target.targetId,
      entityId: target.tableId,
      tableId: target.tableId,
      worldMilliPx: {
        x: integerUnitsToFixed(world.x),
        y: integerUnitsToFixed(world.y),
      },
      proximityRadius: target.proximityRadius,
    }, index);
  }));
}

function validateUniqueTargets(targets) {
  const targetIds = new Set();
  const entityIds = new Set();
  for (const target of targets) {
    if (targetIds.has(target.targetId)) {
      throw new Error(`DUPLICATE_DYNAMIC_TARGET_ID: ${target.targetId}`);
    }
    if (entityIds.has(target.entityId)) {
      throw new Error(`DUPLICATE_DYNAMIC_ENTITY_ID: ${target.entityId}`);
    }
    targetIds.add(target.targetId);
    entityIds.add(target.entityId);
  }
}

function compareCandidates(left, right) {
  if (left.distanceSquaredMilliPx !== right.distanceSquaredMilliPx) {
    return left.distanceSquaredMilliPx - right.distanceSquaredMilliPx;
  }
  if (left.target.priority !== right.target.priority) {
    return left.target.priority - right.target.priority;
  }
  return stableLexicalCompare(left.target.entityId, right.target.entityId);
}

/**
 * Resolves exactly one target by World distance → fixed target priority → stable Entity_ID.
 * Squared integer distance is used for comparison because it is exactly order-equivalent to
 * Euclidean distance and introduces no floating-point tie or insertion-order dependency.
 */
export function resolveDynamicServiceTarget({ playerFootMilliPx, targets }) {
  const player = requireFixedPoint(playerFootMilliPx, "Player footMilliPx");
  if (!Array.isArray(targets)) throw new TypeError("Dynamic service targets는 배열이어야 합니다.");
  const normalized = targets.map(normalizeDynamicServiceTarget);
  validateUniqueTargets(normalized);

  const candidates = [];
  for (const target of normalized) {
    const distanceSquaredMilliPx = safeSquaredDistance(player, target.worldMilliPx);
    const proximitySquaredMilliPx = safeSquaredRadius(target.proximityRadiusMilliPx);
    if (distanceSquaredMilliPx > proximitySquaredMilliPx) continue;
    candidates.push(freezeDeep({
      target,
      distanceSquaredMilliPx,
      distanceMilliPx: Math.sqrt(distanceSquaredMilliPx),
    }));
  }
  candidates.sort(compareCandidates);
  const selected = candidates[0] ?? null;

  return freezeDeep({
    ok: true,
    code: selected ? "DYNAMIC_SERVICE_TARGET_RESOLVED" : "DYNAMIC_SERVICE_TARGET_NOT_FOUND",
    target: selected?.target ?? null,
    distanceMilliPx: selected?.distanceMilliPx ?? null,
    distanceSquaredMilliPx: selected?.distanceSquaredMilliPx ?? null,
    consideredCount: normalized.length,
    inRangeCount: candidates.length,
    ordering: DYNAMIC_TARGET_ORDERING,
    fixedPointScale: MILLI_LOGICAL_PIXEL_SCALE,
  });
}
