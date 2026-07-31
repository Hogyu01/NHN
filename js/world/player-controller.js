import {
  DIAGONAL_NORMALIZER_PPM,
  fixedToDisplayNumber,
  integerUnitsToFixed,
  multiplyDivideTrunc,
} from "../core/fixed-point.js";
import { freezeDeep } from "../core/result.js";
import { navigationPointToWorld } from "./map-schema.js";
import {
  createPlayerCollisionGeometry,
  isPlayerFootFixedPassable,
  PLAYER_COLLISION_HEIGHT,
  PLAYER_COLLISION_WIDTH,
  sweepPlayerMovement,
} from "./collision.js";
import { StaticZoneController } from "./static-zone-controller.js";

export const PLAYER_DIRECTION = Object.freeze({
  UP: "UP",
  LEFT: "LEFT",
  DOWN: "DOWN",
  RIGHT: "RIGHT",
});

export const PLAYER_MOVEMENT_STEP_MILLI_PX = 2_500;
const DIAGONAL_DENOMINATOR_PPM = 1_000_000;
const DIRECTION_ORDER = Object.freeze([
  PLAYER_DIRECTION.UP,
  PLAYER_DIRECTION.LEFT,
  PLAYER_DIRECTION.DOWN,
  PLAYER_DIRECTION.RIGHT,
]);

function requireDirection(direction) {
  if (!DIRECTION_ORDER.includes(direction)) throw new RangeError(`알 수 없는 Player direction입니다: ${direction}`);
  return direction;
}

function logicalToFixed(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field}는 finite number여야 합니다.`);
  const fixed = value * 1_000;
  if (!Number.isSafeInteger(fixed)) throw new RangeError(`${field}는 milli-pixel로 정확히 표현 가능해야 합니다.`);
  return fixed;
}

function inputVector(heldDirections) {
  const dx = Number(heldDirections.has(PLAYER_DIRECTION.RIGHT)) -
    Number(heldDirections.has(PLAYER_DIRECTION.LEFT));
  const dy = Number(heldDirections.has(PLAYER_DIRECTION.DOWN)) -
    Number(heldDirections.has(PLAYER_DIRECTION.UP));
  return Object.freeze({ dx, dy });
}

function movementDelta(vector, movementStepMilliPx) {
  if (vector.dx === 0 && vector.dy === 0) return Object.freeze({ x: 0, y: 0 });
  const diagonal = vector.dx !== 0 && vector.dy !== 0;
  const axisStep = diagonal
    ? multiplyDivideTrunc(movementStepMilliPx, DIAGONAL_NORMALIZER_PPM, DIAGONAL_DENOMINATOR_PPM)
    : movementStepMilliPx;
  return Object.freeze({ x: vector.dx * axisStep, y: vector.dy * axisStep });
}

function directionForVector(vector, previous) {
  if (vector.dy < 0) return PLAYER_DIRECTION.UP;
  if (vector.dy > 0) return PLAYER_DIRECTION.DOWN;
  if (vector.dx < 0) return PLAYER_DIRECTION.LEFT;
  if (vector.dx > 0) return PLAYER_DIRECTION.RIGHT;
  return previous;
}

/** Deterministic fixed-point Player movement over authored World geometry. */
export class PlayerController {
  constructor({
    mapDefinition,
    movementStepMilliPx = PLAYER_MOVEMENT_STEP_MILLI_PX,
    collisionGeometry = null,
    staticZoneController = null,
  }) {
    if (!mapDefinition || typeof mapDefinition !== "object") throw new TypeError("PlayerController mapDefinition이 필요합니다.");
    if (!Number.isSafeInteger(movementStepMilliPx) || movementStepMilliPx < 1) {
      throw new RangeError("movementStepMilliPx는 양의 safe integer여야 합니다.");
    }
    this.mapDefinition = mapDefinition;
    this.movementStepMilliPx = movementStepMilliPx;
    this.collisionGeometry = collisionGeometry ?? createPlayerCollisionGeometry(mapDefinition);
    this.staticZones = staticZoneController ?? new StaticZoneController({
      zones: mapDefinition.zones ?? [],
      collisionWidth: PLAYER_COLLISION_WIDTH,
      collisionHeight: PLAYER_COLLISION_HEIGHT,
    });
    this.heldDirections = new Set();
    this.direction = PLAYER_DIRECTION.DOWN;
    this.moving = false;
    this.lastCollision = freezeDeep({ x: [], y: [] });
    this.lastZoneTransitions = freezeDeep({
      enteredZoneIds: [],
      exitedZoneIds: [],
      openRequests: [],
      occupancy: this.staticZones.snapshot(),
    });
    this.reset();
  }

  reset() {
    const authoredStart = navigationPointToWorld(this.mapDefinition.navigation?.playerStart);
    if (!authoredStart) throw new TypeError("Map authored player_start가 잘못됐습니다.");
    const footMilliPx = {
      x: integerUnitsToFixed(authoredStart.x),
      y: integerUnitsToFixed(authoredStart.y),
    };
    if (!isPlayerFootFixedPassable(this.collisionGeometry, footMilliPx)) {
      throw new RangeError("PLAYER_AUTHORED_START_BLOCKED: authored player_start가 20×12 AABB passable하지 않습니다.");
    }
    this.footMilliPx = footMilliPx;
    this.direction = PLAYER_DIRECTION.DOWN;
    this.moving = false;
    this.heldDirections.clear();
    this.lastCollision = freezeDeep({ x: [], y: [] });
    this.staticZones.reset();
    this.lastZoneTransitions = this.staticZones.update(this.footMilliPx);
    return this.snapshot();
  }

  setDirectionHeld(direction, held) {
    requireDirection(direction);
    if (typeof held !== "boolean") throw new TypeError("held는 boolean이어야 합니다.");
    if (held) this.heldDirections.add(direction);
    else this.heldDirections.delete(direction);
    return this.snapshot();
  }

  clearHeldMovement() {
    this.heldDirections.clear();
    this.moving = false;
    return this.snapshot();
  }

  step({ movementAllowed = true } = {}) {
    if (typeof movementAllowed !== "boolean") throw new TypeError("movementAllowed는 boolean이어야 합니다.");
    if (!movementAllowed) this.clearHeldMovement();
    const vector = movementAllowed ? inputVector(this.heldDirections) : Object.freeze({ dx: 0, dy: 0 });
    this.direction = directionForVector(vector, this.direction);
    const delta = movementDelta(vector, this.movementStepMilliPx);
    const resolved = sweepPlayerMovement(this.collisionGeometry, this.footMilliPx, delta);
    this.footMilliPx = { ...resolved.footMilliPx };
    this.lastCollision = resolved.collisions;
    this.moving = resolved.appliedDeltaMilliPx.x !== 0 || resolved.appliedDeltaMilliPx.y !== 0;
    this.lastZoneTransitions = this.staticZones.update(this.footMilliPx);
    return freezeDeep({
      snapshot: this.snapshot(),
      movement: resolved,
      zoneTransitions: this.lastZoneTransitions,
    });
  }

  setFootPositionLogical(x, y) {
    return this.setFootPositionFixed({
      x: logicalToFixed(x, "Player foot x"),
      y: logicalToFixed(y, "Player foot y"),
    });
  }

  setFootPositionFixed(footMilliPx) {
    if (!footMilliPx || !Number.isSafeInteger(footMilliPx.x) || !Number.isSafeInteger(footMilliPx.y)) {
      throw new TypeError("Player footMilliPx는 x/y safe integer여야 합니다.");
    }
    if (!isPlayerFootFixedPassable(this.collisionGeometry, footMilliPx)) {
      throw new RangeError("PLAYER_POSITION_BLOCKED: 요청한 20×12 Player foot가 passable하지 않습니다.");
    }
    this.footMilliPx = { x: footMilliPx.x, y: footMilliPx.y };
    this.moving = false;
    this.lastCollision = freezeDeep({ x: [], y: [] });
    this.lastZoneTransitions = this.staticZones.update(this.footMilliPx);
    return freezeDeep({ snapshot: this.snapshot(), zoneTransitions: this.lastZoneTransitions });
  }

  dismissZone(zoneId) {
    const dismissed = this.staticZones.dismiss(zoneId);
    this.lastZoneTransitions = freezeDeep({
      enteredZoneIds: [],
      exitedZoneIds: [],
      openRequests: [],
      occupancy: this.staticZones.snapshot(),
    });
    return dismissed;
  }

  isCurrentFootPassable() {
    return isPlayerFootFixedPassable(this.collisionGeometry, this.footMilliPx);
  }

  snapshot() {
    const footMilliPx = Object.freeze({ ...this.footMilliPx });
    return freezeDeep({
      mapId: this.mapDefinition.mapId,
      player: {
        footMilliPx,
        footLogicalPx: {
          x: fixedToDisplayNumber(footMilliPx.x),
          y: fixedToDisplayNumber(footMilliPx.y),
        },
        direction: this.direction,
        moving: this.moving,
        collisionWidth: PLAYER_COLLISION_WIDTH,
        collisionHeight: PLAYER_COLLISION_HEIGHT,
      },
      heldMovementDirections: DIRECTION_ORDER.filter((direction) => this.heldDirections.has(direction)),
      staticZoneOccupancy: this.staticZones.snapshot(),
      lastCollision: this.lastCollision,
      bodyBlocking: false,
    });
  }
}
