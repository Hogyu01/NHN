import { freezeDeep } from "../core/result.js";
import {
  createAuthoredTableServiceTargets,
  DYNAMIC_SERVICE_TARGET_KIND,
  resolveDynamicServiceTarget,
} from "./dynamic-target-resolver.js";

export const WORLD_INTERACTION_ROUTE = Object.freeze({
  STATIC_ZONE_OPEN: "STATIC_ZONE_OPEN",
  DYNAMIC_SERVICE_ACTION: "DYNAMIC_SERVICE_ACTION",
  NO_INTERACTION: "NO_INTERACTION",
});

export const WORLD_INTERACTION_COMMAND_TYPE = Object.freeze({
  [DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER]: "direct-service.interact-guest-order",
  [DYNAMIC_SERVICE_TARGET_KIND.TABLE_SERVICE]: "direct-service.interact-table-service",
});

function stableLexicalCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function invokeSynchronous(callback, args, field) {
  const result = callback(...args);
  if (result && typeof result.then === "function") {
    throw new TypeError(`${field} callback은 Promise를 반환할 수 없습니다.`);
  }
  return result;
}

function normalizeStaticRequest(request, index) {
  if (!request || typeof request.zoneId !== "string" || request.zoneId.length === 0 ||
      typeof request.semantic !== "string" || request.semantic.length === 0) {
    throw new TypeError(`Static interaction request ${index}의 zoneId/semantic이 잘못됐습니다.`);
  }
  return freezeDeep({ zoneId: request.zoneId, semantic: request.semantic });
}

export function createDynamicInteractionCommand(target) {
  const type = WORLD_INTERACTION_COMMAND_TYPE[target?.kind];
  if (!type || typeof target.targetId !== "string" || target.targetId.length === 0) {
    throw new TypeError("Dynamic interaction command에는 유효한 target kind/ID가 필요합니다.");
  }
  return freezeDeep({
    type,
    payload: { targetId: target.targetId },
  });
}

/**
 * Keeps automatic authored static-zone opens and action-only dynamic service commands on separate
 * routes. The downstream command contains only a stable target ID; coordinates remain World-side.
 */
export class WorldInteractionRouter {
  constructor({
    mapDefinition,
    dynamicTargetProvider = () => [],
    onStaticOpen = () => undefined,
    onDynamicCommand = () => undefined,
  }) {
    if (typeof dynamicTargetProvider !== "function") {
      throw new TypeError("dynamicTargetProvider는 함수여야 합니다.");
    }
    if (typeof onStaticOpen !== "function" || typeof onDynamicCommand !== "function") {
      throw new TypeError("World interaction route sink는 함수여야 합니다.");
    }
    this.dynamicTargetProvider = dynamicTargetProvider;
    this.onStaticOpen = onStaticOpen;
    this.onDynamicCommand = onDynamicCommand;
    this.lastStaticRoute = null;
    this.lastDynamicRoute = null;
    this.setMapDefinition(mapDefinition);
  }

  setMapDefinition(mapDefinition) {
    this.mapDefinition = mapDefinition;
    this.authoredTableTargets = createAuthoredTableServiceTargets(mapDefinition);
    this.lastStaticRoute = null;
    this.lastDynamicRoute = null;
    return this.snapshot();
  }

  getDynamicTargets() {
    const runtimeTargets = this.dynamicTargetProvider();
    if (!Array.isArray(runtimeTargets)) {
      throw new TypeError("dynamicTargetProvider 결과는 배열이어야 합니다.");
    }
    return Object.freeze([...this.authoredTableTargets, ...runtimeTargets]);
  }

  routeStaticTransitions(transitions) {
    const requests = transitions?.openRequests;
    if (!Array.isArray(requests)) {
      throw new TypeError("Static zone transitions.openRequests는 배열이어야 합니다.");
    }
    if (requests.length === 0) {
      const route = freezeDeep({
        route: WORLD_INTERACTION_ROUTE.NO_INTERACTION,
        source: "STATIC_ZONE_TRANSITION",
        command: null,
      });
      this.lastStaticRoute = route;
      return route;
    }

    const normalized = requests.map(normalizeStaticRequest)
      .sort((left, right) => stableLexicalCompare(left.zoneId, right.zoneId));
    const request = normalized[0];
    const route = freezeDeep({
      route: WORLD_INTERACTION_ROUTE.STATIC_ZONE_OPEN,
      source: "STATIC_ZONE_TRANSITION",
      request,
      ignoredOverlappingRequestCount: normalized.length - 1,
      command: null,
    });
    invokeSynchronous(this.onStaticOpen, [request, route], "onStaticOpen");
    this.lastStaticRoute = route;
    return route;
  }

  routeAction({
    playerFootMilliPx,
    inputSource = "KEYBOARD",
    inputWorldPoint = null,
  }) {
    if (typeof inputSource !== "string" || inputSource.length === 0) {
      throw new TypeError("Dynamic action inputSource가 필요합니다.");
    }
    if (inputWorldPoint !== null && (!Number.isFinite(inputWorldPoint.x) || !Number.isFinite(inputWorldPoint.y))) {
      throw new TypeError("pointer inputWorldPoint는 finite World coordinate여야 합니다.");
    }
    const resolution = resolveDynamicServiceTarget({
      playerFootMilliPx,
      targets: this.getDynamicTargets(),
    });
    if (!resolution.target) {
      const route = freezeDeep({
        route: WORLD_INTERACTION_ROUTE.NO_INTERACTION,
        source: inputSource,
        resolution,
        command: null,
      });
      this.lastDynamicRoute = route;
      return route;
    }

    const command = createDynamicInteractionCommand(resolution.target);
    const route = freezeDeep({
      route: WORLD_INTERACTION_ROUTE.DYNAMIC_SERVICE_ACTION,
      source: inputSource,
      selectedTargetId: resolution.target.targetId,
      selectedTargetKind: resolution.target.kind,
      resolution,
      command,
    });
    invokeSynchronous(this.onDynamicCommand, [command, route], "onDynamicCommand");
    this.lastDynamicRoute = route;
    return route;
  }

  snapshot() {
    return freezeDeep({
      mapId: this.mapDefinition?.mapId ?? null,
      authoredTargetCount: this.authoredTableTargets?.length ?? 0,
      ordering: Object.freeze([
        "WORLD_DISTANCE_MILLI_PX",
        "TARGET_PRIORITY:GUEST_ORDER=0,TABLE_SERVICE=1",
        "ENTITY_ID_LEXICAL",
      ]),
      staticRoute: "ZONE_ENTER_AUTOMATIC",
      dynamicRoute: "ACTION_ONLY",
      lastStaticRoute: this.lastStaticRoute,
      lastDynamicRoute: this.lastDynamicRoute,
    });
  }
}
