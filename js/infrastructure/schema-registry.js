import { cloneValue, freezeDeep } from "../core/result.js";

export const DATA_SCHEMA = Object.freeze({
  INGREDIENT_REGISTRY_V1: "ingredient-registry.v1",
  RECIPE_REGISTRY_V1: "recipe-registry.v1",
  CANONICAL_INGREDIENT_REGISTRY_V1: "ingredient-registry.canonical.v1",
  CANONICAL_RECIPE_REGISTRY_V1: "recipe-registry.canonical.v1",
  FACILITY_REGISTRY_V1: "facility-registry.v1",
  DIALOGUE_REGISTRY_V1: "dialogue-registry.v1",
  GUEST_ARCHETYPE_REGISTRY_V1: "guest-archetype-registry.v1",
  EVENT_REGISTRY_V1: "event-registry.v1",
  BALANCE_CONFIG_V1: "balance-config.v1",
  CONTENT_MANIFEST_V1: "content-manifest.v1",
  CANONICAL_MIGRATION_REPORT_V1: "canonical-migration-report.v1",
  MAP_DEFINITION_CORE_V1: "map-definition.core.v1",
  SAVE_STATE_CORE_V1: "save-state.core.v1",
  API_PERCENTAGE_V1: "api-percentage.v1",
});

export const CANONICAL_CONTENT_VERSION = 1;

export const CANONICAL_CONTENT_FILE_CONTRACTS = freezeDeep([
  {
    contentId: "content.ingredients",
    filename: "data/ingredients.json",
    schemaName: DATA_SCHEMA.CANONICAL_INGREDIENT_REGISTRY_V1,
    schemaVersion: 1,
  },
  {
    contentId: "content.recipes",
    filename: "data/recipes.json",
    schemaName: DATA_SCHEMA.CANONICAL_RECIPE_REGISTRY_V1,
    schemaVersion: 1,
  },
  {
    contentId: "content.facilities",
    filename: "data/upgrades.json",
    schemaName: DATA_SCHEMA.FACILITY_REGISTRY_V1,
    schemaVersion: 1,
  },
  {
    contentId: "content.dialogue",
    filename: "data/dialogue.json",
    schemaName: DATA_SCHEMA.DIALOGUE_REGISTRY_V1,
    schemaVersion: 1,
  },
  {
    contentId: "content.guests",
    filename: "data/guests.json",
    schemaName: DATA_SCHEMA.GUEST_ARCHETYPE_REGISTRY_V1,
    schemaVersion: 1,
  },
  {
    contentId: "content.events",
    filename: "data/events.json",
    schemaName: DATA_SCHEMA.EVENT_REGISTRY_V1,
    schemaVersion: 1,
  },
  {
    contentId: "content.balance",
    filename: "data/balance.json",
    schemaName: DATA_SCHEMA.BALANCE_CONFIG_V1,
    schemaVersion: 1,
  },
]);

const SUPPORTED_TYPES = new Set([
  "any",
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function requireName(value, field = "schema name") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field}은 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSchemaNode(node, path = "$") {
  if (!isPlainObject(node)) {
    throw new TypeError(`${path} schema node는 plain object여야 합니다.`);
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.length === 0 || types.some((type) => !SUPPORTED_TYPES.has(type))) {
      throw new TypeError(`${path}.type에 지원하지 않는 값이 있습니다.`);
    }
  }
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      throw new TypeError(`${path}.properties는 plain object여야 합니다.`);
    }
    for (const [key, child] of Object.entries(node.properties)) {
      assertSchemaNode(child, `${path}.properties.${key}`);
    }
  }
  if (node.items !== undefined) assertSchemaNode(node.items, `${path}.items`);
  if (isPlainObject(node.additionalProperties)) {
    assertSchemaNode(node.additionalProperties, `${path}.additionalProperties`);
  }
  if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string"))) {
    throw new TypeError(`${path}.required는 문자열 배열이어야 합니다.`);
  }
  if (node.invariants !== undefined && (!Array.isArray(node.invariants) || node.invariants.some((id) => typeof id !== "string"))) {
    throw new TypeError(`${path}.invariants는 문자열 배열이어야 합니다.`);
  }
}

/** Immutable data-only schema registry shared by browser and Node validators. */
export class SchemaRegistry {
  #schemas = new Map();

  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new TypeError("schema entries는 배열이어야 합니다.");
    for (const [name, schema] of entries) this.register(name, schema);
  }

  register(name, schema) {
    const normalizedName = requireName(name);
    if (this.#schemas.has(normalizedName)) {
      throw new Error(`이미 등록된 schema입니다: ${normalizedName}`);
    }
    assertSchemaNode(schema);
    this.#schemas.set(normalizedName, freezeDeep(cloneValue(schema)));
    return this;
  }

  has(name) {
    return this.#schemas.has(name);
  }

  get(name) {
    const schema = this.#schemas.get(name);
    if (!schema) throw new Error(`등록되지 않은 schema입니다: ${name}`);
    return schema;
  }

  names() {
    return Object.freeze([...this.#schemas.keys()].sort());
  }
}

const QUALITY_DISTRIBUTION_SCHEMA = {
  type: "array",
  minItems: 1,
  format: "quality-distribution",
  items: {
    type: "object",
    required: ["minQuality", "maxQuality", "weight"],
    additionalProperties: false,
    properties: {
      minQuality: { type: "number", format: "quality" },
      maxQuality: { type: "number", format: "quality" },
      weight: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

const INGREDIENT_ITEM_SCHEMA = {
  type: "object",
  itemIdField: "ingredientId",
  required: [
    "ingredientId",
    "displayName",
    "basePriceG",
    "marketAvailabilityRate",
    "qualityDistribution",
  ],
  additionalProperties: false,
  properties: {
    ingredientId: { type: "string", format: "stable-id", idNamespace: "ingredient" },
    displayName: { type: "string", minLength: 1 },
    basePriceG: { type: "integer", minimum: 1 },
    marketAvailabilityRate: { type: "number", format: "percentage" },
    qualityDistribution: QUALITY_DISTRIBUTION_SCHEMA,
  },
};

const INGREDIENT_REGISTRY_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "ingredients"],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    ingredients: { type: "array", minItems: 1, items: INGREDIENT_ITEM_SCHEMA },
  },
};

const RECIPE_ITEM_SCHEMA = {
  type: "object",
  itemIdField: "recipeId",
  required: ["recipeId", "displayName", "basePriceG", "ingredientRequirements", "timing"],
  additionalProperties: false,
  properties: {
    recipeId: { type: "string", format: "stable-id", idNamespace: "recipe" },
    displayName: { type: "string", minLength: 1 },
    basePriceG: { type: "integer", minimum: 1 },
    ingredientRequirements: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        required: ["ingredientId", "quantity"],
        additionalProperties: false,
        properties: {
          ingredientId: {
            type: "string",
            format: "stable-id",
            referenceNamespace: "ingredient",
          },
          quantity: { type: "integer", minimum: 1 },
        },
      },
    },
    timing: {
      type: "object",
      required: ["targetOffsetMs", "successWindowMs", "normalWindowMs", "failureOffsetMs"],
      additionalProperties: false,
      properties: {
        targetOffsetMs: { type: "integer", minimum: 0 },
        successWindowMs: { type: "integer", minimum: 0 },
        normalWindowMs: { type: "integer", minimum: 0 },
        failureOffsetMs: { type: "integer", minimum: 1 },
      },
      invariants: ["recipe-timing"],
    },
  },
};

const RECIPE_REGISTRY_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "recipes"],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    recipes: { type: "array", minItems: 1, items: RECIPE_ITEM_SCHEMA },
  },
};

const CANONICAL_INGREDIENT_ITEM_SCHEMA = {
  type: "object",
  itemIdField: "ingredientId",
  required: [
    "ingredientId",
    "displayName",
    "category",
    "flavorProfile",
    "basePriceG",
    "marketAvailabilityRate",
    "marketStockRange",
    "qualityDistribution",
  ],
  additionalProperties: false,
  properties: {
    ingredientId: { type: "string", format: "stable-id", idNamespace: "ingredient" },
    displayName: { type: "string", minLength: 1 },
    category: {
      type: "string",
      enum: [
        "ARCANE",
        "FUNGI",
        "HERB",
        "SPICE",
        "ROOT",
        "MINERAL",
        "GRAIN",
        "PROTEIN",
        "LEGUME",
        "DAIRY",
        "MONSTER_BYPRODUCT",
        "VEGETABLE",
        "MEAT",
        "FRUIT",
      ],
    },
    flavorProfile: { type: "string", minLength: 1, maxLength: 40 },
    basePriceG: { type: "integer", minimum: 1 },
    marketAvailabilityRate: { type: "number", format: "percentage" },
    marketStockRange: {
      type: "object",
      required: ["minimum", "maximum"],
      additionalProperties: false,
      properties: {
        minimum: { type: "integer", minimum: 0 },
        maximum: { type: "integer", minimum: 0 },
      },
      invariants: ["integer-range"],
    },
    qualityDistribution: QUALITY_DISTRIBUTION_SCHEMA,
  },
};

const CANONICAL_INGREDIENT_REGISTRY_SCHEMA = {
  type: "object",
  itemIdField: "contentId",
  required: ["contentId", "schemaVersion", "ingredients"],
  additionalProperties: false,
  properties: {
    contentId: { type: "string", const: "content.ingredients", format: "stable-id", idNamespace: "content-file" },
    schemaVersion: { type: "integer", const: 1 },
    ingredients: {
      type: "array",
      minItems: 10,
      maxItems: 10,
      items: CANONICAL_INGREDIENT_ITEM_SCHEMA,
    },
  },
  invariants: ["canonical-ingredients"],
};

const CANONICAL_RECIPE_ITEM_SCHEMA = {
  type: "object",
  itemIdField: "recipeId",
  required: [
    "recipeId",
    "displayName",
    "basePriceG",
    "ingredientRequirements",
    "timing",
    "unlock",
    "outcomeText",
  ],
  additionalProperties: false,
  properties: {
    ...RECIPE_ITEM_SCHEMA.properties,
    unlock: {
      type: "object",
      required: ["type", "reputationThreshold"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["STARTING", "REPUTATION"] },
        reputationThreshold: { type: ["integer", "null"], format: "quality" },
      },
      invariants: ["recipe-unlock"],
    },
    outcomeText: {
      type: "object",
      required: ["success", "normal", "failure"],
      additionalProperties: false,
      properties: {
        success: { type: "string", minLength: 1, maxLength: 120 },
        normal: { type: "string", minLength: 1, maxLength: 120 },
        failure: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
  },
};

const CANONICAL_RECIPE_REGISTRY_SCHEMA = {
  type: "object",
  itemIdField: "contentId",
  required: ["contentId", "schemaVersion", "recipes"],
  additionalProperties: false,
  properties: {
    contentId: { type: "string", const: "content.recipes", format: "stable-id", idNamespace: "content-file" },
    schemaVersion: { type: "integer", const: 1 },
    recipes: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: CANONICAL_RECIPE_ITEM_SCHEMA,
    },
  },
  invariants: ["canonical-recipes"],
};

const FACILITY_REGISTRY_SCHEMA = {
  type: "object",
  itemIdField: "contentId",
  required: ["contentId", "schemaVersion", "facilities"],
  additionalProperties: false,
  properties: {
    contentId: { type: "string", const: "content.facilities", format: "stable-id", idNamespace: "content-file" },
    schemaVersion: { type: "integer", const: 1 },
    facilities: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        itemIdField: "facilityId",
        required: [
          "facilityId",
          "displayName",
          "kind",
          "stage",
          "costG",
          "unlockReputation",
          "effect",
          "effectiveTiming",
        ],
        additionalProperties: false,
        properties: {
          facilityId: { type: "string", format: "stable-id", idNamespace: "facility" },
          displayName: { type: "string", minLength: 1 },
          kind: { type: "string", enum: ["KITCHEN", "HALL", "STORAGE"] },
          stage: { type: "integer", const: 1 },
          costG: { type: "integer", minimum: 1 },
          unlockReputation: { type: "number", format: "quality" },
          effect: {
            type: "object",
            required: ["type", "value", "unit"],
            additionalProperties: false,
            properties: {
              type: {
                type: "string",
                enum: [
                  "TIMING_WINDOW_BONUS_MS",
                  "PATIENCE_BONUS_MS",
                  "MARKET_PURCHASE_LIMIT_BONUS_QUANTITY",
                ],
              },
              value: { type: "integer", minimum: 1 },
              unit: { type: "string", enum: ["MILLISECONDS", "QUANTITY"] },
            },
          },
          effectiveTiming: { type: "string", const: "SAME_DAY" },
        },
      },
    },
  },
  invariants: ["canonical-facilities"],
};

const DIALOGUE_REGISTRY_SCHEMA = {
  type: "object",
  itemIdField: "contentId",
  required: ["contentId", "schemaVersion", "dialogues"],
  additionalProperties: false,
  properties: {
    contentId: { type: "string", const: "content.dialogue", format: "stable-id", idNamespace: "content-file" },
    schemaVersion: { type: "integer", const: 1 },
    dialogues: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        itemIdField: "dialogueId",
        required: [
          "dialogueId",
          "context",
          "speaker",
          "guestArchetypeId",
          "recipeId",
          "eventId",
          "text",
        ],
        additionalProperties: false,
        properties: {
          dialogueId: { type: "string", format: "stable-id", idNamespace: "dialogue" },
          context: {
            type: "string",
            enum: ["INTRO", "ORDER", "HURRY", "SATISFIED", "STOCKOUT", "TIMEOUT", "EVENT"],
          },
          speaker: { type: "string", enum: ["NARRATOR", "OWNER", "GUEST", "GUILD"] },
          guestArchetypeId: {
            type: ["string", "null"],
            format: "stable-id",
            referenceNamespace: "guest-archetype",
          },
          recipeId: {
            type: ["string", "null"],
            format: "stable-id",
            referenceNamespace: "recipe",
          },
          eventId: {
            type: ["string", "null"],
            format: "stable-id",
            referenceNamespace: "event",
          },
          text: { type: "string", minLength: 1, maxLength: 120 },
        },
      },
    },
  },
  invariants: ["canonical-dialogues"],
};

const GUEST_ARCHETYPE_REGISTRY_SCHEMA = {
  type: "object",
  itemIdField: "contentId",
  required: ["contentId", "schemaVersion", "guestArchetypes"],
  additionalProperties: false,
  properties: {
    contentId: { type: "string", const: "content.guests", format: "stable-id", idNamespace: "content-file" },
    schemaVersion: { type: "integer", const: 1 },
    guestArchetypes: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        itemIdField: "guestArchetypeId",
        required: [
          "guestArchetypeId",
          "displayName",
          "roleLabel",
          "classification",
          "visualCue",
          "assetId",
          "selectionWeight",
          "recipePreferenceWeights",
        ],
        additionalProperties: false,
        properties: {
          guestArchetypeId: { type: "string", format: "stable-id", idNamespace: "guest-archetype" },
          displayName: { type: "string", minLength: 1 },
          roleLabel: { type: "string", minLength: 1, maxLength: 40 },
          classification: {
            type: "string",
            enum: ["HUMAN", "FRIENDLY_NON_HUMAN", "FRIENDLY_MONSTER"],
          },
          visualCue: { type: "string", minLength: 1 },
          assetId: { type: "string", format: "stable-id" },
          selectionWeight: { type: "integer", minimum: 1 },
          recipePreferenceWeights: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              required: ["recipeId", "weight"],
              additionalProperties: false,
              properties: {
                recipeId: {
                  type: "string",
                  format: "stable-id",
                  referenceNamespace: "recipe",
                },
                weight: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
  invariants: ["canonical-guests"],
};

const EVENT_REGISTRY_SCHEMA = {
  type: "object",
  itemIdField: "contentId",
  required: ["contentId", "schemaVersion", "events"],
  additionalProperties: false,
  properties: {
    contentId: { type: "string", const: "content.events", format: "stable-id", idNamespace: "content-file" },
    schemaVersion: { type: "integer", const: 1 },
    events: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        itemIdField: "eventId",
        required: ["eventId", "displayName", "description", "selection", "durationDays", "modifiers"],
        additionalProperties: false,
        properties: {
          eventId: { type: "string", format: "stable-id", idNamespace: "event" },
          displayName: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          selection: { type: "string", enum: ["FIXED_DAY_1", "RANDOM_DAY_2_14"] },
          durationDays: { type: "integer", const: 1 },
          modifiers: {
            type: "object",
            required: [
              "guestCountDelta",
              "patienceDeltaMs",
              "timingWindowBonusMs",
              "marketPurchaseLimitBonusQuantity",
            ],
            additionalProperties: false,
            properties: {
              guestCountDelta: { type: "integer", minimum: -2, maximum: 2 },
              patienceDeltaMs: { type: "integer", minimum: 0, maximum: 10000 },
              timingWindowBonusMs: { type: "integer", minimum: 0, maximum: 500 },
              marketPurchaseLimitBonusQuantity: { type: "integer", minimum: 0, maximum: 20 },
            },
          },
        },
      },
    },
  },
  invariants: ["canonical-events"],
};

const BALANCE_CONFIG_SCHEMA = {
  type: "object",
  itemIdField: "contentId",
  required: [
    "contentId",
    "schemaVersion",
    "campaign",
    "bankruptcy",
    "economy",
    "service",
    "market",
    "contract",
    "world",
  ],
  additionalProperties: false,
  properties: {
    contentId: { type: "string", const: "content.balance", format: "stable-id", idNamespace: "content-file" },
    schemaVersion: { type: "integer", const: 1 },
    campaign: {
      type: "object",
      required: ["days", "startCashG", "startDebtG", "startReputation", "targetReputation"],
      additionalProperties: false,
      properties: {
        days: { type: "integer", const: 14 },
        startCashG: { type: "integer", const: 300 },
        startDebtG: { type: "integer", const: 500 },
        startReputation: { type: "integer", const: 30, format: "quality" },
        targetReputation: { type: "integer", const: 70, format: "quality" },
      },
    },
    bankruptcy: {
      type: "object",
      required: ["arrearsThresholdG", "consecutiveArrearsThreshold"],
      additionalProperties: false,
      properties: {
        arrearsThresholdG: { type: "integer", const: 80 },
        consecutiveArrearsThreshold: { type: "integer", const: 2 },
      },
    },
    economy: {
      type: "object",
      required: ["fixedCostG"],
      additionalProperties: false,
      properties: { fixedCostG: { type: "integer", const: 40, minimum: 20, maximum: 80 } },
    },
    service: {
      type: "object",
      required: [
        "durationMs",
        "minimumDurationMs",
        "maximumDurationMs",
        "defaultGuestCount",
        "minimumGuestCount",
        "maximumGuestCount",
        "basePatienceMs",
        "minimumPatienceMs",
        "maximumPatienceMs",
        "wrongServePenaltyMs",
        "cleanupOvertimeMs",
        "guestSpeedLogicalPxPerSecond",
        "reactionFrameMs",
        "reactionFrameCount",
      ],
      additionalProperties: false,
      properties: {
        durationMs: { type: "integer", const: 105000 },
        minimumDurationMs: { type: "integer", const: 90000 },
        maximumDurationMs: { type: "integer", const: 105000 },
        defaultGuestCount: { type: "integer", const: 6 },
        minimumGuestCount: { type: "integer", const: 4 },
        maximumGuestCount: { type: "integer", const: 12 },
        basePatienceMs: { type: "integer", const: 30000 },
        minimumPatienceMs: { type: "integer", const: 20000 },
        maximumPatienceMs: { type: "integer", const: 60000 },
        wrongServePenaltyMs: { type: "integer", const: 3000 },
        cleanupOvertimeMs: { type: "integer", const: 12000 },
        guestSpeedLogicalPxPerSecond: { type: "integer", const: 96 },
        reactionFrameMs: { type: "integer", const: 120 },
        reactionFrameCount: { type: "integer", const: 4 },
      },
    },
    market: {
      type: "object",
      required: ["priceVariancePercent", "defaultPurchaseLimitQuantity"],
      additionalProperties: false,
      properties: {
        priceVariancePercent: { type: "integer", const: 20, format: "percentage" },
        defaultPurchaseLimitQuantity: { type: "integer", const: 30, minimum: 1 },
      },
    },
    contract: {
      type: "object",
      required: ["prepaidPercent", "arrivalDayOffset", "riskTiers"],
      additionalProperties: false,
      properties: {
        prepaidPercent: { type: "integer", const: 20, format: "percentage" },
        arrivalDayOffset: { type: "integer", const: 1 },
        riskTiers: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            itemIdField: "risk",
            required: ["risk", "successRate", "discountPercent"],
            additionalProperties: false,
            properties: {
              risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
              successRate: { type: "integer", format: "percentage" },
              discountPercent: { type: "integer", format: "percentage" },
            },
          },
        },
      },
    },
    world: {
      type: "object",
      required: [
        "baseMapId",
        "tileSize",
        "cameraViewportWidth",
        "cameraViewportHeight",
        "playerCollisionWidth",
        "playerCollisionHeight",
        "maximumMapAxis",
        "maximumMapArea",
        "maximumRegisteredMaps",
        "baseTableCount",
        "baseSeatsPerTable",
        "baseActiveSeatCount",
      ],
      additionalProperties: false,
      properties: {
        baseMapId: { type: "string", const: "map.base_restaurant", format: "stable-id" },
        tileSize: { type: "integer", const: 32 },
        cameraViewportWidth: { type: "integer", const: 480 },
        cameraViewportHeight: { type: "integer", const: 480 },
        playerCollisionWidth: { type: "integer", const: 20 },
        playerCollisionHeight: { type: "integer", const: 12 },
        maximumMapAxis: { type: "integer", const: 128 },
        maximumMapArea: { type: "integer", const: 16384 },
        maximumRegisteredMaps: { type: "integer", const: 16 },
        baseTableCount: { type: "integer", const: 6 },
        baseSeatsPerTable: { type: "integer", const: 2 },
        baseActiveSeatCount: { type: "integer", const: 12 },
      },
    },
  },
  invariants: ["canonical-balance"],
};

const CONTENT_MANIFEST_SCHEMA = {
  type: "object",
  itemIdField: "manifestId",
  required: ["schemaVersion", "manifestVersion", "contentVersion", "manifestId", "files"],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    manifestVersion: { type: "integer", const: 1 },
    contentVersion: { type: "integer", const: CANONICAL_CONTENT_VERSION },
    manifestId: { type: "string", const: "manifest.canonical-content.v1", format: "stable-id", idNamespace: "content-manifest" },
    files: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        itemIdField: "contentId",
        required: ["contentId", "filename", "schemaName", "schemaVersion", "required"],
        additionalProperties: false,
        properties: {
          contentId: { type: "string", format: "stable-id", referenceNamespace: "content-file" },
          filename: { type: "string", minLength: 1 },
          schemaName: {
            type: "string",
            enum: CANONICAL_CONTENT_FILE_CONTRACTS.map((entry) => entry.schemaName),
          },
          schemaVersion: { type: "integer", const: 1 },
          required: { type: "boolean", const: true },
        },
      },
    },
  },
  invariants: ["canonical-content-manifest"],
};

const CANONICAL_MIGRATION_REPORT_SCHEMA = {
  type: "object",
  itemIdField: "migrationId",
  required: [
    "reportSchemaVersion",
    "migrationId",
    "sourceFormat",
    "targetContentVersion",
    "status",
    "sourceFiles",
    "targetFiles",
    "idMappings",
    "decisions",
    "validation",
  ],
  additionalProperties: false,
  properties: {
    reportSchemaVersion: { type: "integer", const: 1 },
    migrationId: { type: "string", const: "migration.main-content-to-canonical.v1", format: "stable-id", idNamespace: "migration-report" },
    sourceFormat: { type: "string", const: "main.authored-draft-and-legacy.unversioned" },
    targetContentVersion: { type: "integer", const: 1 },
    status: { type: "string", const: "PASS" },
    sourceFiles: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        required: ["filename", "sha256", "classification"],
        additionalProperties: false,
        properties: {
          filename: { type: "string", minLength: 1 },
          sha256: { type: "string", minLength: 64, maxLength: 64, format: "stable-id" },
          classification: {
            type: "string",
            enum: ["MAIN_AUTHORED_CONTENT", "LEGACY_PLACEHOLDER"],
          },
        },
      },
    },
    targetFiles: {
      type: "array",
      minItems: 8,
      maxItems: 8,
      items: {
        type: "object",
        itemIdField: "contentId",
        required: ["filename", "contentId", "schemaName", "schemaVersion", "sha256"],
        additionalProperties: false,
        properties: {
          filename: { type: "string", minLength: 1 },
          contentId: { type: "string", format: "stable-id" },
          schemaName: { type: "string", minLength: 1 },
          schemaVersion: { type: "integer", const: 1 },
          sha256: { type: "string", minLength: 64, maxLength: 64, format: "stable-id" },
        },
      },
    },
    idMappings: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: [
          "domain",
          "sourceFile",
          "sourcePath",
          "sourceValue",
          "disposition",
          "targetId",
          "rationale",
        ],
        additionalProperties: false,
        properties: {
          domain: { type: "string", enum: ["INGREDIENT", "RECIPE", "FACILITY", "GUEST", "EVENT", "DIALOGUE"] },
          sourceFile: { type: ["string", "null"] },
          sourcePath: { type: ["string", "null"] },
          sourceValue: { type: ["string", "null"] },
          disposition: {
            type: "string",
            enum: [
              "MAPPED_LEGACY_VALUE",
              "REPLACED_EXAMPLE_PLACEHOLDER",
              "ADDED_FROM_APPROVED_PLAN",
              "OMITTED_EXAMPLE_PLACEHOLDER",
              "MAPPED_MAIN_CONTENT",
              "RETAINED_FOUNDATION_VALUE",
              "OMITTED_INCOMPATIBLE_VALUE",
            ],
          },
          targetId: { type: ["string", "null"], format: "stable-id" },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
    decisions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        itemIdField: "decisionId",
        required: ["decisionId", "authority", "field", "value", "rationale"],
        additionalProperties: false,
        properties: {
          decisionId: { type: "string", format: "stable-id", idNamespace: "migration-decision" },
          authority: { type: "string", minLength: 1 },
          field: { type: "string", minLength: 1 },
          value: { type: "any" },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
    validation: {
      type: "object",
      required: [
        "validatorStatus",
        "documentCount",
        "diagnosticCount",
        "danglingReferenceCount",
        "ingredientCount",
        "recipeCount",
        "startingRecipeCount",
        "guestCount",
        "friendlyNonHumanOrMonsterCount",
        "facilityCount",
        "eventCount",
      ],
      additionalProperties: false,
      properties: {
        validatorStatus: { type: "string", const: "PASS" },
        documentCount: { type: "integer", const: 8 },
        diagnosticCount: { type: "integer", const: 0 },
        danglingReferenceCount: { type: "integer", const: 0 },
        ingredientCount: { type: "integer", const: 10 },
        recipeCount: { type: "integer", const: 6 },
        startingRecipeCount: { type: "integer", minimum: 2 },
        guestCount: { type: "integer", const: 6 },
        friendlyNonHumanOrMonsterCount: { type: "integer", minimum: 3 },
        facilityCount: { type: "integer", const: 3 },
        eventCount: { type: "integer", minimum: 2 },
      },
    },
  },
  invariants: ["canonical-migration-report"],
};

const MAP_DEFINITION_CORE_SCHEMA = {
  type: "object",
  itemIdField: "mapId",
  required: ["schemaVersion", "mapId", "width", "height", "tileSize", "layers"],
  additionalProperties: true,
  properties: {
    schemaVersion: { type: "integer", minimum: 1 },
    mapId: { type: "string", format: "stable-id", idNamespace: "map" },
    width: { type: "integer", minimum: 1, maximum: 128 },
    height: { type: "integer", minimum: 1, maximum: 128 },
    tileSize: { type: "integer", const: 32 },
    layers: {
      type: "object",
      required: ["ground", "collision", "below", "above"],
      additionalProperties: false,
      properties: {
        ground: { type: "array" },
        collision: { type: "array", items: { type: "integer", enum: [0, 1] } },
        below: { type: "array" },
        above: { type: "array" },
      },
    },
  },
  invariants: ["map-core"],
};

const SAVE_STATE_CORE_SCHEMA = {
  type: "object",
  required: ["formatVersion", "checkpointPhase", "economy", "inventory", "menu", "campaign"],
  additionalProperties: true,
  properties: {
    formatVersion: { type: "integer", minimum: 1 },
    checkpointPhase: { type: "string", enum: ["PLANNING_READY", "TERMINAL"] },
    economy: {
      type: "object",
      required: ["cashG", "contractReserveG", "debtG", "arrearsG"],
      additionalProperties: true,
      properties: {
        cashG: { type: "integer", minimum: 0 },
        contractReserveG: { type: "integer", minimum: 0 },
        debtG: { type: "integer", minimum: 0 },
        arrearsG: { type: "integer", minimum: 0 },
      },
    },
    inventory: {
      type: "object",
      required: ["lots", "reservations"],
      additionalProperties: true,
      properties: {
        lots: {
          type: "array",
          items: {
            type: "object",
            itemIdField: "lotId",
            required: [
              "lotId",
              "ingredientId",
              "quantity",
              "unreservedQuantity",
              "quality",
              "bookCostG",
              "acquiredDay",
            ],
            additionalProperties: true,
            properties: {
              lotId: { type: "string", format: "stable-id", idNamespace: "lot" },
              ingredientId: { type: "string", format: "stable-id" },
              quantity: { type: "integer", minimum: 0 },
              unreservedQuantity: { type: "integer", minimum: 0 },
              quality: { type: "number", format: "quality" },
              bookCostG: { type: "integer", minimum: 0 },
              acquiredDay: { type: "integer", minimum: 1, maximum: 14 },
            },
          },
        },
        reservations: {
          type: "array",
          items: {
            type: "object",
            itemIdField: "reservationId",
            required: ["reservationId", "saleSlotId", "lotId", "ingredientId", "quantity"],
            additionalProperties: true,
            properties: {
              reservationId: { type: "string", format: "stable-id", idNamespace: "reservation" },
              saleSlotId: { type: "string", format: "stable-id", referenceNamespace: "sale-slot" },
              lotId: { type: "string", format: "stable-id", referenceNamespace: "lot" },
              ingredientId: { type: "string", format: "stable-id" },
              quantity: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    menu: {
      type: "object",
      required: ["saleSlots"],
      additionalProperties: true,
      properties: {
        saleSlots: {
          type: "array",
          items: {
            type: "object",
            itemIdField: "saleSlotId",
            required: ["saleSlotId", "recipeId", "state", "activeOrderId"],
            additionalProperties: true,
            properties: {
              saleSlotId: { type: "string", format: "stable-id", idNamespace: "sale-slot" },
              recipeId: { type: "string", format: "stable-id" },
              state: { type: "string", enum: ["AVAILABLE", "ASSIGNED", "SOLD"] },
              activeOrderId: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    campaign: {
      type: "object",
      required: ["day", "reputation", "processedCauseIds", "canonicalDayResults"],
      additionalProperties: true,
      properties: {
        day: { type: "integer", minimum: 1, maximum: 14 },
        reputation: { type: "number", format: "quality" },
        processedCauseIds: {
          type: "array",
          items: { type: "string", format: "stable-id", idNamespace: "processed-cause" },
        },
        canonicalDayResults: {
          type: "array",
          items: {
            type: "object",
            itemIdField: "resultId",
            required: ["resultId", "day"],
            additionalProperties: true,
            properties: {
              resultId: { type: "string", format: "stable-id", idNamespace: "day-result" },
              day: { type: "integer", minimum: 1, maximum: 14 },
            },
          },
        },
      },
    },
  },
  invariants: ["save-core"],
};

const API_PERCENTAGE_SCHEMA = {
  type: "object",
  required: ["rate"],
  additionalProperties: false,
  properties: { rate: { type: "number", format: "percentage" } },
};

export function createDefaultSchemaRegistry() {
  return new SchemaRegistry([
    [DATA_SCHEMA.INGREDIENT_REGISTRY_V1, INGREDIENT_REGISTRY_SCHEMA],
    [DATA_SCHEMA.RECIPE_REGISTRY_V1, RECIPE_REGISTRY_SCHEMA],
    [DATA_SCHEMA.CANONICAL_INGREDIENT_REGISTRY_V1, CANONICAL_INGREDIENT_REGISTRY_SCHEMA],
    [DATA_SCHEMA.CANONICAL_RECIPE_REGISTRY_V1, CANONICAL_RECIPE_REGISTRY_SCHEMA],
    [DATA_SCHEMA.FACILITY_REGISTRY_V1, FACILITY_REGISTRY_SCHEMA],
    [DATA_SCHEMA.DIALOGUE_REGISTRY_V1, DIALOGUE_REGISTRY_SCHEMA],
    [DATA_SCHEMA.GUEST_ARCHETYPE_REGISTRY_V1, GUEST_ARCHETYPE_REGISTRY_SCHEMA],
    [DATA_SCHEMA.EVENT_REGISTRY_V1, EVENT_REGISTRY_SCHEMA],
    [DATA_SCHEMA.BALANCE_CONFIG_V1, BALANCE_CONFIG_SCHEMA],
    [DATA_SCHEMA.CONTENT_MANIFEST_V1, CONTENT_MANIFEST_SCHEMA],
    [DATA_SCHEMA.CANONICAL_MIGRATION_REPORT_V1, CANONICAL_MIGRATION_REPORT_SCHEMA],
    [DATA_SCHEMA.MAP_DEFINITION_CORE_V1, MAP_DEFINITION_CORE_SCHEMA],
    [DATA_SCHEMA.SAVE_STATE_CORE_V1, SAVE_STATE_CORE_SCHEMA],
    [DATA_SCHEMA.API_PERCENTAGE_V1, API_PERCENTAGE_SCHEMA],
  ]);
}
