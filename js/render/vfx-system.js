/**
 * Task 32 — design.md 11.1 vfxContainer: "committed event에서 파생한 결과 중립 World VFX".
 * simulationTimeMs만으로 age를 계산하는 순수 스폰/정리 큐다 — PixiJS Ticker/RAF/wall-clock을
 * 쓰지 않는다. PixiWorldRenderer가 이 큐를 읽어 스프라이트를 만들고 지운다.
 */
export class VfxSystem {
  constructor(sheetConfig) {
    this.sheetConfig = sheetConfig;
    this._active = [];
    this._nextInstanceId = 0;
  }

  /** bootstrap.js의 committed event 구독이 호출한다. */
  spawn({ vfxId, x, y, atMs }) {
    const definition = this.sheetConfig.vfx.find((entry) => entry.id === vfxId);
    if (!definition) return null;
    const durationMs = Math.ceil((this.sheetConfig.vfxSheet.frameCount / definition.fps) * 1000);
    const instanceId = `vfx:${this._nextInstanceId++}`;
    this._active.push({ instanceId, vfxId, x, y, startedAtMs: atMs, durationMs, fps: definition.fps, anchor: definition.anchor });
    return instanceId;
  }

  /** simulationTimeMs 기준으로 만료된 항목을 지우고, 지금 살아있는 항목들의 프레임을 계산해 돌려준다. */
  update(simulationTimeMs) {
    this._active = this._active.filter((entry) => simulationTimeMs - entry.startedAtMs < entry.durationMs);
    return this._active.map((entry) => {
      const elapsedMs = Math.max(0, simulationTimeMs - entry.startedAtMs);
      const frameIndex = Math.min(
        this.sheetConfig.vfxSheet.frameCount - 1,
        Math.floor((elapsedMs / 1000) * entry.fps),
      );
      const { columns, frameWidth, frameHeight } = this.sheetConfig.vfxSheet;
      const column = frameIndex % columns;
      const row = Math.floor(frameIndex / columns);
      return {
        instanceId: entry.instanceId,
        vfxId: entry.vfxId,
        x: entry.x,
        y: entry.y,
        anchor: entry.anchor,
        frame: { x: column * frameWidth, y: row * frameHeight, width: frameWidth, height: frameHeight },
      };
    });
  }

  clear() {
    this._active = [];
  }
}
