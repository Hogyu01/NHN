import { BOOT_STAGE, BOOT_STATUS } from "../app/bootstrap.js";
import { BASE_MAP_ID, MAP_ROLE } from "../world/map-schema.js";
import { MapLoader } from "../world/map-loader.js";
import { MapValidator } from "../world/map-validator.js";
import {
  MAP_ACCESSIBILITY_CODE,
  validateMapAccessibility,
} from "../world/map-accessibility.js";
import {
  createGuestPassabilityGrid,
  createPlayerPassabilityGrid,
} from "../world/passability-grid.js";
import {
  findShortestPath,
  PATH_NEIGHBOR_ORDER,
  PATH_RESULT_CODE,
} from "../world/pathfinder.js";
import {
  createBaseMapFixture,
  createGenericMapFixture,
} from "./map-validation-probe.js";

const QA_ID = "map-accessibility";
const FLOOR_TILE_ID = "tile.fixture.floor";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runCase(id, description, validates, execute) {
  return Promise.resolve().then(execute).then(
    (details) => Object.freeze({ id, description, validates, status: "PASS", details }),
    (error) => Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function grid(width, height, blocked = [], kind = "QA") {
  const cells = Array(width * height).fill(1);
  for (const { x, y } of blocked) cells[y * width + x] = 0;
  return Object.freeze({
    mapId: "map.qa.grid",
    kind,
    width,
    height,
    cells: Object.freeze(cells),
  });
}

function samePoint(left, right) {
  return left.x === right.x && left.y === right.y;
}

function assertPathContract(result, sourceGrid, start, end) {
  assert(result.ok, `성공 path가 아닙니다: ${result.code}`);
  assert(result.path.length === result.distance + 1, "path length와 distance가 일치하지 않습니다.");
  assert(samePoint(result.path[0], start), "path가 start를 포함하지 않습니다.");
  assert(samePoint(result.path.at(-1), end), "path가 end를 포함하지 않습니다.");
  result.path.forEach((node, index) => {
    assert(node.x >= 0 && node.y >= 0 && node.x < sourceGrid.width && node.y < sourceGrid.height, "path node가 bounds 밖입니다.");
    assert(Boolean(sourceGrid.cells[node.y * sourceGrid.width + node.x]), "path node가 blocked입니다.");
    if (index === 0) return;
    const previous = result.path[index - 1];
    assert(Math.abs(previous.x - node.x) + Math.abs(previous.y - node.y) === 1, "path step이 orthogonal이 아닙니다.");
  });
}

function referenceDistance(sourceGrid, start, end) {
  const distances = Array(sourceGrid.width * sourceGrid.height).fill(-1);
  const queue = [{ ...start }];
  let head = 0;
  distances[start.y * sourceGrid.width + start.x] = 0;
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const distance = distances[current.y * sourceGrid.width + current.x];
    if (samePoint(current, end)) return distance;
    for (const [dx, dy] of directions) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (x < 0 || y < 0 || x >= sourceGrid.width || y >= sourceGrid.height) continue;
      const index = y * sourceGrid.width + x;
      if (!sourceGrid.cells[index] || distances[index] !== -1) continue;
      distances[index] = distance + 1;
      queue.push({ x, y });
    }
  }
  return null;
}

function generatedGrid(seed) {
  let state = (seed + 1) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const width = 2 + next() % 11;
  const height = 2 + next() % 11;
  const cells = Array.from({ length: width * height }, () => next() % 5 === 0 ? 0 : 1);
  const start = { x: next() % width, y: next() % height };
  let end = { x: next() % width, y: next() % height };
  if (samePoint(start, end)) end = { x: (end.x + 1) % width, y: end.y };
  cells[start.y * width + start.x] = 1;
  cells[end.y * width + end.x] = 1;
  return {
    sourceGrid: Object.freeze({
      mapId: `map.qa.generated.${String(seed).padStart(3, "0")}`,
      kind: "GENERATED",
      width,
      height,
      cells: Object.freeze(cells),
    }),
    start,
    end,
  };
}

function setCollision(definition, tileX, tileY, value = 1) {
  definition.layers.collision[tileY * definition.width + tileX] = value;
}

function isolateTile(definition, tileX, tileY) {
  for (const [dx, dy] of [[0, -1], [-1, 0], [0, 1], [1, 0]]) {
    setCollision(definition, tileX + dx, tileY + dy);
  }
}

function navigationPoint(pointId, tileX, tileY, offsetX = 16, offsetY = 16) {
  return { pointId, tileX, tileY, offsetX, offsetY };
}

function hasCode(result, code) {
  return result.diagnostics.some((diagnostic) => diagnostic.code === code);
}

function validateReportPaths(accessibility, definition) {
  const guestGrid = createGuestPassabilityGrid(definition);
  const playerGrid = createPlayerPassabilityGrid(definition);
  for (const route of accessibility.report.guest.routes) {
    assertPathContract(route.spawnToSeat, guestGrid, route.spawnToSeat.start, route.spawnToSeat.end);
    assertPathContract(route.seatToExit, guestGrid, route.seatToExit.start, route.seatToExit.end);
  }
  for (const route of accessibility.report.player.semanticZones) {
    assertPathContract(route.pathResult, playerGrid, route.pathResult.start, route.pathResult.end);
  }
  for (const route of accessibility.report.player.tableServiceTargets) {
    assertPathContract(route.pathResult, playerGrid, route.pathResult.start, route.pathResult.end);
  }
}

/**
 * Task 8 unit examples and generated Property 20 validation using production path/grid/loader code.
 * Property 20: Deterministic shortest BFS.
 * **Validates: Requirements 20.5, 23.10, 23.11, 31.4, 33.13, 33.14, 33.15, 34.5, 34.10, 34.11, 34.12**
 */
export async function runMapAccessibilityProbe() {
  const results = await Promise.all([
    runCase(
      "bfs-shortest-and-tie-break",
      "최단 동률에서 N→W→S→E와 first-dequeue 경로를 고정한다",
      "Requirements 33.14, 34.5",
      () => {
        const sourceGrid = grid(3, 3);
        const start = { x: 1, y: 1 };
        const end = { x: 0, y: 0 };
        const first = findShortestPath(sourceGrid, start, end);
        const second = findShortestPath(sourceGrid, start, end);
        const expected = [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }];
        assert(JSON.stringify(PATH_NEIGHBOR_ORDER.map((entry) => entry.direction)) === JSON.stringify(["N", "W", "S", "E"]), "이웃 순서가 다릅니다.");
        assert(JSON.stringify(first.path) === JSON.stringify(expected), `tie path=${JSON.stringify(first.path)}`);
        assert(JSON.stringify(first) === JSON.stringify(second), "동일 grid의 path result가 byte-equivalent하지 않습니다.");
        assertPathContract(first, sourceGrid, start, end);
        const stationary = findShortestPath(sourceGrid, start, start);
        assert(stationary.ok && stationary.distance === 0 && stationary.path.length === 1 && stationary.exploredCount === 1, "start=end 계약이 잘못됐습니다.");
        return { path: first.path, exploredCount: first.exploredCount, stationary: stationary.path };
      },
    ),
    runCase(
      "invalid-endpoints-no-queue",
      "out-of-bounds/blocked endpoint는 queue 생성 전 명시 코드로 거절한다",
      "Requirements 33.15",
      () => {
        const sourceGrid = grid(3, 3, [{ x: 2, y: 2 }]);
        const outOfBounds = findShortestPath(sourceGrid, { x: -1, y: 0 }, { x: 2, y: 2 });
        const blocked = findShortestPath(sourceGrid, { x: 0, y: 0 }, { x: 2, y: 2 });
        assert(!outOfBounds.ok && outOfBounds.code === PATH_RESULT_CODE.ENDPOINT_OUT_OF_BOUNDS, "OOB code가 다릅니다.");
        assert(outOfBounds.queueCreated === false && outOfBounds.exploredCount === 0, "OOB에서 queue가 생성됐습니다.");
        assert(outOfBounds.diagnostics.length === 2, "복수 invalid endpoint가 모두 보고되지 않았습니다.");
        assert(!blocked.ok && blocked.code === PATH_RESULT_CODE.ENDPOINT_BLOCKED, "blocked code가 다릅니다.");
        assert(blocked.queueCreated === false && blocked.exploredCount === 0, "blocked endpoint에서 queue가 생성됐습니다.");
        return {
          outOfBoundsCode: outOfBounds.code,
          blockedCode: blocked.code,
          diagnostics: outOfBounds.diagnostics.length,
        };
      },
    ),
    runCase(
      "unreachable-explicit-diagnostic",
      "valid endpoint 사이가 단절되면 explored count와 PATH_UNREACHABLE을 반환한다",
      "Requirements 33.14, 33.15",
      () => {
        const sourceGrid = grid(4, 3, [
          { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
        ]);
        const result = findShortestPath(sourceGrid, { x: 0, y: 0 }, { x: 3, y: 2 });
        assert(!result.ok && result.code === PATH_RESULT_CODE.UNREACHABLE, `unreachable code=${result.code}`);
        assert(result.queueCreated && result.exploredCount === 4, `explored=${result.exploredCount}`);
        assert(result.diagnostics[0]?.failureCode === PATH_RESULT_CODE.UNREACHABLE, "PathDiagnostic failure code가 다릅니다.");
        return { code: result.code, exploredCount: result.exploredCount };
      },
    ),
    runCase(
      "generated-shortest-path-property",
      "생성 grid에서 production BFS 거리와 독립 reference 거리가 항상 일치한다",
      "Requirements 23.11, 33.14, 34.5",
      () => {
        let reachable = 0;
        let unreachable = 0;
        for (let seed = 0; seed < 128; seed += 1) {
          const { sourceGrid, start, end } = generatedGrid(seed);
          const expectedDistance = referenceDistance(sourceGrid, start, end);
          const first = findShortestPath(sourceGrid, start, end);
          const second = findShortestPath(sourceGrid, start, end);
          assert(JSON.stringify(first) === JSON.stringify(second), `seed ${seed} 결과가 결정론적이지 않습니다.`);
          if (expectedDistance === null) {
            assert(!first.ok && first.code === PATH_RESULT_CODE.UNREACHABLE, `seed ${seed} unreachable 판정이 다릅니다.`);
            unreachable += 1;
          } else {
            assert(first.ok && first.distance === expectedDistance, `seed ${seed} distance=${first.distance}, expected=${expectedDistance}`);
            assertPathContract(first, sourceGrid, start, end);
            reachable += 1;
          }
        }
        return { generatedCases: 128, reachable, unreachable };
      },
    ),
    runCase(
      "player-grid-20x12-erosion",
      "같은 tile anchor에서 Guest point는 통과해도 Player 20×12 AABB 교차는 차단한다",
      "Requirements 33.9, 33.13, 34.6",
      () => {
        const definition = createGenericMapFixture("map.qa.player-erosion", 4, 4);
        definition.objects.push({
          objectId: "object.qa.narrow-blocker",
          kind: "QA_BLOCKER",
          rect: { x: 54, y: 44, width: 2, height: 8 },
          blocksMovement: true,
        });
        const guestGrid = createGuestPassabilityGrid(definition);
        const playerGrid = createPlayerPassabilityGrid(definition);
        const index = 1 * definition.width + 1;
        assert(guestGrid.cells[index] === 1, "Guest point anchor가 불필요하게 차단됐습니다.");
        assert(playerGrid.cells[index] === 0, "Player 20×12 AABB erosion이 blocker를 놓쳤습니다.");
        assert(playerGrid.collisionWidth === 20 && playerGrid.collisionHeight === 12, "Player grid geometry가 20×12가 아닙니다.");
        return { guestPassable: guestGrid.cells[index], playerPassable: playerGrid.cells[index] };
      },
    ),
    runCase(
      "base-accessibility-full-contract",
      "Base의 12-seat 24 guest paths와 4 semantic/6 table target player paths가 모두 유효하다",
      "Requirements 23.11, 33.13, 34.5",
      async () => {
        const definition = createBaseMapFixture();
        const accessibility = validateMapAccessibility(definition, {
          filename: "memory/base-accessibility.json",
          mapId: BASE_MAP_ID,
          role: MAP_ROLE.BASE,
        });
        assert(accessibility.ok, `Base accessibility=${accessibility.diagnostics.map((entry) => entry.code).join(",")}`);
        assert(accessibility.report.summary.activeSeatCount === 12, "active seat count가 12가 아닙니다.");
        assert(accessibility.report.summary.guestPathCount === 24, "guest path count가 24가 아닙니다.");
        assert(accessibility.report.summary.semanticZoneCount === 4, "semantic zone route count가 4가 아닙니다.");
        assert(accessibility.report.summary.tableServiceTargetCount === 6, "table target route count가 6이 아닙니다.");
        assert(accessibility.report.summary.failedRouteCount === 0, "Base 접근성 실패 route가 있습니다.");
        assert(JSON.stringify(accessibility.report.guest.seatOrder) === JSON.stringify([...accessibility.report.guest.seatOrder].sort()), "Seat_ID 순서가 lexical ascending이 아닙니다.");
        validateReportPaths(accessibility, definition);

        const validator = new MapValidator({ knownTileIds: [FLOOR_TILE_ID] });
        const loader = new MapLoader({ mapValidator: validator });
        const loaded = await loader.loadDefinitions([{
          filename: "memory/base-accessibility.json",
          role: MAP_ROLE.BASE,
          data: definition,
          expectedMapId: BASE_MAP_ID,
        }]);
        assert(loaded.canStart && loaded.activeMapValidity.details.accessibility === "PASS", "MapLoader active accessibility 배선이 PASS가 아닙니다.");
        return accessibility.report.summary;
      },
    ),
    runCase(
      "base-inaccessible-route-blocks-start",
      "schema-valid Base의 고립 active seat는 Active_Map_Validity에서 start를 차단한다",
      "Requirements 20.5, 33.8, 33.13, 34.12",
      async () => {
        const definition = clone(createBaseMapFixture());
        const seat = definition.navigation.seatPoints.find((candidate) => candidate.seatId === "seat.01.a");
        isolateTile(definition, seat.tileX, seat.tileY);
        const validator = new MapValidator({ knownTileIds: [FLOOR_TILE_ID] });
        const loader = new MapLoader({ mapValidator: validator });
        const report = await loader.loadDefinitions([{
          filename: "memory/base-inaccessible.json",
          role: MAP_ROLE.BASE,
          data: definition,
          expectedMapId: BASE_MAP_ID,
        }]);
        assert(!report.canStart && !report.activeMapValidity.ok, "inaccessible Base가 start를 허용했습니다.");
        assert(report.activeMapValidity.details.accessibility === "FAIL", "Base accessibility failure가 별도 판정되지 않았습니다.");
        assert(hasCode(report, MAP_ACCESSIBILITY_CODE.GUEST_SPAWN_TO_SEAT), "Spawn→Seat 접근성 진단이 없습니다.");
        assert(hasCode(report, MAP_ACCESSIBILITY_CODE.GUEST_SEAT_TO_EXIT), "Seat→Exit 접근성 진단이 없습니다.");
        return { codes: report.diagnostics.map((entry) => entry.code) };
      },
    ),
    runCase(
      "optional-inaccessible-map-quarantine",
      "접근 불가능한 optional semantic fixture만 격리하고 Base start를 유지한다",
      "Requirements 31.4, 33.7, 33.13",
      async () => {
        const optional = createGenericMapFixture("map.optional.inaccessible", 5, 5);
        optional.navigation.approachPoints.push(navigationPoint("approach.optional.isolated", 3, 3));
        optional.zones.push({
          zoneId: "zone.optional.isolated",
          semantic: "optional",
          rect: { x: 3 * 32, y: 3 * 32, width: 32, height: 32 },
          approachTileIds: ["approach.optional.isolated"],
        });
        isolateTile(optional, 3, 3);
        const validator = new MapValidator({ knownTileIds: [FLOOR_TILE_ID] });
        const loader = new MapLoader({ mapValidator: validator });
        const report = await loader.loadDefinitions([
          {
            filename: "memory/base.json",
            role: MAP_ROLE.BASE,
            data: createBaseMapFixture(),
            expectedMapId: BASE_MAP_ID,
          },
          {
            filename: "memory/optional-inaccessible.json",
            role: MAP_ROLE.OPTIONAL,
            data: optional,
            expectedMapId: optional.mapId,
          },
        ]);
        assert(report.canStart && report.activeMapValidity.ok, "invalid optional accessibility가 Base를 막았습니다.");
        assert(report.quarantined.length === 1 && report.quarantined[0].mapId === optional.mapId, "invalid optional이 격리되지 않았습니다.");
        assert(hasCode(report, MAP_ACCESSIBILITY_CODE.SEMANTIC_ZONE), "optional accessibility 진단이 없습니다.");
        return { active: report.activeMapId, quarantined: report.quarantined[0].mapId };
      },
    ),
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    property: "Property 20: Deterministic shortest BFS",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}
