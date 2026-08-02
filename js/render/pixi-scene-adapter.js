import { PixiWorldRenderer } from "./pixi-world-renderer.js";

/**
 * Task 32 — design.md 11.1. `js/ui/canvas-scene.js`의 `CanvasScene`이 `PrototypeHubAdapter`에
 * 제공하던 좁은 계약(`scene.canvas`, `loadSprite()`, `render(snapshot)`)을 그대로 유지하면서
 * 안은 `PixiWorldRenderer`로 교체하는 얇은 어댑터다. `PrototypeHubAdapter` 쪽 변경을 최소화한다.
 */
export class PixiSceneAdapter {
  constructor({ canvas, assetBaseUrl }) {
    this._renderer = new PixiWorldRenderer({ canvas, assetBaseUrl });
  }

  get canvas() {
    return this._renderer.canvas;
  }

  loadSprite() {
    return this._renderer.loadSprite();
  }

  setMapDefinition(mapDefinition) {
    return this._renderer.setMapDefinition(mapDefinition);
  }

  render(snapshot) {
    return this._renderer.render(snapshot);
  }

  resize() {
    return this._renderer.resize();
  }

  destroy() {
    return this._renderer.destroy();
  }
}
