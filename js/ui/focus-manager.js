const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function visibleFocusable(container) {
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) =>
    element.getAttribute("aria-hidden") !== "true" && !element.closest("[hidden], .hidden"));
}

/** Small DOM focus trap shared by panels and modal overlays. */
export class FocusManager {
  constructor({ root, container, onEscape = null, returnTarget = null }) {
    if (!root || !container) throw new TypeError("FocusManager에는 root와 container가 필요합니다.");
    this.root = root;
    this.container = container;
    this.onEscape = onEscape;
    this.returnTarget = returnTarget;
    this.active = false;
    this.opener = null;
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  activate({ initialFocus = null, opener = this.root.activeElement } = {}) {
    if (this.active) this.deactivate({ returnFocus: false });
    this.active = true;
    this.opener = opener;
    this.root.defaultView?.addEventListener("keydown", this._onKeyDown);
    const target = initialFocus ?? visibleFocusable(this.container)[0] ?? this.container;
    target.focus?.({ preventScroll: true });
  }

  deactivate({ returnFocus = true } = {}) {
    if (!this.active) return;
    this.active = false;
    this.root.defaultView?.removeEventListener("keydown", this._onKeyDown);
    if (returnFocus) (this.returnTarget ?? this.opener)?.focus?.({ preventScroll: true });
    this.opener = null;
  }

  destroy() {
    this.deactivate({ returnFocus: false });
  }

  _onKeyDown(event) {
    if (!this.active) return;
    if (event.key === "Escape" && typeof this.onEscape === "function") {
      event.preventDefault();
      this.onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const items = visibleFocusable(this.container);
    if (items.length === 0) {
      event.preventDefault();
      this.container.focus?.({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && this.root.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && this.root.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }
}
