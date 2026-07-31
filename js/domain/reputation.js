import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction, isStableIdentifier } from "../core/transaction.js";
import {
  applyThresholdCrossingsToProgressionDraft,
  validateProgressionState,
} from "./unlocks.js";

export const REPUTATION_COMMAND = Object.freeze({
  APPLY_CAUSE: "reputation.cause.apply",
});

export const REPUTATION_APPLY_READ_SET = Object.freeze([]);
export const REPUTATION_APPLY_WRITE_SET = Object.freeze(["campaign", "progression"]);
export const REPUTATION_PHASES = Object.freeze(["PLANNING", "SERVICE", "SETTLEMENT"]);

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

function clampReputationDelta(previousReputation, delta) {
  if (delta >= 0) return Math.min(100, previousReputation + Math.min(delta, 100));
  return Math.max(0, previousReputation + Math.max(delta, -100));
}

export function createReputationCampaignFields(reputation = 30) {
  if (!Number.isInteger(reputation) || reputation < 0 || reputation > 100) {
    throw Object.assign(new TypeError("시작 reputation은 0..100 정수여야 합니다."), {
      code: "INVALID_REPUTATION",
    });
  }
  return freezeDeep({
    reputation,
    processedCauseIds: [],
    reputationHistory: [],
  });
}

export function validateReputationCampaignState(campaign) {
  if (!isPlainRecord(campaign) || !isStableIdentifier(campaign.campaignId)) {
    return failure("INVALID_CAMPAIGN_STATE");
  }
  if (!Number.isSafeInteger(campaign.day) || campaign.day < 1 || campaign.day > 14) {
    return failure("INVALID_REPUTATION_DAY", { day: campaign.day });
  }
  if (!Number.isInteger(campaign.reputation) || campaign.reputation < 0 || campaign.reputation > 100) {
    return failure("INVALID_REPUTATION", { reputation: campaign.reputation });
  }
  if (!Array.isArray(campaign.processedCauseIds) || !Array.isArray(campaign.reputationHistory)) {
    return failure("INVALID_REPUTATION_HISTORY");
  }
  if (campaign.processedCauseIds.length !== campaign.reputationHistory.length) {
    return failure("REPUTATION_CAUSE_HISTORY_CARDINALITY_MISMATCH");
  }
  const causes = new Set();
  for (let index = 0; index < campaign.processedCauseIds.length; index += 1) {
    const causeId = campaign.processedCauseIds[index];
    const entry = campaign.reputationHistory[index];
    if (!isStableIdentifier(causeId) || causes.has(causeId)) {
      return failure(causes.has(causeId) ? "DUPLICATE_REPUTATION_CAUSE" : "INVALID_REPUTATION_CAUSE_ID", {
        causeId,
        index,
      });
    }
    if (!isPlainRecord(entry) || entry.causeId !== causeId ||
        !Number.isSafeInteger(entry.day) || entry.day < 1 || entry.day > 14 ||
        !Number.isSafeInteger(entry.requestedDelta) || !Number.isSafeInteger(entry.appliedDelta) ||
        !Number.isInteger(entry.previousReputation) || entry.previousReputation < 0 ||
        entry.previousReputation > 100 || !Number.isInteger(entry.reputation) ||
        entry.reputation < 0 || entry.reputation > 100 ||
        entry.reputation - entry.previousReputation !== entry.appliedDelta) {
      return failure("INVALID_REPUTATION_HISTORY_ENTRY", { index, causeId });
    }
    if (index > 0 && campaign.reputationHistory[index - 1].reputation !== entry.previousReputation) {
      return failure("REPUTATION_HISTORY_DISCONTINUITY", { index, causeId });
    }
    causes.add(causeId);
  }
  const expectedReputation = campaign.reputationHistory.length > 0
    ? campaign.reputationHistory[campaign.reputationHistory.length - 1].reputation
    : campaign.reputation;
  return expectedReputation === campaign.reputation
    ? validationSuccess({ processedCauseCount: causes.size })
    : failure("REPUTATION_HISTORY_RESULT_MISMATCH");
}

export function validateReputationCausePayload(payload) {
  if (!isPlainRecord(payload)) return failure("INVALID_REPUTATION_CAUSE_PAYLOAD");
  if (!isStableIdentifier(payload.causeId)) {
    return failure("INVALID_REPUTATION_CAUSE_ID", { causeId: payload.causeId });
  }
  if (!Number.isSafeInteger(payload.delta)) {
    return failure("INVALID_REPUTATION_DELTA", { delta: payload.delta });
  }
  return validationSuccess();
}

/**
 * The sole reputation mutation authority. Future sale/settlement transactions must delegate here
 * instead of assigning campaign.reputation directly.
 */
export function applyReputationCauseToDraft(campaignDraft, progressionDraft, payload) {
  const payloadValidation = validateReputationCausePayload(payload);
  if (!payloadValidation.ok) return payloadValidation;
  const campaignValidation = validateReputationCampaignState(campaignDraft);
  if (!campaignValidation.ok) return campaignValidation;
  const progressionValidation = validateProgressionState(progressionDraft);
  if (!progressionValidation.ok) return progressionValidation;
  if (campaignDraft.processedCauseIds.includes(payload.causeId)) {
    return failure("DUPLICATE_REPUTATION_CAUSE", { causeId: payload.causeId });
  }

  const previousReputation = campaignDraft.reputation;
  const reputation = clampReputationDelta(previousReputation, payload.delta);
  const crossingResult = applyThresholdCrossingsToProgressionDraft(progressionDraft, {
    previousReputation,
    nextReputation: reputation,
    causeId: payload.causeId,
    crossedDay: campaignDraft.day,
  });
  if (!crossingResult.ok) return crossingResult;

  campaignDraft.reputation = reputation;
  campaignDraft.processedCauseIds.push(payload.causeId);
  campaignDraft.reputationHistory.push({
    causeId: payload.causeId,
    day: campaignDraft.day,
    requestedDelta: payload.delta,
    appliedDelta: reputation - previousReputation,
    previousReputation,
    reputation,
  });
  const afterCampaignValidation = validateReputationCampaignState(campaignDraft);
  if (!afterCampaignValidation.ok) return afterCampaignValidation;
  const afterProgressionValidation = validateProgressionState(progressionDraft);
  if (!afterProgressionValidation.ok) return afterProgressionValidation;
  return success({
    previousReputation,
    reputation,
    requestedDelta: payload.delta,
    appliedDelta: reputation - previousReputation,
    causeId: payload.causeId,
    day: campaignDraft.day,
    qualifiedUnlocks: crossingResult.plan.qualifiedUnlocks,
  });
}

export function planReputationCause({ campaign, progression }, payload) {
  const campaignCandidate = cloneValue(campaign);
  const progressionCandidate = cloneValue(progression);
  const applied = applyReputationCauseToDraft(campaignCandidate, progressionCandidate, payload);
  if (!applied.ok) return applied;
  return success({
    campaign: campaignCandidate,
    progression: progressionCandidate,
    ...applied.plan,
  });
}

export function createApplyReputationCauseAtomicTransaction() {
  return defineAtomicTransaction({
    name: REPUTATION_COMMAND.APPLY_CAUSE,
    readSet: REPUTATION_APPLY_READ_SET,
    writeSet: REPUTATION_APPLY_WRITE_SET,
    allowedPhases: REPUTATION_PHASES,
    validatePayload(ctx) {
      return validateReputationCausePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planReputationCause({
        campaign: ctx.read("campaign"),
        progression: ctx.read("progression"),
      }, ctx.command.payload);
    },
    mutate(draft) {
      const applied = applyReputationCauseToDraft(
        draft.write("campaign"),
        draft.write("progression"),
        draft.command.payload,
      );
      return applied.ok ? validationSuccess() : applied;
    },
    postconditions(before, after, ctx) {
      const planned = planReputationCause({
        campaign: before.campaign,
        progression: before.progression,
      }, ctx.command.payload);
      if (!planned.ok) return planned;
      if (!equivalent(after.campaign, planned.plan.campaign) ||
          !equivalent(after.progression, planned.plan.progression)) {
        return failure("REPUTATION_PLAN_MISMATCH");
      }
      const processedDelta = after.campaign.processedCauseIds.length - before.campaign.processedCauseIds.length;
      return processedDelta === 1
        ? validationSuccess({
          appliedDelta: planned.plan.appliedDelta,
          unlockCount: planned.plan.qualifiedUnlocks.length,
        })
        : failure("REPUTATION_CAUSE_CARDINALITY_MISMATCH", { processedDelta });
    },
    events(before, _after, ctx) {
      const planned = planReputationCause({
        campaign: before.campaign,
        progression: before.progression,
      }, ctx.command.payload);
      if (!planned.ok) return [];
      const reputationEvent = {
        causeId: planned.plan.causeId,
        type: "reputation.cause-applied",
        payload: {
          causeId: planned.plan.causeId,
          day: planned.plan.day,
          requestedDelta: planned.plan.requestedDelta,
          appliedDelta: planned.plan.appliedDelta,
          previousReputation: planned.plan.previousReputation,
          reputation: planned.plan.reputation,
        },
      };
      const unlockEvents = planned.plan.qualifiedUnlocks.map((entry) => ({
        causeId: planned.plan.causeId,
        type: "progression.unlock-qualified",
        payload: {
          unlockId: entry.unlockId,
          kind: entry.kind,
          targetId: entry.targetId,
          threshold: entry.threshold,
          crossedDay: entry.crossedDay,
          availablePlanningDay: entry.availablePlanningDay,
        },
      }));
      return [reputationEvent, ...unlockEvents];
    },
  });
}

function commandEnvelope(input) {
  return {
    commandId: input?.commandId,
    expectedRevision: input?.expectedRevision,
    generationId: input?.generationId,
    issuedAtSimulationMs: input?.issuedAtSimulationMs,
    causeId: input?.payload?.causeId,
    type: REPUTATION_COMMAND.APPLY_CAUSE,
    payload: input?.payload,
    readSet: [...REPUTATION_APPLY_READ_SET],
    writeSet: [...REPUTATION_APPLY_WRITE_SET],
  };
}

export function projectReputation(snapshot) {
  const validation = validateReputationCampaignState(snapshot.campaign);
  if (!validation.ok) throw new TypeError(`Reputation projection이 유효하지 않습니다: ${validation.code}`);
  const latest = snapshot.campaign.reputationHistory.at(-1) ?? null;
  return freezeDeep({
    reputation: snapshot.campaign.reputation,
    minimum: 0,
    maximum: 100,
    processedCauseCount: snapshot.campaign.processedCauseIds.length,
    latestChange: latest === null ? null : cloneValue(latest),
    history: cloneValue(snapshot.campaign.reputationHistory),
  });
}

export class ReputationSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("ReputationSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(
      REPUTATION_COMMAND.APPLY_CAUSE,
      createApplyReputationCauseAtomicTransaction(),
    );
    this.registered = true;
    return this;
  }

  applyCause(input) {
    return this.commandBus.dispatch(commandEnvelope(input));
  }

  project(snapshot) {
    return projectReputation(snapshot);
  }
}

export function registerReputationSystem(commandBus) {
  return new ReputationSystem(commandBus, { register: true });
}
