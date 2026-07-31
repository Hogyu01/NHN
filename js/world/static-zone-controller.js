import { integerUnitsToFixed } from "../core/fixed-point.js";
import { freezeDeep } from "../core/result.js";
import {
  PLAYER_COLLISION_HEIGHT,
  PLAYER_COLLISION_WIDTH,
  playerAabbFixed,
} from "./collision.js";

function normalizeZone(zone, index) {
  if (!zone || typeof zone.zoneId !== "string" || zone.zoneId.length === 0 ||
      typeof zone.semantic !== "string" || zone.semantic.length === 0) {
    throw new TypeError(`Static zone ${index}의 zoneId/semantic이 잘못됐습니다.`);
  }
  const rect = zone.rect;
  if (!rect || !Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) ||
      !Number.isSafeInteger(rect.width) || rect.width < 1 ||
      !Number.isSafeInteger(rect.height) || rect.height < 1) {
    throw new TypeError(`Static zone rect가 잘못됐습니다: ${zone.zoneId}`);
  }
  return freezeDeep({
    zoneId: zone.zoneId,
    semantic: zone.semantic,
    rect: { ...rect },
    fixedRect: {
      left: integerUnitsToFixed(rect.x),
      right: integerUnitsToFixed(rect.x + rect.width),
      top: integerUnitsToFixed(rect.y),
      bottom: integerUnitsToFixed(rect.y + rect.height),
    },
  });
}

function aabbTouchesOrIntersects(aabb, rect) {
  return aabb.left <= rect.right && aabb.right >= rect.left &&
    aabb.top <= rect.bottom && aabb.bottom >= rect.top;
}

/**
 * Tracks authored static-zone occupancy independently from panels. A collision AABB touching the
 * edge of a blocking semantic object counts as inside, allowing interaction without penetration.
 */
export class StaticZoneController {
  constructor({
    zones,
    collisionWidth = PLAYER_COLLISION_WIDTH,
    collisionHeight = PLAYER_COLLISION_HEIGHT,
  }) {
    if (!Array.isArray(zones)) throw new TypeError("StaticZoneController zones는 배열이어야 합니다.");
    this.zones = Object.freeze(zones.map(normalizeZone));
    const ids = new Set();
    for (const zone of this.zones) {
      if (ids.has(zone.zoneId)) throw new Error(`중복 static zone ID입니다: ${zone.zoneId}`);
      ids.add(zone.zoneId);
    }
    this.collisionWidth = collisionWidth;
    this.collisionHeight = collisionHeight;
    this.occupancy = new Map();
    this.reset();
  }

  reset() {
    this.occupancy.clear();
    for (const zone of this.zones) {
      this.occupancy.set(zone.zoneId, { inside: false, dismissedWhileInside: false });
    }
    return this.snapshot();
  }

  update(footMilliPx) {
    const aabb = playerAabbFixed(footMilliPx, {
      collisionWidth: this.collisionWidth,
      collisionHeight: this.collisionHeight,
    });
    const entered = [];
    const exited = [];
    const openRequests = [];

    for (const zone of this.zones) {
      const state = this.occupancy.get(zone.zoneId);
      const inside = aabbTouchesOrIntersects(aabb, zone.fixedRect);
      if (inside && !state.inside) {
        state.inside = true;
        entered.push(zone.zoneId);
        if (!state.dismissedWhileInside) {
          openRequests.push({ zoneId: zone.zoneId, semantic: zone.semantic });
        }
      } else if (!inside && state.inside) {
        state.inside = false;
        state.dismissedWhileInside = false;
        exited.push(zone.zoneId);
      } else if (!inside && state.dismissedWhileInside) {
        state.dismissedWhileInside = false;
      }
    }

    return freezeDeep({
      enteredZoneIds: entered,
      exitedZoneIds: exited,
      openRequests,
      occupancy: this.snapshot(),
    });
  }

  dismiss(zoneId) {
    const state = this.occupancy.get(zoneId);
    if (!state) throw new RangeError(`등록되지 않은 static zone입니다: ${zoneId}`);
    if (!state.inside) return false;
    state.dismissedWhileInside = true;
    return true;
  }

  getZone(zoneId) {
    return this.zones.find((zone) => zone.zoneId === zoneId) ?? null;
  }

  zoneIdForSemantic(semantic) {
    return this.zones.find((zone) => zone.semantic === semantic)?.zoneId ?? null;
  }

  snapshot() {
    return freezeDeep(Object.fromEntries(this.zones.map((zone) => {
      const state = this.occupancy.get(zone.zoneId);
      return [zone.zoneId, {
        semantic: zone.semantic,
        inside: state.inside,
        dismissedWhileInside: state.dismissedWhileInside,
      }];
    })));
  }
}
