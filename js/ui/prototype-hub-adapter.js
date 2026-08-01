import { createRuntimeComposition } from "../app/runtime-composition.js";
import { resolveOrderableRecipe } from "../app/one-day-scenario.js";
import { freezeDeep } from "../core/result.js";
import { ACTIVE_ORDER_STATE } from "../domain/orders.js";
import { SALE_SLOT_STATE } from "../domain/sale-slots.js";
import { deriveCameraTransform } from "../world/camera.js";
import {
  DYNAMIC_SERVICE_TARGET_KIND,
  normalizeDynamicServiceTarget,
  resolveDynamicServiceTarget,
} from "../world/dynamic-target-resolver.js";
import {
  CanvasRectAdapter,
  InputTransform,
} from "../world/input-transform.js";
import { WorldInteractionRouter } from "../world/interaction-router.js";
import {
  PLAYER_MOVEMENT_STEP_MILLI_PX,
  PlayerController,
} from "../world/player-controller.js";
import { CANVAS_LOGICAL_SIZE } from "./canvas-scene.js";
import { InputRouter } from "./input-router.js";
import { PanelManager, STATIC_PANEL_DEFINITIONS } from "./panel-manager.js";

export const PROTOTYPE_WORLD_CONTRACT = Object.freeze({
  tileSize: 32,
  widthTiles: 15,
  heightTiles: 15,
  width: 480,
  height: 480,
});

export const PROTOTYPE_ZONES = Object.freeze([
  Object.freeze({
    id: "board",
    label: "길드 게시판",
    x: 20,
    y: 20,
    w: 100,
    h: 80,
    color: "#4a6fa5",
    body: "(3단계에서 구현 예정)",
  }),
  Object.freeze({
    id: "stove",
    label: "조리대",
    x: 360,
    y: 20,
    w: 100,
    h: 80,
    color: "#c9752f",
    body: "(5단계에서 구현 예정)",
  }),
  Object.freeze({
    id: "counter",
    label: "카운터",
    x: 190,
    y: 380,
    w: 100,
    h: 80,
    color: "#5a9e6f",
    body: "(6단계에서 구현 예정)",
  }),
]);

const SEMANTIC_COLORS = Object.freeze({
  board: "#4a6fa5",
  stove: "#c9752f",
  counter: "#5a9e6f",
  storage: "#775a9e",
});

function prototypeRuntimeMapDefinition() {
  const area = PROTOTYPE_WORLD_CONTRACT.widthTiles * PROTOTYPE_WORLD_CONTRACT.heightTiles;
  return freezeDeep({
    schemaVersion: 1,
    mapId: "map.prototype_runtime",
    width: PROTOTYPE_WORLD_CONTRACT.widthTiles,
    height: PROTOTYPE_WORLD_CONTRACT.heightTiles,
    tileSize: PROTOTYPE_WORLD_CONTRACT.tileSize,
    layers: {
      ground: Array(area).fill("tile.prototype.floor"),
      collision: Array(area).fill(0),
      below: Array(area).fill(null),
      above: Array(area).fill(null),
    },
    objects: [],
    zones: PROTOTYPE_ZONES.map((zone) => ({
      zoneId: `zone.prototype-runtime.${zone.id}`,
      semantic: zone.id,
      rect: { x: zone.x, y: zone.y, width: zone.w, height: zone.h },
      approachTileIds: [`approach.prototype-runtime.${zone.id}`],
    })),
    navigation: {
      playerStart: {
        pointId: "point.prototype-runtime.player-start",
        tileX: 7,
        tileY: 7,
        offsetX: 16,
        offsetY: 16,
      },
      spawnPoint: { pointId: "point.prototype-runtime.spawn", tileX: 1, tileY: 13, offsetX: 16, offsetY: 16 },
      exitPoint: { pointId: "point.prototype-runtime.exit", tileX: 2, tileY: 13, offsetX: 16, offsetY: 16 },
      approachPoints: [],
      seatPoints: [],
      tableServiceTargets: [],
      transitions: [],
    },
    expansionRegions: [],
  });
}

export const PROTOTYPE_RUNTIME_MAP_DEFINITION = prototypeRuntimeMapDefinition();

function presentationForZone(zone) {
  const prototype = PROTOTYPE_ZONES.find((candidate) => candidate.id === zone.semantic);
  const definition = STATIC_PANEL_DEFINITIONS[zone.semantic] ?? {
    label: zone.semantic,
    body: `${zone.semantic} 상호작용`,
  };
  return Object.freeze({
    id: zone.semantic,
    zoneId: zone.zoneId,
    semantic: zone.semantic,
    label: prototype?.label ?? definition.label,
    body: prototype?.body ?? definition.body,
    x: zone.rect.x,
    y: zone.rect.y,
    w: zone.rect.width,
    h: zone.rect.height,
    color: prototype?.color ?? SEMANTIC_COLORS[zone.semantic] ?? "#666666",
  });
}

function lowerDirection(direction) {
  return direction.toLowerCase();
}

function invokeSynchronous(callback, value, field) {
  const outcome = callback(value);
  if (outcome && typeof outcome.then === "function") {
    throw new TypeError(`${field} callback은 Promise를 반환할 수 없습니다.`);
  }
  return outcome;
}

/** Task 24 최소 배선: board panel의 시장 구매/메뉴 확정/Service 시작 real command 3개. */
function boardActions(app) {
  const composition = createRuntimeComposition(app);
  return [
    {
      label: "재료 구매",
      async onClick() {
        const { offers } = resolveOrderableRecipe(app);
        let last = { ok: true };
        for (const offer of offers) {
          last = await composition.buyMarketOffer(offer);
          if (!last.ok) return last;
        }
        return last;
      },
    },
    {
      label: "메뉴 확정",
      async onClick() {
        const { recipeId, recipe } = resolveOrderableRecipe(app);
        const edited = await composition.confirmMenuEntry({
          recipeId,
          enabled: true,
          priceG: recipe.basePriceG,
          plannedQuantity: 1,
        });
        if (!edited.ok) return edited;
        return composition.confirmMenuPlan();
      },
    },
    {
      label: "Service 시작",
      onClick: () => composition.startService(),
    },
  ];
}

/** stove panel: ACTIVE order가 있으면 그 slot을, 없으면 첫 AVAILABLE slot을 조리한다. */
function stoveActions(app) {
  const composition = createRuntimeComposition(app);
  return [
    {
      label: "조리 시작",
      onClick: () => {
        const snapshot = app.store.getSnapshot();
        const activeOrder = snapshot.service.orders.find(
          (order) => order.state === ACTIVE_ORDER_STATE.ACTIVE,
        );
        const slot = activeOrder
          ? snapshot.saleSlots.slots.find((candidate) => candidate.saleSlotId === activeOrder.saleSlotId)
          : snapshot.saleSlots.slots.find((candidate) => candidate.state === SALE_SLOT_STATE.AVAILABLE);
        if (!slot) return Promise.resolve({ ok: false, code: "NO_COOKABLE_SLOT" });
        return composition.startCook({
          recipeId: slot.recipeId,
          saleSlotId: slot.saleSlotId,
          sourceOrderId: activeOrder ? activeOrder.orderId : null,
        });
      },
    },
    {
      label: "조리 완료",
      onClick: () => {
        const timingCook = app.store.getSnapshot().service.timingCook;
        if (!timingCook) return Promise.resolve({ ok: false, code: "NO_RUNNING_COOK" });
        return composition.completeCook({ inputAtMs: timingCook.targetAtMs });
      },
    },
  ];
}

/** counter panel: 첫 ACTIVE order에 carried dish를 서빙한다. */
function counterActions(app) {
  const composition = createRuntimeComposition(app);
  return [
    {
      label: "서빙",
      onClick: () => {
        const activeOrder = app.store.getSnapshot().service.orders.find(
          (order) => order.state === ACTIVE_ORDER_STATE.ACTIVE,
        );
        if (!activeOrder) return Promise.resolve({ ok: false, code: "NO_ACTIVE_ORDER" });
        return composition.serveOrder({ targetOrderId: activeOrder.orderId });
      },
    },
  ];
}

const PANEL_ACTION_BUILDERS = Object.freeze({
  board: boardActions,
  stove: stoveActions,
  counter: counterActions,
});

/**
 * Browser adapter retained under its prototype name for compatibility. Player movement, static
 * zone opens, and dynamic action commands all pass through production World/Input routers.
 */
export class PrototypeHubAdapter {
  constructor({
    scene,
    panelOverlay,
    panelTitle,
    panelBody,
    panelCloseButton,
    mapDefinition = PROTOTYPE_RUNTIME_MAP_DEFINITION,
    inputTarget = window,
    onInteractionCommand = () => undefined,
    getApp = () => null,
  }) {
    if (typeof onInteractionCommand !== "function") {
      throw new TypeError("onInteractionCommand는 함수여야 합니다.");
    }
    this.getApp = getApp;
    this.scene = scene;
    this.inputTarget = inputTarget;
    this.root = panelOverlay.ownerDocument;
    this.onInteractionCommand = onInteractionCommand;
    this.inputRouter = null;
    this.interactionRouter = null;
    this.panelManager = new PanelManager({
      root: this.root,
      overlay: panelOverlay,
      title: panelTitle,
      body: panelBody,
      closeButton: panelCloseButton,
      canvas: scene.canvas,
      onContextChange: () => {
        this.clearMovementInput();
        this.inputRouter?.syncContext();
      },
    });
    this.canvasRectAdapter = new CanvasRectAdapter(scene.canvas);
    this.inputTransform = new InputTransform({
      rectAdapter: this.canvasRectAdapter,
      cameraProvider: () => this.getCameraTransform(),
      viewport: CANVAS_LOGICAL_SIZE,
    });

    this.animationFrame = 1;
    this.animationTimer = 0;
    this.running = false;
    this.inputActive = false;
    this.lastFrameTime = null;
    this.animationFrameRequest = null;
    this.controller = null;
    this.mapDefinition = null;
    this.zonePresentations = [];
    this.guestOrderTargets = Object.freeze([]);
    this.interactionCommands = [];
    this.lastPointerWorld = null;
    this.lastInputTransformCode = null;
    this.destroyed = false;

    this.gameLoop = this.gameLoop.bind(this);
    this.setMapDefinition(mapDefinition);
    this.interactionRouter = new WorldInteractionRouter({
      mapDefinition: this.mapDefinition,
      dynamicTargetProvider: () => this.guestOrderTargets,
      onStaticOpen: (request) => this.#openStaticRequest(request),
      onDynamicCommand: (command) => this.#publishInteractionCommand(command),
    });
    this.inputRouter = new InputRouter({
      root: this.root,
      inputTarget: this.inputTarget,
      canvas: this.scene.canvas,
      inputTransform: this.inputTransform,
      modalOpenProvider: () => this.root.documentElement.dataset.credits === "open",
      panelOpenProvider: () => this.panelManager.isOpen,
      canvasActiveProvider: () => this.inputActive,
      onMovement: (logical) => this.controller.setDirectionHeld(logical.direction, logical.held),
      onAction: (logical) => this.routeInteractionAction({
        inputSource: logical.source,
        inputWorldPoint: logical.worldPoint,
      }),
      onPointerWorld: (logical) => this.#publishPointerWorld(logical),
      onTransformError: (failure) => this.#publishInputTransformError(failure),
      onClearMovement: () => this.clearMovementInput(),
    });
  }

  get panelOpen() {
    return this.panelManager.isOpen;
  }

  activate() {
    this.inputActive = true;
    this.inputRouter?.syncContext();
  }

  deactivate() {
    this.inputActive = false;
    this.inputRouter?.syncContext();
  }

  start() {
    this.activate();
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = null;
    this.animationFrameRequest = this.inputTarget.requestAnimationFrame(this.gameLoop);
  }

  stop({ deactivate = false } = {}) {
    if (this.animationFrameRequest !== null) {
      this.inputTarget.cancelAnimationFrame(this.animationFrameRequest);
    }
    this.animationFrameRequest = null;
    this.running = false;
    this.lastFrameTime = null;
    if (deactivate) this.deactivate();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop({ deactivate: true });
    this.inputRouter?.destroy();
  }

  setMapDefinition(mapDefinition) {
    if (!mapDefinition || typeof mapDefinition !== "object") throw new TypeError("runtime Map definition이 필요합니다.");
    this.panelManager.close({ returnFocus: false });
    this.mapDefinition = mapDefinition;
    this.controller = new PlayerController({
      mapDefinition,
      movementStepMilliPx: PLAYER_MOVEMENT_STEP_MILLI_PX,
    });
    this.zonePresentations = Object.freeze((mapDefinition.zones ?? []).map(presentationForZone));
    this.guestOrderTargets = Object.freeze([]);
    this.interactionCommands = [];
    this.interactionRouter?.setMapDefinition(mapDefinition);
    this.animationFrame = 1;
    this.animationTimer = 0;
    this.lastPointerWorld = null;
    this.lastInputTransformCode = null;
    this.render();
    return this.getWorldSnapshot();
  }

  usePrototypeRegressionMap() {
    return this.setMapDefinition(PROTOTYPE_RUNTIME_MAP_DEFINITION);
  }

  gameLoop(time) {
    if (!this.running) return;
    const deltaMs = this.lastFrameTime === null ? 0 : time - this.lastFrameTime;
    this.lastFrameTime = time;
    this.step(deltaMs);
    this.animationFrameRequest = this.inputTarget.requestAnimationFrame(this.gameLoop);
  }

  clearMovementInput() {
    this.controller?.clearHeldMovement();
  }

  step(deltaMs = 0) {
    const movementAllowed = !this.panelManager.isOpen &&
      this.root.documentElement.dataset.credits !== "open";
    const result = this.controller.step({ movementAllowed });
    this.#processZoneTransitions(result.zoneTransitions);
    this.updateAnimation(deltaMs);
    this.render();
    return this.getWorldSnapshot();
  }

  updateAnimation(deltaMs) {
    if (!this.controller.snapshot().player.moving) {
      this.animationFrame = 1;
      this.animationTimer = 0;
      return;
    }
    this.animationTimer += Math.max(0, deltaMs);
    if (this.animationTimer >= 120) {
      const elapsedFrames = Math.floor(this.animationTimer / 120);
      this.animationTimer %= 120;
      this.animationFrame = 1 + ((this.animationFrame - 1 + elapsedFrames) % 8);
    }
  }

  openPanel(zone) {
    this.clearMovementInput();
    const app = this.getApp();
    const builder = app ? PANEL_ACTION_BUILDERS[zone.semantic] : undefined;
    return this.panelManager.open({
      zoneId: zone.zoneId,
      semantic: zone.semantic,
      label: zone.label,
      body: zone.body,
      actions: builder ? builder(app) : [],
    });
  }

  closePanel({ returnFocus = true } = {}) {
    const activeZoneId = this.panelManager.activeZoneId;
    if (activeZoneId) this.controller.dismissZone(activeZoneId);
    this.clearMovementInput();
    return this.panelManager.close({ returnFocus });
  }

  setPlayerPosition(x, y) {
    const result = this.controller.setFootPositionLogical(x, y);
    this.#processZoneTransitions(result.zoneTransitions);
    this.render();
    return this.getWorldSnapshot();
  }

  setGuestOrderTargets(targets) {
    if (!Array.isArray(targets)) throw new TypeError("guest order targets는 배열이어야 합니다.");
    const normalized = targets.map((target, index) => normalizeDynamicServiceTarget(target, index));
    if (normalized.some((target) => target.kind !== DYNAMIC_SERVICE_TARGET_KIND.GUEST_ORDER)) {
      throw new TypeError("runtime guest target provider에는 GUEST_ORDER만 등록할 수 있습니다.");
    }
    resolveDynamicServiceTarget({
      playerFootMilliPx: this.controller.snapshot().player.footMilliPx,
      targets: [...this.interactionRouter.authoredTableTargets, ...normalized],
    });
    this.guestOrderTargets = Object.freeze(normalized);
    return this.getInteractionSnapshot();
  }

  clearGuestOrderTargets() {
    this.guestOrderTargets = Object.freeze([]);
    return this.getInteractionSnapshot();
  }

  clearInteractionCommands() {
    this.interactionCommands = [];
    return this.getInteractionSnapshot();
  }

  routeInteractionAction({ inputSource = "PROGRAMMATIC", inputWorldPoint = null } = {}) {
    return this.interactionRouter.routeAction({
      playerFootMilliPx: this.controller.snapshot().player.footMilliPx,
      inputSource,
      inputWorldPoint,
    });
  }

  reset() {
    this.clearMovementInput();
    this.panelManager.close({ returnFocus: false });
    this.controller.reset();
    this.guestOrderTargets = Object.freeze([]);
    this.interactionCommands = [];
    this.animationFrame = 1;
    this.animationTimer = 0;
    this.lastPointerWorld = null;
    this.lastInputTransformCode = null;
    this.render();
    return this.getWorldSnapshot();
  }

  getWorldSnapshot() {
    return this.controller.snapshot();
  }

  getCameraTransform() {
    const world = this.controller.snapshot();
    return deriveCameraTransform({
      mapDefinition: this.mapDefinition,
      playerFootLogicalPx: world.player.footLogicalPx,
      viewport: CANVAS_LOGICAL_SIZE,
    });
  }

  clientToWorld(clientX, clientY) {
    return this.inputTransform.clientToWorld(clientX, clientY);
  }

  worldToClient(worldX, worldY) {
    return this.inputTransform.worldToClient(worldX, worldY);
  }

  getInteractionSnapshot() {
    const targets = this.interactionRouter?.getDynamicTargets() ?? [];
    return freezeDeep({
      router: this.interactionRouter?.snapshot() ?? null,
      input: this.inputRouter?.snapshot() ?? null,
      dynamicTargets: targets,
      guestOrderTargetCount: this.guestOrderTargets.length,
      commands: [...this.interactionCommands],
    });
  }

  getState() {
    const world = this.controller.snapshot();
    const camera = this.getCameraTransform();
    const inside = Object.entries(world.staticZoneOccupancy)
      .find(([, occupancy]) => occupancy.inside);
    const player = world.player;
    return freezeDeep({
      player: {
        x: player.footLogicalPx.x,
        y: player.footLogicalPx.y,
        speed: PLAYER_MOVEMENT_STEP_MILLI_PX / 1_000,
        dir: lowerDirection(player.direction),
        moving: player.moving,
        collisionWidth: player.collisionWidth,
        collisionHeight: player.collisionHeight,
        footMilliPx: player.footMilliPx,
      },
      camera,
      inputTransform: {
        lastCode: this.lastInputTransformCode,
        lastPointerWorld: this.lastPointerWorld,
      },
      interaction: this.getInteractionSnapshot(),
      panelOpen: this.panelManager.isOpen,
      currentZoneId: inside?.[1].semantic ?? null,
      activePanelZoneId: this.panelManager.activeSemantic,
      activeMapId: world.mapId,
      heldMovementDirections: world.heldMovementDirections,
      staticZoneOccupancy: world.staticZoneOccupancy,
      animationFrame: this.animationFrame,
      worldSnapshot: world,
    });
  }

  render() {
    const world = this.controller.snapshot();
    const camera = this.getCameraTransform();
    this.scene.render({
      camera,
      zones: this.zonePresentations,
      player: {
        x: world.player.footLogicalPx.x,
        y: world.player.footLogicalPx.y,
        dir: lowerDirection(world.player.direction),
        moving: world.player.moving,
      },
      animationFrame: this.animationFrame,
    });
  }

  #processZoneTransitions(transitions) {
    if (this.panelManager.isOpen || !this.interactionRouter) return null;
    return this.interactionRouter.routeStaticTransitions(transitions);
  }

  #openStaticRequest(request) {
    if (this.panelManager.isOpen) return;
    const presentation = this.zonePresentations.find((zone) => zone.zoneId === request.zoneId);
    if (presentation) this.openPanel(presentation);
  }

  #publishInteractionCommand(command) {
    this.interactionCommands.push(command);
    invokeSynchronous(this.onInteractionCommand, command, "onInteractionCommand");
    const EventConstructor = this.inputTarget.CustomEvent ?? this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor === "function") {
      this.root.dispatchEvent(new EventConstructor("world:interaction-command", {
        detail: command,
      }));
    }
  }

  #publishPointerWorld(logical) {
    this.lastPointerWorld = logical.worldPoint;
    this.lastInputTransformCode = "INPUT_TRANSFORM_OK";
    const EventConstructor = this.inputTarget.CustomEvent ?? this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor === "function") {
      this.root.dispatchEvent(new EventConstructor("world:pointer-coordinate", {
        detail: freezeDeep({ kind: logical.pointerEventType, worldPoint: logical.worldPoint }),
      }));
    }
  }

  #publishInputTransformError(failure) {
    this.lastInputTransformCode = failure.code;
    const EventConstructor = this.inputTarget.CustomEvent ?? this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor === "function") {
      this.root.dispatchEvent(new EventConstructor("world:pointer-transform-error", {
        detail: failure,
      }));
    }
  }
}
