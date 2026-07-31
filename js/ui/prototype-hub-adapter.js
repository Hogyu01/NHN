import { CANVAS_LOGICAL_SIZE } from "./canvas-scene.js";

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

const INITIAL_PLAYER = Object.freeze({
  x: 240,
  y: 240,
  r: 14,
  speed: 2.5,
  dir: "down",
});

const MOVEMENT_KEYS = Object.freeze({
  arrowup: "up",
  w: "up",
  arrowdown: "down",
  s: "down",
  arrowleft: "left",
  a: "left",
  arrowright: "right",
  d: "right",
});

function containsPoint(rect, x, y) {
  return x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h;
}

function normalizeKey(key) {
  return typeof key === "string" ? key.toLowerCase() : "";
}

export class PrototypeHubAdapter {
  constructor({
    scene,
    panelOverlay,
    panelTitle,
    panelBody,
    panelCloseButton,
    inputTarget = window,
  }) {
    this.scene = scene;
    this.panelOverlay = panelOverlay;
    this.panelTitle = panelTitle;
    this.panelBody = panelBody;
    this.panelCloseButton = panelCloseButton;
    this.inputTarget = inputTarget;

    this.player = { ...INITIAL_PLAYER, moving: false };
    this.keys = new Set();
    this.panelOpen = false;
    this.currentZoneId = null;
    this.activePanelZoneId = null;
    this.animationFrame = 1;
    this.animationTimer = 0;
    this.running = false;
    this.inputActive = false;
    this.lastFrameTime = null;
    this.animationFrameRequest = null;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.gameLoop = this.gameLoop.bind(this);
    this.inputTarget.addEventListener("keydown", this.handleKeyDown);
    this.inputTarget.addEventListener("keyup", this.handleKeyUp);
    this.render();
  }

  activate() {
    this.inputActive = true;
  }

  deactivate() {
    this.inputActive = false;
    this.clearMovementInput();
  }

  start() {
    this.activate();
    if (this.running) {
      return;
    }
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
    if (deactivate) {
      this.deactivate();
    }
  }

  destroy() {
    this.stop({ deactivate: true });
    this.inputTarget.removeEventListener("keydown", this.handleKeyDown);
    this.inputTarget.removeEventListener("keyup", this.handleKeyUp);
  }

  gameLoop(time) {
    if (!this.running) {
      return;
    }
    const deltaMs = this.lastFrameTime === null ? 0 : time - this.lastFrameTime;
    this.lastFrameTime = time;
    this.step(deltaMs);
    this.animationFrameRequest = this.inputTarget.requestAnimationFrame(this.gameLoop);
  }

  handleKeyDown(event) {
    const key = normalizeKey(event.key);
    if (!this.inputActive || !(key in MOVEMENT_KEYS)) {
      return;
    }
    event.preventDefault();
    if (this.panelOpen) {
      this.clearMovementInput();
      return;
    }
    this.keys.add(key);
  }

  handleKeyUp(event) {
    const key = normalizeKey(event.key);
    if (!(key in MOVEMENT_KEYS)) {
      return;
    }
    event.preventDefault();
    this.keys.delete(key);
  }

  clearMovementInput() {
    this.keys.clear();
    this.player.moving = false;
  }

  step(deltaMs = 0) {
    this.updatePlayer();
    this.updateAnimation(deltaMs);
    this.render();
  }

  updatePlayer() {
    if (this.panelOpen) {
      this.player.moving = false;
      return;
    }

    let dx = 0;
    let dy = 0;
    if (this.keys.has("arrowup") || this.keys.has("w")) dy -= 1;
    if (this.keys.has("arrowdown") || this.keys.has("s")) dy += 1;
    if (this.keys.has("arrowleft") || this.keys.has("a")) dx -= 1;
    if (this.keys.has("arrowright") || this.keys.has("d")) dx += 1;

    this.player.moving = dx !== 0 || dy !== 0;
    if (this.player.moving) {
      const length = Math.hypot(dx, dy);
      this.player.x += (dx / length) * this.player.speed;
      this.player.y += (dy / length) * this.player.speed;

      if (dy < 0) this.player.dir = "up";
      else if (dy > 0) this.player.dir = "down";
      else if (dx < 0) this.player.dir = "left";
      else if (dx > 0) this.player.dir = "right";
    }

    this.player.x = Math.max(
      this.player.r,
      Math.min(CANVAS_LOGICAL_SIZE.width - this.player.r, this.player.x),
    );
    this.player.y = Math.max(
      this.player.r,
      Math.min(CANVAS_LOGICAL_SIZE.height - this.player.r, this.player.y),
    );

    const insideZone = PROTOTYPE_ZONES.find((zone) =>
      containsPoint(zone, this.player.x, this.player.y),
    );
    if (insideZone) {
      if (insideZone.id !== this.currentZoneId) {
        this.currentZoneId = insideZone.id;
        this.openPanel(insideZone);
      }
    } else {
      this.currentZoneId = null;
    }
  }

  updateAnimation(deltaMs) {
    if (!this.player.moving) {
      this.animationFrame = 1;
      this.animationTimer = 0;
      return;
    }

    this.animationTimer += Math.max(0, deltaMs);
    if (this.animationTimer > 120) {
      this.animationTimer = 0;
      this.animationFrame = this.animationFrame >= 8 ? 1 : this.animationFrame + 1;
    }
  }

  openPanel(zone) {
    this.panelOpen = true;
    this.activePanelZoneId = zone.id;
    this.clearMovementInput();
    this.panelTitle.textContent = zone.label;
    this.panelBody.textContent = zone.body;
    this.panelOverlay.classList.remove("hidden");
    this.panelCloseButton.focus({ preventScroll: true });
  }

  closePanel({ returnFocus = true } = {}) {
    this.panelOpen = false;
    this.activePanelZoneId = null;
    this.clearMovementInput();
    this.panelOverlay.classList.add("hidden");
    if (returnFocus) {
      this.scene.canvas.focus({ preventScroll: true });
    }
  }

  setPlayerPosition(x, y) {
    this.player.x = Math.max(this.player.r, Math.min(CANVAS_LOGICAL_SIZE.width - this.player.r, x));
    this.player.y = Math.max(this.player.r, Math.min(CANVAS_LOGICAL_SIZE.height - this.player.r, y));
    this.player.moving = false;
  }

  reset() {
    this.clearMovementInput();
    Object.assign(this.player, INITIAL_PLAYER, { moving: false });
    this.currentZoneId = null;
    this.activePanelZoneId = null;
    this.panelOpen = false;
    this.animationFrame = 1;
    this.animationTimer = 0;
    this.panelOverlay.classList.add("hidden");
    this.render();
  }

  getState() {
    return Object.freeze({
      player: Object.freeze({ ...this.player }),
      panelOpen: this.panelOpen,
      currentZoneId: this.currentZoneId,
      activePanelZoneId: this.activePanelZoneId,
      animationFrame: this.animationFrame,
    });
  }

  render() {
    this.scene.render({
      zones: PROTOTYPE_ZONES,
      player: this.player,
      animationFrame: this.animationFrame,
    });
  }
}
