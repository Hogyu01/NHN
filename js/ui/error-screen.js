import {
  compareDiagnostics,
  toDiagnosticPresentation,
} from "../core/diagnostic.js";

function requireElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`오류 shell DOM 요소를 찾을 수 없습니다: ${selector}`);
  return element;
}

/**
 * Renders aggregate diagnostics without ever leading with an opaque code. The primary row is
 * always `filename/storage key → errorType`; item, field and code follow in a secondary row.
 */
export class ErrorScreen {
  #blocked = false;

  constructor({ root, showScreen }) {
    if (!root || typeof root.querySelector !== "function") throw new TypeError("root document가 필요합니다.");
    if (typeof showScreen !== "function") throw new TypeError("showScreen callback이 필요합니다.");
    this.root = root;
    this.showScreen = showScreen;
    this.screen = requireElement(root, "#screen-error");
    this.summary = requireElement(root, "#error-summary");
    this.list = requireElement(root, "#error-list");
    this.startButton = requireElement(root, "#btn-start");
  }

  get blocked() {
    return this.#blocked;
  }

  show(diagnostics, { blockStart = true } = {}) {
    if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
      throw new TypeError("표시할 diagnostic이 하나 이상 필요합니다.");
    }
    const ordered = [...diagnostics].sort(compareDiagnostics);
    this.list.replaceChildren();

    ordered.forEach((diagnostic) => {
      const presentation = toDiagnosticPresentation(diagnostic);
      const article = this.root.createElement("article");
      article.className = `diagnostic diagnostic--${presentation.severity.toLowerCase().replaceAll("_", "-")}`;

      const primary = this.root.createElement("p");
      primary.className = "diagnostic-primary";
      primary.textContent = `${presentation.source} · ${presentation.errorType}`;
      article.append(primary);

      const secondary = this.root.createElement("p");
      secondary.className = "diagnostic-secondary";
      secondary.textContent = [
        presentation.itemId ? `item=${presentation.itemId}` : null,
        presentation.fieldPath ? `field=${presentation.fieldPath}` : null,
        `code=${presentation.code}`,
      ].filter(Boolean).join(" · ");
      article.append(secondary);

      if (presentation.details !== null) {
        const details = this.root.createElement("pre");
        details.className = "diagnostic-details";
        details.textContent = JSON.stringify(presentation.details, null, 2);
        article.append(details);
      }
      this.list.append(article);
    });

    this.#blocked = Boolean(blockStart);
    this.startButton.disabled = this.#blocked;
    this.startButton.setAttribute("aria-disabled", String(this.#blocked));
    this.summary.textContent = this.#blocked
      ? `${ordered.length}개 오류로 캠페인 시작이 차단되었습니다. 오류를 수정한 뒤 다시 불러오세요.`
      : `${ordered.length}개 복구 가능한 오류가 있습니다.`;
    this.root.documentElement.dataset.campaignStart = this.#blocked ? "blocked" : "available";
    this.root.documentElement.dataset.validationErrors = String(ordered.length);
    this.showScreen("screen-error");
    this.screen.focus({ preventScroll: true });
    return Object.freeze(ordered);
  }

  clear({ enableStart = true } = {}) {
    this.#blocked = false;
    this.list.replaceChildren();
    this.summary.textContent = "";
    if (enableStart) {
      this.startButton.disabled = false;
      this.startButton.setAttribute("aria-disabled", "false");
    }
    delete this.root.documentElement.dataset.validationErrors;
    this.root.documentElement.dataset.campaignStart = enableStart ? "available" : "blocked";
  }
}
