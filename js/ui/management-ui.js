/**
 * Task 33 — Requirement 12.3 required projections that don't belong to any single zone panel:
 * the always-visible campaign HUD (day/cash/debt/reputation/pause) and the Settlement drill-down
 * shown when `settlement.day-sealed` fires. Pure DOM writers; no domain/command logic here.
 */

const SETTLEMENT_LINES = Object.freeze([
  ["매출", "revenueG"],
  ["판매 수량", "soldQuantity"],
  ["매출원가(COGS)", "cogsG"],
  ["조리 손실", "cookingWasteExpenseG"],
  ["고정비", "fixedCostIncurredG"],
  ["계약 손실", "contractFailureLossG"],
  ["영업이익", "operatingProfitG"],
  ["현금 변동", "netCashChangeG"],
  ["기말 현금", "endingCashG"],
  ["기말 미수금(연체)", "endingArrearsG"],
]);

const PHASE_LABELS = Object.freeze({
  TITLE: "시작",
  PLANNING: "준비",
  SERVICE: "영업 중",
  PAUSED: "일시정지",
  SETTLEMENT: "정산",
  TERMINAL: "완료",
});

function setText(root, selector, value) {
  const element = root.querySelector(selector);
  if (element) element.textContent = String(value);
}

function projectObjective(snapshot, { activeOrderCount, dishCount }) {
  switch (snapshot?.runtimePhase) {
    case "PLANNING":
      return snapshot.menu?.locked
        ? "준비가 끝났습니다. 영업을 시작하세요"
        : "길드 게시판에서 오늘 메뉴를 구성하세요";
    case "SERVICE":
      if (snapshot.service?.carriedDishId) return "완성 요리를 주문한 손님에게 전달하세요";
      if (dishCount > 0) return "배식대에서 완성 요리를 확인하세요";
      if (activeOrderCount > 0) return "화로에서 들어온 주문을 조리하세요";
      return "새 손님의 주문을 기다리는 중입니다";
    case "PAUSED":
      return "영업이 일시정지되었습니다";
    case "SETTLEMENT":
      return "오늘의 정산 결과를 확인하세요";
    case "TERMINAL":
      return "14일간의 식당 운영이 끝났습니다";
    default:
      return "오늘의 식당 운영을 준비하세요";
  }
}

export function updateCampaignHud(root, {
  day,
  totalDays,
  cashG,
  debtG,
  reputation,
  paused,
  snapshot = null,
}) {
  const dayEl = root.querySelector("#hud-day");
  const cashEl = root.querySelector("#hud-cash");
  const debtEl = root.querySelector("#hud-debt");
  const reputationEl = root.querySelector("#hud-reputation");
  const pauseButton = root.querySelector("#btn-pause");
  if (dayEl) dayEl.textContent = `Day ${day}/${totalDays}`;
  if (cashEl) cashEl.textContent = `현금 ${cashG}G`;
  if (debtEl) debtEl.textContent = `부채 ${debtG}G`;
  if (reputationEl) reputationEl.textContent = `평판 ${reputation}/100`;
  if (pauseButton) pauseButton.textContent = paused ? "재개" : "일시정지";

  if (!snapshot) return;
  const phase = snapshot.runtimePhase;
  const entries = snapshot.menu?.locked
    ? snapshot.menu.confirmedEntries
    : snapshot.menu?.draftEntries;
  const menuCount = (entries ?? []).filter(
    (entry) => entry.enabled && entry.plannedQuantity > 0,
  ).length;
  const guestCount = (snapshot.service?.guests ?? []).filter(
    (guest) => guest.state !== "EXITED",
  ).length;
  const activeOrderCount = (snapshot.service?.orders ?? []).filter(
    (order) => order.state === "ACTIVE",
  ).length;
  const dishCount = (snapshot.inventory?.completedDishes ?? []).filter(
    (dish) => dish.state === "CARRIED",
  ).length;
  const phaseEl = root.querySelector("#hud-phase");
  if (phaseEl) {
    phaseEl.textContent = PHASE_LABELS[phase] ?? phase;
    phaseEl.dataset.phase = phase;
  }
  setText(root, "#hud-menu-count", menuCount);
  setText(root, "#hud-guest-count", guestCount);
  setText(root, "#hud-order-count", activeOrderCount);
  setText(root, "#hud-dish-count", dishCount);
  setText(root, "#hud-objective", projectObjective(snapshot, { activeOrderCount, dishCount }));
}

export class SettlementOverlay {
  constructor({ root, overlay, body, closeButton, onClose = () => undefined }) {
    for (const [field, value] of Object.entries({ root, overlay, body, closeButton })) {
      if (!value) throw new TypeError(`SettlementOverlay ${field} 요소가 필요합니다.`);
    }
    this.root = root;
    this.overlay = overlay;
    this.body = body;
    this.closeButton = closeButton;
    this.onClose = onClose;
    this.isOpen = false;
    this._onCloseClick = () => this.close();
    this._onBackdropClick = (event) => {
      if (event.target === this.overlay) this.close();
    };
    this.closeButton.addEventListener("click", this._onCloseClick);
    this.overlay.addEventListener("click", this._onBackdropClick);
    this.focusManager = new FocusManager({ root, container: overlay, onEscape: () => this.close() });
    this.overlay.setAttribute("aria-hidden", "true");
  }

  open(result, { totalDays }) {
    this.body.textContent = "";
    for (const [label, field] of SETTLEMENT_LINES) {
      const dt = this.root.createElement("dt");
      dt.textContent = label;
      const dd = this.root.createElement("dd");
      const value = result[field];
      dd.textContent = typeof value === "number" ? `${value}${field.endsWith("G") ? "G" : ""}` : String(value);
      if (field === "netCashChangeG" && value < 0) dd.classList.add("status-danger");
      if (field === "operatingProfitG" && value < 0) dd.classList.add("status-danger");
      this.body.append(dt, dd);
    }
    const dt = this.root.createElement("dt");
    dt.textContent = "Day";
    const dd = this.root.createElement("dd");
    dd.textContent = `${result.day}/${totalDays}`;
    this.body.prepend(dd);
    this.body.prepend(dt);
    this.overlay.classList.remove("hidden");
    this.overlay.setAttribute("aria-hidden", "false");
    this.root.documentElement.dataset.modalOpen = "open";
    this.isOpen = true;
    this.#publishModalContextChange(true);
    this.focusManager.activate({ initialFocus: this.closeButton });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay.classList.add("hidden");
    this.overlay.setAttribute("aria-hidden", "true");
    this.root.documentElement.dataset.modalOpen = "closed";
    this.#publishModalContextChange(false);
    this.focusManager.deactivate({ returnFocus: false });
    this.onClose();
  }

  destroy() {
    this.close();
    this.closeButton.removeEventListener("click", this._onCloseClick);
    this.overlay.removeEventListener("click", this._onBackdropClick);
    this.focusManager.destroy();
  }

  #publishModalContextChange(open) {
    const EventConstructor = this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor !== "function") return;
    this.root.dispatchEvent(new EventConstructor("ui:modal-context-change", {
      detail: Object.freeze({ modal: "settlement", open }),
    }));
  }
}

export class SettingsOverlay {
  constructor({ root, overlay, closeButton, audioSystem }) {
    for (const [field, value] of Object.entries({ root, overlay, closeButton, audioSystem })) {
      if (!value) throw new TypeError(`SettingsOverlay ${field}가 필요합니다.`);
    }
    this.root = root;
    this.overlay = overlay;
    this.closeButton = closeButton;
    this.audioSystem = audioSystem;
    this.isOpen = false;
    this.focusManager = new FocusManager({ root, container: overlay, onEscape: () => this.close() });
    this._onClose = () => this.close();
    this._onBackdrop = (event) => { if (event.target === overlay) this.close(); };
    closeButton.addEventListener("click", this._onClose);
    overlay.addEventListener("click", this._onBackdrop);
    for (const bus of ["master", "sfx", "bgm"]) {
      const slider = root.querySelector(`#audio-${bus}-volume`);
      const output = root.querySelector(`#audio-${bus}-value`);
      const mute = root.querySelector(`#audio-${bus}-muted`);
      slider?.addEventListener("input", () => {
        const volume = Number(slider.value);
        this.audioSystem.setBusVolume(bus, volume);
        if (output) output.textContent = String(volume);
      });
      mute?.addEventListener("change", () => this.audioSystem.setBusMuted(bus, mute.checked));
    }
    overlay.setAttribute("aria-hidden", "true");
  }

  open(opener = this.root.activeElement) {
    for (const bus of ["master", "sfx", "bgm"]) {
      const settings = this.audioSystem.getBusSettings(bus);
      const slider = this.root.querySelector(`#audio-${bus}-volume`);
      const output = this.root.querySelector(`#audio-${bus}-value`);
      const mute = this.root.querySelector(`#audio-${bus}-muted`);
      if (slider) slider.value = String(settings.volume);
      if (output) output.textContent = String(settings.volume);
      if (mute) mute.checked = settings.muted;
    }
    this.overlay.classList.remove("hidden");
    this.overlay.setAttribute("aria-hidden", "false");
    this.root.documentElement.dataset.modalOpen = "open";
    this.isOpen = true;
    this.focusManager.activate({ initialFocus: this.closeButton, opener });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay.classList.add("hidden");
    this.overlay.setAttribute("aria-hidden", "true");
    this.root.documentElement.dataset.modalOpen = "closed";
    this.focusManager.deactivate({ returnFocus: true });
  }

  destroy() {
    this.close();
    this.closeButton.removeEventListener("click", this._onClose);
    this.overlay.removeEventListener("click", this._onBackdrop);
    this.focusManager.destroy();
  }
}
import { FocusManager } from "./focus-manager.js";
