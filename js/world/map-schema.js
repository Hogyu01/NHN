import { freezeDeep } from "../core/result.js";

export const MAP_SCHEMA_VERSION = 1;
export const MAP_SCHEMA_NAME = "map-definition.v1";
export const BASE_MAP_ID = "map.base_restaurant";

export const MAP_ROLE = Object.freeze({
  BASE: "BASE",
  PROTOTYPE: "PROTOTYPE",
  OPTIONAL: "OPTIONAL",
});

export const MAP_LIMITS = freezeDeep({
  minimumAxis: 1,
  maximumAxis: 128,
  maximumArea: 16_384,
  tileSize: 32,
  maximumRegisteredMaps: 16,
  playerCollisionWidth: 20,
  playerCollisionHeight: 12,
});

export const MAP_LAYER_NAMES = Object.freeze(["ground", "collision", "below", "above"]);
export const BASE_REQUIRED_SEMANTICS = Object.freeze(["board", "stove", "counter", "storage"]);
export const PROTOTYPE_REQUIRED_SEMANTICS = Object.freeze(["board", "stove", "counter"]);
export const FACING_DIRECTIONS = Object.freeze(["UP", "LEFT", "DOWN", "RIGHT"]);

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const RECT_SCHEMA = {
  type: "object",
  required: ["x", "y", "width", "height"],
  additionalProperties: false,
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
  },
};

const NAVIGATION_POINT_PROPERTIES = {
  pointId: { type: "string", format: "stable-id" },
  tileX: { type: "integer", minimum: 0 },
  tileY: { type: "integer", minimum: 0 },
  offsetX: { type: "integer", minimum: 0, maximum: 31 },
  offsetY: { type: "integer", minimum: 0, maximum: 31 },
};

const NAVIGATION_POINT_SCHEMA = {
  type: "object",
  itemIdField: "pointId",
  required: ["pointId", "tileX", "tileY", "offsetX", "offsetY"],
  additionalProperties: false,
  properties: NAVIGATION_POINT_PROPERTIES,
};

const TILE_CELL_SCHEMA = {
  type: ["string", "object", "null"],
  required: ["tileId", "frame"],
  additionalProperties: false,
  properties: {
    tileId: { type: "string", format: "stable-id" },
    frame: { type: "integer", minimum: 0 },
  },
};

/**
 * Strict Task 7 Map_Schema. Dynamic bounds, local namespaces, passability and references are
 * validated by MapValidator after this data-only schema succeeds.
 */
export const MAP_DEFINITION_SCHEMA = freezeDeep({
  type: "object",
  itemIdField: "mapId",
  required: [
    "schemaVersion",
    "mapId",
    "width",
    "height",
    "tileSize",
    "layers",
    "objects",
    "zones",
    "navigation",
    "expansionRegions",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: MAP_SCHEMA_VERSION },
    mapId: { type: "string", format: "stable-id", idNamespace: "map" },
    width: { type: "integer", minimum: MAP_LIMITS.minimumAxis, maximum: MAP_LIMITS.maximumAxis },
    height: { type: "integer", minimum: MAP_LIMITS.minimumAxis, maximum: MAP_LIMITS.maximumAxis },
    tileSize: { type: "integer", const: MAP_LIMITS.tileSize },
    layers: {
      type: "object",
      required: MAP_LAYER_NAMES,
      additionalProperties: false,
      properties: {
        ground: { type: "array", minItems: 1, maxItems: MAP_LIMITS.maximumArea, items: TILE_CELL_SCHEMA },
        collision: {
          type: "array",
          minItems: 1,
          maxItems: MAP_LIMITS.maximumArea,
          items: { type: "integer", enum: [0, 1] },
        },
        below: { type: "array", minItems: 1, maxItems: MAP_LIMITS.maximumArea, items: TILE_CELL_SCHEMA },
        above: { type: "array", minItems: 1, maxItems: MAP_LIMITS.maximumArea, items: TILE_CELL_SCHEMA },
      },
    },
    objects: {
      type: "array",
      items: {
        type: "object",
        itemIdField: "objectId",
        required: ["objectId", "kind", "rect", "blocksMovement"],
        additionalProperties: false,
        properties: {
          objectId: { type: "string", format: "stable-id" },
          kind: { type: "string", minLength: 1 },
          rect: RECT_SCHEMA,
          blocksMovement: { type: "boolean" },
        },
      },
    },
    zones: {
      type: "array",
      items: {
        type: "object",
        itemIdField: "zoneId",
        required: ["zoneId", "semantic", "rect", "approachTileIds"],
        additionalProperties: false,
        properties: {
          zoneId: { type: "string", format: "stable-id" },
          semantic: { type: "string", minLength: 1 },
          rect: RECT_SCHEMA,
          approachTileIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", format: "stable-id" },
          },
        },
      },
    },
    navigation: {
      type: "object",
      required: [
        "playerStart",
        "spawnPoint",
        "exitPoint",
        "approachPoints",
        "seatPoints",
        "tableServiceTargets",
        "transitions",
      ],
      additionalProperties: false,
      properties: {
        playerStart: NAVIGATION_POINT_SCHEMA,
        spawnPoint: NAVIGATION_POINT_SCHEMA,
        exitPoint: NAVIGATION_POINT_SCHEMA,
        approachPoints: { type: "array", items: NAVIGATION_POINT_SCHEMA },
        seatPoints: {
          type: "array",
          items: {
            type: "object",
            itemIdField: "seatId",
            required: [
              "pointId",
              "seatId",
              "tableId",
              "tileX",
              "tileY",
              "offsetX",
              "offsetY",
              "activeByDefault",
              "facing",
            ],
            additionalProperties: false,
            properties: {
              ...NAVIGATION_POINT_PROPERTIES,
              seatId: { type: "string", format: "stable-id" },
              tableId: { type: "string", format: "stable-id" },
              activeByDefault: { type: "boolean" },
              facing: { type: "string", enum: FACING_DIRECTIONS },
            },
          },
        },
        tableServiceTargets: {
          type: "array",
          items: {
            type: "object",
            itemIdField: "targetId",
            required: [
              "targetId",
              "tableId",
              "tileX",
              "tileY",
              "offsetX",
              "offsetY",
              "proximityRadius",
              "approachTileIds",
            ],
            additionalProperties: false,
            properties: {
              targetId: { type: "string", format: "stable-id" },
              tableId: { type: "string", format: "stable-id" },
              tileX: { type: "integer", minimum: 0 },
              tileY: { type: "integer", minimum: 0 },
              offsetX: { type: "integer", minimum: 0, maximum: 31 },
              offsetY: { type: "integer", minimum: 0, maximum: 31 },
              proximityRadius: { type: "integer", minimum: 1 },
              approachTileIds: {
                type: "array",
                minItems: 1,
                items: { type: "string", format: "stable-id" },
              },
            },
          },
        },
        transitions: {
          type: "array",
          items: {
            type: "object",
            itemIdField: "transitionId",
            required: [
              "transitionId",
              "pointId",
              "tileX",
              "tileY",
              "offsetX",
              "offsetY",
              "destinationMapId",
              "destinationEntryId",
            ],
            additionalProperties: false,
            properties: {
              ...NAVIGATION_POINT_PROPERTIES,
              transitionId: { type: "string", format: "stable-id" },
              destinationMapId: { type: "string", format: "stable-id" },
              destinationEntryId: { type: "string", format: "stable-id" },
            },
          },
        },
      },
    },
    expansionRegions: {
      type: "array",
      items: {
        type: "object",
        itemIdField: "regionId",
        required: ["regionId", "rect", "openByDefault", "collisionWhenClosed", "seatIds"],
        additionalProperties: false,
        properties: {
          regionId: { type: "string", format: "stable-id" },
          rect: RECT_SCHEMA,
          openByDefault: { type: "boolean" },
          collisionWhenClosed: { type: "boolean" },
          seatIds: { type: "array", items: { type: "string", format: "stable-id" } },
        },
      },
    },
  },
  invariants: ["map-core"],
});

export function isStableMapIdentifier(value) {
  return typeof value === "string" && STABLE_ID_PATTERN.test(value);
}

export function isMapRole(value) {
  return Object.values(MAP_ROLE).includes(value);
}

export function mapArea(widthOrDefinition, height = undefined) {
  const width = typeof widthOrDefinition === "object" ? widthOrDefinition?.width : widthOrDefinition;
  const resolvedHeight = typeof widthOrDefinition === "object" ? widthOrDefinition?.height : height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(resolvedHeight)) return null;
  const area = width * resolvedHeight;
  return Number.isSafeInteger(area) ? area : null;
}

export function mapWorldSize(definition) {
  if (!definition || mapArea(definition) === null) return null;
  return freezeDeep({
    width: definition.width * MAP_LIMITS.tileSize,
    height: definition.height * MAP_LIMITS.tileSize,
  });
}

export function navigationPointToWorld(point) {
  if (!point || !Number.isSafeInteger(point.tileX) || !Number.isSafeInteger(point.tileY) ||
      !Number.isSafeInteger(point.offsetX) || !Number.isSafeInteger(point.offsetY)) return null;
  return freezeDeep({
    x: point.tileX * MAP_LIMITS.tileSize + point.offsetX,
    y: point.tileY * MAP_LIMITS.tileSize + point.offsetY,
  });
}

export function mapTileIndex(definition, tileX, tileY) {
  if (!definition || !Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY) ||
      tileX < 0 || tileY < 0 || tileX >= definition.width || tileY >= definition.height) return -1;
  return tileY * definition.width + tileX;
}

export function createMapLoadSpecification({ filename, role, expectedMapId = undefined, url = undefined }) {
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new TypeError("Map filename은 비어 있지 않은 문자열이어야 합니다.");
  }
  if (!isMapRole(role)) throw new TypeError(`알 수 없는 Map role입니다: ${role}`);
  if (expectedMapId !== undefined && !isStableMapIdentifier(expectedMapId)) {
    throw new TypeError(`expectedMapId는 stable ID여야 합니다: ${expectedMapId}`);
  }
  return freezeDeep({
    filename,
    role,
    ...(expectedMapId === undefined ? {} : { expectedMapId }),
    ...(url === undefined ? {} : { url }),
  });
}
