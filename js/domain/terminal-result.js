import { IdService } from "../core/ids.js";
import { checkedAddG } from "../core/money.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction } from "../core/transaction.js";
import { applyContractReserveChangeToDraft, CONTRACT_RESERVE_OPERATION } from "./cash-transaction-api.js";
import { applyContractFailureLossToDraft } from "./inventory-accounting.js";
import { CONTRACT_STATUS, createContractState } from "./contract.js";
import { RUNTIME_PHASE } from "./timer-state.js";

/** Requirement 17 — 승리·목표 미달·파산 판정. */
export const TERMINAL_TYPE = Object.freeze({
  BANKRUPTCY: "BANKRUPTCY",
  VICTORY: "VICTORY",
  GOAL_NOT_MET: "GOAL_NOT_MET",
});

export const BANKRUPTCY_THRESHOLDS = Object.freeze({
  arrearsG: 80,
  consecutiveArrearsCount: 2,
});

export const CAMPAIGN_COMMAND = Object.freeze({
  SEAL_SETTLEMENT_OUTCOME: "campaign.settlement-outcome.seal",
});

export const SEAL_SETTLEMENT_OUTCOME_READ_SET = Object.freeze([]);
export const SEAL_SETTLEMENT_OUTCOME_WRITE_SET = Object.freeze([
  "campaign", "economy", "contracts", "inventoryAccounting", "idCounters",
]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_SEAL_SETTLEMENT_PAYLOAD: "결산 결과 봉인 요청 형식이 올바르지 않습니다.",
  SEAL_SETTLEMENT_REQUIRES_SETTLEMENT_PHASE: "Settlement_Phase에서만 결산 결과를 봉인할 수 있습니다.",
  SEAL_SETTLEMENT_ALREADY_SEALED: "이 day의 결산 결과가 이미 봉인됐습니다.",
  SEAL_SETTLEMENT_ID_STATE_INVALID: "결정론적 ID 상태가 올바르지 않습니다.",
  SEAL_SETTLEMENT_POSTCONDITION_FAILED: "결산 결과 봉인 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "결산 결과 봉인 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
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

/**
 * Requirement 17 AC1~6을 그대로 구현한 순수 판정. Settlement가 막 끝난 day의 economy/campaign을
 * 보고: consecutiveArrearsCount를 갱신하고, bankruptcy를 최우선으로, day14에서만 승리/목표
 * 미달을 가른다. cash=0만으로는 종료하지 않는다.
 */
export function evaluateSettlementOutcome({ campaign, economy }) {
  const nextConsecutiveArrearsCount = economy.arrearsG > 0
    ? campaign.consecutiveArrearsCount + 1
    : 0;
  const bankrupt = economy.arrearsG >= BANKRUPTCY_THRESHOLDS.arrearsG ||
    nextConsecutiveArrearsCount >= BANKRUPTCY_THRESHOLDS.consecutiveArrearsCount;

  let terminalType = null;
  if (bankrupt) {
    terminalType = TERMINAL_TYPE.BANKRUPTCY;
  } else if (campaign.day >= 14) {
    const victorious = economy.debtG === 0 && campaign.reputation >= 70;
    terminalType = victorious ? TERMINAL_TYPE.VICTORY : TERMINAL_TYPE.GOAL_NOT_MET;
  }

  return Object.freeze({ nextConsecutiveArrearsCount, terminal: terminalType !== null, terminalType });
}

function buildTerminalResult({ campaign, economy, terminalType }) {
  let revenueG = 0;
  let terminalOperatingProfitG = 0;
  for (const result of campaign.canonicalDayResults) {
    revenueG = checkedAddG(revenueG, result.revenueG, "terminal revenue");
    terminalOperatingProfitG = checkedAddG(terminalOperatingProfitG, result.operatingProfitG, "terminal operating profit");
  }
  return {
    type: terminalType,
    cashG: economy.cashG,
    arrearsG: economy.arrearsG,
    consecutiveArrearsCount: campaign.consecutiveArrearsCount,
    debtG: economy.debtG,
    reputation: campaign.reputation,
    revenueG,
    terminalOperatingProfitG,
    days: campaign.day,
  };
}

/**
 * Requirement 17 AC7 — 종료 시 아직 ACCEPTED_PENDING인 계약은 성공/실패를 굴리지 않고(더 이상
 * D+1이 없으므로) 실패와 같은 방식으로 정리한다: reserve 해제, prepaid를 손실로 전환, 상태를
 * TERMINAL_CANCELLED로 한 번만 표시한다.
 */
function planContractTerminationCleanup({ contracts, economy, inventoryAccounting, idCounters, campaign, generationId }) {
  const pending = contracts.contracts.filter((contract) => contract.status === CONTRACT_STATUS.ACCEPTED_PENDING);
  if (pending.length === 0) {
    return success({ contracts, economy, inventoryAccounting, idCounters, cleanedContractIds: [] });
  }
  const economyCandidate = cloneValue(economy);
  const accountingCandidate = cloneValue(inventoryAccounting);
  let ids;
  try {
    ids = IdService.fromState(idCounters);
    if (ids.campaignId !== campaign.campaignId || ids.day !== campaign.day || ids.generationId !== generationId) {
      return failure("SEAL_SETTLEMENT_ID_STATE_INVALID");
    }
  } catch {
    return failure("SEAL_SETTLEMENT_ID_STATE_INVALID");
  }
  const contractsById = new Map(contracts.contracts.map((contract) => [contract.contractId, contract]));
  const cleanedContractIds = [];
  for (const contract of pending) {
    const causeId = ids.next("cause", { day: campaign.day });
    const movementId = ids.next("movement", { day: campaign.day });
    const released = applyContractReserveChangeToDraft(economyCandidate, {
      operation: CONTRACT_RESERVE_OPERATION.RELEASE,
      amountG: contract.balanceG,
    });
    if (!released.ok) return released;
    const loss = applyContractFailureLossToDraft(economyCandidate, accountingCandidate, {
      movementId,
      day: campaign.day,
      causeId,
      contractId: contract.contractId,
      amountG: contract.prepaidG,
    });
    if (!loss.ok) return loss;
    contractsById.set(contract.contractId, {
      ...contract,
      status: CONTRACT_STATUS.TERMINAL_CANCELLED,
      resolution: null,
    });
    cleanedContractIds.push(contract.contractId);
  }
  let contractsCandidate;
  try {
    contractsCandidate = createContractState({
      day: contracts.day,
      fixedCostG: contracts.fixedCostG,
      offers: contracts.offers,
      contracts: [...contractsById.values()],
      acceptedContractIdForDay: contracts.acceptedContractIdForDay,
      processedResolutionIds: contracts.processedResolutionIds,
    });
  } catch (error) {
    return failure(error?.code ?? "SEAL_SETTLEMENT_POSTCONDITION_FAILED");
  }
  return success({
    contracts: contractsCandidate,
    economy: economyCandidate,
    inventoryAccounting: accountingCandidate,
    idCounters: ids.snapshot(),
    cleanedContractIds,
  });
}

/** 순수 계획: campaign.consecutiveArrearsCount를 갱신하고, terminal이면 결과를 한 번 봉인하며 pending contract를 정리한다. */
export function planSealSettlementOutcome({
  runtimePhase, campaign, economy, contracts, inventoryAccounting, idCounters, generationId,
}) {
  if (runtimePhase !== RUNTIME_PHASE.SETTLEMENT) {
    return failure("SEAL_SETTLEMENT_REQUIRES_SETTLEMENT_PHASE", { runtimePhase });
  }
  if (campaign.settlementOutcomeSealedForDay === campaign.day) {
    return failure("SEAL_SETTLEMENT_ALREADY_SEALED", { day: campaign.day });
  }
  const outcome = evaluateSettlementOutcome({ campaign, economy });
  const campaignCandidate = cloneValue(campaign);
  campaignCandidate.consecutiveArrearsCount = outcome.nextConsecutiveArrearsCount;
  campaignCandidate.settlementOutcomeSealedForDay = campaign.day;

  if (!outcome.terminal) {
    campaignCandidate.terminalResult = null;
    return success({
      campaign: campaignCandidate, economy, contracts, inventoryAccounting, idCounters, outcome, cleanedContractIds: [],
    });
  }

  const cleanup = planContractTerminationCleanup({
    contracts, economy, inventoryAccounting, idCounters, campaign: campaignCandidate, generationId,
  });
  if (!cleanup.ok) return cleanup;
  campaignCandidate.terminalResult = buildTerminalResult({
    campaign: campaignCandidate, economy: cleanup.plan.economy, terminalType: outcome.terminalType,
  });
  return success({
    campaign: campaignCandidate,
    economy: cleanup.plan.economy,
    contracts: cleanup.plan.contracts,
    inventoryAccounting: cleanup.plan.inventoryAccounting,
    idCounters: cleanup.plan.idCounters,
    outcome,
    cleanedContractIds: cleanup.plan.cleanedContractIds,
  });
}

function validatePayload(payload) {
  return isPlainRecord(payload) ? validationSuccess() : failure("INVALID_SEAL_SETTLEMENT_PAYLOAD");
}

export function createSealSettlementOutcomeAtomicTransaction() {
  return defineAtomicTransaction({
    name: CAMPAIGN_COMMAND.SEAL_SETTLEMENT_OUTCOME,
    readSet: SEAL_SETTLEMENT_OUTCOME_READ_SET,
    writeSet: SEAL_SETTLEMENT_OUTCOME_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SETTLEMENT],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planSealSettlementOutcome({
        runtimePhase: ctx.phase,
        campaign: ctx.read("campaign"),
        economy: ctx.read("economy"),
        contracts: ctx.read("contracts"),
        inventoryAccounting: ctx.read("inventoryAccounting"),
        idCounters: ctx.read("idCounters"),
        generationId: ctx.generationId,
      });
    },
    mutate(draft) {
      const planned = planSealSettlementOutcome({
        runtimePhase: RUNTIME_PHASE.SETTLEMENT,
        campaign: draft.read("campaign"),
        economy: draft.read("economy"),
        contracts: draft.read("contracts"),
        inventoryAccounting: draft.read("inventoryAccounting"),
        idCounters: draft.read("idCounters"),
        generationId: draft.command.generationId,
      });
      if (!planned.ok) return planned;
      draft.replace("campaign", planned.plan.campaign);
      draft.replace("economy", planned.plan.economy);
      draft.replace("contracts", planned.plan.contracts);
      draft.replace("inventoryAccounting", planned.plan.inventoryAccounting);
      draft.replace("idCounters", planned.plan.idCounters);
      return validationSuccess();
    },
    postconditions(before, after, ctx) {
      const planned = planSealSettlementOutcome({
        runtimePhase: before.runtimePhase,
        campaign: before.campaign,
        economy: before.economy,
        contracts: before.contracts,
        inventoryAccounting: before.inventoryAccounting,
        idCounters: before.idCounters,
        generationId: ctx.generationId,
      });
      if (!planned.ok) return planned;
      for (const slice of ["campaign", "economy", "contracts", "inventoryAccounting", "idCounters"]) {
        if (!equivalent(after[slice], planned.plan[slice])) {
          return failure("SEAL_SETTLEMENT_POSTCONDITION_FAILED", { slice });
        }
      }
      return validationSuccess();
    },
    events(before, _after, ctx) {
      const planned = planSealSettlementOutcome({
        runtimePhase: before.runtimePhase,
        campaign: before.campaign,
        economy: before.economy,
        contracts: before.contracts,
        inventoryAccounting: before.inventoryAccounting,
        idCounters: before.idCounters,
        generationId: ctx.generationId,
      });
      if (!planned.ok) return [];
      return [{
        type: "campaign.settlement-outcome-sealed",
        payload: {
          day: before.campaign.day,
          consecutiveArrearsCount: planned.plan.outcome.nextConsecutiveArrearsCount,
          terminal: planned.plan.outcome.terminal,
          terminalType: planned.plan.outcome.terminalType,
          cleanedContractIds: planned.plan.cleanedContractIds,
        },
      }];
    },
  });
}

export class CampaignOutcomeSystem {
  constructor(commandBus, { register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("CampaignOutcomeSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(
      CAMPAIGN_COMMAND.SEAL_SETTLEMENT_OUTCOME,
      createSealSettlementOutcomeAtomicTransaction(),
    );
    this.registered = true;
    return this;
  }

  sealSettlementOutcome(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: CAMPAIGN_COMMAND.SEAL_SETTLEMENT_OUTCOME,
      payload: input?.payload ?? {},
      readSet: [...SEAL_SETTLEMENT_OUTCOME_READ_SET],
      writeSet: [...SEAL_SETTLEMENT_OUTCOME_WRITE_SET],
    });
  }
}

export function registerCampaignOutcomeSystem(commandBus) {
  return new CampaignOutcomeSystem(commandBus, { register: true });
}
