import { freezeDeep } from "../core/result.js";
import { createRuntimeComposition } from "../app/runtime-composition.js";
import { qaSeedSeatedGuest } from "../app/one-day-scenario.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function press(root, key, options = {}) {
  root.defaultView.dispatchEvent(new root.defaultView.KeyboardEvent("keydown", { key, bubbles: true, ...options }));
}

export async function runManagementUiBrowserProbe({ root, app }) {
  const results = [];
  const check = async (id, execute) => {
    try {
      results.push({ id, status: "PASS", details: await execute() });
    } catch (error) {
      results.push({ id, status: "FAIL", error: error instanceof Error ? error.message : String(error) });
    }
  };

  await check("management-dom-sections", async () => {
    if (app.store.runtimePhase === "TITLE") {
      const transition = await createRuntimeComposition(app).transitionDayLoop({
        trigger: "NEW_CAMPAIGN_READY",
      });
      assert(transition.ok, `관리 UI QA가 PLANNING에 진입하지 못했습니다: ${transition.code}`);
    }
    const board = app.hub.zonePresentations.find((zone) => zone.semantic === "board");
    app.hub.openPanel(board);
    const headings = [...root.querySelectorAll("#panel-body .panel-section-title")].map((node) => node.textContent);
    for (const required of ["시장", "계약", "시설", "메뉴", "영업"]) {
      assert(headings.some((heading) => heading.includes(required)), `${required} section이 없습니다.`);
    }
    assert(root.querySelectorAll("#panel-body button").length > 0, "경영 command button이 없습니다.");
    const serviceStart = root.querySelector('[data-board-action="service-start"]');
    assert(serviceStart?.disabled, "메뉴 확정 전 영업 시작 버튼이 비활성화되지 않았습니다.");
    const marketBuy = root.querySelector('[data-board-action="market-buy"]');
    assert(marketBuy && !marketBuy.disabled, "시장 구매 버튼을 찾을 수 없습니다.");
    const cashBefore = app.store.getSnapshot().economy.cashG;
    marketBuy.click();
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 20));
    const cashAfter = app.store.getSnapshot().economy.cashG;
    assert(cashAfter < cashBefore, "시장 구매가 현금 상태에 반영되지 않았습니다.");
    const rerenderedHeadings = root.querySelectorAll("#panel-body .panel-section-title");
    assert(rerenderedHeadings.length === headings.length, "구매 뒤 게시판 section이 중복 추가됐습니다.");
    assert(root.querySelector("#panel-body .panel-action-result")?.textContent.length > 0,
      "구매 결과 안내가 표시되지 않았습니다.");
    return { headings, rerenderedHeadingCount: rerenderedHeadings.length, cashBefore, cashAfter };
  });

  await check("board-purchase-menu-service-flow", async () => {
    const marketRows = [...root.querySelectorAll("#panel-body .panel-list li")];
    const saltRow = marketRows.find((row) => row.textContent.includes("소금 수정") && row.textContent.includes("품질"));
    const saltBuy = saltRow?.querySelector("button");
    assert(saltBuy && !saltBuy.disabled, "소금 수정 구매 버튼을 찾을 수 없습니다.");
    saltBuy.click();
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 20));

    const recipeRows = [...root.querySelectorAll("#panel-body .panel-list li")];
    const slimeRecipeRow = recipeRows.find((row) => row.textContent.includes("슬라임 젤리 화채"));
    const mushroomRecipeRow = recipeRows.find((row) => row.textContent.includes("광부의 수정 버섯볶음"));
    assert(slimeRecipeRow && mushroomRecipeRow, "메뉴 Recipe 행을 찾을 수 없습니다.");
    slimeRecipeRow.querySelector('input[type="checkbox"]').checked = false;
    mushroomRecipeRow.querySelector('input[type="checkbox"]').checked = true;
    mushroomRecipeRow.querySelector('input[type="number"]').value = "1";

    const confirmMenu = root.querySelector('[data-board-action="menu-confirm"]');
    assert(confirmMenu && !confirmMenu.disabled, "메뉴 확정 버튼이 활성화되지 않았습니다.");
    confirmMenu.click();
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 40));
    const planned = app.store.getSnapshot();
    assert(typeof planned.menu.activePlanId === "string", "메뉴 확정 계획이 생성되지 않았습니다.");
    const serviceStart = root.querySelector('[data-board-action="service-start"]');
    assert(serviceStart && !serviceStart.disabled, "메뉴 확정 뒤 영업 시작 버튼이 활성화되지 않았습니다.");
    serviceStart.click();
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 40));
    assert(app.store.runtimePhase === "SERVICE", "영업 시작 뒤 SERVICE 단계에 진입하지 못했습니다.");
    assert(root.querySelector("#panel-overlay").classList.contains("hidden"), "영업 시작 뒤 게시판이 닫히지 않았습니다.");

    const board = app.hub.zonePresentations.find((zone) => zone.semantic === "board");
    app.hub.openPanel(board);
    return { activePlanId: planned.menu.activePlanId, phase: app.store.runtimePhase };
  });

  await check("service-order-cook-serve-ui-flow", async () => {
    app.hub.closePanel({ returnFocus: false });
    const guest = qaSeedSeatedGuest(app);
    app.hub.render();
    const target = app.hub.guestOrderTargets.find((candidate) => candidate.entityId === guest.entityId);
    assert(target, `앉은 손님이 주문 상호작용 대상으로 등록되지 않았습니다. ` +
      `seat=${guest.seatId}, guests=${app.store.getSnapshot().service.guests.map((item) => `${item.state}:${item.seatId}`).join(",")}, ` +
      `mapSeats=${app.hub.mapDefinition.navigation.seatPoints.length}`);
    app.hub.setPlayerPosition(target.worldMilliPx.x / 1_000, target.worldMilliPx.y / 1_000);
    const route = app.hub.routeInteractionAction({ inputSource: "QA" });
    assert(route.command?.type === "direct-service.interact-guest-order", "손님 주문 상호작용이 라우팅되지 않았습니다.");
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 40));
    const order = app.store.getSnapshot().service.orders.find((candidate) => candidate.guestId === guest.guestId);
    assert(order?.state === "ACTIVE", "손님 상호작용으로 활성 주문이 생성되지 않았습니다.");

    const stove = app.hub.zonePresentations.find((zone) => zone.semantic === "stove");
    app.hub.openPanel(stove);
    const cookStart = root.querySelector(`[data-service-action="cook-start"][data-order-id="${order.orderId}"]`);
    assert(cookStart, "주문별 조리 시작 버튼이 없습니다.");
    cookStart.click();
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 30));
    const timing = app.store.getSnapshot().service.timingCook;
    assert(timing?.state === "RUNNING_ESCROW", "조리 타이밍 상태가 시작되지 않았습니다.");
    await app.simulationLoop.timerSystem.tick(timing.targetAtMs);
    const cookComplete = root.querySelector('[data-service-action="cook-complete"]');
    assert(cookComplete, "실시간 조리 완료 버튼이 없습니다.");
    cookComplete.click();
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 30));
    assert(app.store.getSnapshot().service.carriedDishId, "조리 완료 뒤 완성 요리를 들지 못했습니다.");

    app.hub.closePanel({ returnFocus: false });
    const counter = app.hub.zonePresentations.find((zone) => zone.semantic === "counter");
    app.hub.openPanel(counter);
    const serve = root.querySelector(`[data-service-action="serve-order"][data-order-id="${order.orderId}"]`);
    assert(serve, "주문별 서빙 버튼이 없습니다.");
    serve.click();
    await new Promise((resolve) => root.defaultView.setTimeout(resolve, 40));
    const sold = app.store.getSnapshot().service.orders.find((candidate) => candidate.orderId === order.orderId);
    assert(sold?.state === "COMPLETED", "카운터 서빙으로 주문이 완료되지 않았습니다.");
    app.hub.closePanel({ returnFocus: false });
    const board = app.hub.zonePresentations.find((zone) => zone.semantic === "board");
    app.hub.openPanel(board);
    return { guestId: guest.guestId, orderId: order.orderId, orderState: sold.state };
  });

  await check("panel-focus-loop-and-canvas-return", () => {
    const close = root.querySelector("#btn-panel-close");
    close.focus();
    press(root, "Tab");
    assert(root.querySelector("#panel-overlay").contains(root.activeElement), "Tab focus가 panel 밖으로 나갔습니다.");
    press(root, "Escape");
    assert(root.activeElement === app.scene.canvas, "Escape 뒤 canvas로 focus가 돌아오지 않았습니다.");
    return { returnedToCanvas: true };
  });

  await check("settings-controls-focus-and-persistence", () => {
    const opener = root.querySelector("#btn-settings");
    opener.click();
    const overlay = root.querySelector("#settings-overlay");
    assert(!overlay.classList.contains("hidden"), "settings가 열리지 않았습니다.");
    const slider = root.querySelector("#audio-sfx-volume");
    slider.value = "37";
    slider.dispatchEvent(new root.defaultView.Event("input", { bubbles: true }));
    assert(app.audioSystem.getBusSettings("sfx").volume === 37, "settings가 AudioSystem에 반영되지 않았습니다.");
    press(root, "Escape");
    assert(root.activeElement === opener, "settings Escape 뒤 opener로 focus가 돌아오지 않았습니다.");
    return { sfxVolume: 37 };
  });

  await check("viewport-no-horizontal-scroll-and-credits-available", () => {
    assert(root.documentElement.scrollWidth <= root.defaultView.innerWidth, "가로 page scroll이 발생했습니다.");
    const credits = root.querySelector("#btn-credits");
    assert(credits && !credits.disabled, "Credits가 항상 접근 가능하지 않습니다.");
    return { scrollWidth: root.documentElement.scrollWidth, viewportWidth: root.defaultView.innerWidth };
  });

  const passed = results.filter((result) => result.status === "PASS").length;
  const report = freezeDeep({ status: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results });
  root.body.dataset.managementUiQa = report.status.toLowerCase();
  root.body.dataset.managementUiQaPassed = String(report.passed);
  root.body.dataset.managementUiQaTotal = String(report.total);
  root.body.dataset.managementUiQaFailures = results
    .filter((result) => result.status === "FAIL")
    .map((result) => `${result.id}:${result.error}`)
    .join("|");
  return report;
}
