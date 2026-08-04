import { freezeDeep } from "../core/result.js";

const EXPECTED_CONTAINERS = Object.freeze([
  "tileGround", "tileBelow", "shadow", "entity", "above", "overlay", "vfx", "worldHud",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function domainDigest(app) {
  const snapshot = app.store.getSnapshot();
  return JSON.stringify({
    revision: app.store.revision,
    rng: snapshot.rng,
    scheduler: app.scheduler.snapshot(),
  });
}

export async function runPixiRendererBrowserProbe({ root, app }) {
  const results = [];
  const check = async (id, execute) => {
    try {
      results.push({ id, status: "PASS", details: await execute() });
    } catch (error) {
      results.push({ id, status: "FAIL", error: error instanceof Error ? error.message : String(error) });
    }
  };
  const renderer = app.scene._renderer;

  await check("renderer-ready-canvas-contract", () => {
    assert(renderer.ready, "renderer가 ready가 아닙니다.");
    assert(app.scene.canvas.width === 480 && app.scene.canvas.height === 480, "logical canvas가 480x480이 아닙니다.");
    return { width: app.scene.canvas.width, height: app.scene.canvas.height };
  });

  let readyTexturePaths = [];
  await check("container-order-and-nearest", () => {
    const order = renderer._app.stage.children.map((child) => child.label);
    assert(JSON.stringify(order) === JSON.stringify(EXPECTED_CONTAINERS), `container 순서가 다릅니다: ${order}`);
    assert([...renderer._textures.values()].every((texture) => texture.source.scaleMode === "nearest"), "nearest가 아닌 texture가 있습니다.");
    readyTexturePaths = [...renderer._textures.keys()];
    return { order, readyTextureCount: readyTexturePaths.length };
  });
  // Task 44 texture-ready evidence: destroy 체크가 뒤에서 _textures를 비우기 전에, 실제로
  // Pixi texture로 로드 완료된 publicPath 목록을 DOM에 남겨 tools/capture-texture-readiness.mjs가
  // release-gate readyAssetIds로 소비할 수 있게 한다.
  root.body.dataset.pixiRendererReadyPaths = JSON.stringify(readyTexturePaths);

  await check("render-permutation-domain-neutral", () => {
    const before = domainDigest(app);
    const common = {
      camera: { origin: { x: 0, y: 0 } },
      player: { x: 100, y: 100, dir: "down", moving: false },
      animationFrame: 0,
      vfxEvents: [],
      simulationTimeMs: app.scheduler.simulationTimeMs,
    };
    const guests = [
      { guestId: "qa.b", archetypeId: "guest.dwarf_courier", x: 120, y: 140, direction: "DOWN", moving: false },
      { guestId: "qa.a", archetypeId: "guest.human_adventurer", x: 100, y: 140, direction: "DOWN", moving: false },
    ];
    renderer.render({ ...common, guests });
    const firstOrder = renderer._containers.entity.children.map((child) => child.label);
    renderer.render({ ...common, guests: [...guests].reverse() });
    const secondOrder = renderer._containers.entity.children.map((child) => child.label);
    assert(JSON.stringify(firstOrder) === JSON.stringify(secondOrder), "entity input 순열이 draw order를 바꿨습니다.");
    assert(renderer._containers.entity.children.every((child) => Number.isInteger(child.x) && Number.isInteger(child.y)), "entity 표시 좌표가 정수가 아닙니다.");
    assert(domainDigest(app) === before, "renderer가 domain digest를 바꿨습니다.");
    return { order: secondOrder };
  });

  await check("resize-and-idempotent-destroy", () => {
    const before = domainDigest(app);
    assert(app.scene.resize() === true, "resize가 실패했습니다.");
    assert(app.scene.canvas.width === 480 && app.scene.canvas.height === 480, "resize가 logical size를 바꿨습니다.");
    app.hub.stop({ deactivate: true });
    app.scene.destroy();
    app.scene.destroy();
    assert(renderer.ready === false && renderer._resourceOwner.destroyed === true, "destroy 상태가 남았습니다.");
    assert(domainDigest(app) === before, "destroy가 domain digest를 바꿨습니다.");
    return { destroyed: true };
  });

  const passed = results.filter((result) => result.status === "PASS").length;
  const report = freezeDeep({ status: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results });
  root.body.dataset.pixiRendererQa = report.status.toLowerCase();
  root.body.dataset.pixiRendererQaPassed = String(report.passed);
  root.body.dataset.pixiRendererQaTotal = String(report.total);
  return report;
}
