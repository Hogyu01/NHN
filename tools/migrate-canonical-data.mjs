#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANONICAL_CONTENT_SPECIFICATIONS,
  CANONICAL_MIGRATION_REPORT_SPECIFICATION,
} from "../js/infrastructure/canonical-content.js";
import { DataValidator, VALIDATION_ERROR_TYPE } from "../js/infrastructure/data-validator.js";
import { CANONICAL_CONTENT_FILE_CONTRACTS } from "../js/infrastructure/schema-registry.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_FILENAME = CANONICAL_MIGRATION_REPORT_SPECIFICATION.filename;
const MIGRATION_ID = "migration.main-content-to-canonical.v1";
const SOURCE_FORMAT = "main.authored-draft-and-legacy.unversioned";
const SOURCE_FILENAMES = Object.freeze([
  "data/ingredients.json",
  "data/recipes.json",
  "data/upgrades.json",
  "data/dialogue.json",
]);

const SOURCE_SHA256 = Object.freeze({
  "data/ingredients.json": "530b4b3e00f44c69381f79f4417f2e4181cdac79e3acb8defba3596310899bce",
  "data/recipes.json": "55bf3f3396d3a8a5f803076e34dbd617cbb1cdafd1ddac47f7b0b1920005399a",
  "data/upgrades.json": "63cbf29eb8e6f753812a9e351afb89c61d622b638cc24679611554d76b05c3b3",
  "data/dialogue.json": "1ef63b98f9f129a661fca534ab77a877178e73ac871bab5a3d6319c1fbcbcb46",
});

const SOURCE_DOCUMENTS = Object.freeze({
  "data/ingredients.json": [
    {
      "이름": "슬라임 젤리",
      "카테고리": "마물 부산물",
      "확률_일반": 0.6,
      "확률_고급": 0.3,
      "확률_희귀": 0.1,
      "맛_프로필": "단맛",
    },
    {
      "이름": "동굴 버섯",
      "카테고리": "채소",
      "확률_일반": 0.65,
      "확률_고급": 0.25,
      "확률_희귀": 0.1,
      "맛_프로필": "감칠맛",
    },
    {
      "이름": "화염 도마뱀 고기",
      "카테고리": "육류",
      "확률_일반": 0.55,
      "확률_고급": 0.3,
      "확률_희귀": 0.15,
      "맛_프로필": "매운맛",
    },
    {
      "이름": "서리 멧돼지 고기",
      "카테고리": "육류",
      "확률_일반": 0.55,
      "확률_고급": 0.35,
      "확률_희귀": 0.1,
      "맛_프로필": "짠맛",
    },
    {
      "이름": "달빛 당근",
      "카테고리": "채소",
      "확률_일반": 0.7,
      "확률_고급": 0.22,
      "확률_희귀": 0.08,
      "맛_프로필": "단맛",
    },
    {
      "이름": "늪지 양파",
      "카테고리": "채소",
      "확률_일반": 0.65,
      "확률_고급": 0.25,
      "확률_희귀": 0.1,
      "맛_프로필": "매운맛",
    },
    {
      "이름": "해독초",
      "카테고리": "약초",
      "확률_일반": 0.6,
      "확률_고급": 0.3,
      "확률_희귀": 0.1,
      "맛_프로필": "쓴맛",
    },
    {
      "이름": "별빛 허브",
      "카테고리": "약초",
      "확률_일반": 0.5,
      "확률_고급": 0.35,
      "확률_희귀": 0.15,
      "맛_프로필": "향긋한맛",
    },
    {
      "이름": "산성 열매",
      "카테고리": "과일",
      "확률_일반": 0.6,
      "확률_고급": 0.28,
      "확률_희귀": 0.12,
      "맛_프로필": "신맛",
    },
    {
      "이름": "소금 수정",
      "카테고리": "광물",
      "확률_일반": 0.5,
      "확률_고급": 0.35,
      "확률_희귀": 0.15,
      "맛_프로필": "짠맛",
    },
  ],
  "data/recipes.json": [
    {
      "이름": "슬라임 젤리 화채",
      "필요_재료": ["슬라임 젤리", "산성 열매"],
      "맛_매칭_보너스": "단맛 재료 + 신맛 재료 = 성공률 +20%",
      "성공_문구": "말랑한 젤리와 새콤한 과즙이 완벽하게 어우러졌다!",
      "보통_문구": "상큼하고 먹을 만한 젤리 화채가 완성됐다.",
      "실패_문구": "젤리가 전부 녹아 끈적한 물이 되어버렸다...",
    },
    {
      "이름": "동굴 버섯 스튜",
      "필요_재료": ["동굴 버섯", "늪지 양파"],
      "맛_매칭_보너스": "감칠맛 재료 + 매운맛 재료 = 성공률 +20%",
      "성공_문구": "깊은 버섯 향 뒤로 알싸한 풍미가 살아난다!",
      "보통_문구": "따뜻하고 든든한 버섯 스튜가 완성됐다.",
      "실패_문구": "버섯을 너무 오래 끓여 정체불명의 죽이 되었다...",
    },
    {
      "이름": "화염 도마뱀 허브구이",
      "필요_재료": ["화염 도마뱀 고기", "별빛 허브"],
      "맛_매칭_보너스": "매운맛 재료 + 향긋한맛 재료 = 성공률 +20%",
      "성공_문구": "불향과 허브 향이 폭발하는 모험가식 특선 구이다!",
      "보통_문구": "조금 맵지만 향이 좋은 도마뱀 구이가 완성됐다.",
      "실패_문구": "도마뱀 고기가 불을 뿜으며 새까맣게 타버렸다...",
    },
    {
      "이름": "서리 멧돼지 당근수프",
      "필요_재료": ["서리 멧돼지 고기", "달빛 당근"],
      "맛_매칭_보너스": "짠맛 재료 + 단맛 재료 = 성공률 +20%",
      "성공_문구": "진한 육수에 당근의 은은한 단맛이 스며들었다!",
      "보통_문구": "추위를 녹여줄 담백한 고기 수프가 완성됐다.",
      "실패_문구": "얼어붙은 고기가 끝내 익지 않아 국물만 미지근하다...",
    },
    {
      "이름": "해독초 산성 샐러드",
      "필요_재료": ["해독초", "산성 열매"],
      "맛_매칭_보너스": "쓴맛 재료 + 신맛 재료 = 성공률 +20%",
      "성공_문구": "새콤한 열매가 해독초의 쓴맛을 산뜻하게 잡아준다!",
      "보통_문구": "건강에는 좋을 것 같은 새콤쌉싸름한 샐러드다.",
      "실패_문구": "혀가 얼얼할 만큼 쓰고 시다. 손님이 고개를 젓는다...",
    },
    {
      "이름": "광부의 수정 버섯볶음",
      "필요_재료": ["소금 수정", "동굴 버섯"],
      "맛_매칭_보너스": "짠맛 재료 + 감칠맛 재료 = 성공률 +20%",
      "성공_문구": "수정 소금이 버섯의 감칠맛을 또렷하게 끌어냈다!",
      "보통_문구": "짭짤하고 고소한 버섯볶음이 완성됐다.",
      "실패_문구": "소금 수정을 너무 많이 갈아 넣어 입안이 사막이 되었다...",
    },
  ],
  "data/upgrades.json": [{
    "이름": "예: 레시피 확장",
    "효과_설명": "",
  }],
  "data/dialogue.json": {
    "모험가": {
      "이름": "초보 모험가 루카",
      "성격_한줄": "겁은 많지만 좋은 재료를 발견하면 누구보다 신이 나는 수다쟁이 모험가",
      "리빌_연출_문구": "루카가 눈치를 살피며 묵직한 봇짐을 풀어 보여줍니다...",
    },
    "손님": [
      {
        "유형": "배고픈 여행자",
        "요청_대사": "멀리서부터 냄새를 맡고 왔어요. 든든한 요리 하나 부탁해요!",
        "재촉_대사": "배에서 천둥이 치고 있어요. 아직 멀었나요?",
        "만족_대사": "살 것 같네요! 다음 여정에도 꼭 들를게요.",
      },
      {
        "유형": "까다로운 마법사",
        "요청_대사": "평범한 맛은 사양하지. 향이 살아 있는 요리를 내오게.",
        "재촉_대사": "내 인내심에도 마나처럼 한계가 있다는 걸 명심하게.",
        "만족_대사": "흠, 제법이군. 이 맛이라면 연구 중간에 다시 찾아오지.",
      },
      {
        "유형": "지친 광부",
        "요청_대사": "오늘 수정 광맥을 세 개나 팠어. 짭짤하고 힘나는 걸로 줘!",
        "재촉_대사": "곡괭이 들 힘도 없다고! 뭐라도 빨리 부탁해!",
        "만족_대사": "이거지! 속이 든든하니 다시 한 층 더 내려갈 수 있겠어.",
      },
      {
        "유형": "수습 성직자",
        "요청_대사": "던전 독기에 오래 노출됐어요. 몸이 맑아질 만한 요리가 있을까요?",
        "재촉_대사": "죄송하지만... 눈앞이 조금씩 빙빙 도는 것 같아요.",
        "만족_대사": "신의 가호가 이 식당에도 머물기를! 정말 개운해졌어요.",
      },
      {
        "유형": "허세 많은 기사",
        "요청_대사": "용맹한 기사에게 어울릴 만큼 화끈한 요리를 내오도록!",
        "재촉_대사": "기사를 기다리게 하다니! 내 갑옷보다 조리가 더 무거운가?",
        "만족_대사": "크흠, 훌륭하군! 맵다고 눈물이 난 것은 절대 아니다.",
      },
      {
        "유형": "호기심 많은 연금술사",
        "요청_대사": "서로 다른 맛이 반응하는 특별한 요리를 실험해 보고 싶어요!",
        "재촉_대사": "반응 시간이 지나면 가설을 검증할 수 없어요. 서둘러 주세요!",
        "만족_대사": "예상 이상의 조합이에요! 이 결과는 제 연구 일지에 적어둘게요.",
      },
    ],
  },
});

const SOURCE_CLASSIFICATIONS = Object.freeze({
  "data/ingredients.json": "MAIN_AUTHORED_CONTENT",
  "data/recipes.json": "MAIN_AUTHORED_CONTENT",
  "data/upgrades.json": "LEGACY_PLACEHOLDER",
  "data/dialogue.json": "MAIN_AUTHORED_CONTENT",
});

const sourceIngredients = SOURCE_DOCUMENTS["data/ingredients.json"];
const sourceRecipes = SOURCE_DOCUMENTS["data/recipes.json"];
const sourceDialogue = SOURCE_DOCUMENTS["data/dialogue.json"];

const INGREDIENT_SOURCE_MAPPINGS = Object.freeze([
  { sourceIndex: 0, targetId: "ingredient.slime_gel", rationale: "동일한 슬라임 젤리 정체성을 유지합니다." },
  { sourceIndex: 1, targetId: "ingredient.cave_mushroom", rationale: "동일한 동굴 버섯 정체성을 유지합니다." },
  { sourceIndex: 7, targetId: "ingredient.glow_herb", rationale: "별빛/발광 허브의 광원 약초 역할을 연결합니다." },
  { sourceIndex: 5, targetId: "ingredient.ember_pepper", rationale: "매운맛 채소 슬롯에 늪지 양파 콘텐츠를 배정합니다." },
  { sourceIndex: 4, targetId: "ingredient.moonroot", rationale: "달빛 계열 뿌리채소 정체성을 연결합니다." },
  { sourceIndex: 9, targetId: "ingredient.crystal_salt", rationale: "소금 수정과 수정 소금은 동일 광물 조미료입니다." },
  { sourceIndex: 6, targetId: "ingredient.stonegrain", rationale: "공용 공급 stable ID에 해독초 콘텐츠를 명시적으로 연결합니다." },
  { sourceIndex: 2, targetId: "ingredient.griffin_egg", rationale: "희귀 마물 단백질 stable ID에 화염 도마뱀 고기를 명시적으로 연결합니다." },
  { sourceIndex: 8, targetId: "ingredient.mimic_bean", rationale: "특수 계약 재료 stable ID에 산성 열매 콘텐츠를 명시적으로 연결합니다." },
  { sourceIndex: 3, targetId: "ingredient.moss_cheese", rationale: "후반 고원가 재료 stable ID에 서리 멧돼지 고기를 명시적으로 연결합니다." },
]);

const ingredientByTargetId = new Map(
  INGREDIENT_SOURCE_MAPPINGS.map((mapping) => [mapping.targetId, sourceIngredients[mapping.sourceIndex]]),
);

function qualityDistribution(source) {
  return [
    { minQuality: 0, maxQuality: 49, weight: source["확률_일반"] },
    { minQuality: 50, maxQuality: 79, weight: source["확률_고급"] },
    { minQuality: 80, maxQuality: 100, weight: source["확률_희귀"] },
  ];
}

function canonicalIngredient(ingredientId, category, basePriceG, marketAvailabilityRate, minimum, maximum) {
  const source = ingredientByTargetId.get(ingredientId);
  return {
    ingredientId,
    displayName: source["이름"],
    category,
    flavorProfile: source["맛_프로필"],
    basePriceG,
    marketAvailabilityRate,
    marketStockRange: { minimum, maximum },
    qualityDistribution: qualityDistribution(source),
  };
}

const INGREDIENTS = Object.freeze({
  contentId: "content.ingredients",
  schemaVersion: 1,
  ingredients: [
    canonicalIngredient("ingredient.slime_gel", "MONSTER_BYPRODUCT", 8, 90, 8, 16),
    canonicalIngredient("ingredient.cave_mushroom", "VEGETABLE", 9, 85, 7, 14),
    canonicalIngredient("ingredient.glow_herb", "HERB", 12, 65, 3, 8),
    canonicalIngredient("ingredient.ember_pepper", "VEGETABLE", 14, 60, 3, 9),
    canonicalIngredient("ingredient.moonroot", "VEGETABLE", 11, 75, 5, 11),
    canonicalIngredient("ingredient.crystal_salt", "MINERAL", 5, 95, 8, 18),
    canonicalIngredient("ingredient.stonegrain", "HERB", 7, 90, 9, 18),
    canonicalIngredient("ingredient.griffin_egg", "MEAT", 22, 45, 2, 6),
    canonicalIngredient("ingredient.mimic_bean", "FRUIT", 16, 55, 3, 7),
    canonicalIngredient("ingredient.moss_cheese", "MEAT", 18, 50, 2, 7),
  ],
});

const RECIPE_SOURCE_MAPPINGS = Object.freeze([
  { sourceIndex: 0, targetId: "recipe.slime_stew" },
  { sourceIndex: 5, targetId: "recipe.stonegrain_bowl" },
  { sourceIndex: 1, targetId: "recipe.glowcap_soup" },
  { sourceIndex: 2, targetId: "recipe.ember_egg_skewer" },
  { sourceIndex: 3, targetId: "recipe.moonroot_pie" },
  { sourceIndex: 4, targetId: "recipe.mimic_hotpot" },
]);

const recipeByTargetId = new Map(
  RECIPE_SOURCE_MAPPINGS.map((mapping) => [mapping.targetId, sourceRecipes[mapping.sourceIndex]]),
);

function canonicalRecipe(recipeId, basePriceG, ingredientRequirements, timing, unlock) {
  const source = recipeByTargetId.get(recipeId);
  return {
    recipeId,
    displayName: source["이름"],
    basePriceG,
    ingredientRequirements,
    timing,
    unlock,
    outcomeText: {
      success: source["성공_문구"],
      normal: source["보통_문구"],
      failure: source["실패_문구"],
    },
  };
}

const RECIPES = Object.freeze({
  contentId: "content.recipes",
  schemaVersion: 1,
  recipes: [
    canonicalRecipe(
      "recipe.slime_stew",
      44,
      [
        { ingredientId: "ingredient.slime_gel", quantity: 2 },
        { ingredientId: "ingredient.mimic_bean", quantity: 1 },
      ],
      { targetOffsetMs: 2200, successWindowMs: 250, normalWindowMs: 650, failureOffsetMs: 3500 },
      { type: "STARTING", reputationThreshold: null },
    ),
    canonicalRecipe(
      "recipe.stonegrain_bowl",
      42,
      [
        { ingredientId: "ingredient.crystal_salt", quantity: 1 },
        { ingredientId: "ingredient.cave_mushroom", quantity: 1 },
      ],
      { targetOffsetMs: 1800, successWindowMs: 300, normalWindowMs: 700, failureOffsetMs: 3200 },
      { type: "STARTING", reputationThreshold: null },
    ),
    canonicalRecipe(
      "recipe.glowcap_soup",
      48,
      [
        { ingredientId: "ingredient.cave_mushroom", quantity: 1 },
        { ingredientId: "ingredient.ember_pepper", quantity: 1 },
      ],
      { targetOffsetMs: 2600, successWindowMs: 220, normalWindowMs: 600, failureOffsetMs: 3800 },
      { type: "REPUTATION", reputationThreshold: 40 },
    ),
    canonicalRecipe(
      "recipe.ember_egg_skewer",
      64,
      [
        { ingredientId: "ingredient.griffin_egg", quantity: 1 },
        { ingredientId: "ingredient.glow_herb", quantity: 1 },
      ],
      { targetOffsetMs: 3000, successWindowMs: 180, normalWindowMs: 500, failureOffsetMs: 4000 },
      { type: "REPUTATION", reputationThreshold: 48 },
    ),
    canonicalRecipe(
      "recipe.moonroot_pie",
      78,
      [
        { ingredientId: "ingredient.moss_cheese", quantity: 1 },
        { ingredientId: "ingredient.moonroot", quantity: 2 },
      ],
      { targetOffsetMs: 3400, successWindowMs: 200, normalWindowMs: 650, failureOffsetMs: 4500 },
      { type: "REPUTATION", reputationThreshold: 56 },
    ),
    canonicalRecipe(
      "recipe.mimic_hotpot",
      72,
      [
        { ingredientId: "ingredient.stonegrain", quantity: 1 },
        { ingredientId: "ingredient.mimic_bean", quantity: 1 },
      ],
      { targetOffsetMs: 3800, successWindowMs: 160, normalWindowMs: 550, failureOffsetMs: 4800 },
      { type: "REPUTATION", reputationThreshold: 64 },
    ),
  ],
});

function assertRecipeMembershipMappings() {
  const ingredientIdBySourceName = new Map(INGREDIENT_SOURCE_MAPPINGS.map((mapping) => [
    sourceIngredients[mapping.sourceIndex]["이름"],
    mapping.targetId,
  ]));
  for (const mapping of RECIPE_SOURCE_MAPPINGS) {
    const source = sourceRecipes[mapping.sourceIndex];
    const expectedIds = source["필요_재료"].map((name) => ingredientIdBySourceName.get(name));
    if (expectedIds.some((ingredientId) => !ingredientId)) {
      throw new Error(`${source["이름"]} source ingredient crosswalk가 완전하지 않습니다.`);
    }
    const recipe = RECIPES.recipes.find((entry) => entry.recipeId === mapping.targetId);
    const actualIds = recipe?.ingredientRequirements.map((entry) => entry.ingredientId) ?? [];
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`${source["이름"]} main recipe membership graph가 ${mapping.targetId}에 보존되지 않았습니다.`);
    }
  }
}

const GUEST_SOURCE_MAPPINGS = Object.freeze([
  { sourceIndex: 0, targetGuestId: "guest.human_adventurer", slug: "human_adventurer" },
  { sourceIndex: 2, targetGuestId: "guest.dwarf_courier", slug: "dwarf_courier" },
  { sourceIndex: 5, targetGuestId: "guest.goblin_scholar", slug: "goblin_scholar" },
  { sourceIndex: 1, targetGuestId: "guest.slime_gourmand", slug: "slime_gourmand" },
  { sourceIndex: 4, targetGuestId: "guest.kobold_porter", slug: "kobold_porter" },
  { sourceIndex: 3, targetGuestId: "guest.mushroom_traveler", slug: "mushroom_traveler" },
]);

const guestSourceById = new Map(
  GUEST_SOURCE_MAPPINGS.map((mapping) => [mapping.targetGuestId, sourceDialogue["손님"][mapping.sourceIndex]]),
);

function canonicalGuest(base) {
  return {
    ...base,
    roleLabel: guestSourceById.get(base.guestArchetypeId)["유형"],
  };
}

const GUESTS = Object.freeze({
  contentId: "content.guests",
  schemaVersion: 1,
  guestArchetypes: [
    canonicalGuest({
      guestArchetypeId: "guest.human_adventurer",
      displayName: sourceDialogue["모험가"]["이름"],
      classification: "HUMAN",
      visualCue: "둥근 배낭",
      assetId: "sprite.guest.human_adventurer",
      selectionWeight: 20,
      recipePreferenceWeights: [
        { recipeId: "recipe.stonegrain_bowl", weight: 5 },
        { recipeId: "recipe.slime_stew", weight: 4 },
        { recipeId: "recipe.glowcap_soup", weight: 3 },
      ],
    }),
    canonicalGuest({
      guestArchetypeId: "guest.dwarf_courier",
      displayName: "드워프 운송인",
      classification: "FRIENDLY_NON_HUMAN",
      visualCue: "큰 소포",
      assetId: "sprite.guest.dwarf_courier",
      selectionWeight: 15,
      recipePreferenceWeights: [
        { recipeId: "recipe.stonegrain_bowl", weight: 6 },
        { recipeId: "recipe.ember_egg_skewer", weight: 4 },
        { recipeId: "recipe.moonroot_pie", weight: 3 },
      ],
    }),
    canonicalGuest({
      guestArchetypeId: "guest.goblin_scholar",
      displayName: "고블린 학자",
      classification: "FRIENDLY_NON_HUMAN",
      visualCue: "책과 안경",
      assetId: "sprite.guest.goblin_scholar",
      selectionWeight: 16,
      recipePreferenceWeights: [
        { recipeId: "recipe.glowcap_soup", weight: 6 },
        { recipeId: "recipe.mimic_hotpot", weight: 4 },
        { recipeId: "recipe.slime_stew", weight: 3 },
      ],
    }),
    canonicalGuest({
      guestArchetypeId: "guest.slime_gourmand",
      displayName: "슬라임 미식가",
      classification: "FRIENDLY_MONSTER",
      visualCue: "냅킨과 숟가락",
      assetId: "sprite.guest.slime_gourmand",
      selectionWeight: 16,
      recipePreferenceWeights: [
        { recipeId: "recipe.slime_stew", weight: 7 },
        { recipeId: "recipe.glowcap_soup", weight: 4 },
        { recipeId: "recipe.mimic_hotpot", weight: 3 },
      ],
    }),
    canonicalGuest({
      guestArchetypeId: "guest.kobold_porter",
      displayName: "코볼트 짐꾼",
      classification: "FRIENDLY_NON_HUMAN",
      visualCue: "꼬리와 나무 상자",
      assetId: "sprite.guest.kobold_porter",
      selectionWeight: 17,
      recipePreferenceWeights: [
        { recipeId: "recipe.ember_egg_skewer", weight: 6 },
        { recipeId: "recipe.stonegrain_bowl", weight: 4 },
        { recipeId: "recipe.mimic_hotpot", weight: 3 },
      ],
    }),
    canonicalGuest({
      guestArchetypeId: "guest.mushroom_traveler",
      displayName: "버섯 종족 여행자",
      classification: "FRIENDLY_NON_HUMAN",
      visualCue: "갓과 김",
      assetId: "sprite.guest.mushroom_traveler",
      selectionWeight: 16,
      recipePreferenceWeights: [
        { recipeId: "recipe.glowcap_soup", weight: 7 },
        { recipeId: "recipe.moonroot_pie", weight: 4 },
        { recipeId: "recipe.stonegrain_bowl", weight: 3 },
      ],
    }),
  ],
});

function guestDialogue(mapping) {
  const source = sourceDialogue["손님"][mapping.sourceIndex];
  return [
    {
      dialogueId: `dialogue.${mapping.slug}.order`,
      context: "ORDER",
      speaker: "GUEST",
      guestArchetypeId: mapping.targetGuestId,
      recipeId: null,
      eventId: null,
      text: source["요청_대사"],
    },
    {
      dialogueId: `dialogue.${mapping.slug}.hurry`,
      context: "HURRY",
      speaker: "GUEST",
      guestArchetypeId: mapping.targetGuestId,
      recipeId: null,
      eventId: null,
      text: source["재촉_대사"],
    },
    {
      dialogueId: `dialogue.${mapping.slug}.satisfied`,
      context: "SATISFIED",
      speaker: "GUEST",
      guestArchetypeId: mapping.targetGuestId,
      recipeId: null,
      eventId: null,
      text: source["만족_대사"],
    },
  ];
}

const DIALOGUE = Object.freeze({
  contentId: "content.dialogue",
  schemaVersion: 1,
  dialogues: [
    {
      dialogueId: "dialogue.intro.narrator",
      context: "INTRO",
      speaker: "NARRATOR",
      guestArchetypeId: null,
      recipeId: null,
      eventId: "event.intro_last_hearth",
      text: "던전 입구의 마지막 화로가 다시 켜졌습니다. 장부는 아직 따뜻하지 않습니다.",
    },
    {
      dialogueId: "dialogue.intro.owner",
      context: "INTRO",
      speaker: "OWNER",
      guestArchetypeId: null,
      recipeId: null,
      eventId: "event.intro_last_hearth",
      text: "주인장, 오늘은 국자보다 계산이 먼저입니다.",
    },
    {
      dialogueId: "dialogue.human_adventurer.profile",
      context: "INTRO",
      speaker: "NARRATOR",
      guestArchetypeId: "guest.human_adventurer",
      recipeId: null,
      eventId: "event.intro_last_hearth",
      text: sourceDialogue["모험가"]["성격_한줄"],
    },
    {
      dialogueId: "dialogue.human_adventurer.reveal",
      context: "INTRO",
      speaker: "NARRATOR",
      guestArchetypeId: "guest.human_adventurer",
      recipeId: null,
      eventId: "event.intro_last_hearth",
      text: sourceDialogue["모험가"]["리빌_연출_문구"],
    },
    ...GUEST_SOURCE_MAPPINGS.flatMap(guestDialogue),
  ],
});

export const CANONICAL_AUTHORED_DOCUMENTS = Object.freeze({
  "data/ingredients.json": INGREDIENTS,
  "data/recipes.json": RECIPES,
  "data/dialogue.json": DIALOGUE,
  "data/guests.json": GUESTS,
});

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

function serializeSourceDocument(filename) {
  const serialized = serializeJson(SOURCE_DOCUMENTS[filename]);
  if (filename !== "data/recipes.json") return serialized;
  return serialized.replace(
    /"필요_재료": \[\n\s+"([^"]+)",\n\s+"([^"]+)"\n\s+\]/g,
    (_match, first, second) => `"필요_재료": [${JSON.stringify(first)}, ${JSON.stringify(second)}]`,
  );
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readText(filename) {
  return readFile(resolve(REPOSITORY_ROOT, filename), "utf8");
}

function parseJson(text, filename) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${filename} JSON parse 실패: ${error.message}`);
  }
}

async function writeText(filename, text) {
  const absolute = resolve(REPOSITORY_ROOT, filename);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

function assertSourceSnapshots() {
  for (const filename of SOURCE_FILENAMES) {
    const actual = sha256(serializeSourceDocument(filename));
    if (actual !== SOURCE_SHA256[filename]) {
      throw new Error(`${filename} embedded source SHA-256 불일치: expected=${SOURCE_SHA256[filename]}, actual=${actual}`);
    }
  }
}

function sourceRecords() {
  return SOURCE_FILENAMES.map((filename) => ({
    filename,
    sha256: SOURCE_SHA256[filename],
    classification: SOURCE_CLASSIFICATIONS[filename],
  }));
}

function buildIdMappings() {
  const mappings = INGREDIENT_SOURCE_MAPPINGS.map((mapping) => ({
    domain: "INGREDIENT",
    sourceFile: "data/ingredients.json",
    sourcePath: `$[${mapping.sourceIndex}]`,
    sourceValue: sourceIngredients[mapping.sourceIndex]["이름"],
    disposition: "MAPPED_MAIN_CONTENT",
    targetId: mapping.targetId,
    rationale: `${mapping.rationale} 표시명·카테고리·맛 프로필과 일반/고급/희귀 가중치를 함께 보존했습니다. 의미가 다른 market availability로 변환하지 않았습니다.`,
  }));

  for (const mapping of RECIPE_SOURCE_MAPPINGS) {
    const source = sourceRecipes[mapping.sourceIndex];
    mappings.push({
      domain: "RECIPE",
      sourceFile: "data/recipes.json",
      sourcePath: `$[${mapping.sourceIndex}]`,
      sourceValue: source["이름"],
      disposition: "MAPPED_MAIN_CONTENT",
      targetId: mapping.targetId,
      rationale: "표시명·두 재료의 membership과 성공/보통/실패 문구를 stable Recipe ID에 보존했습니다. 수량·가격·Timing·해금은 Foundation v1 값을 유지했습니다.",
    });
    mappings.push({
      domain: "RECIPE",
      sourceFile: "data/recipes.json",
      sourcePath: `$[${mapping.sourceIndex}].맛_매칭_보너스`,
      sourceValue: source["맛_매칭_보너스"],
      disposition: "OMITTED_INCOMPATIBLE_VALUE",
      targetId: mapping.targetId,
      rationale: "RNG 없는 deterministic Timing_Cook 계약에 +20% 성공률 필드가 없어 runtime mechanic으로 추정 삽입하지 않았습니다.",
    });
  }

  const dialogueFields = [
    ["요청_대사", "order"],
    ["재촉_대사", "hurry"],
    ["만족_대사", "satisfied"],
  ];
  for (const mapping of GUEST_SOURCE_MAPPINGS) {
    const source = sourceDialogue["손님"][mapping.sourceIndex];
    mappings.push({
      domain: "GUEST",
      sourceFile: "data/dialogue.json",
      sourcePath: `$.손님[${mapping.sourceIndex}].유형`,
      sourceValue: source["유형"],
      disposition: "MAPPED_MAIN_CONTENT",
      targetId: mapping.targetGuestId,
      rationale: "Foundation 종족·분류를 유지하면서 canonical roleLabel로 원문 역할명을 보존했습니다.",
    });
    for (const [field, context] of dialogueFields) {
      mappings.push({
        domain: "DIALOGUE",
        sourceFile: "data/dialogue.json",
        sourcePath: `$.손님[${mapping.sourceIndex}].${field}`,
        sourceValue: source[field],
        disposition: "MAPPED_MAIN_CONTENT",
        targetId: `dialogue.${mapping.slug}.${context}`,
        rationale: `${mapping.targetGuestId}의 canonical ${context.toUpperCase()} 문구로 원문을 보존했습니다.`,
      });
    }
  }

  mappings.push(
    {
      domain: "GUEST",
      sourceFile: "data/dialogue.json",
      sourcePath: "$.모험가.이름",
      sourceValue: sourceDialogue["모험가"]["이름"],
      disposition: "MAPPED_MAIN_CONTENT",
      targetId: "guest.human_adventurer",
      rationale: "인간 손님 archetype의 표시명으로 원문을 보존했습니다.",
    },
    {
      domain: "DIALOGUE",
      sourceFile: "data/dialogue.json",
      sourcePath: "$.모험가.성격_한줄",
      sourceValue: sourceDialogue["모험가"]["성격_한줄"],
      disposition: "MAPPED_MAIN_CONTENT",
      targetId: "dialogue.human_adventurer.profile",
      rationale: "Day 1 소개용 canonical narrative text로 원문을 보존했습니다.",
    },
    {
      domain: "DIALOGUE",
      sourceFile: "data/dialogue.json",
      sourcePath: "$.모험가.리빌_연출_문구",
      sourceValue: sourceDialogue["모험가"]["리빌_연출_문구"],
      disposition: "MAPPED_MAIN_CONTENT",
      targetId: "dialogue.human_adventurer.reveal",
      rationale: "Day 1 소개용 canonical reveal text로 원문을 보존했습니다.",
    },
  );

  for (const targetId of [
    "facility.kitchen_stage_1",
    "facility.hall_stage_1",
    "facility.storage_stage_1",
  ]) {
    mappings.push({
      domain: "FACILITY",
      sourceFile: null,
      sourcePath: null,
      sourceValue: null,
      disposition: "RETAINED_FOUNDATION_VALUE",
      targetId,
      rationale: "main 초안에 대응 가능한 Must 시설 값이 없어 승인된 Foundation canonical v1 값을 유지했습니다.",
    });
  }
  for (const targetId of [
    "event.intro_last_hearth",
    "event.busy_crossroads",
    "event.patient_pilgrims",
    "event.calm_embers",
    "event.quartermaster_visit",
  ]) {
    mappings.push({
      domain: "EVENT",
      sourceFile: null,
      sourcePath: null,
      sourceValue: null,
      disposition: "RETAINED_FOUNDATION_VALUE",
      targetId,
      rationale: "main 초안에 사건 데이터가 없어 승인된 Foundation canonical v1 event를 유지했습니다.",
    });
  }
  mappings.push({
    domain: "FACILITY",
    sourceFile: "data/upgrades.json",
    sourcePath: "$[0].이름",
    sourceValue: SOURCE_DOCUMENTS["data/upgrades.json"][0]["이름"],
    disposition: "OMITTED_EXAMPLE_PLACEHOLDER",
    targetId: null,
    rationale: "'예:' 표시명과 빈 설명은 실제 작성 콘텐츠가 아니며 kitchen/hall/storage Must stage로 추정 변환하지 않았습니다.",
  });
  return mappings;
}

function buildDecisions() {
  return [
    {
      decisionId: "migration.decision.source_snapshots",
      authority: "origin/main f51ea5475184543b8410dc1d3c47ff6c2d404ea5",
      field: "main source files",
      value: SOURCE_SHA256,
      rationale: "내장 source 문서를 origin/main blob의 exact-byte SHA-256과 대조해 mapping source-of-truth가 바뀌지 않도록 고정했습니다.",
    },
    {
      decisionId: "migration.decision.stable_id_crosswalk",
      authority: "explicit merge choice and Foundation canonical v1 cardinality",
      field: "main names to approved stable IDs",
      value: {
        ingredients: INGREDIENT_SOURCE_MAPPINGS.map((entry) => ({
          source: sourceIngredients[entry.sourceIndex]["이름"],
          target: entry.targetId,
        })),
        recipes: RECIPE_SOURCE_MAPPINGS.map((entry) => ({
          source: sourceRecipes[entry.sourceIndex]["이름"],
          target: entry.targetId,
        })),
      },
      rationale: "stable ID는 기술 식별자입니다. 의미가 동일하다고 추정하지 않고, 승인된 10/6 ID set과 main recipe membership graph를 동시에 보존하는 명시적 crosswalk로 기록했습니다.",
    },
    {
      decisionId: "migration.decision.quality_weights_not_percentages",
      authority: "requirements.md 20.2-20.3 and main ingredient draft",
      field: "일반/고급/희귀 확률",
      value: "mapped exactly to qualityDistribution.weight",
      rationale: "합이 1인 0..1 값은 등급 분포 가중치로 그대로 보존했습니다. marketAvailabilityRate 같은 integer percentage로 coercion하지 않았습니다.",
    },
    {
      decisionId: "migration.decision.recipe_mechanical_baseline",
      authority: "Foundation canonical v1 plus main authored recipe membership",
      field: "recipe quantities/prices/timing/unlocks",
      value: "Foundation v1 mechanical values retained",
      rationale: "main은 재료 이름만 제공하고 수량·가격·Timing·해금을 제공하지 않습니다. membership은 매핑하되 누락 수치를 추정하지 않고 Foundation 수치를 유지했습니다.",
    },
    {
      decisionId: "migration.decision.omit_taste_bonus",
      authority: "design.md deterministic Timing_Cook contract",
      field: "맛_매칭_보너스",
      value: sourceRecipes.map((entry) => entry["맛_매칭_보너스"]),
      rationale: "성공률 +20% 효과는 canonical Timing_Cook 판정에 없는 mechanic이므로 원문과 제외 근거만 report에 남겼습니다.",
    },
    {
      decisionId: "migration.decision.guest_roles",
      authority: "requirements.md 34.1-34.2 and main dialogue draft",
      field: "guest roleLabel/displayName/dialogue",
      value: GUEST_SOURCE_MAPPINGS.map((entry) => ({
        roleLabel: sourceDialogue["손님"][entry.sourceIndex]["유형"],
        target: entry.targetGuestId,
      })),
      rationale: "여섯 역할명과 18개 대사 원문을 보존하면서 Foundation의 HUMAN/친화적 비인간·몬스터 구성과 stable ID는 유지했습니다.",
    },
    {
      decisionId: "migration.decision.placeholder_not_promoted",
      authority: "explicit merge constraint",
      field: "data/upgrades.json legacy example",
      value: "omitted",
      rationale: "'예: 레시피 확장'과 빈 설명은 placeholder이므로 실제 시설 콘텐츠로 승격하지 않았습니다.",
    },
    {
      decisionId: "migration.decision.foundation_tuning",
      authority: "Foundation canonical v1",
      field: "market availability/stock, prices, preferences, facilities, events, balance",
      value: "retained",
      rationale: "main이 제공하지 않은 mechanics는 추정하지 않고 기존 Foundation canonical v1 값을 유지했습니다.",
    },
    {
      decisionId: "migration.decision.excluded_domains",
      authority: "requirements.md explicit exclusions and Requirement 34.15",
      field: "spoilage/combat/attack/damage/loot",
      value: "absent",
      rationale: "유통기한·부패와 전투 관련 필드·enum을 canonical payload에 포함하지 않았습니다.",
    },
  ];
}

async function canonicalTargetTexts() {
  const texts = {};
  for (const specification of CANONICAL_CONTENT_SPECIFICATIONS) {
    const authored = CANONICAL_AUTHORED_DOCUMENTS[specification.filename];
    if (authored) {
      texts[specification.filename] = serializeJson(authored);
      continue;
    }
    const actualText = await readText(specification.filename);
    const data = parseJson(actualText, specification.filename);
    const canonicalText = serializeJson(data);
    if (normalizeLineEndings(actualText) !== canonicalText) {
      throw new Error(`${specification.filename}이 canonical JSON serialization과 일치하지 않습니다.`);
    }
    texts[specification.filename] = canonicalText;
  }
  return texts;
}

function parseTargetDocuments(targetTexts) {
  return Object.fromEntries(Object.entries(targetTexts).map(
    ([filename, text]) => [filename, parseJson(text, filename)],
  ));
}

function buildMigrationReport(targetTexts, targetDocuments) {
  const targetFiles = CANONICAL_CONTENT_SPECIFICATIONS.map((specification) => {
    const data = targetDocuments[specification.filename];
    return {
      filename: specification.filename,
      contentId: data.contentId ?? "content.manifest",
      schemaName: specification.schemaName,
      schemaVersion: data.schemaVersion,
      sha256: sha256(targetTexts[specification.filename]),
    };
  });
  const facilities = targetDocuments["data/upgrades.json"].facilities;
  const events = targetDocuments["data/events.json"].events;
  return {
    reportSchemaVersion: 1,
    migrationId: MIGRATION_ID,
    sourceFormat: SOURCE_FORMAT,
    targetContentVersion: 1,
    status: "PASS",
    sourceFiles: sourceRecords(),
    targetFiles,
    idMappings: buildIdMappings(),
    decisions: buildDecisions(),
    validation: {
      validatorStatus: "PASS",
      documentCount: 8,
      diagnosticCount: 0,
      danglingReferenceCount: 0,
      ingredientCount: INGREDIENTS.ingredients.length,
      recipeCount: RECIPES.recipes.length,
      startingRecipeCount: RECIPES.recipes.filter((entry) => entry.unlock.type === "STARTING").length,
      guestCount: GUESTS.guestArchetypes.length,
      friendlyNonHumanOrMonsterCount: GUESTS.guestArchetypes.filter((entry) => entry.classification !== "HUMAN").length,
      facilityCount: facilities.length,
      eventCount: events.length,
    },
  };
}

function validateCanonical(targetDocuments, report) {
  const documents = CANONICAL_CONTENT_SPECIFICATIONS.map((specification) => ({
    ...specification,
    data: targetDocuments[specification.filename],
  }));
  documents.push({ ...CANONICAL_MIGRATION_REPORT_SPECIFICATION, data: report });
  const validation = new DataValidator().validateDocuments(documents);
  if (!validation.ok) {
    const details = validation.diagnostics.map((diagnostic) =>
      `${diagnostic.filename} | ${diagnostic.errorType} | ${diagnostic.fieldPath} | ${diagnostic.code}`,
    ).join("\n");
    throw new Error(`canonical migration payload validation 실패:\n${details}`);
  }
  return validation;
}

function verifyTargetHashes(report, targetTexts) {
  for (const target of report.targetFiles) {
    const actual = sha256(targetTexts[target.filename]);
    if (actual !== target.sha256) {
      throw new Error(`${target.filename} hash 불일치: expected=${target.sha256}, actual=${actual}`);
    }
  }
}

export async function migrateCanonicalData({ write = false } = {}) {
  assertSourceSnapshots();
  assertRecipeMembershipMappings();

  if (write) {
    for (const [filename, data] of Object.entries(CANONICAL_AUTHORED_DOCUMENTS)) {
      await writeText(filename, serializeJson(data));
    }
  }

  const targetTexts = await canonicalTargetTexts();
  for (const [filename, data] of Object.entries(CANONICAL_AUTHORED_DOCUMENTS)) {
    const expected = serializeJson(data);
    const actual = await readText(filename);
    if (normalizeLineEndings(actual) !== expected || targetTexts[filename] !== expected) {
      throw new Error(`${filename}이 main→canonical mapping source-of-truth와 일치하지 않습니다.`);
    }
  }

  const targetDocuments = parseTargetDocuments(targetTexts);
  const expectedReport = buildMigrationReport(targetTexts, targetDocuments);
  const expectedReportText = serializeJson(expectedReport);
  validateCanonical(targetDocuments, expectedReport);

  if (write) await writeText(REPORT_FILENAME, expectedReportText);
  const actualReportText = await readText(REPORT_FILENAME);
  if (normalizeLineEndings(actualReportText) !== expectedReportText) {
    throw new Error(`${REPORT_FILENAME}이 canonical migration source-of-truth와 일치하지 않습니다.`);
  }
  const actualReport = parseJson(actualReportText, REPORT_FILENAME);
  const validation = validateCanonical(targetDocuments, actualReport);
  verifyTargetHashes(actualReport, targetTexts);
  const danglingReferenceCount = validation.diagnostics.filter(
    (entry) => entry.errorType === VALIDATION_ERROR_TYPE.REFERENCE,
  ).length;
  if (danglingReferenceCount !== 0) {
    throw new Error(`dangling reference가 ${danglingReferenceCount}개 남았습니다.`);
  }

  return Object.freeze({
    status: "PASS",
    mode: write ? "REFRESHED" : "VERIFIED",
    contentVersion: 1,
    canonicalFiles: Object.keys(targetTexts).sort(),
    reportFile: REPORT_FILENAME,
    danglingReferenceCount,
    counts: Object.freeze({
      ingredients: INGREDIENTS.ingredients.length,
      recipes: RECIPES.recipes.length,
      startingRecipes: RECIPES.recipes.filter((entry) => entry.unlock.type === "STARTING").length,
      guests: GUESTS.guestArchetypes.length,
      friendlyNonHumanOrMonsters: GUESTS.guestArchetypes.filter((entry) => entry.classification !== "HUMAN").length,
      facilities: targetDocuments["data/upgrades.json"].facilities.length,
      events: targetDocuments["data/events.json"].events.length,
    }),
  });
}

async function main() {
  const argumentsSet = new Set(process.argv.slice(2));
  const supported = new Set(["--write", "--check", "--json"]);
  const unknown = [...argumentsSet].filter((argument) => !supported.has(argument));
  if (unknown.length > 0) throw new Error(`지원하지 않는 인자입니다: ${unknown.join(", ")}`);
  if (argumentsSet.has("--write") === argumentsSet.has("--check")) {
    throw new Error("--write 또는 --check 중 정확히 하나를 지정해야 합니다.");
  }
  const result = await migrateCanonicalData({ write: argumentsSet.has("--write") });
  if (argumentsSet.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Canonical data migration: ${result.status} (${result.mode}, content v${result.contentVersion})`);
    console.log(`Files: ${result.canonicalFiles.length}, dangling references: ${result.danglingReferenceCount}`);
    console.log(`Counts: ingredients=${result.counts.ingredients}, recipes=${result.counts.recipes}, starting=${result.counts.startingRecipes}, guests=${result.counts.guests}, facilities=${result.counts.facilities}, events=${result.counts.events}`);
    console.log(`Report: ${result.reportFile}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
