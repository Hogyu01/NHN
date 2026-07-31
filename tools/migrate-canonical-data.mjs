#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANONICAL_CONTENT_SPECIFICATIONS,
  CANONICAL_MIGRATION_REPORT_SPECIFICATION,
} from "../js/infrastructure/canonical-content.js";
import { DataValidator, VALIDATION_ERROR_TYPE } from "../js/infrastructure/data-validator.js";
import {
  CANONICAL_CONTENT_FILE_CONTRACTS,
  DATA_SCHEMA,
} from "../js/infrastructure/schema-registry.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_FILENAME = CANONICAL_MIGRATION_REPORT_SPECIFICATION.filename;
const LEGACY_FILENAMES = Object.freeze([
  "data/ingredients.json",
  "data/recipes.json",
  "data/upgrades.json",
  "data/dialogue.json",
]);

const LEGACY_DOCUMENTS = Object.freeze({
  "data/ingredients.json": [{
    "이름": "슬라임 젤리",
    "카테고리": "예: 육류/채소/약초/광물 중 하나",
    "확률_일반": 0.6,
    "확률_고급": 0.3,
    "확률_희귀": 0.1,
    "맛_프로필": "예: 신맛",
  }],
  "data/recipes.json": [{
    "이름": "예: 슬라임 스튜",
    "필요_재료": ["슬라임 젤리", "던전 약초"],
    "맛_매칭_보너스": "예: 신맛 재료 + 쓴맛 약초 = 성공률 +20%",
    "성공_문구": "",
    "보통_문구": "",
    "실패_문구": "",
  }],
  "data/upgrades.json": [{
    "이름": "예: 레시피 확장",
    "효과_설명": "",
  }],
  "data/dialogue.json": {
    "모험가": {
      "이름": "",
      "성격_한줄": "",
      "리빌_연출_문구": "예: 봇짐을 풀어 보여줍니다...",
    },
    "손님": [{
      "유형": "예: 배고픈 여행자",
      "요청_대사": "",
      "재촉_대사": "",
      "만족_대사": "",
    }],
  },
});

function qualityDistribution(lowWeight, middleWeight, highWeight) {
  return [
    { minQuality: 0, maxQuality: 49, weight: lowWeight },
    { minQuality: 50, maxQuality: 79, weight: middleWeight },
    { minQuality: 80, maxQuality: 100, weight: highWeight },
  ];
}

const INGREDIENTS = Object.freeze({
  contentId: "content.ingredients",
  schemaVersion: 1,
  ingredients: [
    {
      ingredientId: "ingredient.slime_gel",
      displayName: "슬라임 젤리",
      category: "ARCANE",
      basePriceG: 8,
      marketAvailabilityRate: 90,
      marketStockRange: { minimum: 8, maximum: 16 },
      qualityDistribution: qualityDistribution(0.2, 0.55, 0.25),
    },
    {
      ingredientId: "ingredient.cave_mushroom",
      displayName: "동굴 버섯",
      category: "FUNGI",
      basePriceG: 9,
      marketAvailabilityRate: 85,
      marketStockRange: { minimum: 7, maximum: 14 },
      qualityDistribution: qualityDistribution(0.2, 0.5, 0.3),
    },
    {
      ingredientId: "ingredient.glow_herb",
      displayName: "발광 허브",
      category: "HERB",
      basePriceG: 12,
      marketAvailabilityRate: 65,
      marketStockRange: { minimum: 3, maximum: 8 },
      qualityDistribution: qualityDistribution(0.1, 0.45, 0.45),
    },
    {
      ingredientId: "ingredient.ember_pepper",
      displayName: "잿불 고추",
      category: "SPICE",
      basePriceG: 14,
      marketAvailabilityRate: 60,
      marketStockRange: { minimum: 3, maximum: 9 },
      qualityDistribution: qualityDistribution(0.25, 0.5, 0.25),
    },
    {
      ingredientId: "ingredient.moonroot",
      displayName: "달뿌리",
      category: "ROOT",
      basePriceG: 11,
      marketAvailabilityRate: 75,
      marketStockRange: { minimum: 5, maximum: 11 },
      qualityDistribution: qualityDistribution(0.2, 0.55, 0.25),
    },
    {
      ingredientId: "ingredient.crystal_salt",
      displayName: "수정 소금",
      category: "MINERAL",
      basePriceG: 5,
      marketAvailabilityRate: 95,
      marketStockRange: { minimum: 8, maximum: 18 },
      qualityDistribution: qualityDistribution(0.15, 0.6, 0.25),
    },
    {
      ingredientId: "ingredient.stonegrain",
      displayName: "돌껍질 곡물",
      category: "GRAIN",
      basePriceG: 7,
      marketAvailabilityRate: 90,
      marketStockRange: { minimum: 9, maximum: 18 },
      qualityDistribution: qualityDistribution(0.2, 0.6, 0.2),
    },
    {
      ingredientId: "ingredient.griffin_egg",
      displayName: "그리핀 알",
      category: "PROTEIN",
      basePriceG: 22,
      marketAvailabilityRate: 45,
      marketStockRange: { minimum: 2, maximum: 6 },
      qualityDistribution: qualityDistribution(0.25, 0.45, 0.3),
    },
    {
      ingredientId: "ingredient.mimic_bean",
      displayName: "미믹 콩",
      category: "LEGUME",
      basePriceG: 16,
      marketAvailabilityRate: 55,
      marketStockRange: { minimum: 3, maximum: 7 },
      qualityDistribution: qualityDistribution(0.2, 0.5, 0.3),
    },
    {
      ingredientId: "ingredient.moss_cheese",
      displayName: "이끼 치즈",
      category: "DAIRY",
      basePriceG: 18,
      marketAvailabilityRate: 50,
      marketStockRange: { minimum: 2, maximum: 7 },
      qualityDistribution: qualityDistribution(0.2, 0.45, 0.35),
    },
  ],
});

const RECIPES = Object.freeze({
  contentId: "content.recipes",
  schemaVersion: 1,
  recipes: [
    {
      recipeId: "recipe.slime_stew",
      displayName: "슬라임 스튜",
      basePriceG: 44,
      ingredientRequirements: [
        { ingredientId: "ingredient.slime_gel", quantity: 2 },
        { ingredientId: "ingredient.cave_mushroom", quantity: 1 },
        { ingredientId: "ingredient.crystal_salt", quantity: 1 },
      ],
      timing: { targetOffsetMs: 2200, successWindowMs: 250, normalWindowMs: 650, failureOffsetMs: 3500 },
      unlock: { type: "STARTING", reputationThreshold: null },
    },
    {
      recipeId: "recipe.stonegrain_bowl",
      displayName: "돌곡물 버섯죽",
      basePriceG: 42,
      ingredientRequirements: [
        { ingredientId: "ingredient.stonegrain", quantity: 2 },
        { ingredientId: "ingredient.cave_mushroom", quantity: 1 },
        { ingredientId: "ingredient.crystal_salt", quantity: 1 },
      ],
      timing: { targetOffsetMs: 1800, successWindowMs: 300, normalWindowMs: 700, failureOffsetMs: 3200 },
      unlock: { type: "STARTING", reputationThreshold: null },
    },
    {
      recipeId: "recipe.glowcap_soup",
      displayName: "빛갓 수프",
      basePriceG: 48,
      ingredientRequirements: [
        { ingredientId: "ingredient.cave_mushroom", quantity: 1 },
        { ingredientId: "ingredient.glow_herb", quantity: 1 },
        { ingredientId: "ingredient.crystal_salt", quantity: 1 },
      ],
      timing: { targetOffsetMs: 2600, successWindowMs: 220, normalWindowMs: 600, failureOffsetMs: 3800 },
      unlock: { type: "REPUTATION", reputationThreshold: 40 },
    },
    {
      recipeId: "recipe.ember_egg_skewer",
      displayName: "잿불알 꼬치",
      basePriceG: 64,
      ingredientRequirements: [
        { ingredientId: "ingredient.griffin_egg", quantity: 1 },
        { ingredientId: "ingredient.ember_pepper", quantity: 1 },
      ],
      timing: { targetOffsetMs: 3000, successWindowMs: 180, normalWindowMs: 500, failureOffsetMs: 4000 },
      unlock: { type: "REPUTATION", reputationThreshold: 48 },
    },
    {
      recipeId: "recipe.moonroot_pie",
      displayName: "달뿌리 파이",
      basePriceG: 78,
      ingredientRequirements: [
        { ingredientId: "ingredient.moonroot", quantity: 2 },
        { ingredientId: "ingredient.stonegrain", quantity: 1 },
        { ingredientId: "ingredient.moss_cheese", quantity: 1 },
      ],
      timing: { targetOffsetMs: 3400, successWindowMs: 200, normalWindowMs: 650, failureOffsetMs: 4500 },
      unlock: { type: "REPUTATION", reputationThreshold: 56 },
    },
    {
      recipeId: "recipe.mimic_hotpot",
      displayName: "미믹콩 전골",
      basePriceG: 72,
      ingredientRequirements: [
        { ingredientId: "ingredient.mimic_bean", quantity: 1 },
        { ingredientId: "ingredient.slime_gel", quantity: 1 },
        { ingredientId: "ingredient.glow_herb", quantity: 1 },
        { ingredientId: "ingredient.crystal_salt", quantity: 1 },
      ],
      timing: { targetOffsetMs: 3800, successWindowMs: 160, normalWindowMs: 550, failureOffsetMs: 4800 },
      unlock: { type: "REPUTATION", reputationThreshold: 64 },
    },
  ],
});

const FACILITIES = Object.freeze({
  contentId: "content.facilities",
  schemaVersion: 1,
  facilities: [
    {
      facilityId: "facility.kitchen_stage_1",
      displayName: "화로 온도계",
      kind: "KITCHEN",
      stage: 1,
      costG: 90,
      unlockReputation: 36,
      effect: { type: "TIMING_WINDOW_BONUS_MS", value: 120, unit: "MILLISECONDS" },
      effectiveTiming: "SAME_DAY",
    },
    {
      facilityId: "facility.hall_stage_1",
      displayName: "푹신한 긴의자",
      kind: "HALL",
      stage: 1,
      costG: 110,
      unlockReputation: 42,
      effect: { type: "PATIENCE_BONUS_MS", value: 5000, unit: "MILLISECONDS" },
      effectiveTiming: "SAME_DAY",
    },
    {
      facilityId: "facility.storage_stage_1",
      displayName: "구리 선반",
      kind: "STORAGE",
      stage: 1,
      costG: 100,
      unlockReputation: 48,
      effect: { type: "MARKET_PURCHASE_LIMIT_BONUS_QUANTITY", value: 12, unit: "QUANTITY" },
      effectiveTiming: "SAME_DAY",
    },
  ],
});

const GUESTS = Object.freeze({
  contentId: "content.guests",
  schemaVersion: 1,
  guestArchetypes: [
    {
      guestArchetypeId: "guest.human_adventurer",
      displayName: "인간 모험가",
      classification: "HUMAN",
      visualCue: "둥근 배낭",
      assetId: "sprite.guest.human_adventurer",
      selectionWeight: 20,
      recipePreferenceWeights: [
        { recipeId: "recipe.stonegrain_bowl", weight: 5 },
        { recipeId: "recipe.slime_stew", weight: 4 },
        { recipeId: "recipe.glowcap_soup", weight: 3 },
      ],
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ],
});

const EVENTS = Object.freeze({
  contentId: "content.events",
  schemaVersion: 1,
  events: [
    {
      eventId: "event.intro_last_hearth",
      displayName: "마지막 화로의 첫 불",
      description: "황동 나침반 아래에서 주인장이 첫 장부를 펼칩니다.",
      selection: "FIXED_DAY_1",
      durationDays: 1,
      modifiers: {
        guestCountDelta: 0,
        patienceDeltaMs: 0,
        timingWindowBonusMs: 0,
        marketPurchaseLimitBonusQuantity: 0,
      },
    },
    {
      eventId: "event.busy_crossroads",
      displayName: "붐비는 갈림길",
      description: "길 안내 표지판이 식당을 가리켜 손님이 조금 늘어납니다.",
      selection: "RANDOM_DAY_2_14",
      durationDays: 1,
      modifiers: {
        guestCountDelta: 2,
        patienceDeltaMs: 0,
        timingWindowBonusMs: 0,
        marketPurchaseLimitBonusQuantity: 0,
      },
    },
    {
      eventId: "event.patient_pilgrims",
      displayName: "느긋한 순례단",
      description: "길이 길었던 만큼 손님들이 메뉴를 천천히 기다립니다.",
      selection: "RANDOM_DAY_2_14",
      durationDays: 1,
      modifiers: {
        guestCountDelta: 0,
        patienceDeltaMs: 5000,
        timingWindowBonusMs: 0,
        marketPurchaseLimitBonusQuantity: 0,
      },
    },
    {
      eventId: "event.calm_embers",
      displayName: "얌전한 불씨",
      description: "화로가 드물게 말썽을 쉬어 Timing Cook 여유가 늘어납니다.",
      selection: "RANDOM_DAY_2_14",
      durationDays: 1,
      modifiers: {
        guestCountDelta: 0,
        patienceDeltaMs: 0,
        timingWindowBonusMs: 100,
        marketPurchaseLimitBonusQuantity: 0,
      },
    },
    {
      eventId: "event.quartermaster_visit",
      displayName: "길드 보급관 방문",
      description: "빈 수레가 아깝다며 오늘만 재료를 더 실어 줍니다.",
      selection: "RANDOM_DAY_2_14",
      durationDays: 1,
      modifiers: {
        guestCountDelta: 0,
        patienceDeltaMs: 0,
        timingWindowBonusMs: 0,
        marketPurchaseLimitBonusQuantity: 8,
      },
    },
  ],
});

function guestDialogue(guestArchetypeId, slug, order, hurry, satisfied) {
  return [
    {
      dialogueId: `dialogue.${slug}.order`,
      context: "ORDER",
      speaker: "GUEST",
      guestArchetypeId,
      recipeId: null,
      eventId: null,
      text: order,
    },
    {
      dialogueId: `dialogue.${slug}.hurry`,
      context: "HURRY",
      speaker: "GUEST",
      guestArchetypeId,
      recipeId: null,
      eventId: null,
      text: hurry,
    },
    {
      dialogueId: `dialogue.${slug}.satisfied`,
      context: "SATISFIED",
      speaker: "GUEST",
      guestArchetypeId,
      recipeId: null,
      eventId: null,
      text: satisfied,
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
    ...guestDialogue(
      "guest.human_adventurer",
      "human_adventurer",
      "배낭보다 든든한 한 그릇으로 부탁합니다.",
      "던전 시계가 제 배보다 빠르군요.",
      "이 정도면 지도에 별표를 그려도 되겠습니다.",
    ),
    ...guestDialogue(
      "guest.dwarf_courier",
      "dwarf_courier",
      "소포는 식고, 식사는 따뜻해야 합니다.",
      "배송표보다 주문표가 늦어지고 있습니다.",
      "튼튼한 그릇입니다. 내용물은 더 훌륭하고요.",
    ),
    ...guestDialogue(
      "guest.goblin_scholar",
      "goblin_scholar",
      "오늘의 연구 주제는 빈 접시의 원인입니다.",
      "가설: 조금 더 기다리면 배가 더 고프다.",
      "결론: 재현 실험이 필요한 맛입니다.",
    ),
    ...guestDialogue(
      "guest.slime_gourmand",
      "slime_gourmand",
      "숟가락은 하나면 됩니다. 저는 형태가 유연하거든요.",
      "냅킨이 먼저 녹기 전에 부탁합니다.",
      "탱글함의 기준이 한 단계 올랐습니다.",
    ),
    ...guestDialogue(
      "guest.kobold_porter",
      "kobold_porter",
      "상자는 무겁고 배는 가볍습니다.",
      "꼬리가 세 번 흔들리기 전에 나오면 좋겠습니다.",
      "이제 상자 두 개쯤은 더 들 수 있겠습니다.",
    ),
    ...guestDialogue(
      "guest.mushroom_traveler",
      "mushroom_traveler",
      "김이 나는 메뉴로 부탁합니다. 친척은 아닐 겁니다.",
      "제 갓에서 김이 나기 시작했습니다.",
      "향이 좋군요. 제 갓은 경쟁을 포기했습니다.",
    ),
  ],
});

const BALANCE = Object.freeze({
  contentId: "content.balance",
  schemaVersion: 1,
  campaign: {
    days: 14,
    startCashG: 300,
    startDebtG: 500,
    startReputation: 30,
    targetReputation: 70,
  },
  bankruptcy: {
    arrearsThresholdG: 80,
    consecutiveArrearsThreshold: 2,
  },
  economy: { fixedCostG: 40 },
  service: {
    durationMs: 105000,
    minimumDurationMs: 90000,
    maximumDurationMs: 105000,
    defaultGuestCount: 6,
    minimumGuestCount: 4,
    maximumGuestCount: 12,
    basePatienceMs: 30000,
    minimumPatienceMs: 20000,
    maximumPatienceMs: 60000,
    wrongServePenaltyMs: 3000,
    cleanupOvertimeMs: 12000,
    guestSpeedLogicalPxPerSecond: 96,
    reactionFrameMs: 120,
    reactionFrameCount: 4,
  },
  market: {
    priceVariancePercent: 20,
    defaultPurchaseLimitQuantity: 30,
  },
  contract: {
    prepaidPercent: 20,
    arrivalDayOffset: 1,
    riskTiers: [
      { risk: "LOW", successRate: 90, discountPercent: 5 },
      { risk: "MEDIUM", successRate: 70, discountPercent: 15 },
      { risk: "HIGH", successRate: 50, discountPercent: 30 },
    ],
  },
  world: {
    baseMapId: "map.base_restaurant",
    tileSize: 32,
    cameraViewportWidth: 480,
    cameraViewportHeight: 480,
    playerCollisionWidth: 20,
    playerCollisionHeight: 12,
    maximumMapAxis: 128,
    maximumMapArea: 16384,
    maximumRegisteredMaps: 16,
    baseTableCount: 6,
    baseSeatsPerTable: 2,
    baseActiveSeatCount: 12,
  },
});

const CONTENT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  manifestVersion: 1,
  contentVersion: 1,
  manifestId: "manifest.canonical-content.v1",
  files: CANONICAL_CONTENT_FILE_CONTRACTS.map((contract) => ({
    contentId: contract.contentId,
    filename: contract.filename,
    schemaName: contract.schemaName,
    schemaVersion: contract.schemaVersion,
    required: true,
  })),
});

export const CANONICAL_DOCUMENTS = Object.freeze({
  "data/ingredients.json": INGREDIENTS,
  "data/recipes.json": RECIPES,
  "data/upgrades.json": FACILITIES,
  "data/dialogue.json": DIALOGUE,
  "data/guests.json": GUESTS,
  "data/events.json": EVENTS,
  "data/balance.json": BALANCE,
  "data/content-manifest.json": CONTENT_MANIFEST,
});

function canonicalComparable(value) {
  if (Array.isArray(value)) return value.map(canonicalComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalComparable(value[key])]));
  }
  return value;
}

function semanticallyEqual(left, right) {
  return JSON.stringify(canonicalComparable(left)) === JSON.stringify(canonicalComparable(right));
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function pathExists(filename) {
  try {
    await stat(resolve(REPOSITORY_ROOT, filename));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readText(filename) {
  return readFile(resolve(REPOSITORY_ROOT, filename), "utf8");
}

async function readJson(filename) {
  const text = await readText(filename);
  try {
    return { text, data: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${filename} JSON parse 실패: ${error.message}`);
  }
}

function contentDocumentsForValidation(report = null) {
  const documents = CANONICAL_CONTENT_SPECIFICATIONS.map((specification) => ({
    ...specification,
    data: CANONICAL_DOCUMENTS[specification.filename],
  }));
  if (report) {
    documents.push({
      ...CANONICAL_MIGRATION_REPORT_SPECIFICATION,
      data: report,
    });
  }
  return documents;
}

function assertValidCanonicalDocuments(report = null) {
  const validation = new DataValidator().validateDocuments(contentDocumentsForValidation(report));
  if (!validation.ok) {
    const details = validation.diagnostics.map((diagnostic) =>
      `${diagnostic.filename} | ${diagnostic.errorType} | ${diagnostic.fieldPath} | ${diagnostic.code}`,
    ).join("\n");
    throw new Error(`canonical migration payload validation 실패:\n${details}`);
  }
  return validation;
}

function buildIdMappings() {
  const planned = [
    ...INGREDIENTS.ingredients.map((entry) => ["INGREDIENT", entry.ingredientId]),
    ...RECIPES.recipes.map((entry) => ["RECIPE", entry.recipeId]),
    ...FACILITIES.facilities.map((entry) => ["FACILITY", entry.facilityId]),
    ...GUESTS.guestArchetypes.map((entry) => ["GUEST", entry.guestArchetypeId]),
    ...EVENTS.events.map((entry) => ["EVENT", entry.eventId]),
  ];
  const mappings = planned.map(([domain, targetId]) => ({
    domain,
    sourceFile: null,
    sourcePath: null,
    sourceValue: null,
    disposition: "ADDED_FROM_APPROVED_PLAN",
    targetId,
    rationale: "content-balance-plan.md의 승인된 ID/수량 baseline을 canonical stable ID로 채택했습니다.",
  }));

  const slime = mappings.find((entry) => entry.targetId === "ingredient.slime_gel");
  Object.assign(slime, {
    sourceFile: "data/ingredients.json",
    sourcePath: "$[0].이름",
    sourceValue: "슬라임 젤리",
    disposition: "MAPPED_LEGACY_VALUE",
    rationale: "유일한 비예시 legacy 표시명을 승인 ID ingredient.slime_gel에 명시적으로 매핑했습니다.",
  });
  const stew = mappings.find((entry) => entry.targetId === "recipe.slime_stew");
  Object.assign(stew, {
    sourceFile: "data/recipes.json",
    sourcePath: "$[0].이름",
    sourceValue: "예: 슬라임 스튜",
    disposition: "REPLACED_EXAMPLE_PLACEHOLDER",
    rationale: "'예:' 값은 데이터로 승격하지 않고 승인 계획의 recipe.slime_stew로 교체했습니다.",
  });

  mappings.push(
    {
      domain: "FACILITY",
      sourceFile: "data/upgrades.json",
      sourcePath: "$[0].이름",
      sourceValue: "예: 레시피 확장",
      disposition: "OMITTED_EXAMPLE_PLACEHOLDER",
      targetId: null,
      rationale: "generic 레시피 확장 예시는 kitchen/hall/storage Must stage와 의미가 달라 매핑하지 않았습니다.",
    },
    {
      domain: "DIALOGUE",
      sourceFile: "data/dialogue.json",
      sourcePath: "$.손님[0].유형",
      sourceValue: "예: 배고픈 여행자",
      disposition: "OMITTED_EXAMPLE_PLACEHOLDER",
      targetId: null,
      rationale: "빈 대사와 '예:' 손님 유형은 canonical dialogue/guest ID로 추정 변환하지 않았습니다.",
    },
  );
  return mappings;
}

function buildDecisions() {
  return [
    {
      decisionId: "migration.decision.no_ratio_coercion",
      authority: "requirements.md 20.2 and Task 5",
      field: "legacy ingredients probabilities",
      value: "discarded",
      rationale: "0.6/0.3/0.1은 legacy 등급 확률이며 canonical marketAvailabilityRate와 의미가 다릅니다. 60/30/10으로 coercion하지 않았습니다.",
    },
    {
      decisionId: "migration.decision.approved_ids",
      authority: "content-balance-plan.md sections 3-5",
      field: "ingredient/recipe/guest IDs",
      value: "preserved exactly",
      rationale: "승인 문서의 10 ingredient, 6 Recipe, 6 Guest stable ID를 그대로 사용했습니다.",
    },
    {
      decisionId: "migration.decision.explicit_tuning_baseline",
      authority: "Task 5 implementation baseline within requirements.md ranges",
      field: "prices, stock, preference weights, unlocks, facilities, event modifiers",
      value: "explicit canonical v1 values",
      rationale: "legacy 예시에서 추정하지 않고 이번 migration에서 명시한 값입니다. 후속 balance report가 이 versioned baseline을 측정합니다.",
    },
    {
      decisionId: "migration.decision.fixed_product_values",
      authority: "requirements.md approved product boundary",
      field: "campaign/economy/service/contract/world constants",
      value: "14d, 300G, 500G, 30->70, 40G, 105000ms, 6 guests",
      rationale: "승인된 고정값과 범위·계약을 balance.json에 분리해 단일 versioned source로 기록했습니다.",
    },
    {
      decisionId: "migration.decision.excluded_domains",
      authority: "requirements.md explicit exclusions and Requirement 34.15",
      field: "spoilage/combat/attack/damage/loot",
      value: "absent",
      rationale: "유통기한·부패와 전투 관련 필드·enum을 canonical schema 및 payload에 포함하지 않았습니다.",
    },
  ];
}

function buildMigrationReport(sourceRecords, targetTexts) {
  const targetFiles = Object.entries(targetTexts).map(([filename, text]) => {
    const specification = CANONICAL_CONTENT_SPECIFICATIONS.find((entry) => entry.filename === filename);
    const data = CANONICAL_DOCUMENTS[filename];
    return {
      filename,
      contentId: data.contentId ?? "content.manifest",
      schemaName: specification.schemaName,
      schemaVersion: data.schemaVersion,
      sha256: sha256(text),
    };
  });
  return {
    reportSchemaVersion: 1,
    migrationId: "migration.prototype-to-canonical.v1",
    sourceFormat: "legacy.prototype.unversioned",
    targetContentVersion: 1,
    status: "PASS",
    sourceFiles: sourceRecords,
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
      facilityCount: FACILITIES.facilities.length,
      eventCount: EVENTS.events.length,
    },
  };
}

async function classifyRepositoryData() {
  const legacyReads = await Promise.all(LEGACY_FILENAMES.map(readJson));
  const isLegacy = legacyReads.every((entry, index) =>
    semanticallyEqual(entry.data, LEGACY_DOCUMENTS[LEGACY_FILENAMES[index]]));
  const isCanonical = legacyReads.every((entry, index) =>
    semanticallyEqual(entry.data, CANONICAL_DOCUMENTS[LEGACY_FILENAMES[index]]));
  if (isLegacy) return { mode: "LEGACY", reads: legacyReads };
  if (isCanonical) return { mode: "CANONICAL", reads: legacyReads };
  throw new Error("legacy prototype 또는 canonical v1과 일치하지 않는 입력입니다. 부분 migration/수정본을 추정 변환하지 않습니다.");
}

async function verifyTargetHashes(report, actualTexts) {
  for (const target of report.targetFiles) {
    const text = actualTexts[target.filename];
    if (typeof text !== "string") throw new Error(`migration report target이 없습니다: ${target.filename}`);
    const actualHash = sha256(text);
    if (actualHash !== target.sha256) {
      throw new Error(`${target.filename} hash 불일치: expected=${target.sha256}, actual=${actualHash}`);
    }
  }
}

export async function migrateCanonicalData({ write = false } = {}) {
  const classification = await classifyRepositoryData();
  const expectedTexts = Object.fromEntries(Object.entries(CANONICAL_DOCUMENTS).map(
    ([filename, data]) => [filename, serializeJson(data)],
  ));

  assertValidCanonicalDocuments();

  if (classification.mode === "LEGACY") {
    if (!write) {
      throw new Error("legacy prototype data가 감지됐습니다. 실제 migration에는 --write가 필요합니다.");
    }
    const newTargets = Object.keys(CANONICAL_DOCUMENTS).filter((filename) => !LEGACY_FILENAMES.includes(filename));
    const collisions = [];
    for (const filename of [...newTargets, REPORT_FILENAME]) {
      if (await pathExists(filename)) collisions.push(filename);
    }
    if (collisions.length > 0) {
      throw new Error(`새 canonical target이 이미 존재해 덮어쓰지 않습니다: ${collisions.join(", ")}`);
    }

    const sourceRecords = classification.reads.map((entry, index) => ({
      filename: LEGACY_FILENAMES[index],
      sha256: sha256(entry.text),
      classification: "LEGACY_PLACEHOLDER",
    }));
    const report = buildMigrationReport(sourceRecords, expectedTexts);
    assertValidCanonicalDocuments(report);

    for (const [filename, text] of Object.entries(expectedTexts)) {
      const absolute = resolve(REPOSITORY_ROOT, filename);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text, { encoding: "utf8", flag: "w" });
    }
    const reportAbsolute = resolve(REPOSITORY_ROOT, REPORT_FILENAME);
    await mkdir(dirname(reportAbsolute), { recursive: true });
    await writeFile(reportAbsolute, serializeJson(report), { encoding: "utf8", flag: "wx" });
  }

  const actualTexts = {};
  for (const [filename, expectedText] of Object.entries(expectedTexts)) {
    const actualText = await readText(filename);
    if (actualText !== expectedText) {
      throw new Error(`${filename}이 canonical v1 bytes와 일치하지 않습니다.`);
    }
    actualTexts[filename] = actualText;
  }
  const reportRead = await readJson(REPORT_FILENAME);
  assertValidCanonicalDocuments(reportRead.data);
  await verifyTargetHashes(reportRead.data, actualTexts);
  const danglingReferenceCount = new DataValidator()
    .validateDocuments(contentDocumentsForValidation(reportRead.data))
    .diagnostics
    .filter((entry) => entry.errorType === VALIDATION_ERROR_TYPE.REFERENCE).length;
  if (danglingReferenceCount !== 0) {
    throw new Error(`dangling reference가 ${danglingReferenceCount}개 남았습니다.`);
  }

  return Object.freeze({
    status: "PASS",
    mode: classification.mode === "LEGACY" ? "MIGRATED" : "VERIFIED",
    contentVersion: 1,
    canonicalFiles: Object.keys(expectedTexts).sort(),
    reportFile: REPORT_FILENAME,
    danglingReferenceCount,
    counts: Object.freeze({
      ingredients: INGREDIENTS.ingredients.length,
      recipes: RECIPES.recipes.length,
      startingRecipes: RECIPES.recipes.filter((entry) => entry.unlock.type === "STARTING").length,
      guests: GUESTS.guestArchetypes.length,
      friendlyNonHumanOrMonsters: GUESTS.guestArchetypes.filter((entry) => entry.classification !== "HUMAN").length,
      facilities: FACILITIES.facilities.length,
      events: EVENTS.events.length,
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
