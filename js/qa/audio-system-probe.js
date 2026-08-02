import { freezeDeep } from "../core/result.js";
import { computeEffectiveGain } from "../infrastructure/audio-settings.js";
import { AUDIO_CUE, CueDedupeRing, MUST_CUE_EVENT_BINDINGS, TAVERN_BGM_TRACK_ID } from "../infrastructure/audio-cues.js";
import { AudioSystem, CUE_STATUS } from "../infrastructure/audio-system.js";
import { InMemoryStorage } from "../infrastructure/storage-adapter.js";
import { createFeatureFlags } from "../app/feature-flags.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id, description, validates, status: "FAIL", error: error instanceof Error ? error.message : String(error),
    });
  }
}

class FakeGainNode {
  constructor() {
    this.gain = { value: 1 };
    this.connections = [];
  }

  connect(target) {
    this.connections.push(target);
  }
}

class FakeBufferSourceNode {
  constructor() {
    this.buffer = null;
    this.loop = false;
    this.started = false;
    this.stopped = false;
    this.connections = [];
  }

  connect(target) {
    this.connections.push(target);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  constructor({ initialState = "running" } = {}) {
    this.state = initialState;
    this.destination = {};
  }

  createGain() {
    return new FakeGainNode();
  }

  createBufferSource() {
    return new FakeBufferSourceNode();
  }

  async decodeAudioData(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) throw new Error("empty buffer");
    return { duration: 1, length: arrayBuffer.byteLength };
  }

  async resume() {
    this.state = "running";
  }

  async close() {
    this.state = "closed";
  }
}

function fetchOk() {
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) });
}

function fetch404() {
  return async () => ({ ok: false, status: 404 });
}

export async function runAudioSystemProbe() {
  const results = [];

  results.push(await runCase(
    "effective-gain-formula",
    "effective gain = master * child / 10000이며 어느 쪽이든 muted면 0이다",
    "Requirement 22 AC3~4",
    () => {
      const g1 = computeEffectiveGain({ masterVolume: 80, masterMuted: false, childVolume: 50, childMuted: false });
      assert(g1 === (80 * 50) / 10000, "gain 공식이 다릅니다.");
      const g2 = computeEffectiveGain({ masterVolume: 80, masterMuted: true, childVolume: 50, childMuted: false });
      assert(g2 === 0, "master muted면 0이어야 합니다.");
      const g3 = computeEffectiveGain({ masterVolume: 80, masterMuted: false, childVolume: 50, childMuted: true });
      assert(g3 === 0, "child muted면 0이어야 합니다.");
      return { g1, g2, g3 };
    },
  ));

  results.push(await runCase(
    "mute-preserves-child-value-and-restores",
    "mute/unmute는 volume 값을 보존하고 해제 시 직전 설정으로 복원한다",
    "Requirement 22 AC5",
    () => {
      const audio = new AudioSystem({ storage: new InMemoryStorage() });
      audio.setBusVolume("sfx", 42);
      audio.setBusMuted("sfx", true);
      assert(audio.getBusSettings("sfx").volume === 42, "muted 상태에서도 volume이 보존돼야 합니다.");
      assert(audio.effectiveGain("sfx") === 0, "muted면 effective gain이 0이어야 합니다.");
      audio.setBusMuted("sfx", false);
      assert(audio.getBusSettings("sfx").volume === 42, "unmute 후에도 42여야 합니다.");
      assert(audio.effectiveGain("sfx") === (100 * 42) / 10000, "unmute 후 직전 설정으로 복원돼야 합니다.");
      return { volume: audio.getBusSettings("sfx").volume };
    },
  ));

  results.push(await runCase(
    "settings-round-trip-versioned-and-separate-key",
    "settings는 campaign save와 분리된 versioned key로 저장·복원된다",
    "Requirement 22 AC6",
    () => {
      const storage = new InMemoryStorage();
      const first = new AudioSystem({ storage });
      first.setBusVolume("master", 60);
      first.setBusVolume("bgm", 30);
      first.setBusMuted("bgm", true);
      const second = new AudioSystem({ storage });
      assert(second.getBusSettings("master").volume === 60, "master volume이 복원돼야 합니다.");
      assert(second.getBusSettings("bgm").volume === 30, "bgm volume이 복원돼야 합니다.");
      assert(second.getBusSettings("bgm").muted === true, "bgm muted가 복원돼야 합니다.");
      return { restored: second.settings };
    },
  ));

  results.push(await runCase(
    "no-runtime-backend-reports-unavailable-not-pass",
    "실제 asset/AudioContext가 없으면 UNAVAILABLE로 정직하게 보고하고 PASS로 오인하지 않는다",
    "Task 34 완료 검증 / Requirement 22 AC7",
    async () => {
      const audio = new AudioSystem({ storage: new InMemoryStorage() });
      const status = await audio.registerCue(AUDIO_CUE.PURCHASE, "assets/generated/audio/sfx-purchase.wav");
      assert(status.status === CUE_STATUS.UNAVAILABLE, "runtime audio backend 없이는 UNAVAILABLE이어야 합니다.");
      const play = audio.playCue(AUDIO_CUE.PURCHASE, { eventId: "evt-1" });
      assert(play.ok === false && play.code === CUE_STATUS.UNAVAILABLE, "재생도 실패로 보고돼야 합니다.");
      return status;
    },
  ));

  results.push(await runCase(
    "fetch-404-marks-unavailable",
    "asset fetch가 404면 cue를 UNAVAILABLE로 표시하고 예외를 던지지 않는다",
    "Requirement 22 AC7",
    async () => {
      const audio = new AudioSystem({
        storage: new InMemoryStorage(),
        audioContextFactory: () => new FakeAudioContext(),
        fetchImpl: fetch404(),
      });
      const status = await audio.registerCue(AUDIO_CUE.COOK_FAILURE, "assets/generated/audio/sfx-cook-failure.wav");
      assert(status.status === CUE_STATUS.UNAVAILABLE, "404는 UNAVAILABLE이어야 합니다.");
      return status;
    },
  ));

  results.push(await runCase(
    "ready-cue-plays-and-dedupes-by-event-id",
    "asset가 준비되면 재생되고, 같은 eventId로 두 번째 호출하면 dedupe로 거절된다",
    "Requirement 22 AC1, design 11 cue 정확히 한 번",
    async () => {
      const audio = new AudioSystem({
        storage: new InMemoryStorage(),
        audioContextFactory: () => new FakeAudioContext(),
        fetchImpl: fetchOk(),
      });
      const status = await audio.registerCue(AUDIO_CUE.SETTLEMENT, "assets/generated/audio/sfx-settlement.wav");
      assert(status.status === CUE_STATUS.READY, "fetch/decode 성공이면 READY여야 합니다.");
      const first = audio.playCue(AUDIO_CUE.SETTLEMENT, { eventId: "evt-42" });
      assert(first.ok === true && first.code === "PLAYED", "첫 재생은 성공해야 합니다.");
      const second = audio.playCue(AUDIO_CUE.SETTLEMENT, { eventId: "evt-42" });
      assert(second.ok === false && second.code === "DUPLICATE_CUE_EVENT", "같은 eventId 재생은 거절돼야 합니다.");
      return { first, second };
    },
  ));

  results.push(await runCase(
    "must-cue-event-bindings-cover-five-sfx",
    "5개 Must SFX가 각각 서로 다른 domain event type에 정확히 하나씩 바인딩된다",
    "Requirement 22 AC1",
    () => {
      const cueIds = Object.values(MUST_CUE_EVENT_BINDINGS);
      assert(cueIds.length === 5, "바인딩이 5개여야 합니다.");
      assert(new Set(cueIds).size === 5, "cue ID가 서로 달라야 합니다.");
      assert(new Set(Object.keys(MUST_CUE_EVENT_BINDINGS)).size === 5, "event type이 서로 달라야 합니다.");
      return { bindings: MUST_CUE_EVENT_BINDINGS };
    },
  ));

  results.push(await runCase(
    "handle-domain-event-routes-through-binding",
    "handleDomainEvent는 event.type을 cue로 변환해 playCue를 호출한다",
    "Requirement 22 AC1",
    async () => {
      const audio = new AudioSystem({
        storage: new InMemoryStorage(),
        audioContextFactory: () => new FakeAudioContext(),
        fetchImpl: fetchOk(),
      });
      await audio.registerCue(AUDIO_CUE.ORDER_COMPLETE, "assets/generated/audio/sfx-order-complete.wav");
      const result = audio.handleDomainEvent({ type: "direct-service.sale-committed", eventId: "evt-7" });
      assert(result.ok === true, "바인딩된 event는 재생돼야 합니다.");
      const unbound = audio.handleDomainEvent({ type: "unrelated.event", eventId: "evt-8" });
      assert(unbound.ok === false && unbound.code === "NO_CUE_BOUND", "바인딩 없는 event는 무시돼야 합니다.");
      return { result, unbound };
    },
  ));

  results.push(await runCase(
    "autoplay-suspended-queues-then-resumes-on-gesture",
    "AudioContext가 suspended면 재생을 큐에 넣고, 첫 gesture에서 resume 후 큐를 비운다",
    "Requirement 22 AC7",
    async () => {
      const audio = new AudioSystem({
        storage: new InMemoryStorage(),
        audioContextFactory: () => new FakeAudioContext({ initialState: "suspended" }),
        fetchImpl: fetchOk(),
      });
      await audio.registerBgm("assets/generated/audio/bgm-tavern.wav");
      const queued = audio.startBgm();
      assert(queued.ok === true && queued.code === "QUEUED_FOR_GESTURE", "suspended면 큐잉돼야 합니다.");
      assert(audio._bgmPlaying === false, "gesture 전에는 재생되지 않아야 합니다.");
      const listeners = new Map();
      const fakeTarget = {
        addEventListener: (type, handler) => listeners.set(type, handler),
        removeEventListener: (type) => listeners.delete(type),
      };
      audio.resumeOnFirstGesture(fakeTarget);
      listeners.get("pointerdown")();
      assert(audio.audioContext.state === "running", "gesture 후 resume돼야 합니다.");
      assert(audio._bgmPlaying === true, "gesture 후 큐잉된 BGM이 재생돼야 합니다.");
      return { state: audio.audioContext.state, bgmPlaying: audio._bgmPlaying };
    },
  ));

  results.push(await runCase(
    "decode-fault-is-degraded-and-domain-neutral",
    "decode 실패는 DEGRADED 진단으로 격리되고 외부 domain digest를 변경하지 않는다",
    "Requirement 22 AC7",
    async () => {
      const domainDigest = Object.freeze({ revision: 17, rng: "same", scheduler: "same" });
      const before = JSON.stringify(domainDigest);
      const audio = new AudioSystem({
        storage: new InMemoryStorage(),
        audioContextFactory: () => new FakeAudioContext(),
        fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
      });
      const status = await audio.registerCue(AUDIO_CUE.COOK_FAILURE, "bad.wav");
      assert(status.status === CUE_STATUS.DEGRADED, "decode 실패가 DEGRADED가 아닙니다.");
      assert(JSON.stringify(domainDigest) === before, "audio fault가 domain digest를 바꿨습니다.");
      audio.destroy();
      return { status: status.status, domainDigest };
    },
  ));

  results.push(await runCase(
    "audio-feature-flags-four-independent-combinations",
    "phaseBgm/extendedAudio 네 조합은 서로의 값을 바꾸지 않는다",
    "Task 34 feature predicates",
    () => {
      const combinations = [];
      for (const phaseBgm of [false, true]) {
        for (const extendedAudio of [false, true]) {
          const flags = createFeatureFlags({ phaseBgm, extendedAudio });
          assert(flags.phaseBgm === phaseBgm && flags.extendedAudio === extendedAudio, "flag가 독립적으로 보존되지 않았습니다.");
          combinations.push({ phaseBgm, extendedAudio });
        }
      }
      return { combinations };
    },
  ));

  results.push(await runCase(
    "dedupe-ring-evicts-at-capacity",
    "CueDedupeRing은 capacity를 넘으면 가장 오래된 key부터 밀어내 재사용을 허용한다",
    "design cue dedupe ring",
    () => {
      const ring = new CueDedupeRing({ capacity: 2 });
      assert(ring.shouldPlay("a") === true, "a는 처음이라 허용돼야 합니다.");
      assert(ring.shouldPlay("a") === false, "a 재사용은 거절돼야 합니다.");
      assert(ring.shouldPlay("b") === true, "b는 처음이라 허용돼야 합니다.");
      assert(ring.shouldPlay("c") === true, "c가 들어오면 a가 밀려나야 합니다.");
      assert(ring.shouldPlay("a") === true, "밀려난 a는 다시 허용돼야 합니다.");
      return { capacity: ring.capacity };
    },
  ));

  results.push(await runCase(
    "tavern-bgm-track-id-stable",
    "Tavern_BGM track ID가 고정 상수로 노출된다",
    "Requirement 22 AC2",
    () => {
      assert(typeof TAVERN_BGM_TRACK_ID === "string" && TAVERN_BGM_TRACK_ID.length > 0, "TAVERN_BGM_TRACK_ID가 있어야 합니다.");
      return { TAVERN_BGM_TRACK_ID };
    },
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}
