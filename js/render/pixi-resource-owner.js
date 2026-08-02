/**
 * Task 32 — design.md 11.1 §3.7 ownership token. Map 교체·campaign restart·bootstrap
 * failure·페이지 종료에서 scene children, sprites, graphics, render textures, Application,
 * listener, GPU resource를 idempotent하게 destroy한다. 공유 texture source는 reference
 * count가 0일 때만 해제한다.
 */
export class PixiResourceOwner {
  constructor() {
    this._textureRefCounts = new Map();
    this._children = new Set();
    this._destroyed = false;
  }

  get destroyed() {
    return this._destroyed;
  }

  /** Assets.load(url)로 얻은 텍스처를 소유권 목록에 등록하고 참조 수를 늘린다. */
  acquireTexture(url, texture) {
    if (this._destroyed) throw new Error("이미 destroy된 PixiResourceOwner는 재사용할 수 없습니다.");
    const entry = this._textureRefCounts.get(url) ?? { texture, count: 0 };
    entry.count += 1;
    this._textureRefCounts.set(url, entry);
    return texture;
  }

  /** 더 이상 쓰지 않는 텍스처의 참조를 하나 줄이고, 0이 되면 즉시 destroy한다. */
  releaseTexture(url) {
    const entry = this._textureRefCounts.get(url);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) {
      this._textureRefCounts.delete(url);
      entry.texture.destroy(true);
    }
  }

  /** container/sprite/graphics 등 destroy()를 갖는 PixiJS 객체를 추적한다. */
  track(displayObject) {
    if (this._destroyed) throw new Error("이미 destroy된 PixiResourceOwner는 재사용할 수 없습니다.");
    this._children.add(displayObject);
    return displayObject;
  }

  untrack(displayObject) {
    this._children.delete(displayObject);
  }

  /** Application·container·남은 텍스처를 전부 정리한다. 두 번 호출해도 안전하다(idempotent). */
  destroy(application) {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const child of this._children) {
      if (!child.destroyed) {
        try {
          child.destroy({ children: true });
        } catch {
          // destroy 중 개별 실패는 나머지 정리를 막지 않는다 — domain state와 무관한 renderer 정리다.
        }
      }
    }
    this._children.clear();
    for (const [, entry] of this._textureRefCounts) {
      try {
        entry.texture.destroy(true);
      } catch {
        // 위와 동일한 이유로 무시한다.
      }
    }
    this._textureRefCounts.clear();
    if (application && typeof application.destroy === "function") {
      application.destroy(false, { children: true, texture: false });
    }
  }
}
