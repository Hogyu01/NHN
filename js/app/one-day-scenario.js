import { DAY_LOOP_TRIGGER } from "../domain/day-loop.js";
import { getRecipeDefinition } from "../domain/recipe.js";
import { RUNTIME_PHASE } from "../domain/timer-state.js";
import { createRuntimeComposition } from "./runtime-composition.js";

function assertOk(result, step) {
  if (!result.ok) {
    const error = new Error(`one-day-scenario 단계 실패(${step}): ${result.code}`);
    error.code = result.code;
    error.step = step;
    throw error;
  }
  return result;
}

function eventPayload(result, type) {
  const event = result.events.find((candidate) => candidate.type === type);
  if (!event) {
    const error = new Error(`one-day-scenario: ${type} event를 찾지 못했습니다.`);
    error.code = "ONE_DAY_EVENT_NOT_FOUND";
    throw error;
  }
  return event.payload;
}

/**
 * QA 전용 shortcut. GuestFlow(Task 30)가 아직 없어 손님을 SEATED로 만드는
 * production command가 존재하지 않는다. `?qa=one-day` 스모크 트레이스에서만,
 * Service Start가 실제로 생성한 ScheduledGuestPlan 위에 손님 1명을 SEATED로
 * 직접 commit한다. production 공개 경로(board/stove/counter panel, index.html
 * 일반 부팅)에서는 절대 호출하지 않는다 — Requirement대로 order 이후 단계는
 * 전부 진짜 commandBus command로만 진행한다.
 */
export function qaSeedSeatedGuest(app) {
  const snapshot = app.store.getSnapshot();
  const plan = snapshot.service.plans[0];
  if (!plan) {
    const error = new Error("QA seed: Service Start가 ScheduledGuestPlan을 생성하지 않았습니다.");
    error.code = "QA_SEED_NO_PLAN";
    throw error;
  }
  const guest = Object.freeze({
    guestId: plan.guestId,
    entityId: plan.entityId,
    state: "SEATED",
    seatId: `qa-seat:${plan.guestId}`,
    reaction: null,
  });
  const candidate = {
    ...snapshot,
    service: { ...snapshot.service, guests: [...snapshot.service.guests, guest] },
  };
  app.store.commit(candidate, {
    commandId: `runtime:qa.seed-seated-guest:${app.store.revision}`,
    expectedRevision: app.store.revision,
  });
  return guest;
}

export function resolveOrderableRecipe(app) {
  const { recipes, market } = app.store.getSnapshot();
  for (const recipeId of recipes.unlockedRecipeIds) {
    const recipe = getRecipeDefinition(recipes, recipeId);
    const offers = [];
    let satisfiable = true;
    for (const requirement of recipe.ingredientRequirements) {
      const offer = market.offers.find((candidate) =>
        candidate.ingredientId === requirement.ingredientId &&
        candidate.availableQuantity >= requirement.quantity);
      if (!offer) {
        satisfiable = false;
        break;
      }
      offers.push({ offerId: offer.offerId, quantity: requirement.quantity });
    }
    if (satisfiable) return { recipeId, recipe, offers };
  }
  const error = new Error("one-day-scenario: 시장 offer로 조리 가능한 unlocked recipe를 찾지 못했습니다.");
  error.code = "ONE_DAY_NO_ORDERABLE_RECIPE";
  throw error;
}

/**
 * 조달→메뉴→Service Start→order→cook→sale→Settlement one-day vertical slice를
 * 전부 real commandBus command로 실행하는 driver. `app`은 bootstrapPrototypeApp()의
 * 결과이거나 동일한 인터페이스(store/commandBus/각 System)를 갖춘 Node QA harness다.
 */
export async function runOneDayScenario(app) {
  const composition = createRuntimeComposition(app);
  const trace = [];
  const step = async (name, run) => {
    const result = await run();
    assertOk(result, name);
    trace.push({ step: name, ok: true });
    return result;
  };

  if (app.store.runtimePhase === RUNTIME_PHASE.TITLE) {
    await step("day-loop.title-ready", () => composition.transitionDayLoop({
      trigger: DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY,
    }));
  }

  const { recipeId, recipe, offers } = resolveOrderableRecipe(app);

  for (const offer of offers) {
    await step("market.purchase", () => composition.buyMarketOffer(offer));
  }

  await step("menu.edit", () => composition.confirmMenuEntry({
    recipeId,
    enabled: true,
    priceG: recipe.basePriceG,
    plannedQuantity: 1,
  }));

  await step("menu.confirm", () => composition.confirmMenuPlan());

  await step("service.start", () => composition.startService());

  const guest = qaSeedSeatedGuest(app);
  trace.push({ step: "qa.seed-seated-guest", ok: true });

  const orderResult = await step("order.create", () => composition.createOrder({
    guestId: guest.guestId,
  }));
  const order = eventPayload(orderResult, "order.created");

  await step("cook.start", () => composition.startCook({
    recipeId: order.recipeId,
    saleSlotId: order.saleSlotId,
    sourceOrderId: order.orderId,
  }));

  const targetAtMs = app.store.getSnapshot().service.timingCook.targetAtMs;
  await step("cook.complete", () => composition.completeCook({ inputAtMs: targetAtMs }));

  await step("order.serve", () => composition.serveOrder({ targetOrderId: order.orderId }));

  await step("day-loop.timer-zero", () => composition.transitionDayLoop({
    trigger: DAY_LOOP_TRIGGER.TIMER_ZERO,
  }));

  const transitionToken = app.store.getSnapshot().service.settlementTransitionToken;
  await step("day-loop.cleanup-complete", () => composition.transitionDayLoop({
    trigger: DAY_LOOP_TRIGGER.CLEANUP_VISUALS_COMPLETE,
    transitionToken,
  }));

  await step("settlement.settle", () => composition.settleDay());

  return Object.freeze({
    ok: true,
    trace: Object.freeze(trace),
    finalSnapshot: app.store.getSnapshot(),
  });
}
