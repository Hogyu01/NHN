import {
  CANVAS_LOGICAL_SIZE,
  PLAYER_SPRITE_CONTRACT,
} from "../ui/canvas-scene.js";
import {
  PROTOTYPE_WORLD_CONTRACT,
  PROTOTYPE_ZONES,
} from "../ui/prototype-hub-adapter.js";

const QA_ID = "prototype-baseline";
const EXPECTED_ZONE_IDS = Object.freeze(["board", "stove", "counter"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function runCase(id, description, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      description,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function dispatchKey(root, type, key) {
  root.defaultView.dispatchEvent(
    new KeyboardEvent(type, { key, bubbles: true, cancelable: true }),
  );
}

function sameOrderedValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function renderReport(root, report) {
  root.querySelector("#prototype-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "prototype-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");

  const heading = root.createElement("h2");
  heading.textContent = `Prototype baseline: ${report.status}`;
  section.append(heading);

  const summary = root.createElement("p");
  summary.textContent = `${report.passed}/${report.total} 검사 통과`;
  section.append(summary);

  const list = root.createElement("ol");
  for (const result of report.results) {
    const item = root.createElement("li");
    item.className = result.status === "PASS" ? "qa-pass" : "qa-fail";
    item.textContent = `${result.status === "PASS" ? "PASS" : "FAIL"} — ${result.description}`;
    if (result.error) {
      const error = root.createElement("pre");
      error.textContent = result.error;
      item.append(error);
    }
    list.append(item);
  }
  section.append(list);
  root.body.append(section);

  root.body.dataset.prototypeQa = report.status.toLowerCase();
  root.body.dataset.prototypeQaPassed = String(report.passed);
  root.body.dataset.prototypeQaTotal = String(report.total);
  root.dispatchEvent(new CustomEvent("prototype:qa-complete", { detail: report }));

  console.group(`QA: ${QA_ID} — ${report.status}`);
  console.table(report.results);
  console.groupEnd();
}

export async function runPrototypeRegression({ root = document, scene, hub }) {
  hub.stop();
  hub.activate();
  hub.reset();

  const cases = [
    runCase("core-atomic-invariants", "CommandBus 원자성·rollback·duplicate·effect 격리 probe가 통과한다", async () => {
      const { runCoreInvariantProbe } = await import("./core-invariant-probe.js");
      const report = await runCoreInvariantProbe();
      assert(
        report.status === "PASS",
        report.results
          .filter((result) => result.status === "FAIL")
          .map((result) => `${result.id}: ${result.error}`)
          .join("\n"),
      );
      return report;
    }),

    runCase("deterministic-core-primitives", "ID·fixed clock·scheduler·RNG production probe가 통과한다", async () => {
      const { runDeterministicCoreProbe } = await import("./deterministic-core-probe.js");
      const report = runDeterministicCoreProbe();
      assert(
        report.status === "PASS",
        report.results
          .filter((result) => result.status === "FAIL")
          .map((result) => `${result.id}: ${result.error}`)
          .join("\n"),
      );
      return report;
    }),

    runCase("module-entry", "전역 스크립트 없이 ES module entry가 boot된다", () => {
      const mainScripts = [...root.querySelectorAll("script[src]")].filter((script) =>
        new URL(script.src, root.baseURI).pathname.endsWith("/js/main.js"),
      );
      assert(mainScripts.length === 1, "js/main.js entry는 정확히 하나여야 합니다.");
      assert(mainScripts[0].type === "module", "js/main.js entry의 type은 module이어야 합니다.");
      assert(root.documentElement.dataset.moduleBoot === "ready", "module boot 상태가 ready가 아닙니다.");
      return { type: mainScripts[0].type, boot: root.documentElement.dataset.moduleBoot };
    }),

    runCase("canvas-logical-size", "Canvas logical size가 480×480이다", () => {
      assert(scene.canvas.width === CANVAS_LOGICAL_SIZE.width, "Canvas logical width가 480이 아닙니다.");
      assert(scene.canvas.height === CANVAS_LOGICAL_SIZE.height, "Canvas logical height가 480이 아닙니다.");
      return { width: scene.canvas.width, height: scene.canvas.height };
    }),

    runCase("prototype-map-contract", "15×15 prototype과 세 semantic zone만 유지한다", () => {
      assert(PROTOTYPE_WORLD_CONTRACT.widthTiles === 15, "prototype width가 15 tiles가 아닙니다.");
      assert(PROTOTYPE_WORLD_CONTRACT.heightTiles === 15, "prototype height가 15 tiles가 아닙니다.");
      assert(
        PROTOTYPE_WORLD_CONTRACT.widthTiles * PROTOTYPE_WORLD_CONTRACT.tileSize === 480 &&
          PROTOTYPE_WORLD_CONTRACT.heightTiles * PROTOTYPE_WORLD_CONTRACT.tileSize === 480,
        "prototype tile geometry가 480×480과 일치하지 않습니다.",
      );
      const zoneIds = PROTOTYPE_ZONES.map((zone) => zone.id);
      assert(sameOrderedValues(zoneIds, EXPECTED_ZONE_IDS), "semantic zone은 board/stove/counter 순서여야 합니다.");
      assert(!zoneIds.includes("storage"), "Task 1에서 storage zone을 도입하면 안 됩니다.");
      return { tileSize: 32, dimensions: "15x15", zoneIds };
    }),

    runCase("sprite-contract", "L0 sprite dimensions와 frame order가 계약과 일치한다", async () => {
      const metadata = await withTimeout(
        scene.loadSprite(),
        5000,
        "플레이어 스프라이트 load가 5초 안에 끝나지 않았습니다.",
      );
      assert(PLAYER_SPRITE_CONTRACT.maturity === "L0_Placeholder", "기존 sprite는 L0_Placeholder여야 합니다.");
      assert(PLAYER_SPRITE_CONTRACT.frameWidth === 64 && PLAYER_SPRITE_CONTRACT.frameHeight === 64, "frame은 64×64여야 합니다.");
      assert(PLAYER_SPRITE_CONTRACT.columns === 9 && PLAYER_SPRITE_CONTRACT.rows === 4, "sheet는 9 columns×4 rows여야 합니다.");
      assert(metadata.width === 64 * 9 && metadata.height === 64 * 4, "PNG dimensions가 576×256이 아닙니다.");
      assert(
        sameOrderedValues(PLAYER_SPRITE_CONTRACT.directionOrder, ["up", "left", "down", "right"]),
        "direction row order가 up/left/down/right가 아닙니다.",
      );
      assert(PLAYER_SPRITE_CONTRACT.idleColumn === 0, "idle column은 0이어야 합니다.");
      assert(
        sameOrderedValues(PLAYER_SPRITE_CONTRACT.walkColumns, [1, 2, 3, 4, 5, 6, 7, 8]),
        "walk columns는 1..8이어야 합니다.",
      );
      return { ...metadata, contract: "64x64, 9x4, U/L/D/R, idle 0, walk 1..8", maturity: "L0_Placeholder" };
    }),

    runCase("movement-input", "WASD와 방향키가 각각 World 방향 이동을 만든다", () => {
      const checks = [
        ["w", "y", -1],
        ["ArrowUp", "y", -1],
        ["a", "x", -1],
        ["ArrowLeft", "x", -1],
        ["s", "y", 1],
        ["ArrowDown", "y", 1],
        ["d", "x", 1],
        ["ArrowRight", "x", 1],
      ];
      const observed = [];
      for (const [key, axis, sign] of checks) {
        hub.reset();
        hub.setPlayerPosition(240, 240);
        const before = hub.getState().player;
        dispatchKey(root, "keydown", key);
        hub.step(16);
        dispatchKey(root, "keyup", key);
        const after = hub.getState().player;
        assert((after[axis] - before[axis]) * sign > 0, `${key}가 ${axis}축의 예상 방향으로 이동하지 않았습니다.`);
        observed.push({ key, x: after.x, y: after.y, dir: after.dir });
      }
      return observed;
    }),

    runCase("world-boundary-collision", "20×12 foot AABB가 prototype World 경계를 통과하지 않는다", () => {
      const player = hub.getState().player;
      const halfWidth = player.collisionWidth / 2;
      const halfHeight = player.collisionHeight / 2;
      const checks = [
        [halfWidth, 240, "ArrowLeft", "x", halfWidth],
        [480 - halfWidth, 240, "ArrowRight", "x", 480 - halfWidth],
        [240, halfHeight, "ArrowUp", "y", halfHeight],
        [240, 480 - halfHeight, "ArrowDown", "y", 480 - halfHeight],
      ];
      for (const [x, y, key, axis, expected] of checks) {
        hub.reset();
        hub.setPlayerPosition(x, y);
        dispatchKey(root, "keydown", key);
        hub.step(20);
        dispatchKey(root, "keyup", key);
        assert(hub.getState().player[axis] === expected, `${key} 입력이 World 경계를 통과했습니다.`);
      }
      return { collision: "20x12", xBounds: [halfWidth, 480 - halfWidth], yBounds: [halfHeight, 480 - halfHeight] };
    }),

    runCase("panel-input-suppression", "semantic panel이 열려 있는 동안 movement input을 처리하지 않는다", () => {
      const board = PROTOTYPE_ZONES.find((zone) => zone.id === "board");
      hub.reset();
      hub.setPlayerPosition(board.x + board.w / 2, board.y + board.h / 2);
      hub.step(0);
      const before = hub.getState().player;
      assert(hub.getState().panelOpen, "board 진입 시 panel이 열리지 않았습니다.");
      dispatchKey(root, "keydown", "d");
      hub.step(16);
      dispatchKey(root, "keyup", "d");
      const after = hub.getState().player;
      assert(after.x === before.x && after.y === before.y, "panel open 중 Player가 이동했습니다.");
      return { zoneId: "board", position: { x: after.x, y: after.y } };
    }),

    runCase("semantic-zone-reentry", "board/stove/counter가 닫기→이탈→재진입 때 다시 열린다", () => {
      const observed = [];
      for (const zone of PROTOTYPE_ZONES) {
        hub.reset();
        hub.setPlayerPosition(240, 240);
        hub.step(0);
        hub.setPlayerPosition(zone.x + zone.w / 2, zone.y + zone.h / 2);
        hub.step(0);
        let state = hub.getState();
        assert(state.panelOpen && state.activePanelZoneId === zone.id, `${zone.id} 최초 진입 panel이 열리지 않았습니다.`);
        assert(root.querySelector("#panel-title").textContent === zone.label, `${zone.id} panel 의미 label이 다릅니다.`);

        hub.closePanel({ returnFocus: false });
        hub.step(0);
        state = hub.getState();
        assert(!state.panelOpen, `${zone.id} 내부에서 닫은 panel이 즉시 재개방되었습니다.`);

        hub.setPlayerPosition(240, 240);
        hub.step(0);
        assert(hub.getState().currentZoneId === null, `${zone.id} 이탈이 기록되지 않았습니다.`);

        hub.setPlayerPosition(zone.x + zone.w / 2, zone.y + zone.h / 2);
        hub.step(0);
        state = hub.getState();
        assert(state.panelOpen && state.activePanelZoneId === zone.id, `${zone.id} 재진입 panel이 열리지 않았습니다.`);
        observed.push(zone.id);
      }
      return { reopened: observed };
    }),
  ];

  const results = await Promise.all(cases);
  const passed = results.filter((result) => result.status === "PASS").length;
  const report = Object.freeze({
    qaId: QA_ID,
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });

  renderReport(root, report);
  return report;
}
