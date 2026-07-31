export const CANVAS_LOGICAL_SIZE = Object.freeze({ width: 480, height: 480 });

export const PLAYER_SPRITE_CONTRACT = Object.freeze({
  assetId: "prototype.player_walk.l0",
  maturity: "L0_Placeholder",
  frameWidth: 64,
  frameHeight: 64,
  columns: 9,
  rows: 4,
  directionOrder: Object.freeze(["up", "left", "down", "right"]),
  directionRows: Object.freeze({ up: 0, left: 1, down: 2, right: 3 }),
  idleColumn: 0,
  walkColumns: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
});

export class CanvasScene {
  constructor({ canvas, spriteUrl }) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2D Canvas context를 생성할 수 없습니다.");
    }

    this.canvas = canvas;
    this.context = context;
    this.sprite = new Image();
    this.spriteLoaded = false;
    this.spriteLoadPromise = new Promise((resolve, reject) => {
      this.sprite.addEventListener(
        "load",
        () => {
          this.spriteLoaded = true;
          resolve(this.getSpriteMetadata());
        },
        { once: true },
      );
      this.sprite.addEventListener(
        "error",
        () => reject(new Error(`플레이어 스프라이트를 불러오지 못했습니다: ${spriteUrl}`)),
        { once: true },
      );
    });
    this.sprite.src = spriteUrl.href;
  }

  loadSprite() {
    if (this.sprite.complete && this.sprite.naturalWidth > 0) {
      this.spriteLoaded = true;
      return Promise.resolve(this.getSpriteMetadata());
    }
    return this.spriteLoadPromise;
  }

  getSpriteMetadata() {
    return Object.freeze({
      src: this.sprite.currentSrc || this.sprite.src,
      width: this.sprite.naturalWidth,
      height: this.sprite.naturalHeight,
    });
  }

  render(snapshot) {
    const { context, canvas } = this;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);

    for (const zone of snapshot.zones) {
      context.fillStyle = zone.color;
      context.fillRect(zone.x, zone.y, zone.w, zone.h);
      context.fillStyle = "#f0f0f0";
      context.font = "14px sans-serif";
      context.textAlign = "center";
      context.fillText(zone.label, zone.x + zone.w / 2, zone.y + zone.h / 2 + 5);
    }

    const { player } = snapshot;
    context.beginPath();
    context.ellipse(player.x, player.y + 20, 14, 5, 0, 0, Math.PI * 2);
    context.fillStyle = "rgba(0, 0, 0, 0.35)";
    context.fill();

    if (!this.spriteLoaded || this.sprite.naturalWidth === 0) {
      return;
    }

    const row = PLAYER_SPRITE_CONTRACT.directionRows[player.dir];
    const column = player.moving ? snapshot.animationFrame : PLAYER_SPRITE_CONTRACT.idleColumn;
    context.imageSmoothingEnabled = false;
    context.drawImage(
      this.sprite,
      column * PLAYER_SPRITE_CONTRACT.frameWidth,
      row * PLAYER_SPRITE_CONTRACT.frameHeight,
      PLAYER_SPRITE_CONTRACT.frameWidth,
      PLAYER_SPRITE_CONTRACT.frameHeight,
      player.x - PLAYER_SPRITE_CONTRACT.frameWidth / 2,
      player.y - PLAYER_SPRITE_CONTRACT.frameHeight / 2,
      PLAYER_SPRITE_CONTRACT.frameWidth,
      PLAYER_SPRITE_CONTRACT.frameHeight,
    );
  }
}
