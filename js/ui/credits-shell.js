export const DEFAULT_CREDIT_ENTRIES = Object.freeze([
  Object.freeze({
    assetId: "application.dungeon-restaurant",
    label: "던전 식당 프로토타입 코드와 데이터",
    creator: "프로젝트 팀",
    source: null,
    license: "Project source",
    status: "REGISTERED",
  }),
  Object.freeze({
    assetId: "l0.player.universal-lpc",
    label: "개발용 Player L0 스프라이트",
    creator: "Universal LPC Spritesheet contributors",
    source: "https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator",
    license: "CC-BY-SA 3.0 / GPL 3.0 (dual license)",
    status: "L0_PLACEHOLDER",
  }),
]);

function requireElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`credits shell DOM 요소를 찾을 수 없습니다: ${selector}`);
  return element;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("credit entries는 배열이어야 합니다.");
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") throw new TypeError("credit entry는 object여야 합니다.");
    for (const field of ["assetId", "label", "creator", "license", "status"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new TypeError(`credit entry ${field}가 필요합니다.`);
      }
    }
    if (entry.source !== null && entry.source !== undefined && typeof entry.source !== "string") {
      throw new TypeError("credit source는 문자열 또는 null이어야 합니다.");
    }
    return Object.freeze({
      assetId: entry.assetId,
      label: entry.label,
      creator: entry.creator,
      source: entry.source ?? null,
      license: entry.license,
      status: entry.status,
    });
  });
}

/** Credits modal mounted before data loading, so it remains available on every fatal route. */
export class CreditsShell {
  #entries = [];
  #opener = null;
  #isOpen = false;

  constructor({ root, entries = DEFAULT_CREDIT_ENTRIES }) {
    if (!root || typeof root.querySelector !== "function") throw new TypeError("root document가 필요합니다.");
    this.root = root;
    this.button = requireElement(root, "#btn-credits");
    this.overlay = requireElement(root, "#credits-overlay");
    this.list = requireElement(root, "#credits-list");
    this.closeButton = requireElement(root, "#btn-credits-close");

    this.handleOpen = () => this.open(this.button);
    this.handleClose = () => this.close();
    this.handleKeyDown = (event) => {
      if (this.#isOpen && event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    };
    this.handleBackdrop = (event) => {
      if (event.target === this.overlay) this.close();
    };

    this.button.addEventListener("click", this.handleOpen);
    this.closeButton.addEventListener("click", this.handleClose);
    this.overlay.addEventListener("click", this.handleBackdrop);
    this.root.defaultView?.addEventListener("keydown", this.handleKeyDown);
    this.setEntries(entries);
  }

  get isOpen() {
    return this.#isOpen;
  }

  setEntries(entries) {
    this.#entries = normalizeEntries(entries);
    this.list.replaceChildren();
    for (const entry of this.#entries) {
      const item = this.root.createElement("li");
      item.className = "credit-entry";

      const heading = this.root.createElement("h3");
      heading.textContent = `${entry.label} (${entry.assetId})`;
      item.append(heading);

      const details = this.root.createElement("p");
      details.textContent = `${entry.creator} · ${entry.license} · ${entry.status}`;
      item.append(details);

      if (entry.source) {
        const source = this.root.createElement("a");
        source.href = entry.source;
        source.textContent = "출처 보기";
        source.target = "_blank";
        source.rel = "noopener noreferrer";
        item.append(source);
      }
      this.list.append(item);
    }
    return Object.freeze([...this.#entries]);
  }

  open(opener = this.root.activeElement) {
    this.#opener = opener && typeof opener.focus === "function" ? opener : this.button;
    this.#isOpen = true;
    this.overlay.classList.remove("hidden");
    this.overlay.setAttribute("aria-hidden", "false");
    this.root.documentElement.dataset.credits = "open";
    this.closeButton.focus({ preventScroll: true });
  }

  close() {
    if (!this.#isOpen) return;
    this.#isOpen = false;
    this.overlay.classList.add("hidden");
    this.overlay.setAttribute("aria-hidden", "true");
    this.root.documentElement.dataset.credits = "closed";
    const focusTarget = this.#opener?.isConnected ? this.#opener : this.button;
    this.#opener = null;
    focusTarget.focus({ preventScroll: true });
  }

  destroy() {
    this.button.removeEventListener("click", this.handleOpen);
    this.closeButton.removeEventListener("click", this.handleClose);
    this.overlay.removeEventListener("click", this.handleBackdrop);
    this.root.defaultView?.removeEventListener("keydown", this.handleKeyDown);
  }
}
