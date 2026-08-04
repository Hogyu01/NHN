import { IdService } from "../core/ids.js";
import { cloneValue, freezeDeep, validationFailure, validationSuccess } from "../core/result.js";
import { defineAtomicTransaction } from "../core/transaction.js";
import { createContractState, generateDailyContractOffers } from "./contract.js";
import { createEventState, generateDailyEvent } from "./events.js";
import { generateDailyMarket } from "./market.js";
import { createMenuState } from "./menu.js";
import { createSaleSlotsState } from "./sale-slots.js";
import { RUNTIME_PHASE } from "./timer-state.js";

/**
 * Requirement 15, 7 AC1·7, 6 AC10 — 다음 day 초기화: previous event 제거, daily market
 * 생성, contract offer 생성(기존 pending contract는 그대로 이어감), day event 선택·적용,
 * campaign.day 증가를 한 transaction으로 commit한다. contract D+1 resolution은 이 transaction
 * 뒤 이미 등록된 ContractSystem.resolveContract를 재사용해 별도 command로 처리한다
 * (RESOLVE는 contracts.day가 이미 새 day로 갱신돼 있어야 하기 때문이다).
 */
export const DAY_INITIALIZATION_COMMAND = Object.freeze({
  INITIALIZE: "campaign.day.initialize",
});

export const DAY_INITIALIZATION_READ_SET = Object.freeze([
  "campaign", "market", "contracts", "events", "rng", "idCounters", "recipes",
]);
export const DAY_INITIALIZATION_WRITE_SET = Object.freeze([
  "campaign", "market", "contracts", "events", "rng", "idCounters", "menu", "saleSlots",
]);

const MESSAGE_BY_CODE = Object.freeze({
  INVALID_DAY_INITIALIZATION_PAYLOAD: "day 초기화 요청 형식이 올바르지 않습니다.",
  DAY_INITIALIZATION_REQUIRES_SETTLEMENT: "Settlement_Phase에서만 다음 day를 초기화할 수 있습니다.",
  DAY_INITIALIZATION_NO_NEXT_DAY: "day 14 다음은 초기화할 수 없습니다.",
  DAY_INITIALIZATION_POSTCONDITION_FAILED: "day 초기화 원자 변경 사후조건이 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "day 초기화 검증에 실패했습니다.",
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

function validatePayload(payload) {
  return isPlainRecord(payload) ? validationSuccess() : failure("INVALID_DAY_INITIALIZATION_PAYLOAD");
}

export function planDayInitialization({
  runtimePhase, campaign, market, contracts, events, rng, idCounters, recipes,
}, configuration) {
  if (runtimePhase !== RUNTIME_PHASE.SETTLEMENT) {
    return failure("DAY_INITIALIZATION_REQUIRES_SETTLEMENT", { runtimePhase });
  }
  const nextDay = campaign.day + 1;
  if (nextDay > 14) return failure("DAY_INITIALIZATION_NO_NEXT_DAY", { day: campaign.day });

  const marketGeneration = generateDailyMarket({
    rngState: rng,
    day: nextDay,
    ingredients: configuration.ingredients,
    purchaseLimitQuantity: configuration.balance.market.defaultPurchaseLimitQuantity,
  });
  const contractGeneration = generateDailyContractOffers({
    rngState: marketGeneration.rngState,
    day: nextDay,
    ingredients: configuration.ingredients,
    configuration: configuration.balance.contract,
    fixedCostG: configuration.balance.economy.fixedCostG,
  });
  const mergedContracts = createContractState({
    day: nextDay,
    fixedCostG: configuration.balance.economy.fixedCostG,
    offers: contractGeneration.contracts.offers,
    contracts: contracts.contracts,
  });
  const eventGeneration = generateDailyEvent({
    rngState: contractGeneration.rngState,
    day: nextDay,
    eventDefinitions: configuration.eventDefinitions,
  });

  const campaignCandidate = cloneValue(campaign);
  campaignCandidate.day = nextDay;

  const ids = IdService.fromState(idCounters);
  ids.setDay(nextDay);
  const idCountersCandidate = ids.snapshot();

  const nextHistory = [
    ...events.history,
    { day: nextDay, eventId: eventGeneration.event.eventId },
  ];

  let menu;
  let saleSlots;
  try {
    menu = createMenuState({ day: nextDay, recipes });
    saleSlots = createSaleSlotsState({ day: nextDay });
  } catch (error) {
    return failure("DAY_INITIALIZATION_POSTCONDITION_FAILED", {
      cause: error?.code ?? "NEXT_DAY_MENU_INITIALIZATION_FAILED",
    });
  }

  return success({
    campaign: campaignCandidate,
    market: marketGeneration.market,
    contracts: mergedContracts,
    events: createEventState({ activeEvent: eventGeneration.event, history: nextHistory }),
    rng: eventGeneration.rngState,
    idCounters: idCountersCandidate,
    menu,
    saleSlots,
    nextDay,
  });
}

export function createDayInitializationAtomicTransaction({ ingredients, eventDefinitions, balance } = {}) {
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new TypeError("createDayInitializationAtomicTransaction에는 ingredients 배열이 필요합니다.");
  }
  if (!Array.isArray(eventDefinitions)) {
    throw new TypeError("createDayInitializationAtomicTransaction에는 eventDefinitions 배열이 필요합니다.");
  }
  if (!isPlainRecord(balance)) {
    throw new TypeError("createDayInitializationAtomicTransaction에는 balance 설정이 필요합니다.");
  }
  const configuration = { ingredients, eventDefinitions, balance };

  return defineAtomicTransaction({
    name: DAY_INITIALIZATION_COMMAND.INITIALIZE,
    readSet: DAY_INITIALIZATION_READ_SET,
    writeSet: DAY_INITIALIZATION_WRITE_SET,
    allowedPhases: [RUNTIME_PHASE.SETTLEMENT],
    validatePayload(ctx) {
      return validatePayload(ctx.command.payload);
    },
    preflight(ctx) {
      return planDayInitialization({
        runtimePhase: ctx.phase,
        campaign: ctx.read("campaign"),
        market: ctx.read("market"),
        contracts: ctx.read("contracts"),
        events: ctx.read("events"),
        rng: ctx.read("rng"),
        idCounters: ctx.read("idCounters"),
        recipes: ctx.read("recipes"),
      }, configuration);
    },
    mutate(draft) {
      const planned = planDayInitialization({
        runtimePhase: RUNTIME_PHASE.SETTLEMENT,
        campaign: draft.read("campaign"),
        market: draft.read("market"),
        contracts: draft.read("contracts"),
        events: draft.read("events"),
        rng: draft.read("rng"),
        idCounters: draft.read("idCounters"),
        recipes: draft.read("recipes"),
      }, configuration);
      if (!planned.ok) return planned;
      draft.replace("campaign", planned.plan.campaign);
      draft.replace("market", planned.plan.market);
      draft.replace("contracts", planned.plan.contracts);
      draft.replace("events", planned.plan.events);
      draft.replace("rng", planned.plan.rng);
      draft.replace("idCounters", planned.plan.idCounters);
      draft.replace("menu", planned.plan.menu);
      draft.replace("saleSlots", planned.plan.saleSlots);
      return validationSuccess();
    },
    postconditions(before, after) {
      const planned = planDayInitialization({
        runtimePhase: before.runtimePhase,
        campaign: before.campaign,
        market: before.market,
        contracts: before.contracts,
        events: before.events,
        rng: before.rng,
        idCounters: before.idCounters,
        recipes: before.recipes,
      }, configuration);
      if (!planned.ok) return planned;
      for (const slice of ["campaign", "market", "contracts", "events", "rng", "idCounters", "menu", "saleSlots"]) {
        if (!equivalent(after[slice], planned.plan[slice])) {
          return failure("DAY_INITIALIZATION_POSTCONDITION_FAILED", { slice });
        }
      }
      return validationSuccess();
    },
    events(before, _after, ctx) {
      const planned = planDayInitialization({
        runtimePhase: before.runtimePhase,
        campaign: before.campaign,
        market: before.market,
        contracts: before.contracts,
        events: before.events,
        rng: before.rng,
        idCounters: before.idCounters,
        recipes: before.recipes,
      }, configuration);
      if (!planned.ok) return [];
      return [{
        type: "campaign.day-initialized",
        payload: { day: planned.plan.nextDay, issuedAtSimulationMs: ctx.command.issuedAtSimulationMs },
      }];
    },
  });
}

export class DayInitializationSystem {
  constructor(commandBus, { ingredients, eventDefinitions, balance, register = true } = {}) {
    if (!commandBus || typeof commandBus.register !== "function" || typeof commandBus.dispatch !== "function") {
      throw new TypeError("DayInitializationSystem에는 CommandBus가 필요합니다.");
    }
    this.commandBus = commandBus;
    this.configuration = { ingredients, eventDefinitions, balance };
    this.registered = false;
    if (register) this.register();
  }

  register() {
    if (this.registered) return this;
    this.commandBus.register(
      DAY_INITIALIZATION_COMMAND.INITIALIZE,
      createDayInitializationAtomicTransaction(this.configuration),
    );
    this.registered = true;
    return this;
  }

  initialize(input) {
    return this.commandBus.dispatch({
      commandId: input?.commandId,
      expectedRevision: input?.expectedRevision,
      generationId: input?.generationId,
      issuedAtSimulationMs: input?.issuedAtSimulationMs,
      type: DAY_INITIALIZATION_COMMAND.INITIALIZE,
      payload: input?.payload ?? {},
      readSet: [...DAY_INITIALIZATION_READ_SET],
      writeSet: [...DAY_INITIALIZATION_WRITE_SET],
    });
  }
}

export function registerDayInitializationSystem(commandBus, configuration = {}) {
  return new DayInitializationSystem(commandBus, { ...configuration, register: true });
}
