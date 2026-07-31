import {
  DIAGONAL_NORMALIZER_PPM,
  multiplyDivideTrunc,
} from "../core/fixed-point.js";
import {
  createPlayerCollisionGeometry,
  isPlayerFootFixedPassable,
} from "../world/collision.js";
import {
  PLAYER_DIRECTION,
  PLAYER_MOVEMENT_STEP_MILLI_PX,
  PlayerController,
} from "../world/player-controller.js";

const QA_ID = "player-world";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function navigationPoint(pointId, x, y) {
  return {
    pointId,
    tileX: Math.floor(x / 32),
    tileY: Math.floor(y / 32),
    offsetX: x % 32,
    offsetY: y % 32,
  };
}

function testMap({
  mapId = "map.qa.player",
  width = 8,
  height = 8,
  start = { x: 80, y: 80 },
  collision = null,
  objects = [],
  zones = [],
  expansionRegions = [],
} = {}) {
  const area = width * height;
  return {
    schemaVersion: 1,
    mapId,
    width,
    height,
    tileSize: 32,
    layers: {
      ground: Array(area).fill("tile.qa.floor"),
      collision: collision ?? Array(area).fill(0),
      below: Array(area).fill(null),
      above: Array(area).fill(null),
    },
    objects,
    zones,
    navigation: {
      playerStart: navigationPoint(`${mapId}.player-start`, start.x, start.y),
      spawnPoint: navigationPoint(`${mapId}.spawn`, 48, 48),
      exitPoint: navigationPoint(`${mapId}.exit`, 80, 48),
      approachPoints: [],
      seatPoints: [],
      tableServiceTargets: [],
      transitions: [],
    },
    expansionRegions,
  };
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
  for (const specification of specifications) {
    results.push(await runCase(...specification));
  }
  return results;
}

function hold(controller, ...directions) {
  for (const direction of directions) controller.setDirectionHeld(direction, true);
}

function zoneContactPoints(zone) {
  return Object.freeze({
    outside: Object.freeze({
      x: zone.rect.x + zone.rect.width / 2,
      y: zone.rect.y + zone.rect.height + 7,
    }),
    inside: Object.freeze({
      x: zone.rect.x + zone.rect.width / 2,
      y: zone.rect.y + zone.rect.height + 6,
    }),
  });
}

function generatedMap(seed) {
  let state = (seed + 1) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const width = 8;
  const height = 8;
  const collision = Array.from({ length: width * height }, () => next() % 5 === 0 ? 1 : 0);
  const tileX = 1 + next() % 6;
  const tileY = 1 + next() % 6;
  collision[tileY * width + tileX] = 0;
  const directions = [];
  if (next() & 1) directions.push(PLAYER_DIRECTION.LEFT);
  else directions.push(PLAYER_DIRECTION.RIGHT);
  if (next() & 1) directions.push(PLAYER_DIRECTION.UP);
  else if (next() & 1) directions.push(PLAYER_DIRECTION.DOWN);
  return {
    definition: testMap({
      mapId: `map.qa.generated-player.${String(seed).padStart(3, "0")}`,
      width,
      height,
      start: { x: tileX * 32 + 16, y: tileY * 32 + 16 },
      collision,
    }),
    directions,
    movementStepMilliPx: 1 + next() % 50_000,
  };
}

/**
 * Task 10 unit examples and generated invariant validation over production PlayerController code.
 * Property 22: Player collision and interaction semantics.
 * **Validates: Requirements 1.2, 1.3, 1.4, 11.1, 11.2, 21.4, 33.4, 33.9, 33.12, 34.6**
 */
export async function runPlayerWorldProbe({ baseMap }) {
  if (!baseMap || baseMap.mapId !== "map.base_restaurant") {
    throw new TypeError("Player World probe에는 canonical Base Map이 필요합니다.");
  }

  const results = await runCases([
    [
      "authored-start-and-geometry",
      "Base authored player_start가 20×12 foot AABB와 milli-pixel World snapshot으로 초기화된다",
      "Requirements 33.4, 33.9, 33.12",
      () => {
        const controller = new PlayerController({ mapDefinition: baseMap });
        const snapshot = controller.snapshot();
        const expectedX = (baseMap.navigation.playerStart.tileX * 32 + baseMap.navigation.playerStart.offsetX) * 1_000;
        const expectedY = (baseMap.navigation.playerStart.tileY * 32 + baseMap.navigation.playerStart.offsetY) * 1_000;
        assert(snapshot.player.footMilliPx.x === expectedX && snapshot.player.footMilliPx.y === expectedY, "authored start가 milli-pixel snapshot에 반영되지 않았습니다.");
        assert(snapshot.player.collisionWidth === 20 && snapshot.player.collisionHeight === 12, "Player collision geometry가 20×12가 아닙니다.");
        assert(controller.isCurrentFootPassable(), "Base authored start가 passable하지 않습니다.");
        assert(snapshot.bodyBlocking === false, "Player snapshot이 guest body-block을 선언했습니다.");
        return { mapId: snapshot.mapId, footMilliPx: snapshot.player.footMilliPx, collision: "20x12" };
      },
    ],
    [
      "fixed-point-diagonal-normalization",
      "diagonal 입력은 0.707106 integer normalization과 고정 방향 tie를 사용한다",
      "Requirements 1.2, 33.9, 33.12",
      () => {
        const controller = new PlayerController({ mapDefinition: testMap() });
        const before = controller.snapshot().player.footMilliPx;
        hold(controller, PLAYER_DIRECTION.RIGHT, PLAYER_DIRECTION.DOWN);
        const result = controller.step();
        const expected = multiplyDivideTrunc(
          PLAYER_MOVEMENT_STEP_MILLI_PX,
          DIAGONAL_NORMALIZER_PPM,
          1_000_000,
        );
        assert(result.movement.appliedDeltaMilliPx.x === expected, "diagonal X fixed delta가 다릅니다.");
        assert(result.movement.appliedDeltaMilliPx.y === expected, "diagonal Y fixed delta가 다릅니다.");
        assert(result.snapshot.player.direction === PLAYER_DIRECTION.DOWN, "diagonal 방향 tie가 vertical 우선이 아닙니다.");
        assert(result.snapshot.player.footMilliPx.x === before.x + expected, "diagonal X 위치가 정수 누적되지 않았습니다.");
        return { expectedAxisDeltaMilliPx: expected, footMilliPx: result.snapshot.player.footMilliPx };
      },
    ],
    [
      "x-then-y-corner-sweep",
      "corner collision은 X sweep 뒤 Y sweep으로 해소해 결정론적으로 벽을 따라 미끄러진다",
      "Requirements 33.9, 33.12",
      () => {
        const definition = testMap({
          mapId: "map.qa.corner-sweep",
          start: { x: 40, y: 30 },
          objects: [{
            objectId: "object.corner",
            kind: "WALL",
            rect: { x: 50, y: 40, width: 20, height: 20 },
            blocksMovement: true,
          }],
        });
        const controller = new PlayerController({ mapDefinition: definition, movementStepMilliPx: 20_000 });
        hold(controller, PLAYER_DIRECTION.RIGHT, PLAYER_DIRECTION.DOWN);
        const result = controller.step();
        assert(JSON.stringify(result.movement.sweepOrder) === JSON.stringify(["X", "Y"]), "collision sweep 순서가 X→Y가 아닙니다.");
        assert(result.snapshot.player.footMilliPx.x === 54_142, `corner X=${result.snapshot.player.footMilliPx.x}`);
        assert(result.snapshot.player.footMilliPx.y === 34_000, `corner Y=${result.snapshot.player.footMilliPx.y}`);
        assert(result.movement.collisions.y.includes("object:object.corner"), "corner Y collision ID가 없습니다.");
        return { footMilliPx: result.snapshot.player.footMilliPx, collisions: result.movement.collisions };
      },
    ],
    [
      "static-sweep-no-tunneling-and-world-bounds",
      "큰 fixed delta도 얇은 static blocker와 World 경계를 통과하지 않는다",
      "Requirements 33.9, 33.12",
      () => {
        const blockerMap = testMap({
          mapId: "map.qa.thin-blocker",
          start: { x: 40, y: 80 },
          objects: [{
            objectId: "object.thin",
            kind: "WALL",
            rect: { x: 70, y: 60, width: 2, height: 40 },
            blocksMovement: true,
          }],
        });
        const blockerController = new PlayerController({ mapDefinition: blockerMap, movementStepMilliPx: 50_000 });
        hold(blockerController, PLAYER_DIRECTION.RIGHT);
        const blocked = blockerController.step();
        assert(blocked.snapshot.player.footMilliPx.x === 60_000, "얇은 blocker를 tunneling했습니다.");

        const boundaryController = new PlayerController({
          mapDefinition: testMap({ mapId: "map.qa.boundary", start: { x: 16, y: 16 } }),
          movementStepMilliPx: 50_000,
        });
        hold(boundaryController, PLAYER_DIRECTION.LEFT, PLAYER_DIRECTION.UP);
        const bounded = boundaryController.step();
        assert(bounded.snapshot.player.footMilliPx.x === 10_000, "20px width World left bound가 다릅니다.");
        assert(bounded.snapshot.player.footMilliPx.y === 6_000, "12px height World top bound가 다릅니다.");
        return { blockerX: blocked.snapshot.player.footMilliPx.x, boundary: bounded.snapshot.player.footMilliPx };
      },
    ],
    [
      "four-static-zone-lifecycle",
      "board/stove/counter/storage가 enter→dismiss-inside→exit→re-enter 상태기계를 따른다",
      "Requirements 1.3, 1.4, 11.1, 11.2, 33.4",
      () => {
        const observed = [];
        for (const semantic of ["board", "stove", "counter", "storage"]) {
          const zone = baseMap.zones.find((candidate) => candidate.semantic === semantic);
          assert(zone, `${semantic} zone이 없습니다.`);
          const controller = new PlayerController({ mapDefinition: baseMap });
          const points = zoneContactPoints(zone);
          const outside = controller.setFootPositionLogical(points.outside.x, points.outside.y);
          assert(outside.zoneTransitions.openRequests.length === 0, `${semantic} outside에서 panel request가 생성됐습니다.`);
          const entered = controller.setFootPositionLogical(points.inside.x, points.inside.y);
          assert(entered.zoneTransitions.openRequests[0]?.zoneId === zone.zoneId, `${semantic} enter request가 없습니다.`);
          assert(controller.dismissZone(zone.zoneId), `${semantic} inside dismiss가 기록되지 않았습니다.`);
          assert(controller.step().zoneTransitions.openRequests.length === 0, `${semantic} inside dismiss 뒤 재개방됐습니다.`);
          const exited = controller.setFootPositionLogical(points.outside.x, points.outside.y);
          assert(exited.zoneTransitions.exitedZoneIds.includes(zone.zoneId), `${semantic} exit가 기록되지 않았습니다.`);
          const reentered = controller.setFootPositionLogical(points.inside.x, points.inside.y);
          assert(reentered.zoneTransitions.openRequests[0]?.semantic === semantic, `${semantic} re-entry가 다시 열리지 않았습니다.`);
          observed.push(semantic);
        }
        return { semantics: observed };
      },
    ],
    [
      "guest-body-overlap-is-nonblocking",
      "guest로 표시된 non-static body overlap은 Player movement 결과를 바꾸지 않는다",
      "Requirements 11.1, 34.6",
      () => {
        const guestRect = { x: 70, y: 60, width: 20, height: 40 };
        const nonBlocking = testMap({
          mapId: "map.qa.guest-nonblocking",
          start: { x: 40, y: 80 },
          objects: [{ objectId: "guest.visual", kind: "GUEST", rect: guestRect, blocksMovement: false }],
        });
        const staticBlocking = testMap({
          mapId: "map.qa.guest-static-control",
          start: { x: 40, y: 80 },
          objects: [{ objectId: "wall.control", kind: "WALL", rect: guestRect, blocksMovement: true }],
        });
        const guestController = new PlayerController({ mapDefinition: nonBlocking, movementStepMilliPx: 60_000 });
        const wallController = new PlayerController({ mapDefinition: staticBlocking, movementStepMilliPx: 60_000 });
        hold(guestController, PLAYER_DIRECTION.RIGHT);
        hold(wallController, PLAYER_DIRECTION.RIGHT);
        const guestResult = guestController.step();
        const wallResult = wallController.step();
        assert(guestResult.snapshot.player.footMilliPx.x === 100_000, "guest overlap이 Player를 body-block했습니다.");
        assert(wallResult.snapshot.player.footMilliPx.x === 60_000, "static control blocker가 적용되지 않았습니다.");
        assert(guestResult.snapshot.bodyBlocking === false, "snapshot bodyBlocking이 false가 아닙니다.");
        return { guestOverlapX: guestResult.snapshot.player.footMilliPx.x, staticBlockX: wallResult.snapshot.player.footMilliPx.x };
      },
    ],
    [
      "generated-collision-invariant",
      "128개 생성 World/input에서 결과가 결정론적이고 모든 resolved 20×12 AABB가 passable하다",
      "Requirements 1.2, 23.4, 33.9, 33.12, 34.6",
      () => {
        let collisionCount = 0;
        for (let seed = 0; seed < 128; seed += 1) {
          const generated = generatedMap(seed);
          const first = new PlayerController({
            mapDefinition: generated.definition,
            movementStepMilliPx: generated.movementStepMilliPx,
          });
          const second = new PlayerController({
            mapDefinition: generated.definition,
            movementStepMilliPx: generated.movementStepMilliPx,
          });
          hold(first, ...generated.directions);
          hold(second, ...generated.directions);
          const firstResult = first.step();
          const secondResult = second.step();
          assert(JSON.stringify(firstResult) === JSON.stringify(secondResult), `seed ${seed} movement가 결정론적이지 않습니다.`);
          const geometry = createPlayerCollisionGeometry(generated.definition);
          assert(isPlayerFootFixedPassable(geometry, firstResult.snapshot.player.footMilliPx), `seed ${seed} resolved AABB가 blocked입니다.`);
          if (firstResult.movement.collisions.x.length + firstResult.movement.collisions.y.length > 0) collisionCount += 1;
        }
        assert(collisionCount > 0, "생성 case가 collision branch를 한 번도 실행하지 않았습니다.");
        return { generatedCases: 128, collisionCases: collisionCount };
      },
    ],
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    property: "Property 22: Player collision and interaction semantics",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}

function dispatchKey(root, type, key) {
  root.defaultView.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

function renderReport(root, report) {
  root.querySelector("#player-world-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "player-world-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");
  const heading = root.createElement("h2");
  heading.textContent = `Player World: ${report.status}`;
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
  root.body.dataset.playerWorldQa = report.status.toLowerCase();
  root.body.dataset.playerWorldQaPassed = String(report.passed);
  root.body.dataset.playerWorldQaTotal = String(report.total);
  root.dispatchEvent(new CustomEvent("player-world:qa-complete", { detail: report }));
}

/** Browser integration checks over the actual active hub, panel DOM, and credits modal. */
export async function runPlayerWorldBrowserProbe({ root, hub, shell, baseMap }) {
  hub.stop();
  hub.setMapDefinition(baseMap);
  hub.activate();
  const pure = await runPlayerWorldProbe({ baseMap });
  const browserResults = await runCases([
    [
      "browser-base-runtime-wiring",
      "browser runtime이 Base authored start와 20×12 World snapshot을 사용한다",
      "Requirements 33.9, 33.12",
      () => {
        hub.reset();
        const state = hub.getState();
        assert(state.activeMapId === baseMap.mapId, "browser hub active Map이 Base가 아닙니다.");
        assert(state.player.collisionWidth === 20 && state.player.collisionHeight === 12, "browser Player geometry가 20×12가 아닙니다.");
        const startX = baseMap.navigation.playerStart.tileX * 32 + baseMap.navigation.playerStart.offsetX;
        const startY = baseMap.navigation.playerStart.tileY * 32 + baseMap.navigation.playerStart.offsetY;
        assert(state.player.x === startX && state.player.y === startY, "browser Player가 authored start에서 시작하지 않았습니다.");
        return { mapId: state.activeMapId, start: { x: state.player.x, y: state.player.y } };
      },
    ],
    [
      "browser-four-panels-reentry-and-storage",
      "네 semantic panel이 자동 open/inside dismiss/exit/re-entry하며 storage가 lot과 carried dish를 표시한다",
      "Requirements 1.3, 1.4, 11.2",
      () => {
        const observed = [];
        for (const semantic of ["board", "stove", "counter", "storage"]) {
          const zone = baseMap.zones.find((candidate) => candidate.semantic === semantic);
          const points = zoneContactPoints(zone);
          hub.reset();
          hub.setPlayerPosition(points.outside.x, points.outside.y);
          hub.setPlayerPosition(points.inside.x, points.inside.y);
          assert(hub.getState().panelOpen && hub.getState().activePanelZoneId === semantic, `${semantic} panel이 자동 open되지 않았습니다.`);
          if (semantic === "storage") {
            const body = root.querySelector("#panel-body").textContent;
            assert(body.includes("lot") && body.includes("dish"), "storage panel이 lot/carried dish를 표시하지 않습니다.");
          }
          hub.closePanel({ returnFocus: false });
          hub.step(0);
          assert(!hub.getState().panelOpen, `${semantic} inside dismiss 뒤 즉시 재개방됐습니다.`);
          hub.setPlayerPosition(points.outside.x, points.outside.y);
          hub.setPlayerPosition(points.inside.x, points.inside.y);
          assert(hub.getState().panelOpen, `${semantic} exit/re-entry 뒤 재개방되지 않았습니다.`);
          hub.closePanel({ returnFocus: false });
          observed.push(semantic);
        }
        return { reopened: observed, storageBody: "lot + dish" };
      },
    ],
    [
      "browser-panel-clears-held-movement",
      "panel open은 held movement를 clear하고 panel context에서 이동량을 0으로 유지한다",
      "Requirements 21.4",
      () => {
        const zone = baseMap.zones.find((candidate) => candidate.semantic === "board");
        const points = zoneContactPoints(zone);
        hub.reset();
        hub.setPlayerPosition(points.outside.x, points.outside.y);
        dispatchKey(root, "keydown", "d");
        assert(hub.getState().heldMovementDirections.includes(PLAYER_DIRECTION.RIGHT), "panel 전 held key가 기록되지 않았습니다.");
        hub.setPlayerPosition(points.inside.x, points.inside.y);
        const before = hub.getState().player.footMilliPx;
        assert(hub.getState().heldMovementDirections.length === 0, "panel open이 held key를 clear하지 않았습니다.");
        hub.step(20);
        const after = hub.getState().player.footMilliPx;
        dispatchKey(root, "keyup", "d");
        assert(after.x === before.x && after.y === before.y, "panel context에서 Player가 이동했습니다.");
        hub.closePanel({ returnFocus: false });
        return { before, after };
      },
    ],
    [
      "browser-modal-clears-held-movement",
      "credits modal open도 held movement를 clear하고 modal context에서 이동량을 0으로 유지한다",
      "Requirements 21.4",
      () => {
        hub.reset();
        dispatchKey(root, "keydown", "d");
        assert(hub.getState().heldMovementDirections.includes(PLAYER_DIRECTION.RIGHT), "modal 전 held key가 기록되지 않았습니다.");
        shell.credits.open(hub.scene.canvas);
        const before = hub.getState().player.footMilliPx;
        assert(hub.getState().heldMovementDirections.length === 0, "modal open이 held key를 clear하지 않았습니다.");
        hub.step(20);
        const after = hub.getState().player.footMilliPx;
        dispatchKey(root, "keyup", "d");
        shell.credits.close();
        assert(after.x === before.x && after.y === before.y, "modal context에서 Player가 이동했습니다.");
        return { before, after };
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
