import { requirePositiveG } from "../core/money.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { isStableIdentifier } from "../core/transaction.js";

export const RECIPE_UNLOCK_TYPE = Object.freeze({
  STARTING: "STARTING",
  REPUTATION: "REPUTATION",
});

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateIngredientRequirement(requirement, field, ingredientIds) {
  if (!isPlainRecord(requirement)) return failure("INVALID_RECIPE_INGREDIENT_REQUIREMENT", { field });
  if (!isStableIdentifier(requirement.ingredientId)) {
    return failure("INVALID_RECIPE_INGREDIENT_ID", { field: `${field}.ingredientId` });
  }
  if (ingredientIds && !ingredientIds.has(requirement.ingredientId)) {
    return failure("RECIPE_INGREDIENT_REFERENCE_NOT_FOUND", {
      field: `${field}.ingredientId`,
      ingredientId: requirement.ingredientId,
    });
  }
  if (!Number.isSafeInteger(requirement.quantity) || requirement.quantity <= 0) {
    return failure("INVALID_RECIPE_INGREDIENT_QUANTITY", {
      field: `${field}.quantity`,
      quantity: requirement.quantity,
    });
  }
  return validationSuccess();
}

function validateRecipeTiming(timing) {
  if (!isPlainRecord(timing)) return failure("INVALID_RECIPE_TIMING");
  const fields = ["targetOffsetMs", "successWindowMs", "normalWindowMs", "failureOffsetMs"];
  for (const field of fields) {
    if (!Number.isSafeInteger(timing[field]) || timing[field] < 0) {
      return failure("INVALID_RECIPE_TIMING_VALUE", { field, value: timing[field] });
    }
  }
  if (timing.successWindowMs > timing.normalWindowMs ||
      timing.normalWindowMs >= timing.failureOffsetMs ||
      timing.targetOffsetMs >= timing.failureOffsetMs) {
    return failure("INVALID_RECIPE_TIMING_ORDER", { timing });
  }
  return validationSuccess();
}

function validateRecipeUnlock(unlock) {
  if (!isPlainRecord(unlock) || !Object.values(RECIPE_UNLOCK_TYPE).includes(unlock.type)) {
    return failure("INVALID_RECIPE_UNLOCK");
  }
  if (unlock.type === RECIPE_UNLOCK_TYPE.STARTING) {
    return unlock.reputationThreshold === null
      ? validationSuccess()
      : failure("STARTING_RECIPE_HAS_THRESHOLD", { reputationThreshold: unlock.reputationThreshold });
  }
  return Number.isInteger(unlock.reputationThreshold) &&
    unlock.reputationThreshold >= 0 && unlock.reputationThreshold <= 100
    ? validationSuccess()
    : failure("INVALID_RECIPE_REPUTATION_THRESHOLD", {
      reputationThreshold: unlock.reputationThreshold,
    });
}

export function validateRecipeDefinition(recipe, { ingredientIds = null } = {}) {
  if (!isPlainRecord(recipe)) return failure("INVALID_RECIPE_DEFINITION", { field: "$" });
  if (!isStableIdentifier(recipe.recipeId)) return failure("INVALID_RECIPE_ID", { recipeId: recipe.recipeId });
  if (typeof recipe.displayName !== "string" || recipe.displayName.trim() === "") {
    return failure("INVALID_RECIPE_DISPLAY_NAME", { recipeId: recipe.recipeId });
  }
  try {
    requirePositiveG(recipe.basePriceG, "basePriceG");
    if (BigInt(recipe.basePriceG) * 2n > MAX_SAFE_BIGINT) throw new RangeError("price range overflow");
  } catch {
    return failure("INVALID_RECIPE_BASE_PRICE", { recipeId: recipe.recipeId, basePriceG: recipe.basePriceG });
  }
  if (!Array.isArray(recipe.ingredientRequirements) || recipe.ingredientRequirements.length < 2) {
    return failure("RECIPE_REQUIRES_MULTIPLE_INGREDIENTS", { recipeId: recipe.recipeId });
  }
  const seenIngredients = new Set();
  for (let index = 0; index < recipe.ingredientRequirements.length; index += 1) {
    const requirement = recipe.ingredientRequirements[index];
    const validation = validateIngredientRequirement(
      requirement,
      `ingredientRequirements[${index}]`,
      ingredientIds,
    );
    if (!validation.ok) return validation;
    if (seenIngredients.has(requirement.ingredientId)) {
      return failure("DUPLICATE_RECIPE_INGREDIENT", {
        recipeId: recipe.recipeId,
        ingredientId: requirement.ingredientId,
      });
    }
    seenIngredients.add(requirement.ingredientId);
  }
  const timing = validateRecipeTiming(recipe.timing);
  if (!timing.ok) return timing;
  return validateRecipeUnlock(recipe.unlock);
}

export function calculateRecipePriceRange(recipe) {
  const validation = validateRecipeDefinition(recipe);
  if (!validation.ok) {
    const error = new TypeError(`Recipe 가격 범위를 계산할 수 없습니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  const base = BigInt(recipe.basePriceG);
  return freezeDeep({
    minimumPriceG: Number((base + 1n) / 2n),
    maximumPriceG: Number(base * 2n),
  });
}

export function validateRecipeState(state) {
  if (!isPlainRecord(state) || !Array.isArray(state.definitions) || !Array.isArray(state.unlockedRecipeIds)) {
    return failure("INVALID_RECIPE_STATE");
  }
  const recipeIds = new Set();
  let startingCount = 0;
  for (let index = 0; index < state.definitions.length; index += 1) {
    const recipe = state.definitions[index];
    const validation = validateRecipeDefinition(recipe);
    if (!validation.ok) return failure(validation.code, { recipeIndex: index, ...validation.details });
    if (recipeIds.has(recipe.recipeId)) return failure("DUPLICATE_RECIPE_ID", { recipeId: recipe.recipeId });
    if (index > 0 && compareIds(state.definitions[index - 1].recipeId, recipe.recipeId) >= 0) {
      return failure("RECIPE_DEFINITION_ORDER_INVALID", { recipeIndex: index });
    }
    recipeIds.add(recipe.recipeId);
    if (recipe.unlock.type === RECIPE_UNLOCK_TYPE.STARTING) startingCount += 1;
  }
  if (startingCount < 2) return failure("INSUFFICIENT_STARTING_RECIPES", { startingCount });

  const unlocked = new Set();
  for (let index = 0; index < state.unlockedRecipeIds.length; index += 1) {
    const recipeId = state.unlockedRecipeIds[index];
    if (!isStableIdentifier(recipeId) || !recipeIds.has(recipeId)) {
      return failure("UNLOCKED_RECIPE_NOT_FOUND", { recipeId, unlockIndex: index });
    }
    if (unlocked.has(recipeId)) return failure("DUPLICATE_UNLOCKED_RECIPE_ID", { recipeId });
    if (index > 0 && compareIds(state.unlockedRecipeIds[index - 1], recipeId) >= 0) {
      return failure("UNLOCKED_RECIPE_ORDER_INVALID", { unlockIndex: index });
    }
    unlocked.add(recipeId);
  }
  for (const recipe of state.definitions) {
    if (recipe.unlock.type === RECIPE_UNLOCK_TYPE.STARTING && !unlocked.has(recipe.recipeId)) {
      return failure("STARTING_RECIPE_LOCKED", { recipeId: recipe.recipeId });
    }
  }
  return validationSuccess({ startingCount, unlockedCount: unlocked.size });
}

export function createRecipeState({ recipes, ingredientIds = null, unlockedRecipeIds = [] } = {}) {
  if (!Array.isArray(recipes)) throw new TypeError("recipes 배열이 필요합니다.");
  const ingredientSet = ingredientIds === null
    ? null
    : new Set(Array.isArray(ingredientIds) ? ingredientIds : ingredientIds);
  const definitions = recipes.map((recipe, recipeIndex) => {
    const validation = validateRecipeDefinition(recipe, { ingredientIds: ingredientSet });
    if (!validation.ok) {
      const error = new TypeError(`유효하지 않은 Recipe입니다: ${validation.code}`);
      error.code = validation.code;
      error.details = { recipeIndex, ...validation.details };
      throw error;
    }
    return cloneValue(recipe);
  }).sort((left, right) => compareIds(left.recipeId, right.recipeId));
  const definitionIds = new Set(definitions.map((recipe) => recipe.recipeId));
  const unlocked = new Set(definitions
    .filter((recipe) => recipe.unlock.type === RECIPE_UNLOCK_TYPE.STARTING)
    .map((recipe) => recipe.recipeId));
  for (const recipeId of unlockedRecipeIds) {
    if (!definitionIds.has(recipeId)) {
      const error = new TypeError(`존재하지 않는 Recipe unlock입니다: ${recipeId}`);
      error.code = "UNLOCKED_RECIPE_NOT_FOUND";
      throw error;
    }
    unlocked.add(recipeId);
  }
  const state = {
    definitions,
    unlockedRecipeIds: [...unlocked].sort(compareIds),
  };
  const validation = validateRecipeState(state);
  if (!validation.ok) {
    const error = new TypeError(`유효하지 않은 RecipeState입니다: ${validation.code}`);
    error.code = validation.code;
    throw error;
  }
  return freezeDeep(state);
}

export function getRecipeDefinition(state, recipeId) {
  const validation = validateRecipeState(state);
  if (!validation.ok) throw new TypeError(`RecipeState가 유효하지 않습니다: ${validation.code}`);
  return state.definitions.find((recipe) => recipe.recipeId === recipeId) ?? null;
}

export function isRecipeUnlocked(state, recipeId) {
  return validateRecipeState(state).ok && state.unlockedRecipeIds.includes(recipeId);
}

/** Adds published unlocks at a Planning boundary; it never mutates the source state. */
export function addRecipeUnlocksForPlanning(state, recipeIds) {
  const validation = validateRecipeState(state);
  if (!validation.ok) return failure("RECIPE_STATE_INVALID", { cause: validation.code });
  if (!Array.isArray(recipeIds) || recipeIds.some((recipeId) => !isStableIdentifier(recipeId))) {
    return failure("INVALID_RECIPE_UNLOCK_IDS");
  }
  const definitions = new Set(state.definitions.map((recipe) => recipe.recipeId));
  for (const recipeId of recipeIds) {
    if (!definitions.has(recipeId)) return failure("RECIPE_UNLOCK_TARGET_NOT_FOUND", { recipeId });
  }
  const next = createRecipeState({
    recipes: state.definitions,
    unlockedRecipeIds: [...state.unlockedRecipeIds, ...recipeIds],
  });
  return Object.freeze({ ok: true, state: next, addedRecipeIds: freezeDeep(
    next.unlockedRecipeIds.filter((recipeId) => !state.unlockedRecipeIds.includes(recipeId)),
  ) });
}

export function projectRecipes(state, { runtimePhase = "PLANNING", menuLocked = false } = {}) {
  const validation = validateRecipeState(state);
  if (!validation.ok) throw new TypeError(`Recipe projection이 유효하지 않습니다: ${validation.code}`);
  const unlocked = new Set(state.unlockedRecipeIds);
  return freezeDeep({
    unlockedRecipeIds: [...state.unlockedRecipeIds],
    startingRecipeCount: state.definitions.filter(
      (recipe) => recipe.unlock.type === RECIPE_UNLOCK_TYPE.STARTING,
    ).length,
    recipes: state.definitions.map((recipe) => ({
      ...cloneValue(recipe),
      ...calculateRecipePriceRange(recipe),
      unlocked: unlocked.has(recipe.recipeId),
      editable: unlocked.has(recipe.recipeId) && runtimePhase === "PLANNING" && !menuLocked,
    })),
  });
}

export class RecipeSystem {
  project(snapshot) {
    return projectRecipes(snapshot.recipes, {
      runtimePhase: snapshot.runtimePhase,
      menuLocked: snapshot.menu?.locked ?? false,
    });
  }

  isUnlocked(snapshot, recipeId) {
    return isRecipeUnlocked(snapshot.recipes, recipeId);
  }
}
