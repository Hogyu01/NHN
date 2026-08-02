import { computeEffectiveGain, DEFAULT_AUDIO_SETTINGS, loadAudioSettings, saveAudioSettings } from "./audio-settings.js";
import { AUDIO_CUE, CueDedupeRing, MUST_CUE_EVENT_BINDINGS, TAVERN_BGM_TRACK_ID } from "./audio-cues.js";

export const CUE_STATUS = Object.freeze({
  READY: "READY",
  DEGRADED: "DEGRADED",
  UNAVAILABLE: "UNAVAILABLE",
});

/**
 * Task 34 / Requirement 22 — WebAudio adapter with the 3-bus gain graph, cue dedupe, versioned
 * settings, and autoplay/decode failure isolation. Real Must audio bytes don't exist yet (Task 41
 * generates them later), so every `registerCue`/`registerBgm` call against `assets/generated/audio`
 * resolves to CUE_STATUS.UNAVAILABLE by design — that is the honest state, not a bug, and callers
 * must never treat it as PASS before real assets land. All bus/gain/mute/dedupe/settings logic
 * below is real and independent of whether any actual audio bytes are present.
 */
export class AudioSystem {
  constructor({ audioContextFactory = null, fetchImpl = null, storage = null, dedupeCapacity = 64 } = {}) {
    this.fetchImpl = typeof fetchImpl === "function" ? fetchImpl : null;
    this.storage = storage;
    const loaded = loadAudioSettings(storage);
    this.settings = loaded.settings;
    this.settingsLoadCode = loaded.code;
    this.dedupeRing = new CueDedupeRing({ capacity: dedupeCapacity });
    this.cues = new Map();
    this._bgmPlaying = false;
    this._pendingGestureActions = [];
    this._gestureBound = false;
    this._gestureTarget = null;
    this._onGesture = null;
    this._destroyed = false;

    this.audioContext = null;
    this.busGainNodes = { master: null, sfx: null, bgm: null };
    if (typeof audioContextFactory === "function") {
      try {
        this.audioContext = audioContextFactory();
        this.busGainNodes.master = this.audioContext.createGain();
        this.busGainNodes.sfx = this.audioContext.createGain();
        this.busGainNodes.bgm = this.audioContext.createGain();
        this.busGainNodes.sfx.connect(this.busGainNodes.master);
        this.busGainNodes.bgm.connect(this.busGainNodes.master);
        this.busGainNodes.master.connect(this.audioContext.destination);
      } catch (error) {
        this.audioContext = null;
        this._contextInitError = error instanceof Error ? error.message : String(error);
      }
    }
    this._applyAllGains();
  }

  getBusSettings(bus) {
    return this.settings.buses[bus] ?? null;
  }

  setBusVolume(bus, volume) {
    if (!this.settings.buses[bus]) return { ok: false, code: "UNKNOWN_BUS" };
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) return { ok: false, code: "INVALID_VOLUME" };
    this.settings = Object.freeze({
      ...this.settings,
      buses: Object.freeze({ ...this.settings.buses, [bus]: Object.freeze({ ...this.settings.buses[bus], volume }) }),
    });
    this._applyAllGains();
    this._persistSettings();
    return { ok: true };
  }

  /** mute는 volume 값을 그대로 두고 effective gain만 0으로 만든다(AC5: child 값 보존). */
  setBusMuted(bus, muted) {
    if (!this.settings.buses[bus]) return { ok: false, code: "UNKNOWN_BUS" };
    this.settings = Object.freeze({
      ...this.settings,
      buses: Object.freeze({ ...this.settings.buses, [bus]: Object.freeze({ ...this.settings.buses[bus], muted: Boolean(muted) }) }),
    });
    this._applyAllGains();
    this._persistSettings();
    return { ok: true };
  }

  effectiveGain(childBus) {
    const master = this.settings.buses.master;
    const child = this.settings.buses[childBus];
    return computeEffectiveGain({
      masterVolume: master.volume, masterMuted: master.muted,
      childVolume: child.volume, childMuted: child.muted,
    });
  }

  _applyAllGains() {
    if (!this.audioContext) return;
    for (const bus of ["sfx", "bgm"]) {
      const node = this.busGainNodes[bus];
      if (node) node.gain.value = this.effectiveGain(bus);
    }
    if (this.busGainNodes.master) this.busGainNodes.master.gain.value = this.settings.buses.master.muted ? 0 : 1;
  }

  _persistSettings() {
    saveAudioSettings(this.storage, this.settings);
  }

  async registerCue(cueId, url) {
    const status = await this._loadBuffer(url);
    this.cues.set(cueId, status);
    return status;
  }

  async registerBgm(url) {
    const status = await this._loadBuffer(url);
    this.cues.set(TAVERN_BGM_TRACK_ID, status);
    return status;
  }

  async _loadBuffer(url) {
    if (!this.fetchImpl || !this.audioContext || typeof this.audioContext.decodeAudioData !== "function") {
      return Object.freeze({ status: CUE_STATUS.UNAVAILABLE, reason: "NO_RUNTIME_AUDIO_BACKEND" });
    }
    let response;
    try {
      response = await this.fetchImpl(url);
    } catch (error) {
      return Object.freeze({ status: CUE_STATUS.UNAVAILABLE, reason: error instanceof Error ? error.message : String(error) });
    }
    if (!response || !response.ok) {
      return Object.freeze({ status: CUE_STATUS.UNAVAILABLE, reason: `FETCH_${response?.status ?? "FAILED"}` });
    }
    try {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = await this.audioContext.decodeAudioData(arrayBuffer);
      return Object.freeze({ status: CUE_STATUS.READY, buffer });
    } catch (error) {
      return Object.freeze({ status: CUE_STATUS.DEGRADED, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** commit event 하나당 정확히 한 번만 재생한다(event.eventId 기준 dedupe). */
  playCue(cueId, { eventId } = {}) {
    if (eventId !== undefined && !this.dedupeRing.shouldPlay(eventId)) {
      return { ok: false, code: "DUPLICATE_CUE_EVENT" };
    }
    const entry = this.cues.get(cueId);
    if (!entry || entry.status !== CUE_STATUS.READY) {
      return { ok: false, code: entry?.status ?? CUE_STATUS.UNAVAILABLE };
    }
    if (this.audioContext.state === "suspended") {
      this._pendingGestureActions.push(() => this._playSfxBuffer(entry.buffer));
      return { ok: true, code: "QUEUED_FOR_GESTURE" };
    }
    this._playSfxBuffer(entry.buffer);
    return { ok: true, code: "PLAYED" };
  }

  handleDomainEvent(event) {
    const cueId = MUST_CUE_EVENT_BINDINGS[event?.type];
    if (!cueId) return { ok: false, code: "NO_CUE_BOUND" };
    return this.playCue(cueId, { eventId: event.eventId });
  }

  _playSfxBuffer(buffer) {
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.busGainNodes.sfx);
    source.start(0);
  }

  /** phaseBgm off: 하루 전체(모든 Must phase) 동안 Tavern_BGM 하나를 유지한다. */
  startBgm() {
    const entry = this.cues.get(TAVERN_BGM_TRACK_ID);
    if (!entry || entry.status !== CUE_STATUS.READY) return { ok: false, code: entry?.status ?? CUE_STATUS.UNAVAILABLE };
    if (this._bgmPlaying) return { ok: true, code: "ALREADY_PLAYING" };
    const play = () => {
      this._bgmSource = this.audioContext.createBufferSource();
      this._bgmSource.buffer = entry.buffer;
      this._bgmSource.loop = true;
      this._bgmSource.connect(this.busGainNodes.bgm);
      this._bgmSource.start(0);
      this._bgmPlaying = true;
    };
    if (this.audioContext.state === "suspended") {
      this._pendingGestureActions.push(play);
      return { ok: true, code: "QUEUED_FOR_GESTURE" };
    }
    play();
    return { ok: true, code: "PLAYED" };
  }

  stopBgm() {
    if (this._bgmSource) {
      try {
        this._bgmSource.stop();
      } catch {
        // 이미 정지된 source를 다시 멈추는 것은 무해하다.
      }
      this._bgmSource = null;
    }
    this._bgmPlaying = false;
  }

  /** AC7: autoplay 차단 시 domain state는 그대로 두고, 첫 사용자 gesture에서 재개를 시도한다. */
  resumeOnFirstGesture(target) {
    if (this._gestureBound || !target || typeof target.addEventListener !== "function") return;
    this._gestureBound = true;
    this._gestureTarget = target;
    const onGesture = () => {
      target.removeEventListener("pointerdown", onGesture);
      target.removeEventListener("keydown", onGesture);
      this._gestureBound = false;
      this._gestureTarget = null;
      this._onGesture = null;
      if (this.audioContext?.state === "suspended" && typeof this.audioContext.resume === "function") {
        this.audioContext.resume().catch(() => undefined);
      }
      const queued = this._pendingGestureActions.splice(0, this._pendingGestureActions.length);
      for (const action of queued) action();
    };
    this._onGesture = onGesture;
    target.addEventListener("pointerdown", onGesture);
    target.addEventListener("keydown", onGesture);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stopBgm();
    if (this._gestureTarget && this._onGesture) {
      this._gestureTarget.removeEventListener("pointerdown", this._onGesture);
      this._gestureTarget.removeEventListener("keydown", this._onGesture);
    }
    this._gestureTarget = null;
    this._onGesture = null;
    this._gestureBound = false;
    this._pendingGestureActions = [];
    this.dedupeRing.clear();
    const close = this.audioContext?.close;
    if (typeof close === "function") close.call(this.audioContext).catch?.(() => undefined);
  }

  getStatus() {
    return Object.freeze({
      contextAvailable: this.audioContext !== null,
      contextState: this.audioContext?.state ?? "UNAVAILABLE",
      settingsLoadCode: this.settingsLoadCode,
      bgmPlaying: this._bgmPlaying,
      cues: Object.freeze(Object.fromEntries(
        [...this.cues.entries()].map(([id, entry]) => [id, entry.status]),
      )),
    });
  }
}

export { AUDIO_CUE, DEFAULT_AUDIO_SETTINGS, TAVERN_BGM_TRACK_ID };
