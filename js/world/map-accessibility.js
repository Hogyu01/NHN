import {
  compareDiagnostics,
  createDiagnostic,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import { BASE_MAP_ID } from "./map-schema.js";
import {
  createGuestPassabilityGrid,
  createPlayerPassabilityGrid,
} from "./passability-grid.js";
import { findShortestPath, PATH_NEIGHBOR_ORDER } from "./pathfinder.js";

export const MAP_ACCESSIBILITY_CODE = Object.freeze({
  VALID: "MAP_ACCESSIBILITY_VALID",
  INVALID: "MAP_ACCESSIBILITY_INVALID",
  GUEST_SPAWN_TO_SEAT: "GUEST_SPAWN_TO_SEAT_UNREACHABLE",
  GUEST_SEAT_TO_EXIT: "GUEST_SEAT_TO_EXIT_UNREACHABLE",
  SEMANTIC_ZONE: "PLAYER_SEMANTIC_ZONE_UNREACHABLE",
  TABLE_SERVICE_TARGET: "PLAYER_TABLE_SERVICE_TARGET_UNREACHABLE",
  TRANSITION: "PLAYER_TRANSITION_UNREACHABLE",
});

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function tileCoordinate(point) {
  return freezeDeep({ x: point.tileX, y: point.tileY });
}

function identifierPart(value) {
  return String(value ?? "none").replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 100) || "none";
}

function accessibilityDiagnostic({
  severity,
  filename,
  mapId,
  code,
  fieldPath,
  itemId,
  details,
}) {
  return createDiagnostic({
    diagnosticId: [
      "diagnostic",
      "MapAccessibility",
      identifierPart(filename),
      identifierPart(code),
      identifierPart(itemId),
    ].join(":"),
    severity,
    subsystem: "MapAccessibility",
    filename,
    errorType: "INVARIANT_ERROR",
    code,
    fieldPath,
    itemId,
    mapId,
    details,
  });
}

function routeViaApproaches({ grid, start, approachPointIds, pointById }) {
  const attempts = [];
  const sortedIds = [...new Set(approachPointIds)].sort(compareText);
  for (const approachPointId of sortedIds) {
    const point = pointById.get(approachPointId);
    if (!point) continue;
    const pathResult = findShortestPath(grid, start, tileCoordinate(point));
    attempts.push(freezeDeep({ approachPointId, pathResult }));
    if (pathResult.ok) {
      return freezeDeep({
        ok: true,
        selectedApproachPointId: approachPointId,
        pathResult,
        attempts,
      });
    }
  }
  return freezeDeep({
    ok: false,
    selectedApproachPointId: null,
    pathResult: null,
    attempts,
  });
}

function failedPathDetails(pathResult, routeKind, extra = {}) {
  return freezeDeep({
    routeKind,
    pathCode: pathResult.code,
    pathDiagnostics: pathResult.diagnostics,
    exploredCount: pathResult.exploredCount,
    ...extra,
  });
}

function failedApproachDetails(route, routeKind, extra = {}) {
  return freezeDeep({
    routeKind,
    attemptedApproachPointIds: route.attempts.map((attempt) => attempt.approachPointId),
    attempts: route.attempts.map((attempt) => ({
      approachPointId: attempt.approachPointId,
      pathCode: attempt.pathResult.code,
      exploredCount: attempt.pathResult.exploredCount,
      pathDiagnostics: attempt.pathResult.diagnostics,
    })),
    ...extra,
  });
}

/**
 * Validates all active guest seats and all authored player interaction approaches using the same
 * production grids/pathfinder consumed by runtime movement.
 */
export function validateMapAccessibility(definition, context = {}) {
  if (!definition || typeof definition !== "object" || !definition.navigation) {
    throw new TypeError("MapAccessibility에는 구조 검증이 끝난 Map definition이 필요합니다.");
  }
  const mapId = definition.mapId;
  const filename = context.filename ?? `${mapId}.json`;
  const severity = context.severity ?? (mapId === BASE_MAP_ID
    ? DIAGNOSTIC_SEVERITY.FATAL_BOOT
    : DIAGNOSTIC_SEVERITY.QUARANTINED_CONTENT);
  const navigation = definition.navigation;
  const guestGrid = createGuestPassabilityGrid(definition);
  const playerGrid = createPlayerPassabilityGrid(definition);
  const diagnostics = [];
  const guestRoutes = [];
  const semanticZoneRoutes = [];
  const serviceTargetRoutes = [];
  const transitionRoutes = [];
  let bfsRunCount = 0;
  let successfulRouteCount = 0;

  const spawn = tileCoordinate(navigation.spawnPoint);
  const exit = tileCoordinate(navigation.exitPoint);
  const activeSeats = navigation.seatPoints
    .filter((seat) => seat.activeByDefault)
    .sort((left, right) => compareText(left.seatId, right.seatId));

  for (const seat of activeSeats) {
    const seatCoordinate = tileCoordinate(seat);
    const spawnToSeat = findShortestPath(guestGrid, spawn, seatCoordinate);
    const seatToExit = findShortestPath(guestGrid, seatCoordinate, exit);
    bfsRunCount += 2;
    successfulRouteCount += Number(spawnToSeat.ok) + Number(seatToExit.ok);
    guestRoutes.push(freezeDeep({
      seatId: seat.seatId,
      tableId: seat.tableId,
      spawnToSeat,
      seatToExit,
    }));
    const seatIndex = definition.navigation.seatPoints.indexOf(seat);
    if (!spawnToSeat.ok) {
      diagnostics.push(accessibilityDiagnostic({
        severity,
        filename,
        mapId,
        code: MAP_ACCESSIBILITY_CODE.GUEST_SPAWN_TO_SEAT,
        fieldPath: `$.navigation.seatPoints[${seatIndex}]`,
        itemId: seat.seatId,
        details: failedPathDetails(spawnToSeat, "SPAWN_TO_SEAT", { tableId: seat.tableId }),
      }));
    }
    if (!seatToExit.ok) {
      diagnostics.push(accessibilityDiagnostic({
        severity,
        filename,
        mapId,
        code: MAP_ACCESSIBILITY_CODE.GUEST_SEAT_TO_EXIT,
        fieldPath: `$.navigation.seatPoints[${seatIndex}]`,
        itemId: seat.seatId,
        details: failedPathDetails(seatToExit, "SEAT_TO_EXIT", { tableId: seat.tableId }),
      }));
    }
  }

  const pointById = new Map(navigation.approachPoints.map((point) => [point.pointId, point]));
  const playerStart = tileCoordinate(navigation.playerStart);
  const zones = [...definition.zones].sort((left, right) =>
    compareText(left.semantic, right.semantic) || compareText(left.zoneId, right.zoneId));
  for (const zone of zones) {
    const route = routeViaApproaches({
      grid: playerGrid,
      start: playerStart,
      approachPointIds: zone.approachTileIds,
      pointById,
    });
    bfsRunCount += route.attempts.length;
    successfulRouteCount += Number(route.ok);
    semanticZoneRoutes.push(freezeDeep({
      zoneId: zone.zoneId,
      semantic: zone.semantic,
      ...route,
    }));
    if (!route.ok) {
      diagnostics.push(accessibilityDiagnostic({
        severity,
        filename,
        mapId,
        code: MAP_ACCESSIBILITY_CODE.SEMANTIC_ZONE,
        fieldPath: `$.zones[${definition.zones.indexOf(zone)}].approachTileIds`,
        itemId: zone.zoneId,
        details: failedApproachDetails(route, "PLAYER_TO_SEMANTIC_ZONE", { semantic: zone.semantic }),
      }));
    }
  }

  const targets = [...navigation.tableServiceTargets]
    .sort((left, right) => compareText(left.targetId, right.targetId));
  for (const target of targets) {
    const route = routeViaApproaches({
      grid: playerGrid,
      start: playerStart,
      approachPointIds: target.approachTileIds,
      pointById,
    });
    bfsRunCount += route.attempts.length;
    successfulRouteCount += Number(route.ok);
    serviceTargetRoutes.push(freezeDeep({
      targetId: target.targetId,
      tableId: target.tableId,
      ...route,
    }));
    if (!route.ok) {
      diagnostics.push(accessibilityDiagnostic({
        severity,
        filename,
        mapId,
        code: MAP_ACCESSIBILITY_CODE.TABLE_SERVICE_TARGET,
        fieldPath: `$.navigation.tableServiceTargets[${navigation.tableServiceTargets.indexOf(target)}].approachTileIds`,
        itemId: target.targetId,
        details: failedApproachDetails(route, "PLAYER_TO_TABLE_SERVICE_TARGET", { tableId: target.tableId }),
      }));
    }
  }

  const transitions = [...navigation.transitions]
    .sort((left, right) => compareText(left.transitionId, right.transitionId));
  for (const transition of transitions) {
    const pathResult = findShortestPath(playerGrid, playerStart, tileCoordinate(transition));
    bfsRunCount += 1;
    successfulRouteCount += Number(pathResult.ok);
    transitionRoutes.push(freezeDeep({
      transitionId: transition.transitionId,
      destinationMapId: transition.destinationMapId,
      destinationEntryId: transition.destinationEntryId,
      pathResult,
    }));
    if (!pathResult.ok) {
      diagnostics.push(accessibilityDiagnostic({
        severity,
        filename,
        mapId,
        code: MAP_ACCESSIBILITY_CODE.TRANSITION,
        fieldPath: `$.navigation.transitions[${navigation.transitions.indexOf(transition)}]`,
        itemId: transition.transitionId,
        details: failedPathDetails(pathResult, "PLAYER_TO_TRANSITION", {
          destinationMapId: transition.destinationMapId,
          destinationEntryId: transition.destinationEntryId,
        }),
      }));
    }
  }

  const requiredRouteCount = activeSeats.length * 2 + zones.length + targets.length + transitions.length;
  const report = freezeDeep({
    reportType: "PathDiagnosticReport",
    contractVersion: 1,
    mapId,
    filename,
    neighborOrder: PATH_NEIGHBOR_ORDER.map((neighbor) => neighbor.direction),
    guest: {
      gridKind: guestGrid.kind,
      seatOrder: activeSeats.map((seat) => seat.seatId),
      routes: guestRoutes,
    },
    player: {
      gridKind: playerGrid.kind,
      collisionWidth: playerGrid.collisionWidth,
      collisionHeight: playerGrid.collisionHeight,
      semanticZones: semanticZoneRoutes,
      tableServiceTargets: serviceTargetRoutes,
      transitions: transitionRoutes,
    },
    summary: {
      activeSeatCount: activeSeats.length,
      guestPathCount: activeSeats.length * 2,
      semanticZoneCount: zones.length,
      tableServiceTargetCount: targets.length,
      transitionCount: transitions.length,
      requiredRouteCount,
      successfulRouteCount,
      failedRouteCount: requiredRouteCount - successfulRouteCount,
      bfsRunCount,
    },
  });
  const sortedDiagnostics = Object.freeze([...diagnostics].sort(compareDiagnostics));
  return freezeDeep({
    ok: sortedDiagnostics.length === 0,
    code: sortedDiagnostics.length === 0 ? MAP_ACCESSIBILITY_CODE.VALID : MAP_ACCESSIBILITY_CODE.INVALID,
    diagnostics: sortedDiagnostics,
    report,
  });
}

export class MapAccessibilityValidator {
  validate(definition, context = {}) {
    return validateMapAccessibility(definition, context);
  }
}
