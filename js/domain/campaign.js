import { DAY_LOOP_TRIGGER } from "./day-loop.js";
import { CONTRACT_STATUS } from "./contract.js";

/**
 * Task 29 — Settlement가 commit된 뒤 하루를 마무리하는 순서를 오케스트레이션한다.
 * 각 단계는 이미 등록된 real command다: SettlementSystem(Task 23)이 SETTLE_DAY를 이미
 * 끝냈다는 전제 위에서, CampaignOutcomeSystem→(terminal 아니면) DayInitializationSystem→
 * 밀린 contract resolve→DayLoopController TRANSITION 순서로 이어붙인다.
 */
export class CampaignManager {
  constructor({ store, commandBus, campaignOutcomeSystem, dayInitializationSystem, contractSystem, dayLoopController }) {
    if (!store || !commandBus) throw new TypeError("CampaignManager에는 store/commandBus가 필요합니다.");
    this.store = store;
    this.commandBus = commandBus;
    this.campaignOutcomeSystem = campaignOutcomeSystem;
    this.dayInitializationSystem = dayInitializationSystem;
    this.contractSystem = contractSystem;
    this.dayLoopController = dayLoopController;
  }

  _commandInput(payload) {
    return {
      commandId: `campaign-manager:${this.store.revision}:${Math.random().toString(36).slice(2)}`,
      expectedRevision: this.store.revision,
      generationId: this.store.generationId,
      issuedAtSimulationMs: 0,
      payload,
    };
  }

  /** Settlement 직후 한 번 호출한다. 성공하면 TERMINAL 또는 다음 PLANNING_READY까지 이어진다. */
  async advanceAfterSettlement() {
    const sealed = await this.campaignOutcomeSystem.sealSettlementOutcome(this._commandInput({}));
    if (!sealed.ok) return { ok: false, stage: "seal-settlement-outcome", result: sealed };

    const snapshot = this.store.getSnapshot();
    const outcome = snapshot.campaign.terminalResult;
    if (outcome) {
      const transitioned = await this.dayLoopController.transition(this._commandInput({
        trigger: DAY_LOOP_TRIGGER.CAMPAIGN_TERMINAL_READY,
      }));
      if (!transitioned.ok) return { ok: false, stage: "campaign-terminal-transition", result: transitioned };
      return { ok: true, terminal: true, terminalResult: outcome };
    }

    const initialized = await this.dayInitializationSystem.initialize(this._commandInput({}));
    if (!initialized.ok) return { ok: false, stage: "day-initialization", result: initialized };

    const advanced = await this.dayLoopController.transition(this._commandInput({
      trigger: DAY_LOOP_TRIGGER.NEXT_DAY_READY,
    }));
    if (!advanced.ok) return { ok: false, stage: "next-day-transition", result: advanced };

    // contract.resolve는 PLANNING phase에서만 허용되므로(Requirement 6 AC1) NEXT_DAY_READY로
    // Planning에 진입한 뒤에 D+1 resolution을 처리한다.
    const nextDay = this.store.getSnapshot().campaign.day;
    const pending = this.store.getSnapshot().contracts.contracts.filter(
      (contract) => contract.status === CONTRACT_STATUS.ACCEPTED_PENDING && contract.resolutionDay === nextDay,
    );
    const resolved = [];
    for (const contract of pending) {
      const result = await this.contractSystem.resolveContract(this._commandInput({
        day: nextDay,
        contractId: contract.contractId,
      }));
      resolved.push({ contractId: contract.contractId, ok: result.ok, code: result.code });
      if (!result.ok) return { ok: false, stage: "contract-resolution", result, resolved };
    }

    return { ok: true, terminal: false, nextDay, resolvedContracts: resolved };
  }
}

export function createCampaignManager(dependencies) {
  return new CampaignManager(dependencies);
}
