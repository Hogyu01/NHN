import { freezeDeep } from "../core/result.js";

export const PATH_NEIGHBOR_ORDER = freezeDeep([
  { direction: "N", dx: 0, dy: -1 },
  { direction: "W", dx: -1, dy: 0 },
  { direction: "S", dx: 0, dy: 1 },
  { direction: "E", dx: 1, dy: 0 },
]);

export const PATH_RESULT_CODE = Object.freeze({
  FOUND: "PATH_FOUND",
  ENDPOINT_OUT_OF_BOUNDS: "PATH_ENDPOINT_OUT_OF_BOUNDS",
  ENDPOINT_BLOCKED: "PATH_ENDPOINT_BLOCKED",
  UNREACHABLE: "PATH_UNREACHABLE",
});

const EMPTY_DIAGNOSTICS = Object.freeze([]);

function identifierPart(value) {
  return String(value ?? "none").replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 100) || "none";
}

function coordinateSnapshot(point) {
  return freezeDeep({
    x: Number.isSafeInteger(point?.x) ? point.x : null,
    y: Number.isSafeInteger(point?.y) ? point.y : null,
  });
}

function assertGrid(grid) {
  if (!grid || typeof grid !== "object" || Array.isArray(grid)) {
    throw new TypeError("pathfinder grid는 object여야 합니다.");
  }
  if (!Number.isSafeInteger(grid.width) || grid.width < 1 ||
      !Number.isSafeInteger(grid.height) || grid.height < 1) {
    throw new RangeError("pathfinder grid width/height는 양의 safe integer여야 합니다.");
  }
  const area = grid.width * grid.height;
  if (!Number.isSafeInteger(area) || !Array.isArray(grid.cells) || grid.cells.length !== area) {
    throw new RangeError("pathfinder grid cells 길이는 width×height와 같아야 합니다.");
  }
  if (grid.cells.some((cell) => cell !== 0 && cell !== 1 && cell !== false && cell !== true)) {
    throw new TypeError("pathfinder grid cells는 passable 1/true 또는 blocked 0/false만 허용합니다.");
  }
  if (typeof grid.kind !== "string" || grid.kind.trim() === "") {
    throw new TypeError("pathfinder grid kind가 필요합니다.");
  }
  return area;
}

function inBounds(grid, point) {
  return Number.isSafeInteger(point?.x) && Number.isSafeInteger(point?.y) &&
    point.x >= 0 && point.y >= 0 && point.x < grid.width && point.y < grid.height;
}

function indexOf(grid, point) {
  return point.y * grid.width + point.x;
}

function isPassable(grid, point) {
  return Boolean(grid.cells[indexOf(grid, point)]);
}

/**
 * Stable, serializable path failure record used by validation, runtime fault handling and QA.
 */
export function createPathDiagnostic({
  mapId,
  gridKind,
  start,
  end,
  exploredCount,
  failureCode,
  endpoint = null,
  details = undefined,
}) {
  if (!Number.isSafeInteger(exploredCount) || exploredCount < 0) {
    throw new TypeError("PathDiagnostic exploredCount는 0 이상의 safe integer여야 합니다.");
  }
  if (!Object.values(PATH_RESULT_CODE).includes(failureCode) || failureCode === PATH_RESULT_CODE.FOUND) {
    throw new TypeError(`PathDiagnostic failureCode가 잘못됐습니다: ${failureCode}`);
  }
  const normalizedStart = coordinateSnapshot(start);
  const normalizedEnd = coordinateSnapshot(end);
  return freezeDeep({
    pathDiagnosticId: [
      "path-diagnostic",
      identifierPart(mapId),
      identifierPart(gridKind),
      identifierPart(failureCode),
      identifierPart(endpoint),
      `${normalizedStart.x ?? "x"}-${normalizedStart.y ?? "y"}`,
      `${normalizedEnd.x ?? "x"}-${normalizedEnd.y ?? "y"}`,
    ].join(":"),
    mapId: typeof mapId === "string" && mapId.length > 0 ? mapId : "map.unknown",
    gridKind,
    start: normalizedStart,
    end: normalizedEnd,
    exploredCount,
    failureCode,
    endpoint,
    ...(details === undefined ? {} : { details }),
  });
}

function failureResult({ grid, start, end, code, exploredCount, queueCreated, diagnostics }) {
  return freezeDeep({
    ok: false,
    code,
    mapId: typeof grid.mapId === "string" ? grid.mapId : "map.unknown",
    gridKind: grid.kind,
    start: coordinateSnapshot(start),
    end: coordinateSnapshot(end),
    queueCreated,
    exploredCount,
    distance: null,
    path: null,
    diagnostics,
  });
}

function endpointFailures(grid, start, end) {
  const failures = [];
  for (const [endpoint, point] of [["START", start], ["END", end]]) {
    if (!inBounds(grid, point)) {
      failures.push(createPathDiagnostic({
        mapId: grid.mapId,
        gridKind: grid.kind,
        start,
        end,
        exploredCount: 0,
        failureCode: PATH_RESULT_CODE.ENDPOINT_OUT_OF_BOUNDS,
        endpoint,
        details: { width: grid.width, height: grid.height },
      }));
    } else if (!isPassable(grid, point)) {
      failures.push(createPathDiagnostic({
        mapId: grid.mapId,
        gridKind: grid.kind,
        start,
        end,
        exploredCount: 0,
        failureCode: PATH_RESULT_CODE.ENDPOINT_BLOCKED,
        endpoint,
      }));
    }
  }
  return Object.freeze(failures);
}

function reconstructPath(grid, predecessor, endIndex) {
  const reversed = [];
  let cursor = endIndex;
  while (cursor >= 0) {
    reversed.push({ x: cursor % grid.width, y: Math.floor(cursor / grid.width) });
    cursor = predecessor[cursor];
  }
  reversed.reverse();
  return freezeDeep(reversed);
}

/**
 * Deterministic shortest-path BFS.
 *
 * Endpoints are fully checked before queue allocation. Nodes are marked visited on first enqueue,
 * predecessor ties therefore follow N→W→S→E, and the path is returned when end is first dequeued.
 */
export function findShortestPath(grid, start, end) {
  const area = assertGrid(grid);
  const failures = endpointFailures(grid, start, end);
  if (failures.length > 0) {
    return failureResult({
      grid,
      start,
      end,
      code: failures[0].failureCode,
      exploredCount: 0,
      queueCreated: false,
      diagnostics: failures,
    });
  }

  const startIndex = indexOf(grid, start);
  const endIndex = indexOf(grid, end);
  const predecessor = new Int32Array(area);
  predecessor.fill(-2);
  predecessor[startIndex] = -1;
  const queue = new Int32Array(area);
  let head = 0;
  let tail = 1;
  let exploredCount = 0;
  queue[0] = startIndex;

  while (head < tail) {
    const currentIndex = queue[head];
    head += 1;
    exploredCount += 1;

    if (currentIndex === endIndex) {
      const path = reconstructPath(grid, predecessor, endIndex);
      return freezeDeep({
        ok: true,
        code: PATH_RESULT_CODE.FOUND,
        mapId: typeof grid.mapId === "string" ? grid.mapId : "map.unknown",
        gridKind: grid.kind,
        start: coordinateSnapshot(start),
        end: coordinateSnapshot(end),
        queueCreated: true,
        exploredCount,
        distance: path.length - 1,
        path,
        diagnostics: EMPTY_DIAGNOSTICS,
      });
    }

    const currentX = currentIndex % grid.width;
    const currentY = Math.floor(currentIndex / grid.width);
    for (const neighbor of PATH_NEIGHBOR_ORDER) {
      const nextX = currentX + neighbor.dx;
      const nextY = currentY + neighbor.dy;
      if (nextX < 0 || nextY < 0 || nextX >= grid.width || nextY >= grid.height) continue;
      const nextIndex = nextY * grid.width + nextX;
      if (predecessor[nextIndex] !== -2 || !grid.cells[nextIndex]) continue;
      predecessor[nextIndex] = currentIndex;
      queue[tail] = nextIndex;
      tail += 1;
    }
  }

  const diagnostic = createPathDiagnostic({
    mapId: grid.mapId,
    gridKind: grid.kind,
    start,
    end,
    exploredCount,
    failureCode: PATH_RESULT_CODE.UNREACHABLE,
  });
  return failureResult({
    grid,
    start,
    end,
    code: diagnostic.failureCode,
    exploredCount,
    queueCreated: true,
    diagnostics: Object.freeze([diagnostic]),
  });
}
