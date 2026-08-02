#!/usr/bin/env node
const ROUTES = Object.freeze({
  "pixi-renderer": Object.freeze({
    markerExpression: "document.body?.dataset?.pixiRendererQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.pixiRendererQa ?? null,
      passed: document.body?.dataset?.pixiRendererQaPassed ?? null,
      total: document.body?.dataset?.pixiRendererQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null
    })`,
    assert(state) {
      return state.marker === "pass" && state.passed === "4" && state.total === "4" && state.moduleBoot === "ready";
    },
  }),
  "management-ui": Object.freeze({
    markerExpression: "document.body?.dataset?.managementUiQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.managementUiQa ?? null,
      passed: document.body?.dataset?.managementUiQaPassed ?? null,
      total: document.body?.dataset?.managementUiQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null
    })`,
    assert(state) {
      return state.marker === "pass" && state.passed === "6" && state.total === "6" && state.moduleBoot === "ready";
    },
  }),
  "day-loop": Object.freeze({
    markerExpression: "document.body?.dataset?.dayLoopQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.dayLoopQa ?? null,
      passed: document.body?.dataset?.dayLoopQaPassed ?? null,
      total: document.body?.dataset?.dayLoopQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      runtimePhase: document.documentElement.dataset.dayLoopPhase ?? null,
      validationAttempts: document.documentElement.dataset.dayLoopStartValidationAttempts ?? null,
      reportText: document.querySelector("#day-loop-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "2" &&
        state.total === "2" &&
        state.moduleBoot === "ready" &&
        state.runtimePhase === "PLANNING" &&
        state.validationAttempts === "1";
    },
  }),
  "timer-system": Object.freeze({
    markerExpression: "document.body?.dataset?.timerSystemQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.timerSystemQa ?? null,
      passed: document.body?.dataset?.timerSystemQaPassed ?? null,
      total: document.body?.dataset?.timerSystemQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "2" &&
        state.total === "2" &&
        state.moduleBoot === "ready";
    },
  }),
  "one-day": Object.freeze({
    markerExpression: "document.body?.dataset?.oneDayQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.oneDayQa ?? null,
      passed: document.body?.dataset?.oneDayQaPassed ?? null,
      total: document.body?.dataset?.oneDayQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      runtimePhase: document.documentElement.dataset.oneDayPhase ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "2" &&
        state.total === "2" &&
        state.moduleBoot === "ready" &&
        state.runtimePhase === "SETTLEMENT";
    },
  }),
  "bootstrap-features": Object.freeze({
    markerExpression: "document.body?.dataset?.bootstrapFeatureQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.bootstrapFeatureQa ?? null,
      passed: document.body?.dataset?.bootstrapFeatureQaPassed ?? null,
      total: document.body?.dataset?.bootstrapFeatureQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      bootStatus: document.documentElement.dataset.bootStatus ?? null,
      bootStage: document.documentElement.dataset.bootStage ?? null,
      buildId: document.documentElement.dataset.buildId ?? null,
      campaignStart: document.documentElement.dataset.campaignStart ?? null,
      faultInjection: document.documentElement.dataset.bootFaultInjection ?? null,
      featureFlagsEnabled: document.documentElement.dataset.featureFlagsEnabled ?? null,
      phaseBgm: document.documentElement.dataset.phaseBgm ?? null,
      extendedAudio: document.documentElement.dataset.extendedAudio ?? null,
      errorVisible: !document.querySelector("#screen-error")?.classList.contains("hidden"),
      creditsEntries: document.querySelectorAll("#credits-list .credit-entry").length,
      reportText: document.querySelector("#bootstrap-feature-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "10" &&
        state.total === "10" &&
        state.moduleBoot === "ready" &&
        state.bootStatus === "ready" &&
        state.bootStage === "STORE" &&
        typeof state.buildId === "string" && state.buildId.length > 0 &&
        state.campaignStart === "blocked" &&
        state.faultInjection === "data" &&
        state.featureFlagsEnabled === "0" &&
        state.phaseBgm === "false" &&
        state.extendedAudio === "false" &&
        state.errorVisible === true &&
        state.creditsEntries >= 2;
    },
  }),
  "map-validation": Object.freeze({
    markerExpression: "document.body?.dataset?.mapValidationQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.mapValidationQa ?? null,
      passed: document.body?.dataset?.mapValidationQaPassed ?? null,
      total: document.body?.dataset?.mapValidationQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      bootStatus: document.documentElement.dataset.bootStatus ?? null,
      bootStage: document.documentElement.dataset.bootStage ?? null,
      mapStageStatus: document.documentElement.dataset.mapStageStatus ?? null,
      mapStageCode: document.documentElement.dataset.mapStageCode ?? null,
      activeMapValidity: document.documentElement.dataset.activeMapValidity ?? null,
      mapFaultInjection: document.documentElement.dataset.mapFaultInjection ?? null,
      campaignStart: document.documentElement.dataset.campaignStart ?? null,
      errorVisible: !document.querySelector("#screen-error")?.classList.contains("hidden"),
      creditsEntries: document.querySelectorAll("#credits-list .credit-entry").length,
      reportText: document.querySelector("#map-validation-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "12" &&
        state.total === "12" &&
        state.moduleBoot === "ready" &&
        state.bootStatus === "ready" &&
        state.bootStage === "STORE" &&
        state.mapStageStatus === "pass" &&
        state.mapStageCode === "MAP_READY" &&
        state.activeMapValidity === "ACTIVE_MAP_VALID" &&
        state.mapFaultInjection === "base" &&
        state.campaignStart === "blocked" &&
        state.errorVisible === true &&
        state.creditsEntries >= 2;
    },
  }),
  "player-world": Object.freeze({
    markerExpression: "document.body?.dataset?.playerWorldQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.playerWorldQa ?? null,
      passed: document.body?.dataset?.playerWorldQaPassed ?? null,
      total: document.body?.dataset?.playerWorldQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      runtimeMapId: document.documentElement.dataset.runtimeMapId ?? null,
      playerCollision: document.documentElement.dataset.playerCollision ?? null,
      playerStartMilliPx: document.documentElement.dataset.playerStartMilliPx ?? null,
      reportText: document.querySelector("#player-world-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "11" &&
        state.total === "11" &&
        state.moduleBoot === "ready" &&
        state.runtimeMapId === "map.base_restaurant" &&
        state.playerCollision === "20x12" &&
        state.playerStartMilliPx === "112000,504000";
    },
  }),
  "camera-input": Object.freeze({
    markerExpression: "document.body?.dataset?.cameraInputQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.cameraInputQa ?? null,
      passed: document.body?.dataset?.cameraInputQaPassed ?? null,
      total: document.body?.dataset?.cameraInputQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      runtimeMapId: document.documentElement.dataset.runtimeMapId ?? null,
      cameraOrigin: document.documentElement.dataset.runtimeCameraOrigin ?? null,
      inputTransform: document.documentElement.dataset.inputTransform ?? null,
      reportText: document.querySelector("#camera-input-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "14" &&
        state.total === "14" &&
        state.moduleBoot === "ready" &&
        state.runtimeMapId === "map.base_restaurant" &&
        state.cameraOrigin === "0,160" &&
        state.inputTransform === "client-rect-480-camera-world";
    },
  }),
  "world-interaction": Object.freeze({
    markerExpression: "document.body?.dataset?.worldInteractionQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.worldInteractionQa ?? null,
      passed: document.body?.dataset?.worldInteractionQaPassed ?? null,
      total: document.body?.dataset?.worldInteractionQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      runtimeMapId: document.documentElement.dataset.runtimeMapId ?? null,
      ordering: document.documentElement.dataset.worldInteractionOrdering ?? null,
      authoredTargets: document.documentElement.dataset.worldInteractionAuthoredTargets ?? null,
      reportText: document.querySelector("#world-interaction-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "18" &&
        state.total === "18" &&
        state.moduleBoot === "ready" &&
        state.runtimeMapId === "map.base_restaurant" &&
        state.ordering === "world-distance-priority-entity-id" &&
        state.authoredTargets === "6";
    },
  }),
  "data-validation": Object.freeze({
    markerExpression: "document.body?.dataset?.dataValidationQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.dataValidationQa ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      campaignStart: document.documentElement.dataset.campaignStart ?? null,
      validationErrors: document.documentElement.dataset.validationErrors ?? null,
      errorVisible: !document.querySelector("#screen-error")?.classList.contains("hidden"),
      creditsEntries: document.querySelectorAll("#credits-list .credit-entry").length,
      reportText: document.querySelector("#data-validation-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.moduleBoot === "ready" &&
        state.campaignStart === "blocked" &&
        state.errorVisible === true &&
        state.creditsEntries >= 2;
    },
  }),
  "prototype-baseline": Object.freeze({
    markerExpression: "document.body?.dataset?.prototypeQa ?? null",
    stateExpression: `({
      marker: document.body?.dataset?.prototypeQa ?? null,
      passed: document.body?.dataset?.prototypeQaPassed ?? null,
      total: document.body?.dataset?.prototypeQaTotal ?? null,
      moduleBoot: document.documentElement.dataset.moduleBoot ?? null,
      reportText: document.querySelector("#prototype-qa-report")?.textContent?.trim() ?? null
    })`,
    assert(state) {
      return state.marker === "pass" &&
        state.passed === "10" &&
        state.total === "10" &&
        state.moduleBoot === "ready";
    },
  }),
});

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const routeName = argument("--route", null);
const port = Number(argument("--port", "9333"));
const baseUrl = argument("--base-url", "http://127.0.0.1:8765/");
const timeoutMs = Number(argument("--timeout-ms", "15000"));
const route = ROUTES[routeName];
if (!route) {
  console.error(`--route는 다음 중 하나여야 합니다: ${Object.keys(ROUTES).join(", ")}`);
  process.exit(2);
}
if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  console.error("--port와 --timeout-ms는 양의 정수여야 합니다.");
  process.exit(2);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function findPageTarget() {
  const endpoint = `http://127.0.0.1:${port}/json`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(endpoint)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      // Chrome may still be opening its DevTools endpoint.
    }
    await sleep(100);
  }
  throw new Error(`DevTools page target을 ${timeoutMs}ms 안에 찾지 못했습니다: ${endpoint}`);
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("open", () => {
      let nextId = 1;
      const pending = new Map();
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;
        const operation = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) operation.reject(new Error(message.error.message));
        else operation.resolve(message.result);
      });
      resolve({
        socket,
        call(method, params = {}) {
          return new Promise((operationResolve, operationReject) => {
            const id = nextId;
            nextId += 1;
            pending.set(id, { resolve: operationResolve, reject: operationReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
      });
    }, { once: true });
  });
}

async function evaluate(call, expression) {
  const response = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "Browser evaluation failed");
  }
  return response.result.value;
}

const target = await findPageTarget();
const connection = await connect(target.webSocketDebuggerUrl);
try {
  const url = new URL(baseUrl);
  url.searchParams.set("qa", routeName);
  await connection.call("Page.navigate", { url: url.href });

  const deadline = Date.now() + timeoutMs;
  let marker = null;
  while (Date.now() < deadline) {
    try {
      marker = await evaluate(connection.call, route.markerExpression);
      if (marker) break;
    } catch {
      // Navigation can briefly destroy the execution context.
    }
    await sleep(100);
  }

  const state = await evaluate(connection.call, route.stateExpression);
  console.log(JSON.stringify({ route: routeName, url: url.href, state }, null, 2));
  if (!route.assert(state)) process.exitCode = 1;
} finally {
  connection.socket.close();
}
