/**
 * Task 33 / Requirement 12.4 — mandatory first-campaign guidance covering Planning/Service/
 * Settlement purpose, movement, action, pause, and the PLANNING_READY rollback boundary. No
 * optional step-by-step tutorial script is built (out of hackathon scope); dismissing this single
 * mandatory screen is the only "skip" and always leads straight into Day 1 Planning.
 */

const STORAGE_KEY = "dungeon-restaurant.onboarding-seen.v1";

const GUIDANCE_ITEMS = Object.freeze([
  { title: "Planning", body: "재료를 구매하고 오늘 팔 Recipe를 확정합니다. 길드 게시판에서 처리합니다." },
  { title: "Service", body: "손님이 입장·주문하면 조리대에서 조리하고 카운터에서 서빙합니다. 방향키/WASD로 이동, E·Enter·Space 또는 클릭으로 상호작용합니다." },
  { title: "Settlement", body: "영업이 끝나면 매출·원가·이익이 정산되어 결산 화면에 표시되고 다음 날로 넘어갑니다." },
  { title: "일시정지", body: "HUD의 일시정지 버튼으로 언제든 Service 진행을 멈추고 재개할 수 있습니다." },
  { title: "되돌리기 경계", body: "Service를 시작하면 그날 Planning으로 되돌릴 수 없습니다. 되돌리기는 그날 Planning 시작 시점(PLANNING_READY)까지만 가능합니다." },
]);

function readSeenFlag(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSeenFlag(storage) {
  try {
    storage?.setItem(STORAGE_KEY, "1");
  } catch {
    // localStorage 접근 불가(private mode 등)는 guidance 반복 표시로만 이어지는 UI 편의 저하일 뿐이므로 무시한다.
  }
}

export class OnboardingGuide {
  constructor({ root, overlay, list, closeButton, storage = null }) {
    for (const [field, value] of Object.entries({ root, overlay, list, closeButton })) {
      if (!value) throw new TypeError(`OnboardingGuide ${field} 요소가 필요합니다.`);
    }
    this.root = root;
    this.overlay = overlay;
    this.list = list;
    this.closeButton = closeButton;
    this.storage = storage;
    this.focusManager = new FocusManager({
      root,
      container: overlay,
      onEscape: () => this.closeButton.click(),
    });
    this.overlay.setAttribute("aria-hidden", "true");
  }

  shouldShow() {
    return !readSeenFlag(this.storage);
  }

  show() {
    this.list.textContent = "";
    for (const item of GUIDANCE_ITEMS) {
      const li = this.root.createElement("li");
      const strong = this.root.createElement("strong");
      strong.textContent = `${item.title} — `;
      li.append(strong, this.root.createTextNode(item.body));
      this.list.append(li);
    }
    this.overlay.classList.remove("hidden");
    this.overlay.setAttribute("aria-hidden", "false");
    this.root.documentElement.dataset.modalOpen = "open";
    this.#publishModalContextChange(true);
    this.focusManager.activate({ initialFocus: this.closeButton });
    return new Promise((resolve) => {
      const onClose = () => {
        this.closeButton.removeEventListener("click", onClose);
        this.overlay.classList.add("hidden");
        this.overlay.setAttribute("aria-hidden", "true");
        this.root.documentElement.dataset.modalOpen = "closed";
        this.focusManager.deactivate({ returnFocus: false });
        this.#publishModalContextChange(false);
        writeSeenFlag(this.storage);
        resolve();
      };
      this.closeButton.addEventListener("click", onClose);
    });
  }

  destroy() {
    this.focusManager.destroy();
  }

  #publishModalContextChange(open) {
    const EventConstructor = this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor !== "function") return;
    this.root.dispatchEvent(new EventConstructor("ui:modal-context-change", {
      detail: Object.freeze({ modal: "onboarding", open }),
    }));
  }
}
import { FocusManager } from "./focus-manager.js";
