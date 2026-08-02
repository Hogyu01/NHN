import { createRuntimeComposition } from "../app/runtime-composition.js";
import { freezeDeep } from "../core/result.js";
import { ACTIVE_ORDER_STATE, ORDER_GUEST_STATE } from "../domain/orders.js";
import { SALE_SLOT_STATE } from "../domain/sale-slots.js";
import { TIMING_COOK_STATE } from "../domain/timing-cook.js";
import { RUNTIME_PHASE } from "../domain/timer-state.js";
import { navigationPointToWorld } from "../world/map-schema.js";
import { deriveCameraTransform } from "../world/camera.js";
import {
  DYNAMIC_SERVICE_TARGET_KIND,
  createGuestOrderTarget,
  normalizeDynamicServiceTarget,
  resolveDynamicServiceTarget,
} from "../world/dynamic-target-resolver.js";
import {
  CanvasRectAdapter,
  InputTransform,
} from "../world/input-transform.js";
import { WorldInteractionRouter } from "../world/interaction-router.js";
import {
  PLAYER_MOVEMENT_STEP_MILLI_PX,
  PlayerController,
} from "../world/player-controller.js";
import { CANVAS_LOGICAL_SIZE } from "../world/viewport-contract.js";
import { InputRouter } from "./input-router.js";
import { updateCampaignHud } from "./management-ui.js";
import { PanelManager, STATIC_PANEL_DEFINITIONS } from "./panel-manager.js";

const INGREDIENT_ICON_PATH = Object.freeze({
  "ingredient.slime_gel": "assets/generated/ingredients/slime-gel.png",
  "ingredient.cave_mushroom": "assets/generated/ingredients/cave-mushroom.png",
  "ingredient.glow_herb": "assets/generated/ingredients/glow-herb.png",
  "ingredient.ember_pepper": "assets/generated/ingredients/ember-pepper.png",
  "ingredient.moonroot": "assets/generated/ingredients/moonroot.png",
  "ingredient.crystal_salt": "assets/generated/ingredients/crystal-salt.png",
  "ingredient.stonegrain": "assets/generated/ingredients/stonegrain.png",
  "ingredient.griffin_egg": "assets/generated/ingredients/fire-lizard-meat.png",
  "ingredient.mimic_bean": "assets/generated/ingredients/acid-berry.png",
  "ingredient.moss_cheese": "assets/generated/ingredients/frost-boar-meat.png",
});

export const PROTOTYPE_WORLD_CONTRACT = Object.freeze({
  tileSize: 32,
  widthTiles: 15,
  heightTiles: 15,
  width: 480,
  height: 480,
});

export const PROTOTYPE_ZONES = Object.freeze([
  Object.freeze({
    id: "board",
    label: "길드 게시판",
    x: 20,
    y: 20,
    w: 100,
    h: 80,
    color: "#4a6fa5",
    body: "(3단계에서 구현 예정)",
  }),
  Object.freeze({
    id: "stove",
    label: "조리대",
    x: 360,
    y: 20,
    w: 100,
    h: 80,
    color: "#c9752f",
    body: "(5단계에서 구현 예정)",
  }),
  Object.freeze({
    id: "counter",
    label: "카운터",
    x: 190,
    y: 380,
    w: 100,
    h: 80,
    color: "#5a9e6f",
    body: "(6단계에서 구현 예정)",
  }),
]);

const SEMANTIC_COLORS = Object.freeze({
  board: "#4a6fa5",
  stove: "#c9752f",
  counter: "#5a9e6f",
  storage: "#775a9e",
});

function prototypeRuntimeMapDefinition() {
  const area = PROTOTYPE_WORLD_CONTRACT.widthTiles * PROTOTYPE_WORLD_CONTRACT.heightTiles;
  return freezeDeep({
    schemaVersion: 1,
    mapId: "map.prototype_runtime",
    width: PROTOTYPE_WORLD_CONTRACT.widthTiles,
    height: PROTOTYPE_WORLD_CONTRACT.heightTiles,
    tileSize: PROTOTYPE_WORLD_CONTRACT.tileSize,
    layers: {
      ground: Array(area).fill("tile.prototype.floor"),
      collision: Array(area).fill(0),
      below: Array(area).fill(null),
      above: Array(area).fill(null),
    },
    objects: [],
    zones: PROTOTYPE_ZONES.map((zone) => ({
      zoneId: `zone.prototype-runtime.${zone.id}`,
      semantic: zone.id,
      rect: { x: zone.x, y: zone.y, width: zone.w, height: zone.h },
      approachTileIds: [`approach.prototype-runtime.${zone.id}`],
    })),
    navigation: {
      playerStart: {
        pointId: "point.prototype-runtime.player-start",
        tileX: 7,
        tileY: 7,
        offsetX: 16,
        offsetY: 16,
      },
      spawnPoint: { pointId: "point.prototype-runtime.spawn", tileX: 1, tileY: 13, offsetX: 16, offsetY: 16 },
      exitPoint: { pointId: "point.prototype-runtime.exit", tileX: 2, tileY: 13, offsetX: 16, offsetY: 16 },
      approachPoints: [],
      seatPoints: [],
      tableServiceTargets: [],
      transitions: [],
    },
    expansionRegions: [],
  });
}

export const PROTOTYPE_RUNTIME_MAP_DEFINITION = prototypeRuntimeMapDefinition();

function presentationForZone(zone) {
  const prototype = PROTOTYPE_ZONES.find((candidate) => candidate.id === zone.semantic);
  const definition = STATIC_PANEL_DEFINITIONS[zone.semantic] ?? {
    label: zone.semantic,
    body: `${zone.semantic} 상호작용`,
  };
  return Object.freeze({
    id: zone.semantic,
    zoneId: zone.zoneId,
    semantic: zone.semantic,
    label: prototype?.label ?? definition.label,
    body: prototype?.body ?? definition.body,
    x: zone.rect.x,
    y: zone.rect.y,
    w: zone.rect.width,
    h: zone.rect.height,
    color: prototype?.color ?? SEMANTIC_COLORS[zone.semantic] ?? "#666666",
  });
}

function lowerDirection(direction) {
  return direction.toLowerCase();
}

function invokeSynchronous(callback, value, field) {
  const outcome = callback(value);
  if (outcome && typeof outcome.then === "function") {
    throw new TypeError(`${field} callback은 Promise를 반환할 수 없습니다.`);
  }
  return outcome;
}

/**
 * Task 33 — board panel을 실제 재료별 수량 입력·Recipe별 메뉴 체크박스가 있는 화면으로
 * 그린다(이전엔 버튼 하나로 첫 Recipe만 자동 구매/등록했다). 실제 domain command만 쓴다.
 */
const BOARD_ERROR_MESSAGE = Object.freeze({
  MARKET_PURCHASE_REQUIRES_PLANNING: "준비 단계에서만 재료를 구매할 수 있습니다.",
  INSUFFICIENT_MARKET_STOCK: "선택한 수량만큼 시장 재고가 남아 있지 않습니다.",
  MARKET_PURCHASE_LIMIT_EXCEEDED: "오늘 구매할 수 있는 수량을 초과했습니다.",
  INSUFFICIENT_AVAILABLE_CASH: "사용 가능한 현금이 부족합니다.",
  MENU_CONFIRM_LOCKED: "현재는 메뉴를 변경할 수 없습니다.",
  MENU_EDIT_LOCKED: "현재는 메뉴를 변경할 수 없습니다.",
  INVENTORY_SHORTAGE: "메뉴 수량에 필요한 재료가 부족합니다. 시장에서 재료를 더 구매해주세요.",
  SERVICE_START_PLAN_REQUIRED: "메뉴 수량을 정하고 메뉴 확정을 먼저 눌러주세요.",
  SERVICE_START_UNCONFIRMED_MENU_EDITS: "변경한 메뉴를 다시 확정해주세요.",
  SERVICE_START_ENABLED_RECIPE_REQUIRED: "판매 수량이 1개 이상인 메뉴가 필요합니다.",
  SERVICE_START_AVAILABLE_SLOT_REQUIRED: "확정된 판매 메뉴가 없습니다.",
});

function boardResultMessage(result, fallback) {
  if (result?.ok) return fallback;
  const diagnosticMessage = result?.diagnostics?.find(
    (diagnostic) => typeof diagnostic?.details?.message === "string",
  )?.details?.message;
  return diagnosticMessage ?? BOARD_ERROR_MESSAGE[result?.code] ?? `처리할 수 없습니다. (${result?.code ?? "UNKNOWN"})`;
}

function renderBoardPanel(app, bodyEl, root, initialMessage = "") {
  bodyEl.textContent = "";
  const composition = createRuntimeComposition(app);
  const el = (tag, props = {}, children = []) => {
    const node = root.createElement(tag);
    Object.assign(node, props);
    for (const child of children) node.append(child);
    return node;
  };

  const section = (titleText) => {
    const heading = el("h3", { className: "panel-section-title", textContent: titleText });
    bodyEl.append(heading);
  };
  const status = el("p", { className: "panel-action-result", textContent: initialMessage });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const setStatus = (text) => { status.textContent = text; };

  const rerender = (message = "") => renderBoardPanel(app, bodyEl, root, message);
  bodyEl.append(status);

  // --- 시장: 재료별 수량 입력 ---
  section("시장 — 재료 구매");
  const snapshot = app.store.getSnapshot();
  const planningPhase = snapshot.runtimePhase === "PLANNING";
  const ingredient = (ingredientId) =>
    app.ingredientCatalog?.find((entry) => entry.ingredientId === ingredientId) ?? null;
  const ingredientName = (ingredientId) => ingredient(ingredientId)?.displayName ?? ingredientId;
  const offerList = el("ul", { className: "panel-list" });
  for (const offer of snapshot.market?.offers ?? []) {
    const soldOut = offer.availableQuantity <= 0;
    const qtyInput = el("input", {
      type: "number", min: "1", max: String(Math.max(1, offer.availableQuantity)), value: "1",
      className: "panel-qty-input", disabled: soldOut || !planningPhase,
    });
    const buyButton = el("button", {
      type: "button",
      textContent: soldOut ? "품절" : "구매",
      disabled: soldOut || !planningPhase,
    });
    buyButton.dataset.boardAction = "market-buy";
    buyButton.addEventListener("click", async () => {
      buyButton.disabled = true;
      const quantity = Math.max(1, Math.min(offer.availableQuantity, Number(qtyInput.value) || 1));
      const result = await composition.buyMarketOffer({ offerId: offer.offerId, quantity });
      rerender(boardResultMessage(result, `구매 완료: ${ingredientName(offer.ingredientId)} x${quantity}`));
    });
    const definition = ingredient(offer.ingredientId);
    const icon = el("img", {
      className: "market-offer-icon",
      src: INGREDIENT_ICON_PATH[offer.ingredientId] ?? "",
      alt: "",
    });
    const details = el("div", { className: "market-offer-details" }, [
      el("strong", { textContent: ingredientName(offer.ingredientId) }),
      el("span", { textContent: `${definition?.flavorProfile ?? "특제"} · 품질 ${offer.quality}` }),
      el("small", { textContent: `재고 ${offer.availableQuantity} · 개당 ${offer.unitPriceG}G` }),
    ]);
    const controls = el("div", { className: "market-offer-controls" }, [qtyInput, buyButton]);
    const row = el("li", { className: "market-offer-card" }, [icon, details, controls]);
    offerList.append(row);
  }
  if ((snapshot.market?.offers ?? []).length === 0) offerList.append(el("li", { textContent: "오늘은 더 구매할 재료가 없습니다." }));
  bodyEl.append(offerList);

  // --- Contracts ---
  section("계약 · 내일 도착할 식재료");
  const contractProjection = app.contractSystem.project(snapshot);
  const contractList = el("ul", { className: "panel-list" });
  for (const offer of contractProjection.offers) {
    const riskCheck = el("input", {
      type: "checkbox",
      checked: !offer.fixedCostRiskConfirmationRequired,
      disabled: !offer.fixedCostRiskConfirmationRequired || !offer.acceptanceEnabled,
      ariaLabel: "고정비 부족 위험 확인",
    });
    const acceptButton = el("button", {
      type: "button",
      textContent: offer.acceptanceEnabled ? "수락" : "수락 불가",
      disabled: !planningPhase || !offer.acceptanceEnabled || offer.fixedCostRiskConfirmationRequired,
    });
    if (offer.fixedCostRiskConfirmationRequired) {
      riskCheck.addEventListener("change", () => { acceptButton.disabled = !riskCheck.checked; });
    }
    acceptButton.addEventListener("click", async () => {
      acceptButton.disabled = true;
      const result = await composition.acceptContract({
        offerId: offer.offerId,
        fixedCostRiskConfirmed: riskCheck.checked,
      });
      rerender(boardResultMessage(result, "계약을 수락했습니다. 입고일을 확인하세요."));
    });
    const lineSummary = (offer.lines ?? [])
      .map((line) => `${ingredientName(line.ingredientId)} x${line.quantity}`)
      .join(", ");
    const row = el("li", {}, [
      el("span", {
        textContent: `${lineSummary} · 총 ${offer.totalPriceG}G · 선금 ${offer.prepaidG}G · Day ${offer.arrivalDay} 도착${offer.disabledReason ? ` · ${offer.disabledReason}` : ""}`,
      }),
      ...(offer.fixedCostRiskConfirmationRequired
        ? [el("label", { className: "panel-confirm-label" }, [riskCheck, root.createTextNode(" 위험 확인")])]
        : []),
      acceptButton,
    ]);
    contractList.append(row);
  }
  if (contractProjection.offers.length === 0) {
    contractList.append(el("li", { textContent: "오늘 제안된 계약이 없습니다." }));
  }
  bodyEl.append(contractList);

  // --- Facilities ---
  section("시설 · 영구 업그레이드");
  const facilityProjection = app.facilitySystem.project(snapshot);
  const facilityList = el("ul", { className: "panel-list" });
  for (const stage of facilityProjection.stages) {
    const purchaseButton = el("button", {
      type: "button",
      textContent: stage.purchased ? "구매 완료" : "구매",
      disabled: !planningPhase || !stage.purchaseEnabled,
    });
    purchaseButton.addEventListener("click", async () => {
      purchaseButton.disabled = true;
      const result = await composition.purchaseFacility({ facilityId: stage.facilityId });
      rerender(boardResultMessage(result, `${stage.displayName} 시설을 구매했습니다.`));
    });
    facilityList.append(el("li", {}, [
      el("span", {
        textContent: `${stage.displayName} · ${stage.costG}G · 평판 ${stage.condition.current}/${stage.condition.threshold}${stage.disabledReason ? ` · ${stage.disabledReason}` : ""}`,
      }),
      purchaseButton,
    ]));
  }
  bodyEl.append(facilityList);

  // --- 메뉴: Recipe별 체크박스 + 수량 ---
  section("메뉴 — 오늘 판매할 Recipe");
  const draftByRecipeId = new Map((snapshot.menu?.draftEntries ?? []).map((entry) => [entry.recipeId, entry]));
  const recipeList = el("ul", { className: "panel-list" });
  const menuLocked = snapshot.menu?.locked === true;
  const menuControls = [];
  for (const recipeId of snapshot.recipes?.unlockedRecipeIds ?? []) {
    const recipe = snapshot.recipes.definitions.find((def) => def.recipeId === recipeId);
    const draft = draftByRecipeId.get(recipeId);
    const checkbox = el("input", {
      type: "checkbox",
      checked: Boolean(draft?.enabled),
      disabled: menuLocked || !planningPhase,
    });
    const qtyInput = el("input", {
      type: "number", min: "0", max: "20", value: String(draft?.plannedQuantity ?? 0),
      className: "panel-qty-input", disabled: menuLocked || !planningPhase,
    });
    menuControls.push({ recipeId, recipe, checkbox, qtyInput });
    const requirements = (recipe?.ingredientRequirements ?? [])
      .map((requirement) => `${ingredientName(requirement.ingredientId)} x${requirement.quantity}`)
      .join(", ");
    const row = el("li", {}, [
      checkbox,
      el("span", {
        textContent: `${recipe?.displayName ?? recipeId} · ${recipe?.basePriceG ?? "?"}G · 필요: ${requirements}`,
      }),
      qtyInput,
    ]);
    recipeList.append(row);
  }
  bodyEl.append(recipeList);

  const confirmButton = el("button", { type: "button", textContent: menuLocked ? "메뉴 확정됨" : "메뉴 확정" });
  confirmButton.dataset.boardAction = "menu-confirm";
  confirmButton.disabled = menuLocked || !planningPhase;
  confirmButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    const activeControls = menuControls.filter(
      ({ checkbox, qtyInput }) => checkbox.checked && Math.max(0, Number(qtyInput.value) || 0) > 0,
    );
    if (activeControls.length === 0) {
      setStatus("판매할 메뉴의 수량을 1개 이상 입력해주세요.");
      confirmButton.disabled = false;
      return;
    }
    for (const control of menuControls) {
      const edited = await composition.confirmMenuEntry({
        recipeId: control.recipeId,
        enabled: control.checkbox.checked,
        priceG: control.recipe.basePriceG,
        plannedQuantity: control.checkbox.checked
          ? Math.max(0, Number(control.qtyInput.value) || 0)
          : 0,
      });
      if (!edited.ok) {
        setStatus(boardResultMessage(edited, ""));
        confirmButton.disabled = false;
        return;
      }
    }
    const result = await composition.confirmMenuPlan();
    rerender(boardResultMessage(result, "메뉴가 확정됐습니다. 이제 영업을 시작할 수 있습니다."));
  });
  bodyEl.append(confirmButton);

  // --- Service 시작 ---
  section("영업");
  const positiveConfirmedEntries = (snapshot.menu?.confirmedEntries ?? []).filter(
    (entry) => entry.enabled && entry.plannedQuantity > 0,
  );
  const serviceInProgress = ["SERVICE", "PAUSED"].includes(snapshot.runtimePhase);
  const menuPlanReady = planningPhase && !menuLocked &&
    typeof snapshot.menu?.activePlanId === "string" &&
    snapshot.menu?.planRevision > 0 &&
    positiveConfirmedEntries.length > 0 &&
    JSON.stringify(snapshot.menu?.draftEntries) === JSON.stringify(snapshot.menu?.confirmedEntries);
  const serviceGuide = el("p", {
    className: "panel-service-guide",
    textContent: serviceInProgress
      ? "현재 영업이 진행 중입니다."
      : menuPlanReady
      ? `메뉴 ${positiveConfirmedEntries.length}종의 준비가 끝났습니다.`
      : "메뉴 수량을 입력하고 메뉴 확정을 완료하면 영업을 시작할 수 있습니다.",
  });
  const startButton = el("button", {
    type: "button",
    textContent: serviceInProgress ? "영업 진행 중" : "영업 시작",
    disabled: !menuPlanReady,
  });
  startButton.dataset.boardAction = "service-start";
  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    const result = await composition.startService();
    if (result.ok) {
      app.hub?.closePanel();
      app.hub?.render();
      return;
    }
    setStatus(boardResultMessage(result, ""));
    startButton.disabled = false;
  });
  bodyEl.append(serviceGuide);
  if (!serviceInProgress && menuPlanReady) {
    const plannedServings = positiveConfirmedEntries.reduce(
      (total, entry) => total + entry.plannedQuantity,
      0,
    );
    const expectedGuestCount = app.serviceConfiguration?.defaultGuestCount ?? 6;
    const capacityGuide = el("p", {
      className: "panel-service-guide",
      textContent: plannedServings < expectedGuestCount
        ? `오늘 예정 손님 ${expectedGuestCount}명 · 준비 ${plannedServings}인분 · ${expectedGuestCount - plannedServings}명은 품절로 떠납니다`
        : `오늘 예정 손님 ${expectedGuestCount}명 · 준비 ${plannedServings}인분`,
    });
    if (plannedServings < expectedGuestCount) capacityGuide.dataset.tone = "warning";
    bodyEl.append(capacityGuide);
  }
  bodyEl.append(startButton);

}

/** stove panel: ACTIVE order가 있으면 그 slot을, 없으면 첫 AVAILABLE slot을 조리한다. */
function stoveActions(app) {
  const composition = createRuntimeComposition(app);
  return [
    {
      label: "조리 시작",
      onClick: () => {
        const snapshot = app.store.getSnapshot();
        const activeOrder = snapshot.service.orders.find(
          (order) => order.state === ACTIVE_ORDER_STATE.ACTIVE,
        );
        const slot = activeOrder
          ? snapshot.saleSlots.slots.find((candidate) => candidate.saleSlotId === activeOrder.saleSlotId)
          : snapshot.saleSlots.slots.find((candidate) => candidate.state === SALE_SLOT_STATE.AVAILABLE);
        if (!slot) return Promise.resolve({ ok: false, code: "NO_COOKABLE_SLOT" });
        return composition.startCook({
          recipeId: slot.recipeId,
          saleSlotId: slot.saleSlotId,
          sourceOrderId: activeOrder ? activeOrder.orderId : null,
        });
      },
    },
    {
      label: "조리 완료",
      onClick: () => {
        const timingCook = app.store.getSnapshot().service.timingCook;
        if (!timingCook) return Promise.resolve({ ok: false, code: "NO_RUNNING_COOK" });
        return composition.completeCook({ inputAtMs: timingCook.targetAtMs });
      },
    },
  ];
}

/** counter panel: 첫 ACTIVE order에 carried dish를 서빙한다. */
function counterActions(app) {
  const composition = createRuntimeComposition(app);
  return [
    {
      label: "서빙",
      onClick: () => {
        const activeOrder = app.store.getSnapshot().service.orders.find(
          (order) => order.state === ACTIVE_ORDER_STATE.ACTIVE,
        );
        if (!activeOrder) return Promise.resolve({ ok: false, code: "NO_ACTIVE_ORDER" });
        return composition.serveOrder({ targetOrderId: activeOrder.orderId });
      },
    },
  ];
}

function renderServiceStatus(root, bodyEl) {
  const status = root.createElement("p");
  status.className = "panel-action-result";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  bodyEl.append(status);
  return (message) => { status.textContent = message; };
}

function recipeName(app, recipeId) {
  return app.recipeCatalog?.find((recipe) => recipe.recipeId === recipeId)?.displayName ?? recipeId;
}

function renderStovePanel(app, bodyEl, root) {
  bodyEl.textContent = "";
  const composition = createRuntimeComposition(app);
  const setStatus = renderServiceStatus(root, bodyEl);
  const snapshot = app.store.getSnapshot();
  const timingCook = snapshot.service.timingCook;
  const running = timingCook?.state === TIMING_COOK_STATE.RUNNING_ESCROW;
  const heading = root.createElement("h3");
  heading.className = "panel-section-title";
  heading.textContent = running ? "조리 타이밍" : "대기 주문";
  bodyEl.append(heading);

  if (running) {
    const summary = root.createElement("p");
    summary.className = "panel-service-guide";
    summary.textContent = `${recipeName(app, timingCook.recipeId)} 조리 중`;
    const progress = root.createElement("progress");
    progress.className = "cook-timing-progress";
    progress.max = timingCook.failureAtMs - timingCook.startedAtMs;
    progress.setAttribute("aria-label", "조리 진행도");
    const hint = root.createElement("p");
    hint.className = "panel-service-guide cook-timing-hint";
    const updateProgress = () => {
      if (!progress.isConnected) return;
      const now = app.scheduler?.simulationTimeMs ?? timingCook.startedAtMs;
      progress.value = Math.max(0, Math.min(progress.max, now - timingCook.startedAtMs));
      const remaining = timingCook.targetAtMs - now;
      hint.textContent = remaining > 0
        ? `최적 타이밍까지 ${(remaining / 1000).toFixed(1)}초`
        : `최적 타이밍에서 ${(Math.abs(remaining) / 1000).toFixed(1)}초 경과`;
      root.defaultView.requestAnimationFrame(updateProgress);
    };
    const complete = root.createElement("button");
    complete.type = "button";
    complete.dataset.serviceAction = "cook-complete";
    complete.textContent = "지금 꺼내기";
    complete.addEventListener("click", async () => {
      complete.disabled = true;
      const inputAtMs = app.scheduler?.simulationTimeMs ?? timingCook.startedAtMs;
      const result = await composition.completeCook({ inputAtMs });
      if (result.ok) renderStovePanel(app, bodyEl, root);
      else {
        setStatus(`조리를 완료하지 못했습니다. (${result.code ?? "UNKNOWN"})`);
        complete.disabled = false;
      }
    });
    bodyEl.append(summary, progress, hint, complete);
    updateProgress();
    return;
  }

  if (snapshot.service.carriedDishId) {
    setStatus("완성된 요리를 들고 있습니다. 카운터에서 손님을 선택해 서빙하세요.");
    return;
  }

  const activeOrders = snapshot.service.orders.filter((order) => order.state === ACTIVE_ORDER_STATE.ACTIVE);
  const list = root.createElement("ul");
  list.className = "panel-list service-order-list";
  for (const order of activeOrders) {
    const button = root.createElement("button");
    button.type = "button";
    button.dataset.serviceAction = "cook-start";
    button.dataset.orderId = order.orderId;
    button.textContent = "조리 시작";
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = await composition.startCook({
        recipeId: order.recipeId,
        saleSlotId: order.saleSlotId,
        sourceOrderId: order.orderId,
      });
      if (result.ok) renderStovePanel(app, bodyEl, root);
      else {
        setStatus(`조리를 시작하지 못했습니다. (${result.code ?? "UNKNOWN"})`);
        button.disabled = false;
      }
    });
    const line = root.createElement("li");
    const label = root.createElement("span");
    label.textContent = `${recipeName(app, order.recipeId)} · 손님 ${order.guestId.split(":").at(-1)}`;
    line.append(label, button);
    list.append(line);
  }
  if (activeOrders.length === 0) {
    const empty = root.createElement("li");
    empty.textContent = "접수된 주문이 없습니다. 앉은 손님 가까이에서 상호작용하세요.";
    list.append(empty);
  }
  bodyEl.append(list);
}

function renderCounterPanel(app, bodyEl, root) {
  bodyEl.textContent = "";
  const composition = createRuntimeComposition(app);
  const setStatus = renderServiceStatus(root, bodyEl);
  const snapshot = app.store.getSnapshot();
  const dish = snapshot.inventory.completedDishes.find(
    (candidate) => candidate.dishId === snapshot.service.carriedDishId,
  );
  const heading = root.createElement("h3");
  heading.className = "panel-section-title";
  heading.textContent = "서빙할 손님";
  bodyEl.append(heading);
  if (!dish) {
    setStatus("들고 있는 완성 요리가 없습니다. 화로에서 먼저 조리하세요.");
    return;
  }
  const dishSummary = root.createElement("p");
  dishSummary.className = "panel-service-guide";
  dishSummary.textContent = `현재 요리: ${recipeName(app, dish.recipeId)}`;
  bodyEl.append(dishSummary);
  const orders = snapshot.service.orders.filter((order) => order.state === ACTIVE_ORDER_STATE.ACTIVE);
  const list = root.createElement("ul");
  list.className = "panel-list service-order-list";
  for (const order of orders) {
    const button = root.createElement("button");
    button.type = "button";
    button.dataset.serviceAction = "serve-order";
    button.dataset.orderId = order.orderId;
    button.textContent = order.recipeId === dish.recipeId ? "서빙" : "다른 요리 서빙";
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = await composition.serveOrder({ targetOrderId: order.orderId });
      if (result.ok) renderCounterPanel(app, bodyEl, root);
      else {
        setStatus(`서빙하지 못했습니다. (${result.code ?? "UNKNOWN"})`);
        button.disabled = false;
      }
    });
    const line = root.createElement("li");
    const label = root.createElement("span");
    label.textContent = `${recipeName(app, order.recipeId)} · 손님 ${order.guestId.split(":").at(-1)}`;
    line.append(label, button);
    list.append(line);
  }
  bodyEl.append(list);
}

const PANEL_ACTION_BUILDERS = Object.freeze({
  stove: stoveActions,
  counter: counterActions,
});

/**
 * Browser adapter retained under its prototype name for compatibility. Player movement, static
 * zone opens, and dynamic action commands all pass through production World/Input routers.
 */
export class PrototypeHubAdapter {
  constructor({
    scene,
    panelOverlay,
    panelTitle,
    panelBody,
    panelCloseButton,
    mapDefinition = PROTOTYPE_RUNTIME_MAP_DEFINITION,
    inputTarget = window,
    onInteractionCommand = () => undefined,
    getApp = () => null,
    externalFrameDriver = false,
  }) {
    if (typeof onInteractionCommand !== "function") {
      throw new TypeError("onInteractionCommand는 함수여야 합니다.");
    }
    this.getApp = getApp;
    this.scene = scene;
    this.inputTarget = inputTarget;
    this.root = panelOverlay.ownerDocument;
    this.onInteractionCommand = onInteractionCommand;
    this.externalFrameDriver = Boolean(externalFrameDriver);
    this.inputRouter = null;
    this.interactionRouter = null;
    this.panelManager = new PanelManager({
      root: this.root,
      overlay: panelOverlay,
      title: panelTitle,
      body: panelBody,
      closeButton: panelCloseButton,
      canvas: scene.canvas,
      onContextChange: () => {
        this.clearMovementInput();
        this.inputRouter?.syncContext();
      },
    });
    this.canvasRectAdapter = new CanvasRectAdapter(scene.canvas);
    this.inputTransform = new InputTransform({
      rectAdapter: this.canvasRectAdapter,
      cameraProvider: () => this.getCameraTransform(),
      viewport: CANVAS_LOGICAL_SIZE,
    });

    this.animationFrame = 0;
    this.animationTimer = 0;
    this.running = false;
    this.inputActive = false;
    this.lastFrameTime = null;
    this.animationFrameRequest = null;
    this.controller = null;
    this.mapDefinition = null;
    this.zonePresentations = [];
    this.guestOrderTargets = Object.freeze([]);
    this.interactionCommands = [];
    this.lastPointerWorld = null;
    this.lastInputTransformCode = null;
    this.destroyed = false;

    this.gameLoop = this.gameLoop.bind(this);
    this.setMapDefinition(mapDefinition);
    this.interactionRouter = new WorldInteractionRouter({
      mapDefinition: this.mapDefinition,
      dynamicTargetProvider: () => this.guestOrderTargets,
      onStaticOpen: (request) => this.#openStaticRequest(request),
      onDynamicCommand: (command) => this.#publishInteractionCommand(command),
    });
    this.inputRouter = new InputRouter({
      root: this.root,
      inputTarget: this.inputTarget,
      canvas: this.scene.canvas,
      inputTransform: this.inputTransform,
      modalOpenProvider: () => this.root.documentElement.dataset.modalOpen === "open",
      panelOpenProvider: () => this.panelManager.isOpen,
      canvasActiveProvider: () => this.inputActive,
      onMovement: (logical) => this.controller.setDirectionHeld(logical.direction, logical.held),
      onAction: (logical) => this.routeInteractionAction({
        inputSource: logical.source,
        inputWorldPoint: logical.worldPoint,
      }),
      onPointerWorld: (logical) => this.#publishPointerWorld(logical),
      onTransformError: (failure) => this.#publishInputTransformError(failure),
      onClearMovement: () => this.clearMovementInput(),
    });
  }

  get panelOpen() {
    return this.panelManager.isOpen;
  }

  activate() {
    this.inputActive = true;
    this.inputRouter?.syncContext();
  }

  deactivate() {
    this.inputActive = false;
    this.inputRouter?.syncContext();
  }

  start() {
    this.activate();
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = null;
    if (this.externalFrameDriver) return;
    this.animationFrameRequest = this.inputTarget.requestAnimationFrame(this.gameLoop);
  }

  stop({ deactivate = false } = {}) {
    if (this.animationFrameRequest !== null) {
      this.inputTarget.cancelAnimationFrame(this.animationFrameRequest);
    }
    this.animationFrameRequest = null;
    this.running = false;
    this.lastFrameTime = null;
    if (deactivate) this.deactivate();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop({ deactivate: true });
    this.inputRouter?.destroy();
    this.panelManager?.destroy();
    this.scene?.destroy?.();
  }

  setMapDefinition(mapDefinition) {
    if (!mapDefinition || typeof mapDefinition !== "object") throw new TypeError("runtime Map definition이 필요합니다.");
    this.panelManager.close({ returnFocus: false });
    this.mapDefinition = mapDefinition;
    this.controller = new PlayerController({
      mapDefinition,
      movementStepMilliPx: PLAYER_MOVEMENT_STEP_MILLI_PX,
    });
    this.zonePresentations = Object.freeze((mapDefinition.zones ?? []).map(presentationForZone));
    this.guestOrderTargets = Object.freeze([]);
    this.interactionCommands = [];
    this.interactionRouter?.setMapDefinition(mapDefinition);
    this.animationFrame = 0;
    this.animationTimer = 0;
    this.lastPointerWorld = null;
    this.lastInputTransformCode = null;
    this.scene.setMapDefinition?.(mapDefinition);
    this.render();
    return this.getWorldSnapshot();
  }

  usePrototypeRegressionMap() {
    return this.setMapDefinition(PROTOTYPE_RUNTIME_MAP_DEFINITION);
  }

  gameLoop(time) {
    if (!this.running || this.externalFrameDriver) return;
    const deltaMs = this.lastFrameTime === null ? 0 : time - this.lastFrameTime;
    this.lastFrameTime = time;
    this.step(deltaMs);
    this.animationFrameRequest = this.inputTarget.requestAnimationFrame(this.gameLoop);
  }

  clearMovementInput() {
    this.controller?.clearHeldMovement();
  }

  step(deltaMs = 0) {
    const movementAllowed = !this.panelManager.isOpen &&
      this.root.documentElement.dataset.modalOpen !== "open" &&
      this.getApp()?.store?.runtimePhase !== RUNTIME_PHASE.PAUSED;
    const result = this.controller.step({ movementAllowed });
    this.#processZoneTransitions(result.zoneTransitions);
    this.updateAnimation(deltaMs);
    this.render();
    return this.getWorldSnapshot();
  }

  updateAnimation(deltaMs) {
    // player_walk_v2.png는 idle 프레임이 따로 없는 4열 sheet라(guest sheet와 같은 규약) 정지
    // 시 frame 0을 재사용하고, 이동 중에는 0~3을 순환한다.
    if (!this.controller.snapshot().player.moving) {
      this.animationFrame = 0;
      this.animationTimer = 0;
      return;
    }
    this.animationTimer += Math.max(0, deltaMs);
    if (this.animationTimer >= 120) {
      const elapsedFrames = Math.floor(this.animationTimer / 120);
      this.animationTimer %= 120;
      this.animationFrame = (this.animationFrame + elapsedFrames) % 4;
    }
  }

  openPanel(zone) {
    this.clearMovementInput();
    const app = this.getApp();
    if (app && zone.semantic === "board") {
      return this.panelManager.open({
        zoneId: zone.zoneId,
        semantic: zone.semantic,
        label: zone.label,
        renderContent: (bodyEl, root) => renderBoardPanel(app, bodyEl, root),
      });
    }
    if (app && zone.semantic === "stove") {
      return this.panelManager.open({
        zoneId: zone.zoneId,
        semantic: zone.semantic,
        label: zone.label,
        renderContent: (bodyEl, root) => renderStovePanel(app, bodyEl, root),
      });
    }
    if (app && zone.semantic === "counter") {
      return this.panelManager.open({
        zoneId: zone.zoneId,
        semantic: zone.semantic,
        label: zone.label,
        renderContent: (bodyEl, root) => renderCounterPanel(app, bodyEl, root),
      });
    }
    const builder = app ? PANEL_ACTION_BUILDERS[zone.semantic] : undefined;
    return this.panelManager.open({
      zoneId: zone.zoneId,
      semantic: zone.semantic,
      label: zone.label,
      body: zone.body,
      actions: builder ? builder(app) : [],
    });
  }

  closePanel({ returnFocus = true } = {}) {
    const activeZoneId = this.panelManager.activeZoneId;
    if (activeZoneId) this.controller.dismissZone(activeZoneId);
    this.clearMovementInput();
    return this.panelManager.close({ returnFocus });
  }

  setPlayerPosition(x, y) {
    const result = this.controller.setFootPositionLogical(x, y);
    this.#processZoneTransitions(result.zoneTransitions);
    this.render();
    return this.getWorldSnapshot();
  }

  setGuestOrderTargets(targets) {
    if (!Array.isArray(targets)) throw new TypeError("guest order targets는 배열이어야 합니다.");
    const normalized = targets.map((target, index) => normalizeDynamicServiceTarget(target, index));
    if (normalized.some((target) => target.kind !== DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER)) {
      throw new TypeError("runtime guest target provider에는 GUEST_ORDER만 등록할 수 있습니다.");
    }
    resolveDynamicServiceTarget({
      playerFootMilliPx: this.controller.snapshot().player.footMilliPx,
      targets: [...this.interactionRouter.authoredTableTargets, ...normalized],
    });
    this.guestOrderTargets = Object.freeze(normalized);
    return this.getInteractionSnapshot();
  }

  clearGuestOrderTargets() {
    this.guestOrderTargets = Object.freeze([]);
    return this.getInteractionSnapshot();
  }

  clearInteractionCommands() {
    this.interactionCommands = [];
    return this.getInteractionSnapshot();
  }

  routeInteractionAction({ inputSource = "PROGRAMMATIC", inputWorldPoint = null } = {}) {
    return this.interactionRouter.routeAction({
      playerFootMilliPx: this.controller.snapshot().player.footMilliPx,
      inputSource,
      inputWorldPoint,
    });
  }

  reset() {
    this.clearMovementInput();
    this.panelManager.close({ returnFocus: false });
    this.controller.reset();
    this.guestOrderTargets = Object.freeze([]);
    this.interactionCommands = [];
    this.animationFrame = 0;
    this.animationTimer = 0;
    this.lastPointerWorld = null;
    this.lastInputTransformCode = null;
    this.render();
    return this.getWorldSnapshot();
  }

  getWorldSnapshot() {
    return this.controller.snapshot();
  }

  getCameraTransform() {
    const world = this.controller.snapshot();
    return deriveCameraTransform({
      mapDefinition: this.mapDefinition,
      playerFootLogicalPx: world.player.footLogicalPx,
      viewport: CANVAS_LOGICAL_SIZE,
    });
  }

  clientToWorld(clientX, clientY) {
    return this.inputTransform.clientToWorld(clientX, clientY);
  }

  worldToClient(worldX, worldY) {
    return this.inputTransform.worldToClient(worldX, worldY);
  }

  getInteractionSnapshot() {
    const targets = this.interactionRouter?.getDynamicTargets() ?? [];
    return freezeDeep({
      router: this.interactionRouter?.snapshot() ?? null,
      input: this.inputRouter?.snapshot() ?? null,
      dynamicTargets: targets,
      guestOrderTargetCount: this.guestOrderTargets.length,
      commands: [...this.interactionCommands],
    });
  }

  getState() {
    const world = this.controller.snapshot();
    const camera = this.getCameraTransform();
    const inside = Object.entries(world.staticZoneOccupancy)
      .find(([, occupancy]) => occupancy.inside);
    const player = world.player;
    return freezeDeep({
      player: {
        x: player.footLogicalPx.x,
        y: player.footLogicalPx.y,
        speed: PLAYER_MOVEMENT_STEP_MILLI_PX / 1_000,
        dir: lowerDirection(player.direction),
        moving: player.moving,
        collisionWidth: player.collisionWidth,
        collisionHeight: player.collisionHeight,
        footMilliPx: player.footMilliPx,
      },
      camera,
      inputTransform: {
        lastCode: this.lastInputTransformCode,
        lastPointerWorld: this.lastPointerWorld,
      },
      interaction: this.getInteractionSnapshot(),
      panelOpen: this.panelManager.isOpen,
      currentZoneId: inside?.[1].semantic ?? null,
      activePanelZoneId: this.panelManager.activeSemantic,
      activeMapId: world.mapId,
      heldMovementDirections: world.heldMovementDirections,
      staticZoneOccupancy: world.staticZoneOccupancy,
      animationFrame: this.animationFrame,
      worldSnapshot: world,
    });
  }

  render() {
    const world = this.controller.snapshot();
    const camera = this.getCameraTransform();
    const app = this.getApp();
    const simulationTimeMs = app?.scheduler?.simulationTimeMs ?? 0;
    let runtimeSnapshot = null;
    if (app?.store) {
      const snapshot = app.store.getSnapshot();
      runtimeSnapshot = snapshot;
      this.#syncGuestOrderTargets(snapshot);
      updateCampaignHud(this.root, {
        day: snapshot.campaign.day,
        totalDays: 14,
        cashG: snapshot.economy.cashG,
        debtG: snapshot.economy.debtG,
        reputation: snapshot.campaign.reputation,
        paused: snapshot.runtimePhase === RUNTIME_PHASE.PAUSED,
        snapshot,
        guestCatalog: app.guestCatalog,
      });
    }
    this.scene.render({
      camera,
      zones: this.zonePresentations,
      player: {
        x: world.player.footLogicalPx.x,
        y: world.player.footLogicalPx.y,
        dir: lowerDirection(world.player.direction),
        moving: world.player.moving,
      },
      animationFrame: this.animationFrame,
      guests: this.#buildGuestRenderList(),
      carriedDish: runtimeSnapshot?.service?.carriedDishId
        ? runtimeSnapshot.inventory?.completedDishes?.find(
          (dish) => dish.dishId === runtimeSnapshot.service.carriedDishId,
        ) ?? null
        : null,
      vfxEvents: app?.vfxSystem ? app.vfxSystem.update(simulationTimeMs) : [],
      simulationTimeMs,
    });
  }

  #syncGuestOrderTargets(snapshot) {
    const seatPoints = this.mapDefinition?.navigation?.seatPoints ?? [];
    const targets = (snapshot.service?.guests ?? [])
      .filter((guest) => guest.state === ORDER_GUEST_STATE.SEATED)
      .map((guest) => {
        const seat = seatPoints.find((point) => point.seatId === guest.seatId);
        if (!seat) return null;
        const world = navigationPointToWorld(seat);
        return createGuestOrderTarget({
          targetId: `guest-order-target.${guest.guestId}`,
          entityId: guest.entityId,
          footMilliPx: { x: Math.round(world.x * 1_000), y: Math.round(world.y * 1_000) },
          proximityRadius: 52,
        });
      })
      .filter(Boolean);
    const previousIds = this.guestOrderTargets.map((target) => target.targetId).join("|");
    const nextIds = targets.map((target) => target.targetId).join("|");
    if (previousIds !== nextIds) this.guestOrderTargets = Object.freeze(targets);
  }

  /**
   * Task 32 — guest 연속 위치는 GameStore에 없다(Task 30). 이동 중이면 guestMotionTracker로
   * 재계산하고, 그 외(SEATED 등)에는 seat 고정 world point를 쓴다. app이 없으면(QA 등) 빈
   * 배열을 돌려준다 — render()는 여전히 pure presentation 경계다.
   */
  #buildGuestRenderList() {
    const app = this.getApp();
    if (!app?.store || !app?.guestMotionTracker) return [];
    const snapshot = app.store.getSnapshot();
    const simulationTimeMs = app.scheduler?.simulationTimeMs ?? 0;
    const seatPoints = this.mapDefinition?.navigation?.seatPoints ?? [];
    const plansByGuestId = new Map((snapshot.service?.plans ?? []).map((plan) => [plan.guestId, plan]));
    const MOVING_STATES = new Set([ORDER_GUEST_STATE.MOVING_TO_SEAT, ORDER_GUEST_STATE.MOVING_TO_EXIT]);

    return (snapshot.service?.guests ?? []).map((guest) => {
      const plan = plansByGuestId.get(guest.guestId);
      const archetypeId = plan?.archetypeId ?? null;
      if (MOVING_STATES.has(guest.state)) {
        const motion = app.guestMotionTracker.positionAt(guest.guestId, simulationTimeMs);
        if (motion) {
          return {
            guestId: guest.guestId,
            archetypeId,
            x: motion.world.x,
            y: motion.world.y,
            direction: motion.direction,
            moving: true,
            animationElapsedMs: motion.elapsedMs,
          };
        }
      }
      const seat = seatPoints.find((point) => point.seatId === guest.seatId);
      const world = seat ? navigationPointToWorld(seat) : { x: 0, y: 0 };
      return {
        guestId: guest.guestId,
        archetypeId,
        x: world.x,
        y: world.y,
        direction: "DOWN",
        moving: false,
        animationElapsedMs: 0,
      };
    });
  }

  #processZoneTransitions(transitions) {
    if (this.panelManager.isOpen || !this.interactionRouter) return null;
    return this.interactionRouter.routeStaticTransitions(transitions);
  }

  #openStaticRequest(request) {
    if (this.panelManager.isOpen) return;
    const presentation = this.zonePresentations.find((zone) => zone.zoneId === request.zoneId);
    if (presentation) this.openPanel(presentation);
  }

  #publishInteractionCommand(command) {
    this.interactionCommands.push(command);
    invokeSynchronous(this.onInteractionCommand, command, "onInteractionCommand");
    const EventConstructor = this.inputTarget.CustomEvent ?? this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor === "function") {
      this.root.dispatchEvent(new EventConstructor("world:interaction-command", {
        detail: command,
      }));
    }
  }

  #publishPointerWorld(logical) {
    this.lastPointerWorld = logical.worldPoint;
    this.lastInputTransformCode = "INPUT_TRANSFORM_OK";
    const EventConstructor = this.inputTarget.CustomEvent ?? this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor === "function") {
      this.root.dispatchEvent(new EventConstructor("world:pointer-coordinate", {
        detail: freezeDeep({ kind: logical.pointerEventType, worldPoint: logical.worldPoint }),
      }));
    }
  }

  #publishInputTransformError(failure) {
    this.lastInputTransformCode = failure.code;
    const EventConstructor = this.inputTarget.CustomEvent ?? this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor === "function") {
      this.root.dispatchEvent(new EventConstructor("world:pointer-transform-error", {
        detail: failure,
      }));
    }
  }
}
