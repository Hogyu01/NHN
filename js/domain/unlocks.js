import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import { synchronizeMenuForPlanning } from "./menu.js";
import { addRecipeUnlocksForPlanning, validateRecipeState } from "./recipe.js";

export const UNLOCK_KIND = Object.freeze({
  RECIPE: "RECIPE",
  FACILITY: "FACILITY",
});

export const UNLOCK_COMMAND = Object.freeze({
  PUBLISH_FOR_PLANNING: "progression.unlock.publish",
});

export const UNLOCK_PUBLISH_READ_SET = Object.freeze(["campaign"]);
export const UNLOCK_PUBLISH_WRITE_SET = Object.freeze(["progression", "recipes", "menu"]);

function failure(code, details = undefined) {
  return validationFailure(code, [], details);
}

function success(plan) {
  return Object.freeze({ ok: true, plan: freezeDeep(plan) });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCatalogEntries(left, right) {
  return left.threshold - right.threshold || compareIds(left.unlockId, right.unlockId);
}

function comparePendingEntries(left, right) {
  return left.availablePlanningDay - right.availablePlanningDay ||
    left.threshold - right.threshold || compareIds(left.unlockId, right.unlockId);
}

function equivalent(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equivalent(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equivalent(left[key], right[key]));
  }
  return false;
}

function requireCampaignDay(day, field = "day", maximum = 14) {
  return Number.isSafeInteger(day) && day >= 1 && day <= maximum
    ? validationSuccess()
    : failure("INVALID_UNLOCK_DAY", { field, value: day });
}

export function createUnlockId(kind, targetId) {
  if (!Object.values(UNLOCK_KIND).includes(kind) || !isStableIdentifier(targetId)) {
    throw Object.assign(new TypeError("unlock kind 또는 target ID가 유효하지 않습니다."), {
      code: "INVALID_UNLOCK_TARGET",
    });
  }
  const unlockId = `unlock.${kind.toLowerCase()}.${targetId}`;
  if (!isStableIdentifier(unlockId)) {
    throw Object.assign(new TypeError("생성된 unlock ID가 유효하지 않습니다."), {
      code: "INVALID_UNLOCK_ID",
    });
  }
  return unlockId;
}

export function validateUnlockDescriptor(descriptor, field = "unlock") {
  if (!isPlainRecord(descriptor)) return failure("INVALID_UNLOCK_DESCRIPTOR", { field });
  if (!isStableIdentifier(descriptor.unlockId)) {
    return failure("INVALID_UNLOCK_ID", { field: `${field}.unlockId`, value: descriptor.unlockId });
  }
  if (!Object.values(UNLOCK_KIND).includes(descriptor.kind)) {
    return failure("INVALID_UNLOCK_KIND", { field: `${field}.kind`, value: descriptor.kind });
  }
  if (!isStableIdentifier(descriptor.targetId)) {
    return failure("INVALID_UNLOCK_TARGET_ID", { field: `${field}.targetId`, value: descriptor.targetId });
  }
  if (!Number.isInteger(descriptor.threshold) || descriptor.threshold < 0 || descriptor.threshold > 100) {
    return failure("INVALID_UNLOCK_THRESHOLD", {
      field: `${field}.threshold`,
      value: descriptor.threshold,
    });
  }
  let expectedUnlockId;
  try {
    expectedUnlockId = createUnlockId(descriptor.kind, descriptor.targetId);
  } catch {
    return failure("INVALID_UNLOCK_ID", { field: `${field}.unlockId` });
  }
  return descriptor.unlockId === expectedUnlockId
    ? validationSuccess()
    : failure("UNLOCK_ID_TARGET_MISMATCH", {
      field: `${field}.unlockId`,
      expected: expectedUnlockId,
      actual: descriptor.unlockId,
    });
}

/** Builds the immutable Must unlock threshold registry from canonical Recipe/facility content. */
export function createUnlockCatalog({ recipes, facilities } = {}) {
  if (!Array.isArray(recipes) || !Array.isArray(facilities)) {
    throw Object.assign(new TypeError("Recipe와 facility 배열이 필요합니다."), {
      code: "INVALID_UNLOCK_CATALOG_INPUT",
    });
  }
  const entries = [];
  for (const recipe of recipes) {
    if (!isPlainRecord(recipe) || !isStableIdentifier(recipe.recipeId) || !isPlainRecord(recipe.unlock)) {
      throw Object.assign(new TypeError("unlock catalog의 Recipe가 유효하지 않습니다."), {
        code: "INVALID_UNLOCK_RECIPE",
      });
    }
    if (recipe.unlock.type !== "REPUTATION") continue;
    entries.push({
      unlockId: createUnlockId(UNLOCK_KIND.RECIPE, recipe.recipeId),
      kind: UNLOCK_KIND.RECIPE,
      targetId: recipe.recipeId,
      threshold: recipe.unlock.reputationThreshold,
    });
  }
  for (const facility of facilities) {
    if (!isPlainRecord(facility) || !isStableIdentifier(facility.facilityId)) {
      throw Object.assign(new TypeError("unlock catalog의 facility가 유효하지 않습니다."), {
        code: "INVALID_UNLOCK_FACILITY",
      });
    }
    entries.push({
      unlockId: createUnlockId(UNLOCK_KIND.FACILITY, facility.facilityId),
      kind: UNLOCK_KIND.FACILITY,
      targetId: facility.facilityId,
      threshold: facility.unlockReputation,
    });
  }
  entries.sort(compareCatalogEntries);
  const seenUnlocks = new Set();
  const seenTargets = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const validation = validateUnlockDescriptor(entries[index], `unlockCatalog[${index}]`);
    if (!validation.ok) {
      throw Object.assign(new TypeError(validation.code), { code: validation.code, details: validation.details });
    }
    const targetKey = `${entries[index].kind}:${entries[index].targetId}`;
    if (seenUnlocks.has(entries[index].unlockId) || seenTargets.has(targetKey)) {
      throw Object.assign(new TypeError("unlock catalog에 중복 대상이 있습니다."), {
        code: "DUPLICATE_UNLOCK_TARGET",
      });
    }
    seenUnlocks.add(entries[index].unlockId);
    seenTargets.add(targetKey);
  }
  return freezeDeep(entries);
}

export function validateProgressionState(state) {
  if (!isPlainRecord(state) || !Array.isArray(state.unlockCatalog) ||
      !Array.isArray(state.pendingUnlocks) || !Array.isArray(state.publishedUnlockIds) ||
      !Array.isArray(state.unlockedFacilityIds)) {
    return failure("INVALID_PROGRESSION_STATE");
  }
  const catalogById = new Map();
  for (let index = 0; index < state.unlockCatalog.length; index += 1) {
    const descriptor = state.unlockCatalog[index];
    const validation = validateUnlockDescriptor(descriptor, `unlockCatalog[${index}]`);
    if (!validation.ok) return validation;
    if (catalogById.has(descriptor.unlockId)) {
      return failure("DUPLICATE_UNLOCK_ID", { unlockId: descriptor.unlockId });
    }
    if (index > 0 && compareCatalogEntries(state.unlockCatalog[index - 1], descriptor) >= 0) {
      return failure("UNLOCK_CATALOG_ORDER_INVALID", { index });
    }
    catalogById.set(descriptor.unlockId, descriptor);
  }

  const published = new Set();
  for (let index = 0; index < state.publishedUnlockIds.length; index += 1) {
    const unlockId = state.publishedUnlockIds[index];
    if (!isStableIdentifier(unlockId) || !catalogById.has(unlockId)) {
      return failure("PUBLISHED_UNLOCK_NOT_FOUND", { unlockId, index });
    }
    if (published.has(unlockId)) return failure("DUPLICATE_PUBLISHED_UNLOCK", { unlockId });
    if (index > 0 && compareIds(state.publishedUnlockIds[index - 1], unlockId) >= 0) {
      return failure("PUBLISHED_UNLOCK_ORDER_INVALID", { index });
    }
    published.add(unlockId);
  }

  const pending = new Set();
  for (let index = 0; index < state.pendingUnlocks.length; index += 1) {
    const entry = state.pendingUnlocks[index];
    const descriptorValidation = validateUnlockDescriptor(entry, `pendingUnlocks[${index}]`);
    if (!descriptorValidation.ok) return descriptorValidation;
    const canonical = catalogById.get(entry.unlockId);
    if (!canonical || !equivalent(canonical, {
      unlockId: entry.unlockId,
      kind: entry.kind,
      targetId: entry.targetId,
      threshold: entry.threshold,
    })) {
      return failure("PENDING_UNLOCK_CATALOG_MISMATCH", { unlockId: entry.unlockId });
    }
    if (!isStableIdentifier(entry.causeId)) {
      return failure("INVALID_UNLOCK_CAUSE_ID", { index, causeId: entry.causeId });
    }
    const crossingDay = requireCampaignDay(entry.crossedDay, `pendingUnlocks[${index}].crossedDay`);
    if (!crossingDay.ok) return crossingDay;
    const availableDay = requireCampaignDay(
      entry.availablePlanningDay,
      `pendingUnlocks[${index}].availablePlanningDay`,
      15,
    );
    if (!availableDay.ok) return availableDay;
    if (entry.availablePlanningDay !== entry.crossedDay + 1) {
      return failure("UNLOCK_AVAILABILITY_DAY_MISMATCH", { unlockId: entry.unlockId });
    }
    if (pending.has(entry.unlockId) || published.has(entry.unlockId)) {
      return failure("UNLOCK_ALREADY_HANDLED", { unlockId: entry.unlockId });
    }
    if (index > 0 && comparePendingEntries(state.pendingUnlocks[index - 1], entry) >= 0) {
      return failure("PENDING_UNLOCK_ORDER_INVALID", { index });
    }
    pending.add(entry.unlockId);
  }

  const facilityTargets = new Set(
    state.unlockCatalog
      .filter((descriptor) => descriptor.kind === UNLOCK_KIND.FACILITY)
      .map((descriptor) => descriptor.targetId),
  );
  const expectedFacilities = state.unlockCatalog
    .filter((descriptor) => descriptor.kind === UNLOCK_KIND.FACILITY && published.has(descriptor.unlockId))
    .map((descriptor) => descriptor.targetId)
    .sort(compareIds);
  const seenFacilities = new Set();
  for (let index = 0; index < state.unlockedFacilityIds.length; index += 1) {
    const facilityId = state.unlockedFacilityIds[index];
    if (!isStableIdentifier(facilityId) || !facilityTargets.has(facilityId)) {
      return failure("UNLOCKED_FACILITY_NOT_FOUND", { facilityId, index });
    }
    if (seenFacilities.has(facilityId)) return failure("DUPLICATE_UNLOCKED_FACILITY", { facilityId });
    if (index > 0 && compareIds(state.unlockedFacilityIds[index - 1], facilityId) >= 0) {
      return failure("UNLOCKED_FACILITY_ORDER_INVALID", { index });
    }
    seenFacilities.add(facilityId);
  }
  return equivalent(state.unlockedFacilityIds, expectedFacilities)
    ? validationSuccess({
      catalogCount: state.unlockCatalog.length,
      pendingCount: state.pendingUnlocks.length,
      publishedCount: state.publishedUnlockIds.length,
    })
    : failure("PUBLISHED_FACILITY_PROJECTION_MISMATCH", {
      expected: expectedFacilities,
      actual: state.unlockedFacilityIds,
    });
}

export function createProgressionState({ unlockCatalog } = {}) {
  if (!Array.isArray(unlockCatalog)) {
    throw Object.assign(new TypeError("unlockCatalog 배열이 필요합니다."), {
      code: "INVALID_UNLOCK_CATALOG_INPUT",
    });
  }
  const state = {
    unlockCatalog: cloneValue(unlockCatalog).sort(compareCatalogEntries),
    pendingUnlocks: [],
    publishedUnlockIds: [],
    unlockedFacilityIds: [],
  };
  const validation = validateProgressionState(state);
  if (!validation.ok) {
    throw Object.assign(new TypeError(`ProgressionState가 유효하지 않습니다: ${validation.code}`), {
      code: validation.code,
      details: validation.details,
    });
  }
  return freezeDeep(state);
}

/**
 * Records every not-yet-handled actual crossing. ReputationSystem is the only caller allowed to
 * invoke this draft helper, so qualification and the reputation Cause_Id commit share one boundary.
 */
export function applyThresholdCrossingsToProgressionDraft(
  progressionDraft,
  { previousReputation, nextReputation, causeId, crossedDay },
) {
  const validation = validateProgressionState(progressionDraft);
  if (!validation.ok) return validation;
  if (!Number.isInteger(previousReputation) || previousReputation < 0 || previousReputation > 100 ||
      !Number.isInteger(nextReputation) || nextReputation < 0 || nextReputation > 100 ||
      !isStableIdentifier(causeId)) {
    return failure("INVALID_UNLOCK_CROSSING_INPUT");
  }
  const dayValidation = requireCampaignDay(crossedDay, "crossedDay");
  if (!dayValidation.ok) return dayValidation;
  const handled = new Set([
    ...progressionDraft.pendingUnlocks.map((entry) => entry.unlockId),
    ...progressionDraft.publishedUnlockIds,
  ]);
  const qualified = progressionDraft.unlockCatalog
    .filter((descriptor) =>
      previousReputation < descriptor.threshold && nextReputation >= descriptor.threshold &&
      !handled.has(descriptor.unlockId))
    .map((descriptor) => ({
      ...cloneValue(descriptor),
      causeId,
      crossedDay,
      availablePlanningDay: crossedDay + 1,
    }));
  progressionDraft.pendingUnlocks.push(...qualified);
  progressionDraft.pendingUnlocks.sort(comparePendingEntries);
  const afterValidation = validateProgressionState(progressionDraft);
  if (!afterValidation.ok) return afterValidation;
  return success({ qualifiedUnlocks: qualified });
}

function validatePublishPayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_UNLOCK_PUBLISH_PAYLOAD");
  return requireCampaignDay(payload.day, "payload.day");
}

export function planUnlockPublication({ campaign, progression, recipes, menu }, payload) {
  const payloadValidation = validatePublishPayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  if (!isPlainRecord(campaign) || !isStableIdentifier(campaign.campaignId)) {
    return failure("INVALID_CAMPAIGN_STATE");
  }
  const campaignDay = requireCampaignDay(campaign.day, "campaign.day");
  if (!campaignDay.ok) return campaignDay;
  if (campaign.day !== payload.day) {
    return failure("UNLOCK_PUBLISH_DAY_MISMATCH", {
      campaignDay: campaign.day,
      payloadDay: payload.day,
    });
  }
  const progressionValidation = validateProgressionState(progression);
  if (!progressionValidation.ok) return progressionValidation;
  const recipeValidation = validateRecipeState(recipes);
  if (!recipeValidation.ok) return failure("RECIPE_STATE_INVALID", { cause: recipeValidation.code });
  if (!isPlainRecord(menu) || menu.day !== campaign.day) {
    return failure("UNLOCK_MENU_DAY_MISMATCH", { menuDay: menu?.day, campaignDay: campaign.day });
  }
  const dueUnlocks = progression.pendingUnlocks
    .filter((entry) => entry.availablePlanningDay <= campaign.day)
    .sort(comparePendingEntries);
  if (dueUnlocks.length === 0) return failure("NO_UNLOCKS_DUE", { day: campaign.day });

  const recipeIds = dueUnlocks
    .filter((entry) => entry.kind === UNLOCK_KIND.RECIPE)
    .map((entry) => entry.targetId);
  const recipeResult = addRecipeUnlocksForPlanning(recipes, recipeIds);
  if (!recipeResult.ok) return recipeResult;
  const menuResult = synchronizeMenuForPlanning(menu, recipeResult.state);
  if (!menuResult.ok) return menuResult;

  const progressionCandidate = cloneValue(progression);
  const dueIds = new Set(dueUnlocks.map((entry) => entry.unlockId));
  progressionCandidate.pendingUnlocks = progressionCandidate.pendingUnlocks
    .filter((entry) => !dueIds.has(entry.unlockId));
  progressionCandidate.publishedUnlockIds = [
    ...new Set([...progressionCandidate.publishedUnlockIds, ...dueIds]),
  ].sort(compareIds);
  progressionCandidate.unlockedFacilityIds = progressionCandidate.unlockCatalog
    .filter((descriptor) => descriptor.kind === UNLOCK_KIND.FACILITY &&
      progressionCandidate.publishedUnlockIds.includes(descriptor.unlockId))
    .map((descriptor) => descriptor.targetId)
    .sort(compareIds);
  const candidateValidation = validateProgressionState(progressionCandidate);
  if (!candidateValidation.ok) return candidateValidation;

  return success({
    progression: progressionCandidate,
    recipes: recipeResult.state,
    menu: menuResult.plan.menu,
    dueUnlocks,
    addedRecipeIds: recipeResult.addedRecipeIds,
    unlockedFacilityIds: progressionCandidate.unlockedFacilityIds,
  });
}

export function createPublishUnlocksAtomicTransaction() {
  return defineAtomicTransaction({
    name: UNLOCK_COMMAND.PUBLISH_FOR_PLANNING,
    readSet: UNLOCK_PUBLISH_READ_SET,
    writeSet: UNLOCK_PUBLISH_WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      return validatePublishPayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planUnlockPublication({
        campaign: ctx.read("campaign"),
        progression: ctx.read("progression"),
        recipes: ctx.read("recipes"),
        menu: ctx.read("menu"),
      }, ctx.command.payload);
    },
    mutate(draft) {
      const planned = planUnlockPublication({
        campaign: draft.read("campaign"),
        progression: draft.read("progression"),
        recipes: draft.read("recipes"),
        menu: draft.read("menu"),
      }, draft.command.payload);
      if (!planned.ok) return planned;
      for (const slice of UNLOCK_PUBLISH_WRITE_SET) draft.replace(slice, planned.plan[slice]);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planUnlockPublication({
        campaign: before.campaign,
        progression: before.progression,
        recipes: before.recipes,
        menu: before.menu,
      }, ctx.command.payload);
      if (!planned.ok) return planned;
      for (const slice of UNLOCK_PUBLISH_WRITE_SET) {
        if (!equivalent(after[slice], planned.plan[slice])) {
          return failure("UNLOCK_PUBLICATION_PLAN_MISMATCH", { slice });
        }
      }
      return validationSuccess({ publishedCount: planned.plan.dueUnlocks.length });
    },
    events(before, _after, ctx) {
      const planned = planUnlockPublication({
        campaign: before.campaign,
        progression: before.progression,
        recipes: before.recipes,
        menu: before.menu,
      }, ctx.command.payload);
      if (!planned.ok) return [];
      return planned.plan.dueUnlocks.map((entry) => ({
        causeId: entry.causeId,
        type: "progression.unlock-available",
        payload: {
          unlockId: entry.unlockId,
          kind: entry.kind,
          targetId: entry.targetId,
          threshold: entry.threshold,
          crossedDay: entry.crossedDay,
          availablePlanningDay: entry.availablePlanningDay,
          publishedDay: before.campaign.day,
        },
      }));
    },
  });
}

function commandEnvelope(input) {
  return {
    commandId: input?.commandId,
    expectedRevision: input?.expectedRevision,
    generationId: input?.generationId,
    issuedAtSimulationMs: input?.issuedAtSimulationMs,
    type: UNLOCK_COMMAND.PUBLISH_FOR_PLANNING,
    payload: input?.payload,
    readSet: [...UNLOCK_PUBLISH_READ_SET],
    writeSet: [...UNLOCK_PUBLISH_WRITE_SET],
  };
}

export function projectUnlocks(snapshot) {
  const validation = validateProgressionState(snapshot.progression);
  if (!validation.ok) throw new TypeError(`Progression projection이 유효하지 않습니다: ${validation.code}`);
  const day = snapshot.campaign?.day;
  return freezeDeep({
    publishedUnlockIds: [...snapshot.progression.publishedUnlockIds],
    unlockedFacilityIds: [...snapshot.progression.unlockedFacilityIds],
    pendingUnlocks: snapshot.progression.pendingUnlocks.map((entry) => ({
      ...cloneValue(entry),
      due: Number.isSafeInteger(day) && entry.availablePlanningDay <= day,
    })),
  });
}

export class UnlockPublisher {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("UnlockPublisher에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(
      UNLOCK_COMMAND.PUBLISH_FOR_PLANNING,
      createPublishUnlocksAtomicTransaction(),
    );
    this.registered = true;
    return this;
  }

  publishForPlanning(input) {
    return this.commandBus.dispatch(commandEnvelope(input));
  }

  project(snapshot) {
    return projectUnlocks(snapshot);
  }
}

export function registerUnlockPublisher(commandBus) {
  return new UnlockPublisher(commandBus, { register: true });
}
