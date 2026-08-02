/**
 * Task 34 / Requirement 22 AC1~2 — the 5 Must SFX cue IDs, the Tavern_BGM track ID, and the
 * domain event → cue bindings that fire them. `extendedAudio` cues are intentionally not listed
 * here: turning that flag on must add cues without altering Must cue IDs/routing.
 */

export const AUDIO_CUE = Object.freeze({
  PURCHASE: "sfx.purchase",
  COOK_SUCCESS: "sfx.cook_success",
  COOK_FAILURE: "sfx.cook_failure",
  ORDER_COMPLETE: "sfx.order_complete",
  SETTLEMENT: "sfx.settlement",
});

export const TAVERN_BGM_TRACK_ID = "bgm.tavern";

/** event.type → cue ID. bootstrap.js가 commandBus.subscribeEvent로 정확히 한 번씩만 연결한다. */
export const MUST_CUE_EVENT_BINDINGS = Object.freeze({
  "market.offer-purchased": AUDIO_CUE.PURCHASE,
  "direct-service.cook-completed": AUDIO_CUE.COOK_SUCCESS,
  "direct-service.cook-failed": AUDIO_CUE.COOK_FAILURE,
  "direct-service.sale-committed": AUDIO_CUE.ORDER_COMPLETE,
  "settlement.day-sealed": AUDIO_CUE.SETTLEMENT,
});

/**
 * commit event가 중복 전달되거나(재시도, 이중 구독 등) 같은 eventId가 두 번 들어와도 cue는
 * 정확히 한 번만 재생하기 위한 고정 용량 ring. capacity를 넘으면 가장 오래된 key부터 밀려난다.
 */
export class CueDedupeRing {
  constructor({ capacity = 64 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError("capacity는 1 이상의 정수여야 합니다.");
    this.capacity = capacity;
    this._seen = new Set();
    this._order = [];
  }

  shouldPlay(key) {
    if (typeof key !== "string" || key.length === 0) return true;
    if (this._seen.has(key)) return false;
    this._seen.add(key);
    this._order.push(key);
    if (this._order.length > this.capacity) {
      const evicted = this._order.shift();
      this._seen.delete(evicted);
    }
    return true;
  }

  clear() {
    this._seen.clear();
    this._order = [];
  }
}
