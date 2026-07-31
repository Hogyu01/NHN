import { freezeDeep } from "../core/result.js";
import {
  CAMERA_VIEWPORT_SIZE,
  cameraAxis,
  deriveCameraTransform,
} from "../world/camera.js";
import {
  createPlayerCollisionGeometry,
  isPlayerFootFixedPassable,
} from "../world/collision.js";
import {
  clientToWorld,
  INPUT_TRANSFORM_CODE,
  worldToClient,
} from "../world/input-transform.js";

const QA_ID = "camera-input";
const ROUND_TRIP_TOLERANCE = 1e-9;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNear(actual, expected, message, tolerance = ROUND_TRIP_TOLERANCE) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected=${expected}, actual=${actual}`);
  }
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runCases(specifications) {
  const results = [];
  for (const specification of specifications) results.push(await runCase(...specification));
  return results;
}

function smallMap(width, height, mapId = `map.qa.small.${width}x${height}`) {
  return freezeDeep({ schemaVersion: 1, mapId, width, height, tileSize: 32 });
}

function semanticAtWorldPoint(mapDefinition, point) {
  return (mapDefinition.zones ?? []).find((zone) =>
    point.x >= zone.rect.x && point.x <= zone.rect.x + zone.rect.width &&
    point.y >= zone.rect.y && point.y <= zone.rect.y + zone.rect.height
  )?.semantic ?? null;
}

function collisionAtWorldPoint(mapDefinition, point) {
  const tileX = Math.floor(point.x / mapDefinition.tileSize);
  const tileY = Math.floor(point.y / mapDefinition.tileSize);
  if (tileX < 0 || tileY < 0 || tileX >= mapDefinition.width || tileY >= mapDefinition.height) {
    return "VOID";
  }
  return mapDefinition.layers.collision[tileY * mapDefinition.width + tileX];
}

function assertRoundTrip(worldPoint, rect, camera) {
  const outbound = worldToClient(worldPoint.x, worldPoint.y, rect, camera);
  assert(outbound.ok, `World→client 변환 실패: ${outbound.code}`);
  const inbound = clientToWorld(outbound.client.x, outbound.client.y, rect, camera);
  assert(inbound.ok, `client→World 변환 실패: ${inbound.code}`);
  assertNear(inbound.world.x, worldPoint.x, "World X round-trip 오차");
  assertNear(inbound.world.y, worldPoint.y, "World Y round-trip 오차");
  return { client: outbound.client, viewport: inbound.viewport, world: inbound.world };
}

function findPassableBottomRight(mapDefinition) {
  const geometry = createPlayerCollisionGeometry(mapDefinition);
  for (let tileY = mapDefinition.height - 2; tileY >= 1; tileY -= 1) {
    for (let tileX = mapDefinition.width - 2; tileX >= 1; tileX -= 1) {
      const point = { x: tileX * 32 + 16, y: tileY * 32 + 16 };
      if (isPlayerFootFixedPassable(geometry, { x: point.x * 1_000, y: point.y * 1_000 })) {
        return point;
      }
    }
  }
  throw new Error("Base Map에서 bottom-right passable Player foot를 찾지 못했습니다.");
}

/**
 * Task 11 examples and deterministic invariant sweep over production Camera/Input code.
 * Property 21: Camera and CSS input round-trip.
 * **Validates: Requirements 18.1, 18.2, 18.10, 21.8, 29.1, 29.4, 31.3, 31.5, 31.6, 33.10, 33.11, 33.12**
 */
export async function runCameraInputProbe({ baseMap }) {
  if (!baseMap || baseMap.mapId !== "map.base_restaurant") {
    throw new TypeError("Camera/Input probe에는 canonical Base Map이 필요합니다.");
  }

  const results = await runCases([
    [
      "base-four-corner-clamp",
      "Base 네 corner target은 960×640 Map 경계 안의 (0..480, 0..160) origin으로 clamp된다",
      "Requirements 33.10, 33.12",
      () => {
        const cases = [
          [{ x: 0, y: 0 }, { x: 0, y: 0 }],
          [{ x: 960, y: 0 }, { x: 480, y: 0 }],
          [{ x: 0, y: 640 }, { x: 0, y: 160 }],
          [{ x: 960, y: 640 }, { x: 480, y: 160 }],
        ];
        const origins = cases.map(([target, expected]) => {
          const camera = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: target });
          assert(camera.origin.x === expected.x && camera.origin.y === expected.y, `corner ${JSON.stringify(target)} clamp가 다릅니다.`);
          return camera.origin;
        });
        return { worldSize: { width: 960, height: 640 }, origins };
      },
    ],
    [
      "dead-zone-free-integer-origin",
      "Player foot center가 1px 이동하면 unclamped camera origin도 즉시 1px 이동하고 origin은 정수다",
      "Requirements 33.10",
      () => {
        const first = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: { x: 480, y: 320 } });
        const second = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: { x: 481, y: 321 } });
        assert(first.origin.x === 240 && first.origin.y === 80, "Base center camera origin이 다릅니다.");
        assert(second.origin.x === 241 && second.origin.y === 81, "dead-zone 없는 camera 추적이 아닙니다.");
        assert(Number.isSafeInteger(second.origin.x) && Number.isSafeInteger(second.origin.y), "camera origin이 정수가 아닙니다.");
        assert(cameraAxis(480.49, 960) === 240 && cameraAxis(480.51, 960) === 241, "cameraAxis Math.round 경계가 다릅니다.");
        return { first: first.origin, second: second.origin };
      },
    ],
    [
      "small-map-letterbox-center",
      "480보다 작은 Map은 양축 음수 origin으로 viewport 중앙에 letterbox 배치된다",
      "Requirements 33.10, 33.12",
      () => {
        const camera = deriveCameraTransform({
          mapDefinition: smallMap(10, 8),
          playerFootLogicalPx: { x: 16, y: 16 },
        });
        assert(camera.origin.x === -80 && camera.origin.y === -112, `small Map origin=${JSON.stringify(camera.origin)}`);
        assert(camera.smallMapCentered.x && camera.smallMapCentered.y, "small Map centered 축 표시가 다릅니다.");
        return { origin: camera.origin, worldSize: camera.worldSize };
      },
    ],
    [
      "mixed-axis-center-and-clamp",
      "한 축만 작은 Map은 그 축만 중앙 정렬하고 큰 축은 Player center를 clamp한다",
      "Requirements 33.10, 33.12",
      () => {
        const camera = deriveCameraTransform({
          mapDefinition: smallMap(10, 20, "map.qa.mixed-axis"),
          playerFootLogicalPx: { x: 300, y: 500 },
        });
        assert(camera.origin.x === -80, "작은 X축이 중앙 정렬되지 않았습니다.");
        assert(camera.origin.y === 160, "큰 Y축이 max origin으로 clamp되지 않았습니다.");
        assert(camera.smallMapCentered.x && !camera.smallMapCentered.y, "축별 small Map 표시가 다릅니다.");
        return { origin: camera.origin, centered: camera.smallMapCentered };
      },
    ],
    [
      "css-shrink-expand-invariance",
      "CSS Canvas 축소·확대에서도 같은 World point가 동일하게 복원된다",
      "Requirements 21.8, 33.11, 33.12",
      () => {
        const camera = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: { x: 480, y: 320 } });
        const worldPoint = { x: 512.25, y: 271.75 };
        const rects = [
          { left: 17, top: 29, width: 240, height: 240 },
          { left: 31.5, top: 43.25, width: 960, height: 960 },
          { left: -20, top: 10, width: 720, height: 360 },
        ];
        return { cases: rects.map((rect) => assertRoundTrip(worldPoint, rect, camera)) };
      },
    ],
    [
      "viewport-edge-transform",
      "Canvas rect 네 edge는 camera origin과 origin+480 World edge로 변환된다",
      "Requirements 21.8, 33.11",
      () => {
        const camera = { origin: { x: 240, y: 80 } };
        const rect = { left: 100, top: 50, width: 600, height: 300 };
        const topLeft = clientToWorld(rect.left, rect.top, rect, camera);
        const bottomRight = clientToWorld(rect.left + rect.width, rect.top + rect.height, rect, camera);
        assert(topLeft.ok && bottomRight.ok, "viewport edge 변환이 실패했습니다.");
        assert(topLeft.world.x === 240 && topLeft.world.y === 80, "top-left World edge가 다릅니다.");
        assert(bottomRight.world.x === 720 && bottomRight.world.y === 560, "bottom-right World edge가 다릅니다.");
        return { topLeft: topLeft.world, bottomRight: bottomRight.world };
      },
    ],
    [
      "zero-canvas-rect-diagnostic",
      "width 또는 height가 0인 Canvas rect는 CANVAS_RECT_EMPTY 진단으로 명시 거절된다",
      "Requirements 21.8, 33.11",
      () => {
        const widthZero = clientToWorld(0, 0, { left: 0, top: 0, width: 0, height: 480 }, { x: 0, y: 0 });
        const heightZero = clientToWorld(0, 0, { left: 0, top: 0, width: 480, height: 0 }, { x: 0, y: 0 });
        for (const result of [widthZero, heightZero]) {
          assert(!result.ok && result.code === INPUT_TRANSFORM_CODE.CANVAS_RECT_EMPTY, "zero rect code가 CANVAS_RECT_EMPTY가 아닙니다.");
          assert(result.diagnostics[0]?.errorType === "CanvasRectError", "zero rect transform diagnostic이 없습니다.");
        }
        return { code: widthZero.code, diagnostic: widthZero.diagnostics[0] };
      },
    ],
    [
      "deterministic-round-trip-sweep",
      "256개 Map/foot/rect/World 조합이 byte-equivalent camera와 tolerance 내 round-trip을 만든다",
      "Requirements 18.10, 21.8, 23.4, 33.10, 33.11, 33.12",
      () => {
        for (let seed = 0; seed < 256; seed += 1) {
          const target = {
            x: ((seed * 73) % 961) + (seed % 4) / 4,
            y: ((seed * 47) % 641) + (seed % 5) / 5,
          };
          const first = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: target });
          const second = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: target });
          assert(JSON.stringify(first) === JSON.stringify(second), `seed ${seed} camera가 결정론적이지 않습니다.`);
          const rect = {
            left: (seed % 17) - 8,
            top: (seed % 13) - 6,
            width: 120 + (seed * 37) % 900,
            height: 120 + (seed * 53) % 700,
          };
          const worldPoint = {
            x: (seed * 97) % 960 + 0.125,
            y: (seed * 61) % 640 + 0.375,
          };
          assertRoundTrip(worldPoint, rect, first);
        }
        return { generatedCases: 256, tolerance: ROUND_TRIP_TOLERANCE };
      },
    ],
    [
      "world-target-and-collision-invariance",
      "camera와 CSS scale이 달라도 같은 World pointer는 같은 semantic target과 collision cell을 선택한다",
      "Requirements 21.8, 31.5, 33.11, 33.12",
      () => {
        const board = baseMap.zones.find((zone) => zone.semantic === "board");
        assert(board, "Base board zone이 없습니다.");
        const worldPoint = {
          x: board.rect.x + board.rect.width / 2,
          y: board.rect.y + board.rect.height / 2,
        };
        const variants = [
          {
            camera: deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: { x: 240, y: 240 } }),
            rect: { left: 0, top: 0, width: 240, height: 240 },
          },
          {
            camera: deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: { x: 320, y: 240 } }),
            rect: { left: 40, top: 20, width: 960, height: 960 },
          },
        ];
        const selections = variants.map(({ camera, rect }) => {
          const roundTrip = assertRoundTrip(worldPoint, rect, camera);
          return {
            semantic: semanticAtWorldPoint(baseMap, roundTrip.world),
            collision: collisionAtWorldPoint(baseMap, roundTrip.world),
          };
        });
        assert(selections.every((selection) => selection.semantic === "board"), "World pointer가 board target을 안정적으로 선택하지 않았습니다.");
        assert(selections.every((selection) => selection.collision === selections[0].collision), "World pointer collision cell이 달라졌습니다.");
        return { worldPoint, selections };
      },
    ],
    [
      "derived-camera-does-not-mutate-world",
      "Camera derivation은 Map/Player source를 변경하거나 camera 필드를 삽입하지 않는다",
      "Requirements 18.2, 18.10, 33.12",
      () => {
        const source = { mapDefinition: baseMap, playerFootLogicalPx: { x: 480, y: 320 } };
        const before = JSON.stringify(source);
        const camera = deriveCameraTransform(source);
        const after = JSON.stringify(source);
        assert(before === after, "Camera derivation이 source World 값을 변경했습니다.");
        assert(!Object.hasOwn(source, "camera") && !Object.hasOwn(source.playerFootLogicalPx, "camera"), "Camera가 source state에 저장됐습니다.");
        return { origin: camera.origin, sourceByteEquivalent: true };
      },
    ],
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    property: "Property 21: Camera and CSS input round-trip",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}

function renderReport(root, report) {
  root.querySelector("#camera-input-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "camera-input-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");
  const heading = root.createElement("h2");
  heading.textContent = `Camera/Input: ${report.status}`;
  const summary = root.createElement("p");
  summary.textContent = `${report.passed}/${report.total} 검사 통과`;
  const list = root.createElement("ol");
  for (const result of report.results) {
    const item = root.createElement("li");
    item.className = result.status === "PASS" ? "qa-pass" : "qa-fail";
    item.textContent = `${result.status} — ${result.description}`;
    if (result.error) {
      const error = root.createElement("pre");
      error.textContent = result.error;
      item.append(error);
    }
    list.append(item);
  }
  section.append(heading, summary, list);
  root.body.append(section);
  root.body.dataset.cameraInputQa = report.status.toLowerCase();
  root.body.dataset.cameraInputQaPassed = String(report.passed);
  root.body.dataset.cameraInputQaTotal = String(report.total);
  root.dispatchEvent(new CustomEvent("camera-input:qa-complete", { detail: report }));
}

/** Browser integration over the production hub, live DOMRect, Canvas pointer listener, and renderer. */
export async function runCameraInputBrowserProbe({ root, hub, baseMap }) {
  hub.stop();
  hub.setMapDefinition(baseMap);
  hub.activate();
  const pure = await runCameraInputProbe({ baseMap });
  const browserResults = await runCases([
    [
      "browser-runtime-camera-wiring",
      "production hub state는 derived camera를 노출하지만 authoritative World snapshot에는 저장하지 않는다",
      "Requirements 18.2, 18.10, 33.10, 33.12",
      () => {
        hub.reset();
        const state = hub.getState();
        const expected = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: state.player });
        assert(JSON.stringify(state.camera.origin) === JSON.stringify(expected.origin), "runtime camera origin이 Player foot에서 파생되지 않았습니다.");
        assert(!Object.hasOwn(hub.getWorldSnapshot(), "camera"), "authoritative World snapshot에 camera가 저장됐습니다.");
        return { origin: state.camera.origin, worldSnapshotCamera: false };
      },
    ],
    [
      "browser-live-css-pointer-round-trip",
      "실제 Canvas DOMRect를 240px/600px로 바꿔도 pointer listener가 같은 World point를 발행한다",
      "Requirements 21.8, 33.11, 33.12",
      () => {
        hub.reset();
        const canvas = hub.scene.canvas;
        const previousStyle = canvas.getAttribute("style");
        const worldPoint = { x: hub.getState().player.x, y: hub.getState().player.y };
        const observations = [];
        try {
          for (const size of [240, 600]) {
            canvas.style.width = `${size}px`;
            canvas.style.height = `${size}px`;
            const outbound = hub.worldToClient(worldPoint.x, worldPoint.y);
            assert(outbound.ok, `live World→client ${size}px 변환 실패: ${outbound.code}`);
            canvas.dispatchEvent(new root.defaultView.MouseEvent("pointermove", {
              bubbles: true,
              clientX: outbound.client.x,
              clientY: outbound.client.y,
            }));
            const observed = hub.getState().inputTransform.lastPointerWorld;
            assert(observed, `${size}px pointer event가 World point를 발행하지 않았습니다.`);
            const browserTolerance = Math.max(
              CAMERA_VIEWPORT_SIZE.width / outbound.rect.width,
              CAMERA_VIEWPORT_SIZE.height / outbound.rect.height,
            ) + Number.EPSILON;
            assertNear(observed.x, worldPoint.x, `${size}px browser World X`, browserTolerance);
            assertNear(observed.y, worldPoint.y, `${size}px browser World Y`, browserTolerance);
            observations.push({ size, observed, browserTolerance });
          }
        } finally {
          if (previousStyle === null) canvas.removeAttribute("style");
          else canvas.setAttribute("style", previousStyle);
        }
        return { worldPoint, observations };
      },
    ],
    [
      "browser-camera-render-clamp",
      "Player를 Base bottom-right passable 위치로 옮기면 render와 input이 max-clamped camera를 공유한다",
      "Requirements 33.9, 33.10, 33.11, 33.12",
      () => {
        const point = findPassableBottomRight(baseMap);
        hub.setPlayerPosition(point.x, point.y);
        const state = hub.getState();
        const expected = deriveCameraTransform({ mapDefinition: baseMap, playerFootLogicalPx: point });
        assert(JSON.stringify(state.camera.origin) === JSON.stringify(expected.origin), "render runtime camera가 max clamp를 공유하지 않습니다.");
        assert(state.camera.origin.x === 480 && state.camera.origin.y === 160, "Base max camera origin이 (480,160)이 아닙니다.");
        const roundTrip = hub.worldToClient(point.x, point.y);
        assert(roundTrip.ok, "max camera World→client 변환이 실패했습니다.");
        const restored = hub.clientToWorld(roundTrip.client.x, roundTrip.client.y);
        assert(restored.ok, "max camera client→World 변환이 실패했습니다.");
        assertNear(restored.world.x, point.x, "max camera World X");
        assertNear(restored.world.y, point.y, "max camera World Y");
        hub.reset();
        return { point, origin: expected.origin };
      },
    ],
    [
      "browser-world-only-pointer-payload",
      "runtime pointer adapter의 downstream event는 client 좌표 없이 World_Coordinate만 전달한다",
      "Requirements 31.5, 33.11, 33.12",
      () => {
        hub.reset();
        const canvas = hub.scene.canvas;
        const worldPoint = { x: hub.getState().player.x, y: hub.getState().player.y };
        const outbound = hub.worldToClient(worldPoint.x, worldPoint.y);
        assert(outbound.ok, "pointer payload fixture 변환이 실패했습니다.");
        let detail = null;
        root.addEventListener("world:pointer-coordinate", (event) => {
          detail = event.detail;
        }, { once: true });
        canvas.dispatchEvent(new root.defaultView.MouseEvent("pointerdown", {
          bubbles: true,
          clientX: outbound.client.x,
          clientY: outbound.client.y,
        }));
        assert(detail?.worldPoint, "World pointer event payload가 없습니다.");
        assert(!Object.hasOwn(detail, "clientX") && !Object.hasOwn(detail, "clientY"), "client 좌표가 downstream payload로 누출됐습니다.");
        const browserTolerance = Math.max(
          CAMERA_VIEWPORT_SIZE.width / outbound.rect.width,
          CAMERA_VIEWPORT_SIZE.height / outbound.rect.height,
        ) + Number.EPSILON;
        assertNear(detail.worldPoint.x, worldPoint.x, "event World X", browserTolerance);
        assertNear(detail.worldPoint.y, worldPoint.y, "event World Y", browserTolerance);
        return { ...detail, browserTolerance };
      },
    ],
  ]);

  const results = Object.freeze([...pure.results, ...browserResults]);
  const passed = results.filter((result) => result.status === "PASS").length;
  const report = Object.freeze({
    qaId: QA_ID,
    property: pure.property,
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
  renderReport(root, report);
  return report;
}
