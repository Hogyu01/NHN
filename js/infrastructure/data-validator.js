import {
  compareDiagnostics,
  createDiagnostic,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import { createDefaultSchemaRegistry } from "./schema-registry.js";

export const VALIDATION_BOUNDARY = Object.freeze({
  STATIC_REQUIRED: "STATIC_REQUIRED",
  STATIC_OPTIONAL: "STATIC_OPTIONAL",
  MAP_BASE: "MAP_BASE",
  MAP_OPTIONAL: "MAP_OPTIONAL",
  SAVE: "SAVE",
  API: "API",
});

export const VALIDATION_ERROR_TYPE = Object.freeze({
  FIELD: "FIELD_ERROR",
  TYPE: "TYPE_ERROR",
  ID: "ID_ERROR",
  RANGE: "RANGE_ERROR",
  REFERENCE: "REFERENCE_ERROR",
  INVARIANT: "INVARIANT_ERROR",
  SCHEMA: "SCHEMA_ERROR",
  PARSE: "PARSE_ERROR",
  LOAD: "LOAD_ERROR",
});

const BOUNDARY_SEVERITY = Object.freeze({
  [VALIDATION_BOUNDARY.STATIC_REQUIRED]: DIAGNOSTIC_SEVERITY.FATAL_BOOT,
  [VALIDATION_BOUNDARY.STATIC_OPTIONAL]: DIAGNOSTIC_SEVERITY.QUARANTINED_CONTENT,
  [VALIDATION_BOUNDARY.MAP_BASE]: DIAGNOSTIC_SEVERITY.FATAL_BOOT,
  [VALIDATION_BOUNDARY.MAP_OPTIONAL]: DIAGNOSTIC_SEVERITY.QUARANTINED_CONTENT,
  [VALIDATION_BOUNDARY.SAVE]: DIAGNOSTIC_SEVERITY.BLOCKING_STATE,
  [VALIDATION_BOUNDARY.API]: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
});

const BLOCKING_SEVERITIES = new Set([
  DIAGNOSTIC_SEVERITY.FATAL_BOOT,
  DIAGNOSTIC_SEVERITY.BLOCKING_STATE,
  DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT,
]);

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const QUALITY_WEIGHT_TOLERANCE = 0.000001;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field}는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value;
}

function sourceOf(document) {
  return requireText(document.filename ?? document.storageKey, "filename/storageKey");
}

function fieldPath(parent, key) {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent === "$" ? `$.${key}` : `${parent}.${key}`;
}

function actualType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isSafeInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value, expected) {
  if (expected === "any") return true;
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return isPlainObject(value);
  if (expected === "integer") return Number.isSafeInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function matchesAnyType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected ?? "any"];
  return types.some((type) => typeMatches(value, type));
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left && right && typeof left === "object" && typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function safeIdentifier(value) {
  return String(value).replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 120) || "none";
}

export function resolveValidationSeverity(boundary) {
  const severity = BOUNDARY_SEVERITY[boundary];
  if (!severity) throw new TypeError(`알 수 없는 validation boundary입니다: ${boundary}`);
  return severity;
}

function classifySeverity(severity) {
  if (severity === DIAGNOSTIC_SEVERITY.FATAL_BOOT) return "FATAL";
  if (severity === DIAGNOSTIC_SEVERITY.QUARANTINED_CONTENT) return "QUARANTINED";
  if (severity === DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND) return "RECOVERABLE";
  if (severity === DIAGNOSTIC_SEVERITY.BLOCKING_STATE) return "BLOCKING";
  return "INTERNAL";
}

function summarize(diagnostics) {
  const counts = {
    fatal: 0,
    blocking: 0,
    quarantined: 0,
    recoverable: 0,
    internal: 0,
  };
  for (const diagnostic of diagnostics) {
    const classification = classifySeverity(diagnostic.severity).toLowerCase();
    counts[classification] += 1;
  }
  return freezeDeep({
    total: diagnostics.length,
    ...counts,
    hasBlocking: diagnostics.some((diagnostic) => BLOCKING_SEVERITIES.has(diagnostic.severity)),
  });
}

/**
 * Pure, coercion-free schema/reference/invariant validator shared by browser and Node loaders.
 */
export class DataValidator {
  constructor({ registry = createDefaultSchemaRegistry() } = {}) {
    this.registry = registry;
  }

  validate(document) {
    return this.validateDocuments([document]);
  }

  validateDocuments(documents) {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new TypeError("documents는 하나 이상의 validation document 배열이어야 합니다.");
    }

    const diagnosticsByDocument = documents.map(() => []);
    const idNamespaces = new Map();
    const pendingReferences = [];
    let issueSequence = 0;

    const addIssue = (documentIndex, issue) => {
      const document = documents[documentIndex];
      const source = sourceOf(document);
      const boundary = document.boundary ?? VALIDATION_BOUNDARY.STATIC_REQUIRED;
      const diagnostic = createDiagnostic({
        diagnosticId: [
          "diagnostic",
          safeIdentifier(source),
          safeIdentifier(issue.errorType),
          safeIdentifier(issue.code),
          safeIdentifier(issue.path),
          String(issueSequence).padStart(6, "0"),
        ].join(":"),
        severity: resolveValidationSeverity(boundary),
        subsystem: "DataValidator",
        filename: source,
        errorType: issue.errorType,
        code: issue.code,
        itemId: issue.itemId,
        fieldPath: issue.path,
        details: issue.details,
      });
      issueSequence += 1;
      diagnosticsByDocument[documentIndex].push(diagnostic);
      return diagnostic;
    };

    const registerId = (namespace, value, context) => {
      let values = idNamespaces.get(namespace);
      if (!values) {
        values = new Map();
        idNamespaces.set(namespace, values);
      }
      const first = values.get(value);
      if (first) {
        addIssue(context.documentIndex, {
          errorType: VALIDATION_ERROR_TYPE.ID,
          code: "DUPLICATE_ID",
          path: context.path,
          itemId: context.itemId ?? value,
          details: {
            namespace,
            value,
            firstSource: sourceOf(documents[first.documentIndex]),
            firstFieldPath: first.path,
          },
        });
        return;
      }
      values.set(value, context);
    };

    const applyFormat = (value, schema, context) => {
      if (!schema.format) return;
      if (schema.format === "stable-id") {
        if (typeof value === "string" && !STABLE_ID_PATTERN.test(value)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.ID,
            code: "ID_FORMAT_INVALID",
            path: context.path,
            itemId: context.itemId,
            details: { value },
          });
        }
        return;
      }
      if (schema.format === "percentage") {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        if (!Number.isSafeInteger(value)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: value > 0 && value < 1
              ? "PERCENTAGE_NORMALIZED_RATIO_FORBIDDEN"
              : "PERCENTAGE_INTEGER_REQUIRED",
            path: context.path,
            itemId: context.itemId,
            details: { value, expected: "integer percentage 0..100" },
          });
        } else if (value < 0 || value > 100) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "PERCENTAGE_OUT_OF_RANGE",
            path: context.path,
            itemId: context.itemId,
            details: { value, minimum: 0, maximum: 100 },
          });
        }
        return;
      }
      if (schema.format === "quality") {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        const code = !Number.isSafeInteger(value)
          ? "QUALITY_INTEGER_REQUIRED"
          : value < 0 || value > 100
            ? "QUALITY_OUT_OF_RANGE"
            : null;
        if (code) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code,
            path: context.path,
            itemId: context.itemId,
            details: { value, minimum: 0, maximum: 100 },
          });
        }
        return;
      }
      if (schema.format === "quality-distribution") {
        if (!Array.isArray(value)) return;
        let weightSum = 0;
        let allWeightsFinite = true;
        value.forEach((entry, index) => {
          if (!isPlainObject(entry)) return;
          if (typeof entry.weight !== "number" || !Number.isFinite(entry.weight)) {
            allWeightsFinite = false;
          } else {
            weightSum += entry.weight;
          }
          if (
            Number.isSafeInteger(entry.minQuality) &&
            Number.isSafeInteger(entry.maxQuality) &&
            entry.minQuality > entry.maxQuality
          ) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "QUALITY_DISTRIBUTION_BOUNDARY_ORDER",
              path: fieldPath(context.path, index),
              itemId: context.itemId,
              details: { minQuality: entry.minQuality, maxQuality: entry.maxQuality },
            });
          }
        });
        if (allWeightsFinite && Math.abs(weightSum - 1) > QUALITY_WEIGHT_TOLERANCE) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "QUALITY_DISTRIBUTION_WEIGHT_SUM",
            path: context.path,
            itemId: context.itemId,
            details: { actual: weightSum, expected: 1, tolerance: QUALITY_WEIGHT_TOLERANCE },
          });
        }
        return;
      }
      addIssue(context.documentIndex, {
        errorType: VALIDATION_ERROR_TYPE.SCHEMA,
        code: "SCHEMA_FORMAT_UNKNOWN",
        path: context.path,
        itemId: context.itemId,
        details: { format: schema.format },
      });
    };

    const runInvariant = (invariantId, value, context) => {
      if (invariantId === "recipe-timing") {
        if (!isPlainObject(value)) return;
        const { successWindowMs, normalWindowMs, failureOffsetMs } = value;
        if (
          Number.isSafeInteger(successWindowMs) &&
          Number.isSafeInteger(normalWindowMs) &&
          Number.isSafeInteger(failureOffsetMs) &&
          !(successWindowMs <= normalWindowMs && normalWindowMs < failureOffsetMs)
        ) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "RECIPE_TIMING_ORDER_INVALID",
            path: context.path,
            itemId: context.itemId,
            details: { successWindowMs, normalWindowMs, failureOffsetMs },
          });
        }
        return;
      }

      if (invariantId === "map-core") {
        if (!isPlainObject(value)) return;
        const { width, height, layers } = value;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return;
        const area = width * height;
        if (!Number.isSafeInteger(area) || area > 16_384) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "MAP_AREA_OUT_OF_RANGE",
            path: context.path,
            itemId: context.itemId,
            details: { width, height, area, maximum: 16_384 },
          });
        }
        if (isPlainObject(layers)) {
          for (const layerName of ["ground", "collision", "below", "above"]) {
            if (Array.isArray(layers[layerName]) && layers[layerName].length !== area) {
              addIssue(context.documentIndex, {
                errorType: VALIDATION_ERROR_TYPE.INVARIANT,
                code: "MAP_LAYER_LENGTH_MISMATCH",
                path: `${context.path}.layers.${layerName}`,
                itemId: context.itemId,
                details: { expected: area, actual: layers[layerName].length, layerName },
              });
            }
          }
        }
        return;
      }

      if (invariantId === "save-core") {
        if (!isPlainObject(value)) return;
        const economy = value.economy;
        if (
          isPlainObject(economy) &&
          Number.isSafeInteger(economy.cashG) &&
          Number.isSafeInteger(economy.contractReserveG) &&
          economy.contractReserveG > economy.cashG
        ) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "SAVE_RESERVE_EXCEEDS_CASH",
            path: `${context.path}.economy.contractReserveG`,
            details: { cashG: economy.cashG, contractReserveG: economy.contractReserveG },
          });
        }

        const lots = Array.isArray(value.inventory?.lots) ? value.inventory.lots : [];
        const reservations = Array.isArray(value.inventory?.reservations) ? value.inventory.reservations : [];
        const reservedByLot = new Map();
        for (const reservation of reservations) {
          if (!isPlainObject(reservation) || typeof reservation.lotId !== "string" || !Number.isSafeInteger(reservation.quantity)) continue;
          reservedByLot.set(reservation.lotId, (reservedByLot.get(reservation.lotId) ?? 0) + reservation.quantity);
        }
        for (const lot of lots) {
          if (!isPlainObject(lot) || typeof lot.lotId !== "string") continue;
          const reserved = reservedByLot.get(lot.lotId) ?? 0;
          if (
            Number.isSafeInteger(lot.quantity) &&
            Number.isSafeInteger(lot.unreservedQuantity) &&
            lot.quantity !== lot.unreservedQuantity + reserved
          ) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "SAVE_LOT_RESERVATION_MISMATCH",
              path: `${context.path}.inventory.lots`,
              itemId: lot.lotId,
              details: {
                quantity: lot.quantity,
                unreservedQuantity: lot.unreservedQuantity,
                reservedQuantity: reserved,
              },
            });
          }
        }

        const slots = Array.isArray(value.menu?.saleSlots) ? value.menu.saleSlots : [];
        for (const slot of slots) {
          if (!isPlainObject(slot)) continue;
          const assignedHasOrder = slot.state === "ASSIGNED" && typeof slot.activeOrderId === "string" && slot.activeOrderId.length > 0;
          const unassignedHasNoOrder = slot.state !== "ASSIGNED" && slot.activeOrderId === null;
          if (!assignedHasOrder && !unassignedHasNoOrder) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "SAVE_SLOT_ORDER_MISMATCH",
              path: `${context.path}.menu.saleSlots`,
              itemId: slot.saleSlotId,
              details: { state: slot.state, activeOrderId: slot.activeOrderId },
            });
          }
        }

        const results = Array.isArray(value.campaign?.canonicalDayResults)
          ? value.campaign.canonicalDayResults
          : [];
        const seenDays = new Set();
        for (const result of results) {
          if (!isPlainObject(result) || !Number.isSafeInteger(result.day)) continue;
          if (seenDays.has(result.day)) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "SAVE_DUPLICATE_DAY_RESULT",
              path: `${context.path}.campaign.canonicalDayResults`,
              itemId: result.resultId,
              details: { day: result.day },
            });
          }
          seenDays.add(result.day);
        }
        return;
      }

      if (invariantId === "integer-range") {
        if (!isPlainObject(value)) return;
        if (
          Number.isSafeInteger(value.minimum) &&
          Number.isSafeInteger(value.maximum) &&
          value.minimum > value.maximum
        ) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "INTEGER_RANGE_ORDER_INVALID",
            path: context.path,
            itemId: context.itemId,
            details: { minimum: value.minimum, maximum: value.maximum },
          });
        }
        return;
      }

      if (invariantId === "recipe-unlock") {
        if (!isPlainObject(value)) return;
        const startingIsValid = value.type === "STARTING" && value.reputationThreshold === null;
        const reputationIsValid = value.type === "REPUTATION" &&
          Number.isSafeInteger(value.reputationThreshold) &&
          value.reputationThreshold >= 0 &&
          value.reputationThreshold <= 100;
        if (!startingIsValid && !reputationIsValid) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "RECIPE_UNLOCK_CONTRACT_INVALID",
            path: context.path,
            itemId: context.itemId,
            details: {
              type: value.type,
              reputationThreshold: value.reputationThreshold,
            },
          });
        }
        return;
      }

      if (invariantId === "canonical-ingredients") {
        if (!isPlainObject(value) || !Array.isArray(value.ingredients)) return;
        const expectedIds = [
          "ingredient.cave_mushroom",
          "ingredient.crystal_salt",
          "ingredient.ember_pepper",
          "ingredient.glow_herb",
          "ingredient.griffin_egg",
          "ingredient.mimic_bean",
          "ingredient.moonroot",
          "ingredient.moss_cheese",
          "ingredient.slime_gel",
          "ingredient.stonegrain",
        ];
        const actualIds = value.ingredients
          .map((entry) => entry?.ingredientId)
          .filter((entry) => typeof entry === "string")
          .sort();
        if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "CANONICAL_INGREDIENT_ID_SET_INVALID",
            path: `${context.path}.ingredients`,
            details: { expectedIds, actualIds },
          });
        }
        for (const ingredient of value.ingredients) {
          const distribution = ingredient?.qualityDistribution;
          if (!Array.isArray(distribution) || distribution.length === 0) continue;
          const ordered = [...distribution].sort((left, right) => left.minQuality - right.minQuality);
          let expectedMinimum = 0;
          let validCoverage = true;
          for (const band of ordered) {
            if (!Number.isSafeInteger(band?.minQuality) || !Number.isSafeInteger(band?.maxQuality)) {
              validCoverage = false;
              break;
            }
            if (band.minQuality !== expectedMinimum) validCoverage = false;
            expectedMinimum = band.maxQuality + 1;
          }
          if (expectedMinimum !== 101) validCoverage = false;
          if (!validCoverage) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "QUALITY_DISTRIBUTION_COVERAGE_INVALID",
              path: `${context.path}.ingredients`,
              itemId: ingredient?.ingredientId,
              details: { expectedCoverage: "0..100 contiguous" },
            });
          }
        }
        return;
      }

      if (invariantId === "canonical-recipes") {
        if (!isPlainObject(value) || !Array.isArray(value.recipes)) return;
        const expectedIds = [
          "recipe.ember_egg_skewer",
          "recipe.glowcap_soup",
          "recipe.mimic_hotpot",
          "recipe.moonroot_pie",
          "recipe.slime_stew",
          "recipe.stonegrain_bowl",
        ];
        const actualIds = value.recipes
          .map((entry) => entry?.recipeId)
          .filter((entry) => typeof entry === "string")
          .sort();
        if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "CANONICAL_RECIPE_ID_SET_INVALID",
            path: `${context.path}.recipes`,
            details: { expectedIds, actualIds },
          });
        }
        const startingCount = value.recipes.filter((recipe) => recipe?.unlock?.type === "STARTING").length;
        if (startingCount < 2) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "CANONICAL_STARTING_RECIPE_COUNT_INVALID",
            path: `${context.path}.recipes`,
            details: { minimum: 2, actual: startingCount },
          });
        }
        for (const recipe of value.recipes) {
          const requirements = Array.isArray(recipe?.ingredientRequirements)
            ? recipe.ingredientRequirements
            : [];
          const ids = requirements.map((entry) => entry?.ingredientId).filter(Boolean);
          if (new Set(ids).size !== ids.length) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "RECIPE_DUPLICATE_INGREDIENT_REFERENCE",
              path: `${context.path}.recipes`,
              itemId: recipe?.recipeId,
              details: { ingredientIds: ids },
            });
          }
          const timing = recipe?.timing;
          if (
            isPlainObject(timing) &&
            Number.isSafeInteger(timing.targetOffsetMs) &&
            Number.isSafeInteger(timing.normalWindowMs) &&
            Number.isSafeInteger(timing.failureOffsetMs) &&
            timing.targetOffsetMs + timing.normalWindowMs >= timing.failureOffsetMs
          ) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "RECIPE_FAILURE_DEADLINE_TOO_EARLY",
              path: `${context.path}.recipes`,
              itemId: recipe?.recipeId,
              details: { ...timing },
            });
          }
        }
        return;
      }

      if (invariantId === "canonical-facilities") {
        if (!isPlainObject(value) || !Array.isArray(value.facilities)) return;
        const expectedEffectByKind = {
          KITCHEN: ["TIMING_WINDOW_BONUS_MS", "MILLISECONDS"],
          HALL: ["PATIENCE_BONUS_MS", "MILLISECONDS"],
          STORAGE: ["MARKET_PURCHASE_LIMIT_BONUS_QUANTITY", "QUANTITY"],
        };
        for (const [kind, [effectType, unit]] of Object.entries(expectedEffectByKind)) {
          const matches = value.facilities.filter((facility) => facility?.kind === kind);
          if (matches.length !== 1) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "FACILITY_KIND_CARDINALITY_INVALID",
              path: `${context.path}.facilities`,
              details: { kind, expected: 1, actual: matches.length },
            });
            continue;
          }
          if (matches[0]?.effect?.type !== effectType || matches[0]?.effect?.unit !== unit) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "FACILITY_EFFECT_KIND_MISMATCH",
              path: `${context.path}.facilities`,
              itemId: matches[0]?.facilityId,
              details: { kind, expectedEffectType: effectType, expectedUnit: unit },
            });
          }
        }
        return;
      }

      if (invariantId === "canonical-guests") {
        if (!isPlainObject(value) || !Array.isArray(value.guestArchetypes)) return;
        const humanCount = value.guestArchetypes.filter((guest) => guest?.classification === "HUMAN").length;
        const friendlyCount = value.guestArchetypes.filter((guest) =>
          guest?.classification === "FRIENDLY_NON_HUMAN" ||
          guest?.classification === "FRIENDLY_MONSTER").length;
        if (humanCount < 1 || friendlyCount < 3) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "GUEST_COMPOSITION_INVALID",
            path: `${context.path}.guestArchetypes`,
            details: { humanMinimum: 1, humanCount, friendlyMinimum: 3, friendlyCount },
          });
        }
        const selectionWeight = value.guestArchetypes.reduce(
          (sum, guest) => sum + (Number.isSafeInteger(guest?.selectionWeight) ? guest.selectionWeight : 0),
          0,
        );
        if (selectionWeight !== 100) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "GUEST_SELECTION_WEIGHT_SUM_INVALID",
            path: `${context.path}.guestArchetypes`,
            details: { expected: 100, actual: selectionWeight },
          });
        }
        const forbiddenTokens = new Set(["ATTACK", "COMBAT", "DAMAGE", "LOOT"]);
        const scanForbidden = (node) => {
          if (Array.isArray(node)) return node.some(scanForbidden);
          if (!isPlainObject(node)) {
            return typeof node === "string" && forbiddenTokens.has(node.toUpperCase());
          }
          return Object.entries(node).some(([key, child]) =>
            forbiddenTokens.has(key.toUpperCase()) || scanForbidden(child));
        };
        if (scanForbidden(value.guestArchetypes)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "GUEST_COMBAT_BOUNDARY_VIOLATION",
            path: `${context.path}.guestArchetypes`,
            details: { forbidden: [...forbiddenTokens].sort() },
          });
        }
        for (const guest of value.guestArchetypes) {
          const preferences = Array.isArray(guest?.recipePreferenceWeights)
            ? guest.recipePreferenceWeights
            : [];
          const ids = preferences.map((entry) => entry?.recipeId).filter(Boolean);
          if (new Set(ids).size !== ids.length) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "GUEST_DUPLICATE_RECIPE_PREFERENCE",
              path: `${context.path}.guestArchetypes`,
              itemId: guest?.guestArchetypeId,
              details: { recipeIds: ids },
            });
          }
        }
        return;
      }

      if (invariantId === "canonical-events") {
        if (!isPlainObject(value) || !Array.isArray(value.events)) return;
        const intro = value.events.filter((event) => event?.selection === "FIXED_DAY_1");
        const pool = value.events.filter((event) => event?.selection === "RANDOM_DAY_2_14");
        if (intro.length !== 1 || intro[0]?.eventId !== "event.intro_last_hearth") {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "EVENT_DAY_ONE_INTRO_INVALID",
            path: `${context.path}.events`,
            details: { expected: "event.intro_last_hearth", actualCount: intro.length },
          });
        }
        if (pool.length < 1) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "EVENT_MUST_POOL_EMPTY",
            path: `${context.path}.events`,
            details: { minimum: 1, actual: pool.length },
          });
        }
        for (const event of pool) {
          const modifiers = event?.modifiers;
          if (isPlainObject(modifiers) && Object.values(modifiers).every((modifier) => modifier === 0)) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "EVENT_POOL_MODIFIER_EMPTY",
              path: `${context.path}.events`,
              itemId: event?.eventId,
            });
          }
        }
        return;
      }

      if (invariantId === "canonical-dialogues") {
        if (!isPlainObject(value) || !Array.isArray(value.dialogues)) return;
        const introCount = value.dialogues.filter((entry) => entry?.context === "INTRO").length;
        if (introCount < 1) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "DIALOGUE_INTRO_MISSING",
            path: `${context.path}.dialogues`,
          });
        }
        const guestIds = [
          "guest.human_adventurer",
          "guest.dwarf_courier",
          "guest.goblin_scholar",
          "guest.slime_gourmand",
          "guest.kobold_porter",
          "guest.mushroom_traveler",
        ];
        for (const guestId of guestIds) {
          const contexts = new Set(value.dialogues
            .filter((entry) => entry?.guestArchetypeId === guestId)
            .map((entry) => entry?.context));
          const missing = ["ORDER", "HURRY", "SATISFIED"].filter((entry) => !contexts.has(entry));
          if (missing.length > 0) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "GUEST_DIALOGUE_CONTEXT_MISSING",
              path: `${context.path}.dialogues`,
              itemId: guestId,
              details: { missing },
            });
          }
        }
        return;
      }

      if (invariantId === "canonical-balance") {
        if (!isPlainObject(value)) return;
        const reactionDuration = value.service?.reactionFrameMs * value.service?.reactionFrameCount;
        if (reactionDuration !== 480) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "MEAL_REACTION_DURATION_INVALID",
            path: `${context.path}.service`,
            details: { expected: 480, actual: reactionDuration },
          });
        }
        const expectedRisk = {
          LOW: [90, 5],
          MEDIUM: [70, 15],
          HIGH: [50, 30],
        };
        const riskTiers = Array.isArray(value.contract?.riskTiers) ? value.contract.riskTiers : [];
        for (const [risk, [successRate, discountPercent]] of Object.entries(expectedRisk)) {
          const matches = riskTiers.filter((entry) => entry?.risk === risk);
          if (
            matches.length !== 1 ||
            matches[0]?.successRate !== successRate ||
            matches[0]?.discountPercent !== discountPercent
          ) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.INVARIANT,
              code: "CONTRACT_RISK_TABLE_INVALID",
              path: `${context.path}.contract.riskTiers`,
              itemId: risk,
              details: { successRate, discountPercent, actual: matches },
            });
          }
        }
        return;
      }

      if (invariantId === "canonical-content-manifest") {
        if (!isPlainObject(value) || !Array.isArray(value.files)) return;
        const expected = [
          ["content.ingredients", "data/ingredients.json", "ingredient-registry.canonical.v1"],
          ["content.recipes", "data/recipes.json", "recipe-registry.canonical.v1"],
          ["content.facilities", "data/upgrades.json", "facility-registry.v1"],
          ["content.dialogue", "data/dialogue.json", "dialogue-registry.v1"],
          ["content.guests", "data/guests.json", "guest-archetype-registry.v1"],
          ["content.events", "data/events.json", "event-registry.v1"],
          ["content.balance", "data/balance.json", "balance-config.v1"],
        ].sort((left, right) => left[0].localeCompare(right[0], "en"));
        const actual = value.files.map((entry) => [
          entry?.contentId,
          entry?.filename,
          entry?.schemaName,
        ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]), "en"));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "CONTENT_MANIFEST_CONTRACT_MISMATCH",
            path: `${context.path}.files`,
            details: { expected, actual },
          });
        }
        return;
      }

      if (invariantId === "canonical-migration-report") {
        if (!isPlainObject(value)) return;
        const expectedSources = [
          "data/dialogue.json",
          "data/ingredients.json",
          "data/recipes.json",
          "data/upgrades.json",
        ];
        const actualSources = Array.isArray(value.sourceFiles)
          ? value.sourceFiles.map((entry) => entry?.filename).sort()
          : [];
        const expectedTargets = [
          "data/balance.json",
          "data/content-manifest.json",
          "data/dialogue.json",
          "data/events.json",
          "data/guests.json",
          "data/ingredients.json",
          "data/recipes.json",
          "data/upgrades.json",
        ];
        const actualTargets = Array.isArray(value.targetFiles)
          ? value.targetFiles.map((entry) => entry?.filename).sort()
          : [];
        if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "MIGRATION_SOURCE_SET_INVALID",
            path: `${context.path}.sourceFiles`,
            details: { expectedSources, actualSources },
          });
        }
        if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "MIGRATION_TARGET_SET_INVALID",
            path: `${context.path}.targetFiles`,
            details: { expectedTargets, actualTargets },
          });
        }
        if (
          value.validation?.validatorStatus !== "PASS" ||
          value.validation?.diagnosticCount !== 0 ||
          value.validation?.danglingReferenceCount !== 0
        ) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.INVARIANT,
            code: "MIGRATION_VALIDATION_NOT_CLEAN",
            path: `${context.path}.validation`,
            details: value.validation,
          });
        }
        return;
      }

      addIssue(context.documentIndex, {
        errorType: VALIDATION_ERROR_TYPE.SCHEMA,
        code: "SCHEMA_INVARIANT_UNKNOWN",
        path: context.path,
        itemId: context.itemId,
        details: { invariantId },
      });
    };

    const walk = (value, schema, context) => {
      const expectedType = schema.type ?? "any";
      if (!matchesAnyType(value, expectedType)) {
        addIssue(context.documentIndex, {
          errorType: VALIDATION_ERROR_TYPE.TYPE,
          code: "TYPE_MISMATCH",
          path: context.path,
          itemId: context.itemId,
          details: { expected: expectedType, actual: actualType(value) },
        });
        return;
      }

      if (schema.const !== undefined && !sameValue(value, schema.const)) {
        addIssue(context.documentIndex, {
          errorType: VALIDATION_ERROR_TYPE.FIELD,
          code: "FIELD_CONST_MISMATCH",
          path: context.path,
          itemId: context.itemId,
          details: { expected: schema.const, actual: value },
        });
      }
      if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameValue(candidate, value))) {
        addIssue(context.documentIndex, {
          errorType: VALIDATION_ERROR_TYPE.FIELD,
          code: "FIELD_ENUM_MISMATCH",
          path: context.path,
          itemId: context.itemId,
          details: { allowed: schema.enum, actual: value },
        });
      }

      if (typeof value === "number" && Number.isFinite(value)) {
        if (schema.minimum !== undefined && value < schema.minimum) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "VALUE_BELOW_MINIMUM",
            path: context.path,
            itemId: context.itemId,
            details: { minimum: schema.minimum, actual: value },
          });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "VALUE_ABOVE_MAXIMUM",
            path: context.path,
            itemId: context.itemId,
            details: { maximum: schema.maximum, actual: value },
          });
        }
      }

      if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "STRING_TOO_SHORT",
            path: context.path,
            itemId: context.itemId,
            details: { minimum: schema.minLength, actual: value.length },
          });
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "STRING_TOO_LONG",
            path: context.path,
            itemId: context.itemId,
            details: { maximum: schema.maxLength, actual: value.length },
          });
        }
      }

      let itemId = context.itemId;
      if (isPlainObject(value) && typeof schema.itemIdField === "string") {
        const candidate = value[schema.itemIdField];
        if (typeof candidate === "string" && candidate.length > 0) itemId = candidate;
      }
      const nextContext = { ...context, itemId };
      applyFormat(value, schema, nextContext);

      if (schema.idNamespace && typeof value === "string" && STABLE_ID_PATTERN.test(value)) {
        registerId(schema.idNamespace, value, nextContext);
      }
      if (schema.referenceNamespace && typeof value === "string" && STABLE_ID_PATTERN.test(value)) {
        pendingReferences.push({
          namespace: schema.referenceNamespace,
          value,
          ...nextContext,
        });
      }

      if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "ARRAY_TOO_SHORT",
            path: context.path,
            itemId,
            details: { minimum: schema.minItems, actual: value.length },
          });
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
          addIssue(context.documentIndex, {
            errorType: VALIDATION_ERROR_TYPE.RANGE,
            code: "ARRAY_TOO_LONG",
            path: context.path,
            itemId,
            details: { maximum: schema.maxItems, actual: value.length },
          });
        }
        if (schema.items) {
          value.forEach((entry, index) => walk(entry, schema.items, {
            ...nextContext,
            path: fieldPath(context.path, index),
          }));
        }
      }

      if (isPlainObject(value)) {
        const properties = isPlainObject(schema.properties) ? schema.properties : {};
        for (const requiredField of schema.required ?? []) {
          if (!Object.prototype.hasOwnProperty.call(value, requiredField)) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.FIELD,
              code: "FIELD_REQUIRED",
              path: fieldPath(context.path, requiredField),
              itemId,
              details: { field: requiredField },
            });
          }
        }
        for (const [key, childValue] of Object.entries(value)) {
          const childSchema = properties[key];
          if (childSchema) {
            walk(childValue, childSchema, {
              ...nextContext,
              path: fieldPath(context.path, key),
            });
          } else if (schema.additionalProperties === false) {
            addIssue(context.documentIndex, {
              errorType: VALIDATION_ERROR_TYPE.FIELD,
              code: "FIELD_UNKNOWN",
              path: fieldPath(context.path, key),
              itemId,
              details: { field: key },
            });
          } else if (isPlainObject(schema.additionalProperties)) {
            walk(childValue, schema.additionalProperties, {
              ...nextContext,
              path: fieldPath(context.path, key),
            });
          }
        }
      }

      for (const invariantId of schema.invariants ?? []) {
        runInvariant(invariantId, value, nextContext);
      }
    };

    documents.forEach((document, documentIndex) => {
      const schemaName = requireText(document.schemaName, "schemaName");
      sourceOf(document);
      const boundary = document.boundary ?? VALIDATION_BOUNDARY.STATIC_REQUIRED;
      resolveValidationSeverity(boundary);
      if (!this.registry.has(schemaName)) {
        addIssue(documentIndex, {
          errorType: VALIDATION_ERROR_TYPE.SCHEMA,
          code: "SCHEMA_NOT_REGISTERED",
          path: "$",
          details: { schemaName },
        });
        return;
      }
      walk(document.data, this.registry.get(schemaName), {
        documentIndex,
        path: "$",
        itemId: undefined,
      });
    });

    for (const reference of pendingReferences) {
      if (!idNamespaces.get(reference.namespace)?.has(reference.value)) {
        addIssue(reference.documentIndex, {
          errorType: VALIDATION_ERROR_TYPE.REFERENCE,
          code: "REFERENCE_NOT_FOUND",
          path: reference.path,
          itemId: reference.itemId,
          details: { namespace: reference.namespace, value: reference.value },
        });
      }
    }

    const allDiagnostics = diagnosticsByDocument.flat().sort(compareDiagnostics);
    const documentResults = documents.map((document, index) => {
      const diagnostics = Object.freeze([...diagnosticsByDocument[index]].sort(compareDiagnostics));
      const boundary = document.boundary ?? VALIDATION_BOUNDARY.STATIC_REQUIRED;
      return Object.freeze({
        source: sourceOf(document),
        schemaName: document.schemaName,
        boundary,
        classification: classifySeverity(resolveValidationSeverity(boundary)),
        ok: diagnostics.length === 0,
        diagnostics,
      });
    });
    const summary = summarize(allDiagnostics);

    return Object.freeze({
      ok: allDiagnostics.length === 0,
      code: allDiagnostics.length === 0 ? "VALIDATION_PASSED" : "VALIDATION_FAILED",
      canStart: !summary.hasBlocking,
      diagnostics: Object.freeze(allDiagnostics),
      documentResults: Object.freeze(documentResults),
      summary,
    });
  }
}
