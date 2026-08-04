export const RECIPE_TEXTURE_PATH = Object.freeze({
  "recipe.slime_stew": "assets/generated/recipes/slime-jelly.png",
  "recipe.stonegrain_bowl": "assets/generated/recipes/mushroom-medley.png",
  "recipe.glowcap_soup": "assets/generated/recipes/mushroom-stew.png",
  "recipe.ember_egg_skewer": "assets/generated/recipes/spiced-crawfish.png",
  "recipe.moonroot_pie": "assets/generated/recipes/meat-hotpot.png",
  "recipe.mimic_hotpot": "assets/generated/recipes/berry-salad.png",
});

export function resolveCarriedDishTexturePath(carriedDish) {
  if (!carriedDish) return null;
  return RECIPE_TEXTURE_PATH[carriedDish.recipeId] ?? null;
}
