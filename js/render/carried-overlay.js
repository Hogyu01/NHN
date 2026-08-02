export const RECIPE_TEXTURE_PATH = Object.freeze({
  "recipe.slime_stew": "assets/icons/dishes/dish-jelly-bowl.png",
  "recipe.stonegrain_bowl": "assets/icons/dishes/dish-mushroom-medley.png",
  "recipe.glowcap_soup": "assets/icons/dishes/dish-mushroom-stew.png",
  "recipe.ember_egg_skewer": "assets/icons/dishes/dish-spiced-crawfish.png",
  "recipe.moonroot_pie": "assets/icons/dishes/dish-berry-salad.png",
  "recipe.mimic_hotpot": "assets/icons/dishes/dish-meat-hotpot.png",
});

export function resolveCarriedDishTexturePath(carriedDish) {
  if (!carriedDish) return null;
  return RECIPE_TEXTURE_PATH[carriedDish.recipeId] ?? null;
}
