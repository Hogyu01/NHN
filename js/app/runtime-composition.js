import { COOK_TRIGGER } from "../domain/timing-cook.js";

/**
 * Task 24 — board/stove/counter/storage panel button과 one-day-scenario driver가
 * 공유하는 production command dispatch 조합. 여기서 만드는 함수는 항상 실제
 * commandBus.dispatch를 거치는 real command이며, mock/shortcut state를 만들지 않는다.
 */

function commandInput(store, idPrefix, payload) {
  return {
    commandId: `${idPrefix}:${store.revision}`,
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs: store.revision * 20,
    payload,
  };
}

export function createRuntimeComposition(app) {
  if (!app || !app.store || !app.commandBus) {
    throw new TypeError("createRuntimeComposition에는 부팅된 app이 필요합니다.");
  }

  return Object.freeze({
    buyMarketOffer({ offerId, quantity }) {
      const day = app.store.getSnapshot().campaign.day;
      return app.marketSystem.purchaseOffer(
        commandInput(app.store, "runtime:market.purchase", { offerId, quantity, day }),
      );
    },

    confirmMenuEntry({ recipeId, enabled, priceG, plannedQuantity }) {
      return app.menuSystem.editEntry(
        commandInput(app.store, "runtime:menu.edit", { recipeId, enabled, priceG, plannedQuantity }),
      );
    },

    confirmMenuPlan() {
      const day = app.store.getSnapshot().campaign.day;
      return app.menuSystem.confirmPlan(commandInput(app.store, "runtime:menu.confirm", { day }));
    },

    startService() {
      const day = app.store.getSnapshot().campaign.day;
      return app.dayLoopController.confirmServiceStart(
        commandInput(app.store, "runtime:service.start", { day }),
      );
    },

    createOrder({ guestId }) {
      return app.orderSystem.createOrder(commandInput(app.store, "runtime:order.create", { guestId }));
    },

    startCook({ recipeId, saleSlotId, sourceOrderId = null, trigger = COOK_TRIGGER.PLAYER }) {
      return app.directServiceSystem.startCook(
        commandInput(app.store, "runtime:cook.start", { recipeId, saleSlotId, sourceOrderId, trigger }),
      );
    },

    // inputAtMs가 null이 아니면 Timing_Cook 판정에서 issuedAtSimulationMs와 반드시
    // 동일해야 하는 "같은 tick 관측" 값이라, 호출자가 둘을 직접 맞춰서 넘긴다.
    completeCook({ inputAtMs, issuedAtSimulationMs = inputAtMs }) {
      const store = app.store;
      return app.directServiceSystem.completeCook({
        commandId: `runtime:cook.complete:${store.revision}`,
        expectedRevision: store.revision,
        generationId: store.generationId,
        issuedAtSimulationMs,
        payload: { inputAtMs },
      });
    },

    serveOrder({ targetOrderId }) {
      return app.directServiceSystem.serve(
        commandInput(app.store, "runtime:order.serve", { targetOrderId }),
      );
    },

    transitionDayLoop({ trigger, earlyEnd = undefined, transitionToken = undefined }) {
      return app.dayLoopController.transition(
        commandInput(app.store, "runtime:day-loop.transition", { trigger, earlyEnd, transitionToken }),
      );
    },

    settleDay() {
      const day = app.store.getSnapshot().campaign.day;
      return app.settlementSystem.settleDay(commandInput(app.store, "runtime:settlement.settle", { day }));
    },
  });
}
