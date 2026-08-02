import * as PIXI from "../libs/pixijs/pixi.min.js";
import { PixiResourceOwner } from "./pixi-resource-owner.js";
import { resolveDirectionRow, resolveSpriteFrameRect } from "./sprite-animator.js";
import { RECIPE_TEXTURE_PATH, resolveCarriedDishTexturePath } from "./carried-overlay.js";

const VFX_TEXTURE_PATH = Object.freeze({
  "vfx.sale_success": "assets/vfx/vfx-sale-success.png",
  "vfx.cooking_success": "assets/vfx/vfx-cooking-success.png",
  "vfx.cooking_waste": "assets/vfx/vfx-cooking-waste.png",
  "vfx.order_failure": "assets/vfx/vfx-order-failure.png",
});
const HUD_ICON_PATH = Object.freeze({
  "hud.gold": "assets/icons/hud/hud-gold.png",
  "hud.reputation": "assets/icons/hud/hud-reputation.png",
  "hud.timer": "assets/icons/hud/hud-timer.png",
  "world.interaction_marker": "assets/icons/hud/world-interaction-marker.png",
});
export const LOGICAL_SIZE = 480;
const TILE_SIZE = 32;
// 서로 다른 원본 frame을 타일 높이에 맞춰 정규화한다. 프레임을 먼저 자른 뒤 height를
// 고정해야 Pixi가 원본 sheet 전체 크기를 기준으로 스케일을 되돌리지 않는다.
const PLAYER_VISUAL_HEIGHT_PX = 40;
const GUEST_VISUAL_HEIGHT_PX = 36;

// player_walk.png(구 L0_Placeholder, 머리 없는 프로토타입 도형)는 QA fixture 전용으로 남기고,
// 실제 렌더링은 player_ai/*.png(팀원 제공 4방향×4프레임)을 합성한 player_walk_v2.png를 쓴다.
// 이 sheet는 idle 프레임이 따로 없어(hasIdleColumn:false) guest sheet와 같은 규약이다.
export const PLAYER_SHEET = Object.freeze({
  frameWidth: 132,
  frameHeight: 256,
  directionRowOrder: Object.freeze(["DOWN", "LEFT", "RIGHT", "UP"]),
  hasIdleColumn: false,
  walkColumnCount: 4,
  texturePath: "assets/sprites/player_walk_v2.png",
});

export const GUEST_SHEET = Object.freeze({
  frameWidth: 314,
  frameHeight: 314,
  directionRowOrder: Object.freeze(["DOWN", "LEFT", "RIGHT", "UP"]),
  hasIdleColumn: false,
  walkColumnCount: 4,
});

/** guestArchetypeId → assets/sprites/guests_v2/*.png. guest-sprites-v2.json과 같은 목록이다. */
export const GUEST_ARCHETYPE_TEXTURE = Object.freeze({
  "guest.human_adventurer": "assets/sprites/guests_v2/human_adventurer_walk.png",
  "guest.dwarf_courier": "assets/sprites/guests_v2/dwarf_courier_walk.png",
  "guest.goblin_scholar": "assets/sprites/guests_v2/goblin_scholar_walk.png",
  "guest.slime_gourmand": "assets/sprites/guests_v2/slime_gourmand_walk.png",
  "guest.kobold_porter": "assets/sprites/guests_v2/kobold_porter_walk.png",
  "guest.mushroom_traveler": "assets/sprites/guests_v2/mushroom_traveler_walk.png",
});

/**
 * Task 32 — design.md 11.1. `CanvasScene`이 `PrototypeHubAdapter`에 제공하던 `scene.canvas`,
 * asset load lifecycle, `render(snapshot)` 주입 경계를 대체한다. 고정 container 순서(ground/
 * below → shadow → entity → above → overlay → vfx → world HUD)를 유지하고, PixiJS Ticker나
 * RAF timestamp를 gameplay 판정에 쓰지 않는다 — render()는 매 프레임 호출자(PrototypeHubAdapter
 * .step())가 넘겨주는 snapshot만 읽는 pure presentation 함수다.
 */
export class PixiWorldRenderer {
  constructor({ canvas, assetBaseUrl }) {
    if (!canvas) throw new TypeError("PixiWorldRenderer에는 canvas가 필요합니다.");
    this._canvas = canvas;
    this._assetBaseUrl = assetBaseUrl;
    this._resourceOwner = new PixiResourceOwner();
    this._app = null;
    this._ready = false;
    this._readyPromise = null;

    this._containers = {};
    this._textures = new Map();
    this._entitySprites = new Map();
    this._vfxSprites = new Map();
    this._carriedDishSprite = null;
    this._floorTiles = [];
    this._propSprites = [];
    this._zoneMarkerSprites = [];
  }

  get canvas() {
    return this._canvas;
  }

  get ready() {
    return this._ready;
  }

  /** CanvasScene.loadSprite()와 같은 이름의 호환 진입점 — Application init + 텍스처 로드가 끝나면 resolve된다. */
  loadSprite() {
    if (!this._readyPromise) this._readyPromise = this._init();
    return this._readyPromise;
  }

  async _init() {
    this._app = new PIXI.Application();
    const initPromise = this._app.init({
      canvas: this._canvas,
      width: LOGICAL_SIZE,
      height: LOGICAL_SIZE,
      backgroundColor: 0x11131a,
      antialias: false,
      resolution: 1,
      autoDensity: false,
      preference: "webgl",
      hello: false,
      // 제출 영상용 스크린 캡처가 WebGL 버퍼를 그대로 읽을 수 있게 유지한다(작은 성능 비용).
      preserveDrawingBuffer: true,
    });
    // WebGL/context negotiation이 막히는 환경(예: GPU 비활성 headless 브라우저)에서도 무한
    // 대기하지 않고 진단 가능한 에러로 실패하게 한다 — 조용히 영원히 멈추는 것보다 낫다.
    const timeoutMs = 8000;
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`PIXI_INIT_TIMEOUT_${timeoutMs}MS`)), timeoutMs);
    });
    try {
      await Promise.race([initPromise, timeout]);
    } catch (error) {
      this._resourceOwner.destroy(this._app);
      this._app = null;
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
    PIXI.TextureSource.defaultOptions.scaleMode = "nearest";

    const stage = this._app.stage;
    const order = ["tileGround", "tileBelow", "shadow", "entity", "above", "overlay", "vfx", "worldHud"];
    for (const name of order) {
      const container = new PIXI.Container();
      container.label = name;
      this._resourceOwner.track(container);
      stage.addChild(container);
      this._containers[name] = container;
    }

    try {
      await this._loadCoreTextures();
    } catch (error) {
      this._resourceOwner.destroy(this._app);
      this._app = null;
      throw error;
    }
    this._ready = true;
    const playerTexture = this._textures.get(PLAYER_SHEET.texturePath);
    return {
      ready: true,
      width: playerTexture?.source?.width ?? PLAYER_SHEET.frameWidth * PLAYER_SHEET.walkColumnCount,
      height: playerTexture?.source?.height ?? PLAYER_SHEET.frameHeight * PLAYER_SHEET.directionRowOrder.length,
    };
  }

  async _loadTexture(relativePath) {
    if (this._textures.has(relativePath)) return this._textures.get(relativePath);
    const url = new URL(relativePath, this._assetBaseUrl).href;
    const texture = await PIXI.Assets.load({ src: url, data: { scaleMode: "nearest" } });
    texture.source.scaleMode = "nearest";
    this._resourceOwner.acquireTexture(url, texture);
    this._textures.set(relativePath, texture);
    return texture;
  }

  async _loadCoreTextures() {
    await Promise.all([
      this._loadTexture("assets/tiles/tileset/tile_r1_c1.png"),
      this._loadTexture("assets/tiles/tileset/tile_r2_c2.png"),
      this._loadTexture("assets/tiles/furniture/furniture-board.png"),
      this._loadTexture("assets/tiles/furniture/furniture-stove.png"),
      this._loadTexture("assets/tiles/furniture/furniture-counter.png"),
      this._loadTexture("assets/tiles/furniture/furniture-shelf-ingredients.png"),
      this._loadTexture("assets/tiles/furniture/furniture-table.png"),
      this._loadTexture(PLAYER_SHEET.texturePath),
      ...Object.values(GUEST_ARCHETYPE_TEXTURE).map((path) => this._loadTexture(path)),
      ...Object.values(VFX_TEXTURE_PATH).map((path) => this._loadTexture(path)),
      ...Object.values(HUD_ICON_PATH).map((path) => this._loadTexture(path)),
      ...Object.values(RECIPE_TEXTURE_PATH).map((path) => this._loadTexture(path)),
    ]);
  }

  resize() {
    if (!this._ready || !this._app?.renderer) return false;
    this._app.renderer.resize(LOGICAL_SIZE, LOGICAL_SIZE);
    this._canvas.width = LOGICAL_SIZE;
    this._canvas.height = LOGICAL_SIZE;
    return true;
  }

  _frameTexture(relativePath) {
    const base = this._textures.get(relativePath);
    if (!base) throw new Error(`필수 Pixi texture가 준비되지 않았습니다: ${relativePath}`);
    return new PIXI.Texture({ source: base.source });
  }

  /** map이 바뀔 때 한 번만 호출한다 — 바닥/벽/고정 소품은 매 프레임 다시 그리지 않는다. */
  setMapDefinition(mapDefinition) {
    if (!this._ready) return;
    for (const sprite of this._floorTiles) sprite.destroy();
    this._floorTiles = [];
    for (const sprite of this._propSprites) sprite.destroy();
    this._propSprites = [];
    for (const sprite of this._zoneMarkerSprites) sprite.destroy();
    this._zoneMarkerSprites = [];
    this._containers.tileGround.removeChildren();
    this._containers.above.removeChildren();

    const floorTexture = this._textures.get("assets/tiles/tileset/tile_r1_c1.png");
    const wallTexture = this._textures.get("assets/tiles/tileset/tile_r2_c2.png");
    if (floorTexture && wallTexture) {
      for (let y = 0; y < mapDefinition.height; y += 1) {
        for (let x = 0; x < mapDefinition.width; x += 1) {
          const index = y * mapDefinition.width + x;
          const blocked = mapDefinition.layers.collision[index] === 1;
          const sprite = new PIXI.Sprite(blocked ? wallTexture : floorTexture);
          sprite.width = TILE_SIZE;
          sprite.height = TILE_SIZE;
          sprite.x = x * TILE_SIZE;
          sprite.y = y * TILE_SIZE;
          this._containers.tileGround.addChild(sprite);
          this._floorTiles.push(sprite);
        }
      }
    }

    const fixtureTextureByKind = {
      BOARD: "assets/tiles/furniture/furniture-board.png",
      STOVE: "assets/tiles/furniture/furniture-stove.png",
      COUNTER: "assets/tiles/furniture/furniture-counter.png",
      STORAGE: "assets/tiles/furniture/furniture-shelf-ingredients.png",
      TABLE: "assets/tiles/furniture/furniture-table.png",
    };
    const markerTexture = this._textures.get(HUD_ICON_PATH["world.interaction_marker"]);
    for (const object of mapDefinition.objects ?? []) {
      const relativePath = fixtureTextureByKind[object.kind];
      const texture = relativePath ? this._textures.get(relativePath) : null;
      if (!texture) continue;
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5, 0.8);
      const scale = (TILE_SIZE * 1.6) / Math.max(texture.width, texture.height);
      sprite.scale.set(scale);
      sprite.x = object.rect.x + object.rect.width / 2;
      sprite.y = object.rect.y + object.rect.height / 2;
      this._containers.above.addChild(sprite);
      this._propSprites.push(sprite);

      if (markerTexture && object.kind !== "TABLE") {
        const marker = new PIXI.Sprite(markerTexture);
        marker.anchor.set(0.5, 1);
        marker.width = 18;
        marker.height = 18;
        marker.x = object.rect.x + object.rect.width / 2;
        marker.y = object.rect.y - 3;
        this._containers.overlay.addChild(marker);
        this._zoneMarkerSprites.push(marker);
      }
    }
  }

  _entitySprite(key, texturePath) {
    let sprite = this._entitySprites.get(key);
    if (!sprite) {
      sprite = new PIXI.Sprite(this._frameTexture(texturePath));
      sprite.label = key;
      sprite.anchor.set(0.5, 0.9);
      this._containers.entity.addChild(sprite);
      this._entitySprites.set(key, sprite);
    }
    return sprite;
  }

  _removeEntitySprite(key) {
    const sprite = this._entitySprites.get(key);
    if (!sprite) return;
    sprite.texture?.destroy(false);
    sprite.destroy();
    this._entitySprites.delete(key);
  }

  /**
   * pure presentation update. snapshot: {camera, player, guests[], vfxEvents[], simulationTimeMs}.
   * GameStore/revision/RNG/scheduler를 전혀 건드리지 않는다 — 여기서 읽기만 한다.
   */
  render(snapshot) {
    if (!this._ready) return;
    const cameraOrigin = snapshot.camera?.origin ?? { x: 0, y: 0 };
    for (const name of ["tileGround", "tileBelow", "shadow", "entity", "above", "overlay"]) {
      this._containers[name].position.set(-cameraOrigin.x, -cameraOrigin.y);
    }

    if (snapshot.player) {
      const sprite = this._entitySprite("player", PLAYER_SHEET.texturePath);
      sprite.x = Math.round(snapshot.player.x);
      sprite.y = Math.round(snapshot.player.y);
      // 주인장 이동은 domain scheduler가 아니라 실시간 RAF deltaMs로 움직이는 별도 계층이라
      // (design C-component 표), PrototypeHubAdapter가 이미 계산해둔 0~3 column을 그대로
      // 쓴다 — guest처럼 simulationTimeMs 기반 elapsedMs로 다시 계산하지 않는다. idle 프레임이
      // 따로 없는 sheet라(hasIdleColumn:false) 정지 시에는 frame 0을 그대로 재사용한다.
      const row = resolveDirectionRow(PLAYER_SHEET.directionRowOrder, snapshot.player.dir);
      const column = snapshot.player.moving ? (snapshot.animationFrame ?? 0) : 0;
      this._applyFrame(sprite, {
        x: column * PLAYER_SHEET.frameWidth,
        y: row * PLAYER_SHEET.frameHeight,
        width: PLAYER_SHEET.frameWidth,
        height: PLAYER_SHEET.frameHeight,
      });
      sprite.height = PLAYER_VISUAL_HEIGHT_PX;
      sprite.scale.x = sprite.scale.y;
    }

    const seenGuestKeys = new Set();
    for (const guest of snapshot.guests ?? []) {
      const key = `guest:${guest.guestId}`;
      seenGuestKeys.add(key);
      const texturePath = GUEST_ARCHETYPE_TEXTURE[guest.archetypeId];
      if (!texturePath) throw new Error(`등록되지 않은 guest archetype texture입니다: ${guest.archetypeId}`);
      const sprite = this._entitySprite(key, texturePath);
      sprite.x = Math.round(guest.x);
      sprite.y = Math.round(guest.y);
      const frame = resolveSpriteFrameRect(GUEST_SHEET, {
        direction: guest.direction,
        moving: guest.moving,
        animationElapsedMs: guest.animationElapsedMs ?? 0,
      });
      this._applyFrame(sprite, frame);
      sprite.height = GUEST_VISUAL_HEIGHT_PX;
      sprite.scale.x = sprite.scale.y;
    }
    for (const key of [...this._entitySprites.keys()]) {
      if (key.startsWith("guest:") && !seenGuestKeys.has(key)) this._removeEntitySprite(key);
    }

    this._syncCarriedDish(snapshot.carriedDish ?? null, snapshot.player ?? null);
    this._syncVfxSprites(snapshot.vfxEvents ?? []);
    this._sortEntitiesByFootY();
  }

  _applyFrame(sprite, frame) {
    const texture = sprite.texture;
    if (!texture || texture === PIXI.Texture.EMPTY) return;
    texture.frame = new PIXI.Rectangle(frame.x, frame.y, frame.width, frame.height);
    texture.updateUvs();
  }

  _sortEntitiesByFootY() {
    const children = [...this._containers.entity.children];
    children.sort((a, b) => (a.y - b.y) || (a.label ?? "").localeCompare(b.label ?? ""));
    children.forEach((child, index) => { child.zIndex = index; });
    this._containers.entity.sortableChildren = true;
  }

  _syncCarriedDish(carriedDish, player) {
    if (!carriedDish || !player) {
      if (this._carriedDishSprite) {
        this._carriedDishSprite.destroy();
        this._carriedDishSprite = null;
      }
      return;
    }
    const texturePath = resolveCarriedDishTexturePath(carriedDish);
    if (!texturePath) throw new Error(`등록되지 않은 carried dish recipe texture입니다: ${carriedDish.recipeId}`);
    if (!this._carriedDishSprite || this._carriedDishSprite.label !== carriedDish.recipeId) {
      this._carriedDishSprite?.destroy();
      this._carriedDishSprite = new PIXI.Sprite(this._textures.get(texturePath));
      this._carriedDishSprite.label = carriedDish.recipeId;
      this._carriedDishSprite.anchor.set(0.5, 0.5);
      this._carriedDishSprite.width = 24;
      this._carriedDishSprite.height = 24;
      this._containers.overlay.addChild(this._carriedDishSprite);
    }
    this._carriedDishSprite.x = Math.round(player.x);
    this._carriedDishSprite.y = Math.round(player.y) - 38;
  }

  /** vfxContainer 동기화 — VfxSystem.update()가 계산해준 활성 인스턴스만큼만 스프라이트를 유지한다. */
  _syncVfxSprites(vfxEvents) {
    const seen = new Set();
    for (const event of vfxEvents) {
      seen.add(event.instanceId);
      let sprite = this._vfxSprites.get(event.instanceId);
      if (!sprite) {
        const texturePath = VFX_TEXTURE_PATH[event.vfxId];
        if (!texturePath) continue;
        sprite = new PIXI.Sprite(this._frameTexture(texturePath));
        sprite.label = event.instanceId;
        sprite.anchor.set(0.5, event.anchor === "BOTTOM_CENTER" ? 1 : 0.5);
        this._containers.vfx.addChild(sprite);
        this._vfxSprites.set(event.instanceId, sprite);
      }
      sprite.x = Math.round(event.x);
      sprite.y = Math.round(event.y);
      this._applyFrame(sprite, event.frame);
    }
    for (const [instanceId, sprite] of [...this._vfxSprites]) {
      if (!seen.has(instanceId)) {
        sprite.texture?.destroy(false);
        sprite.destroy();
        this._vfxSprites.delete(instanceId);
      }
    }
  }

  /** design 11.1 §3.7 — map 교체·campaign restart·bootstrap failure·페이지 종료에서 호출한다. */
  destroy() {
    for (const key of [...this._entitySprites.keys()]) this._removeEntitySprite(key);
    for (const [, sprite] of this._vfxSprites) {
      sprite.texture?.destroy(false);
      sprite.destroy();
    }
    this._vfxSprites.clear();
    this._carriedDishSprite?.destroy();
    this._carriedDishSprite = null;
    for (const sprite of this._floorTiles) sprite.destroy();
    for (const sprite of this._propSprites) sprite.destroy();
    for (const sprite of this._zoneMarkerSprites) sprite.destroy();
    this._floorTiles = [];
    this._propSprites = [];
    this._zoneMarkerSprites = [];
    this._resourceOwner.destroy(this._app);
    this._app = null;
    this._ready = false;
    this._textures.clear();
    this._containers = {};
  }
}
