import { freezeDeep } from "../core/result.js";

export const STATIC_PANEL_DEFINITIONS = freezeDeep({
  board: {
    label: "길드 게시판",
    body: "시장·계약·메뉴 계획을 확인합니다.",
  },
  stove: {
    label: "조리대",
    body: "주문 Recipe의 Timing Cook을 시작합니다.",
  },
  counter: {
    label: "카운터",
    body: "완성한 요리와 서빙 대상을 확인합니다.",
  },
  storage: {
    label: "식재료 보관고",
    body: "재료 lot: 0개 · 운반 중 dish: 없음",
  },
});

function projectionFor(semantic, projection = {}) {
  const definition = STATIC_PANEL_DEFINITIONS[semantic] ?? {
    label: semantic,
    body: `${semantic} 상호작용`,
  };
  if (semantic !== "storage") return definition;
  const lots = Array.isArray(projection.lots) ? projection.lots : [];
  const carriedDish = projection.carriedDish ?? null;
  return {
    label: definition.label,
    body: `재료 lot: ${lots.length}개 · 운반 중 dish: ${carriedDish?.recipeId ?? "없음"}`,
  };
}

/** DOM-only panel adapter; zone occupancy remains authoritative in StaticZoneController. */
export class PanelManager {
  constructor({
    root,
    overlay,
    title,
    body,
    closeButton,
    canvas,
    onContextChange = null,
  }) {
    if (!root || typeof root.querySelector !== "function") throw new TypeError("PanelManager root document가 필요합니다.");
    for (const [field, value] of Object.entries({ overlay, title, body, closeButton, canvas })) {
      if (!value) throw new TypeError(`PanelManager ${field} 요소가 필요합니다.`);
    }
    if (onContextChange !== null && typeof onContextChange !== "function") {
      throw new TypeError("PanelManager onContextChange는 함수 또는 null이어야 합니다.");
    }
    this.root = root;
    this.overlay = overlay;
    this.title = title;
    this.body = body;
    this.closeButton = closeButton;
    this.canvas = canvas;
    this.onContextChange = onContextChange;
    this.activeZoneId = null;
    this.activeSemantic = null;
    this.openState = false;
    this.overlay.setAttribute("aria-hidden", "true");
  }

  get isOpen() {
    return this.openState;
  }

  open({ zoneId, semantic, label = undefined, body = undefined, projection = undefined }) {
    if (typeof zoneId !== "string" || zoneId.length === 0 ||
        typeof semantic !== "string" || semantic.length === 0) {
      throw new TypeError("Panel open에는 zoneId와 semantic이 필요합니다.");
    }
    const resolved = projectionFor(semantic, projection);
    this.activeZoneId = zoneId;
    this.activeSemantic = semantic;
    this.openState = true;
    this.title.textContent = label ?? resolved.label;
    this.body.textContent = body ?? resolved.body;
    this.overlay.classList.remove("hidden");
    this.overlay.setAttribute("aria-hidden", "false");
    this.onContextChange?.(true, this.snapshot());
    this.closeButton.focus({ preventScroll: true });
    return this.snapshot();
  }

  close({ returnFocus = true } = {}) {
    const previous = this.snapshot();
    this.activeZoneId = null;
    this.activeSemantic = null;
    this.openState = false;
    this.overlay.classList.add("hidden");
    this.overlay.setAttribute("aria-hidden", "true");
    this.onContextChange?.(false, previous);
    if (returnFocus) this.canvas.focus({ preventScroll: true });
    return previous;
  }

  snapshot() {
    return freezeDeep({
      isOpen: this.openState,
      activeZoneId: this.activeZoneId,
      activeSemantic: this.activeSemantic,
      title: this.title.textContent,
      body: this.body.textContent,
    });
  }
}
