import { freezeDeep } from "../core/result.js";
import { PLAYER_DIRECTION } from "../world/player-controller.js";

export const INPUT_CONTEXT = Object.freeze({
  MODAL: "MODAL",
  PANEL: "PANEL",
  CANVAS: "CANVAS",
  GLOBAL: "GLOBAL",
});

export const LOGICAL_INPUT_KIND = Object.freeze({
  MOVEMENT: "MOVEMENT",
  ACTION: "ACTION",
  POINTER_WORLD: "POINTER_WORLD",
  GLOBAL_SHORTCUT: "GLOBAL_SHORTCUT",
});

export const INPUT_SOURCE = Object.freeze({
  KEYBOARD: "KEYBOARD",
  POINTER: "POINTER",
});

export const ACTION_KEYS = Object.freeze(["e", "enter", "space"]);

const MOVEMENT_KEYS = Object.freeze({
  arrowup: PLAYER_DIRECTION.UP,
  w: PLAYER_DIRECTION.UP,
  arrowdown: PLAYER_DIRECTION.DOWN,
  s: PLAYER_DIRECTION.DOWN,
  arrowleft: PLAYER_DIRECTION.LEFT,
  a: PLAYER_DIRECTION.LEFT,
  arrowright: PLAYER_DIRECTION.RIGHT,
  d: PLAYER_DIRECTION.RIGHT,
});

function normalizeKey(key, code = "") {
  if (key === " " || key === "Spacebar" || code === "Space") return "space";
  return typeof key === "string" ? key.toLowerCase() : "";
}

function invokeSynchronous(callback, value, field) {
  const outcome = callback(value);
  if (outcome && typeof outcome.then === "function") {
    throw new TypeError(`${field} callback은 Promise를 반환할 수 없습니다.`);
  }
  return outcome;
}

export function resolveInputContext({ modalOpen, panelOpen, canvasActive }) {
  for (const [field, value] of Object.entries({ modalOpen, panelOpen, canvasActive })) {
    if (typeof value !== "boolean") throw new TypeError(`${field}는 boolean이어야 합니다.`);
  }
  if (modalOpen) return INPUT_CONTEXT.MODAL;
  if (panelOpen) return INPUT_CONTEXT.PANEL;
  if (canvasActive) return INPUT_CONTEXT.CANVAS;
  return INPUT_CONTEXT.GLOBAL;
}

export function keyboardToLogicalInput({ type, key, code = "", repeat = false }) {
  if (type !== "keydown" && type !== "keyup") {
    throw new TypeError("keyboard logical input type은 keydown 또는 keyup이어야 합니다.");
  }
  const normalizedKey = normalizeKey(key, code);
  const direction = MOVEMENT_KEYS[normalizedKey];
  if (direction) {
    return freezeDeep({
      kind: LOGICAL_INPUT_KIND.MOVEMENT,
      source: INPUT_SOURCE.KEYBOARD,
      direction,
      held: type === "keydown",
      key: normalizedKey,
    });
  }
  if (type === "keydown" && ACTION_KEYS.includes(normalizedKey)) {
    return freezeDeep({
      kind: LOGICAL_INPUT_KIND.ACTION,
      source: INPUT_SOURCE.KEYBOARD,
      key: normalizedKey,
      repeated: Boolean(repeat),
      worldPoint: null,
    });
  }
  return null;
}

export function pointerToLogicalAction(worldPoint, pointerType = "mouse") {
  if (!worldPoint || !Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y)) {
    throw new TypeError("pointer logical action에는 finite World point가 필요합니다.");
  }
  return freezeDeep({
    kind: LOGICAL_INPUT_KIND.ACTION,
    source: INPUT_SOURCE.POINTER,
    pointerType: typeof pointerType === "string" && pointerType.length > 0 ? pointerType : "unknown",
    worldPoint: { x: worldPoint.x, y: worldPoint.y },
  });
}

/**
 * Browser input adapter with fixed modal → panel → Canvas → global priority. It never creates a
 * domain payload itself; keyboard and pointer actions share the same World interaction callback.
 */
export class InputRouter {
  constructor({
    root,
    inputTarget,
    canvas,
    inputTransform,
    modalOpenProvider,
    panelOpenProvider,
    canvasActiveProvider,
    onMovement,
    onAction,
    onPointerWorld = () => undefined,
    onTransformError = () => undefined,
    onClearMovement = () => undefined,
    onGlobalShortcut = () => undefined,
  }) {
    if (!root || typeof root.addEventListener !== "function") throw new TypeError("InputRouter root가 필요합니다.");
    if (!inputTarget || typeof inputTarget.addEventListener !== "function") throw new TypeError("InputRouter inputTarget이 필요합니다.");
    if (!canvas || typeof canvas.addEventListener !== "function") throw new TypeError("InputRouter Canvas가 필요합니다.");
    if (!inputTransform || typeof inputTransform.clientToWorld !== "function") throw new TypeError("InputRouter InputTransform이 필요합니다.");
    for (const [field, value] of Object.entries({
      modalOpenProvider,
      panelOpenProvider,
      canvasActiveProvider,
      onMovement,
      onAction,
      onPointerWorld,
      onTransformError,
      onClearMovement,
      onGlobalShortcut,
    })) {
      if (typeof value !== "function") throw new TypeError(`InputRouter ${field}는 함수여야 합니다.`);
    }

    this.root = root;
    this.inputTarget = inputTarget;
    this.canvas = canvas;
    this.inputTransform = inputTransform;
    this.modalOpenProvider = modalOpenProvider;
    this.panelOpenProvider = panelOpenProvider;
    this.canvasActiveProvider = canvasActiveProvider;
    this.onMovement = onMovement;
    this.onAction = onAction;
    this.onPointerWorld = onPointerWorld;
    this.onTransformError = onTransformError;
    this.onClearMovement = onClearMovement;
    this.onGlobalShortcut = onGlobalShortcut;
    this.lastRoute = null;
    this.destroyed = false;

    this.handleKeyDown = (event) => this.routeKeyboardEvent(event);
    this.handleKeyUp = (event) => this.routeKeyboardEvent(event);
    this.handlePointerMove = (event) => this.routePointerEvent(event);
    this.handlePointerDown = (event) => this.routePointerEvent(event);
    this.handleContextChange = () => this.syncContext();
    this.handleBlur = () => invokeSynchronous(this.onClearMovement, undefined, "onClearMovement");

    this.inputTarget.addEventListener("keydown", this.handleKeyDown);
    this.inputTarget.addEventListener("keyup", this.handleKeyUp);
    this.inputTarget.addEventListener("blur", this.handleBlur);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.root.addEventListener("ui:modal-context-change", this.handleContextChange);
  }

  getContext() {
    return resolveInputContext({
      modalOpen: Boolean(this.modalOpenProvider()),
      panelOpen: Boolean(this.panelOpenProvider()),
      canvasActive: Boolean(this.canvasActiveProvider()),
    });
  }

  syncContext() {
    const context = this.getContext();
    if (context !== INPUT_CONTEXT.CANVAS) {
      invokeSynchronous(this.onClearMovement, undefined, "onClearMovement");
    }
    return context;
  }

  routeKeyboardEvent(event) {
    const logical = keyboardToLogicalInput({
      type: event.type,
      key: event.key,
      code: event.code,
      repeat: event.repeat,
    });
    const context = this.getContext();

    if (logical?.kind === LOGICAL_INPUT_KIND.MOVEMENT && !logical.held) {
      invokeSynchronous(this.onMovement, logical, "onMovement");
    }

    if (context !== INPUT_CONTEXT.CANVAS) {
      if (context === INPUT_CONTEXT.MODAL || context === INPUT_CONTEXT.PANEL) {
        invokeSynchronous(this.onClearMovement, undefined, "onClearMovement");
      } else if (event.type === "keydown") {
        invokeSynchronous(this.onGlobalShortcut, freezeDeep({
          kind: LOGICAL_INPUT_KIND.GLOBAL_SHORTCUT,
          key: normalizeKey(event.key, event.code),
        }), "onGlobalShortcut");
      }
      this.lastRoute = freezeDeep({ context, consumedByGameplay: false, logical });
      return this.lastRoute;
    }

    if (!logical) {
      this.lastRoute = freezeDeep({ context, consumedByGameplay: false, logical: null });
      return this.lastRoute;
    }
    event.preventDefault?.();
    if (logical.kind === LOGICAL_INPUT_KIND.MOVEMENT) {
      if (logical.held) invokeSynchronous(this.onMovement, logical, "onMovement");
    } else if (!logical.repeated) {
      invokeSynchronous(this.onAction, logical, "onAction");
    }
    this.lastRoute = freezeDeep({
      context,
      consumedByGameplay: logical.kind !== LOGICAL_INPUT_KIND.ACTION || !logical.repeated,
      logical,
    });
    return this.lastRoute;
  }

  routePointerEvent(event) {
    const context = this.getContext();
    if (context !== INPUT_CONTEXT.CANVAS) {
      this.lastRoute = freezeDeep({ context, consumedByGameplay: false, logical: null });
      return this.lastRoute;
    }
    const transformed = this.inputTransform.clientToWorld(event.clientX, event.clientY);
    if (!transformed.ok) {
      invokeSynchronous(this.onTransformError, freezeDeep({
        code: transformed.code,
        diagnostics: transformed.diagnostics,
      }), "onTransformError");
      this.lastRoute = freezeDeep({ context, consumedByGameplay: false, code: transformed.code, logical: null });
      return this.lastRoute;
    }

    const pointerWorld = freezeDeep({
      kind: LOGICAL_INPUT_KIND.POINTER_WORLD,
      source: INPUT_SOURCE.POINTER,
      pointerEventType: event.type,
      worldPoint: transformed.world,
    });
    invokeSynchronous(this.onPointerWorld, pointerWorld, "onPointerWorld");

    const isPrimaryAction = event.type === "pointerdown" &&
      (event.button === undefined || event.button === 0) &&
      event.isPrimary !== false;
    let logical = pointerWorld;
    if (isPrimaryAction) {
      event.preventDefault?.();
      logical = pointerToLogicalAction(transformed.world, event.pointerType);
      invokeSynchronous(this.onAction, logical, "onAction");
    }
    this.lastRoute = freezeDeep({ context, consumedByGameplay: true, logical });
    return this.lastRoute;
  }

  snapshot() {
    return freezeDeep({
      context: this.getContext(),
      priority: Object.freeze([
        INPUT_CONTEXT.MODAL,
        INPUT_CONTEXT.PANEL,
        INPUT_CONTEXT.CANVAS,
        INPUT_CONTEXT.GLOBAL,
      ]),
      actionKeys: ACTION_KEYS,
      lastRoute: this.lastRoute,
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.inputTarget.removeEventListener("keydown", this.handleKeyDown);
    this.inputTarget.removeEventListener("keyup", this.handleKeyUp);
    this.inputTarget.removeEventListener("blur", this.handleBlur);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.root.removeEventListener("ui:modal-context-change", this.handleContextChange);
  }
}
