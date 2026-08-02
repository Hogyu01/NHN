import { COOK_TRIGGER } from "../domain/timing-cook.js";

/**
 * Task 24 — board/stove/counter/storage panel button과 one-day-scenario driver가
 * 공유하는 production command dispatch 조합. 여기서 만드는 함수는 항상 실제
 * commandBus.dispatch를 거치는 real command이며, mock/shortcut state를 만들지 않는다.
 */

function commandInput(app, idPrefix, payload) {
  const store = app.store;
  const schedulerTime = app.scheduler?.simulationTimeMs;
  const issuedAtSimulationMs = Number.isSafeInteger(schedulerTime) && schedulerTime >= 0
    ? schedulerTime
    : store.revision * 20;
  return {
    commandId: `${idPrefix}:${store.revision}`,
    expectedRevision: store.revision,
    generationId: store.generationId,
    issuedAtSimulationMs,
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
        commandInput(app, "runtime:market.purchase", { offerId, quantity, day }),
      );
    },

    acceptContract({ offerId, fixedCostRiskConfirmed = false }) {
      const day = app.store.getSnapshot().campaign.day;
      return app.contractSystem.acceptContract(commandInput(
        app,
        "runtime:contract.accept",
        { day, offerId, fixedCostRiskConfirmed },
      ));
    },

    purchaseFacility({ facilityId }) {
      const day = app.store.getSnapshot().campaign.day;
      return app.facilitySystem.purchase(commandInput(
        app,
        "runtime:facility.purchase",
        { day, facilityId },
      ));
    },

    confirmMenuEntry({ recipeId, enabled, priceG, plannedQuantity }) {
      return app.menuSystem.editEntry(
        commandInput(app, "runtime:menu.edit", { recipeId, enabled, priceG, plannedQuantity }),
      );
    },

    confirmMenuPlan() {
      const day = app.store.getSnapshot().campaign.day;
      return app.menuSystem.confirmPlan(commandInput(app, "runtime:menu.confirm", { day }));
    },

    startService() {
      const day = app.store.getSnapshot().campaign.day;
      return app.dayLoopController.confirmServiceStart(
        commandInput(app, "runtime:service.start", { day }),
      );
    },

    createOrder({ guestId }) {
      return app.orderSystem.createOrder(commandInput(app, "runtime:order.create", { guestId }));
    },

    startCook({ recipeId, saleSlotId, sourceOrderId = null, trigger = COOK_TRIGGER.PLAYER }) {
      return app.directServiceSystem.startCook(
        commandInput(app, "runtime:cook.start", { recipeId, saleSlotId, sourceOrderId, trigger }),
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
        commandInput(app, "runtime:order.serve", { targetOrderId }),
      );
    },

    transitionDayLoop({ trigger, earlyEnd = undefined, transitionToken = undefined }) {
      return app.dayLoopController.transition(
        commandInput(app, "runtime:day-loop.transition", { trigger, earlyEnd, transitionToken }),
      );
    },

    settleDay() {
      const day = app.store.getSnapshot().campaign.day;
      return app.settlementSystem.settleDay(commandInput(app, "runtime:settlement.settle", { day }));
    },
  });
}
