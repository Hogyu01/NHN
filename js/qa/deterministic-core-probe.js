import {
  createCampaignId,
  IdService,
} from "../core/ids.js";
import {
  fixedDeltaPerStep,
  integerUnitsToFixed,
  multiplyDivideHalfUp,
} from "../core/fixed-point.js";
import {
  ACCUMULATOR_CAP_MS,
  SIMULATION_STEP_MS,
  SimulationClock,
} from "../core/time.js";
import {
  compareScheduledItems,
  Scheduler,
  SCHEDULER_CONTROL,
  SCHEDULER_EVENT_CLASS,
  SCHEDULER_PRIORITY,
} from "../core/scheduler.js";
import {
  CORE_RNG_STREAMS,
  createRngRegistryState,
  fnv1a32,
  RngRegistry,
  sampleUint32Below,
  utf8Bytes,
} from "../core/rng.js";
import {
  formatDeterministicTrace,
  formatRngTrace,
  formatSchedulerTrace,
} from "../core/deterministic-trace.js";

const QA_ID = "deterministic-core";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function equivalent(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function assertJsonRoundTrip(value, label) {
  const restored = JSON.parse(JSON.stringify(value));
  assert(equivalent(restored, value), `${label} state가 JSON round-trip에서 바뀌었습니다.`);
  return restored;
}

function event(stableId, eventClass, simulationTimeMs = 100) {
  return { stableId, eventClass, simulationTimeMs, payload: { stableId } };
}

function runCase(id, description, validates, execute) {
  try {
    const details = execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function runRngTrace(registry) {
  return [
    registry.nextInt("market", 41),
    registry.nextUint32("contractOffer"),
    registry.percentage("contractResolution", 70),
    registry.nextInt("demand", 12),
    registry.nextInt("event", 8),
    registry.nextInt("market", 101),
  ];
}

/**
 * Runtime QA probe that imports and exercises production deterministic primitives directly.
 * Property matrices are bounded deterministic enumerations, not a separate test framework.
 *
 * Property 10: RNG 재현성과 stream 독립성
 * **Validates: Requirements 6.14, 7.7, 10.10, 15.6, 23.4, 27.4, 31.6**
 *
 * Property 11: Scheduler priority와 pause 불변성
 * **Validates: Requirements 10.9, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7**
 */
export function runDeterministicCoreProbe() {
  const results = [
    runCase(
      "id-kind-counters-and-generation",
      "kind별 10자리 ID와 generation cursor가 save/restore 뒤 이어진다",
      "Requirements 18.6, 19.7",
      () => {
        const service = new IdService({
          campaignId: "campaign:qa",
          day: 3,
          generationId: 7,
          counters: {},
        });
        const firstGuest = service.next("guest");
        const firstLot = service.next("lot");
        const secondGuest = service.next("guest");
        assert(firstGuest === "campaign:qa:guest:3:0000000000", "첫 guest ID가 계약과 다릅니다.");
        assert(firstLot === "campaign:qa:lot:3:0000000000", "kind별 counter가 독립적이지 않습니다.");
        assert(secondGuest.endsWith(":0000000001"), "guest counter가 순서대로 증가하지 않습니다.");
        const restored = IdService.fromState(assertJsonRoundTrip(service.snapshot(), "IdService"));
        assert(restored.next("guest").endsWith(":0000000002"), "복원된 ID cursor가 이어지지 않습니다.");
        assert(restored.advanceGeneration() === 8, "generationId가 정확히 1 증가하지 않습니다.");
        assert(createCampaignId(0x1234abcd, 2) === "campaign:1234abcd:0000000002", "campaign ID가 explicit input으로 재현되지 않습니다.");
        return { firstGuest, firstLot, generationId: restored.generationId };
      },
    ),
    runCase(
      "fixed-point-foundation",
      "고정소수점 이동량과 Half-Up 유리수 계산이 정수로 유지된다",
      "Requirements 34.5, 34.8",
      () => {
        assert(integerUnitsToFixed(96) === 96_000, "96 logical pixel fixed 변환이 잘못됐습니다.");
        assert(fixedDeltaPerStep(96) === 1_920, "96px/s의 20ms delta가 1,920 milli-pixel이 아닙니다.");
        assert(multiplyDivideHalfUp(5, 1, 2) === 3, "양수 Half-Up이 잘못됐습니다.");
        assert(multiplyDivideHalfUp(-5, 1, 2) === -3, "음수 Half-Up이 0 반대 방향으로 반올림되지 않았습니다.");
        return { guestStepMilliPx: fixedDeltaPerStep(96), stepMs: SIMULATION_STEP_MS };
      },
    ),
    runCase(
      "clock-cap-without-step-loss",
      "250ms frame cap을 넘은 elapsed도 backlog로 이월되어 20ms step이 누락되지 않는다",
      "Requirements 19.1, 19.4, 19.6",
      () => {
        const clock = new SimulationClock();
        const observedSteps = [];
        let frame = clock.advance(1_000);
        observedSteps.push(...frame.steps);
        assert(frame.acceptedElapsedMs === ACCUMULATOR_CAP_MS, "첫 frame intake가 250ms cap이 아닙니다.");
        assert(frame.deferredElapsedMs === 750, "초과 elapsed가 backlog에 보존되지 않았습니다.");
        while (clock.hasPendingElapsed) {
          frame = clock.drainPendingFrame();
          observedSteps.push(...frame.steps);
        }
        assert(observedSteps.length === 50, "1,000ms에서 20ms logical step 50개가 생성되지 않았습니다.");
        assert(observedSteps.every((step, index) => step.simulationTimeMs === (index + 1) * 20), "logical timestamp가 20ms 연속 경계가 아닙니다.");
        assert(clock.simulationTimeMs === 1_000, "logical simulation time이 1,000ms에 도달하지 않았습니다.");

        clock.advance(10);
        const pausedAt = clock.simulationTimeMs;
        const pause = clock.pause();
        assert(pause.discardedElapsedMs === 10, "pause가 부분 accumulator를 비우지 않았습니다.");
        const ignored = clock.advance(500);
        assert(ignored.steps.length === 0 && clock.simulationTimeMs === pausedAt, "PAUSED elapsed가 simulation을 진행했습니다.");
        clock.resume();
        assertJsonRoundTrip(clock.snapshot(), "SimulationClock");
        return { logicalSteps: observedSteps.length, simulationTimeMs: clock.simulationTimeMs };
      },
    ),
    runCase(
      "scheduler-priority-and-stable-tie",
      "same timestamp는 canonical priority이며 완전 동률은 stableId lexical 순서다",
      "Requirements 10.4, 10.9, 34.4",
      () => {
        const tiedA = { simulationTimeMs: 1, priority: 5, insertionSequence: 9, stableId: "arrival:a" };
        const tiedZ = { ...tiedA, stableId: "arrival:z" };
        assert(compareScheduledItems(tiedA, tiedZ) < 0, "stableId 최종 tie-break가 lexical ascending이 아닙니다.");

        const scheduler = new Scheduler();
        const shuffled = [
          ["arrival", SCHEDULER_EVENT_CLASS.ARRIVAL],
          ["cook", SCHEDULER_EVENT_CLASS.COOK_COMPLETION],
          ["input", SCHEDULER_EVENT_CLASS.PLAYER_INPUT],
          ["timeout", SCHEDULER_EVENT_CLASS.TIMEOUT],
          ["zero", SCHEDULER_EVENT_CLASS.TIMER_ZERO],
          ["pause", SCHEDULER_EVENT_CLASS.PAUSE],
        ];
        for (const [id, eventClass] of shuffled) scheduler.schedule(event(id, eventClass));
        const order = [];
        scheduler.runDue(100, (item) => order.push(item.eventClass));
        const expected = [
          SCHEDULER_EVENT_CLASS.PAUSE,
          SCHEDULER_EVENT_CLASS.TIMER_ZERO,
          SCHEDULER_EVENT_CLASS.TIMEOUT,
          SCHEDULER_EVENT_CLASS.PLAYER_INPUT,
          SCHEDULER_EVENT_CLASS.COOK_COMPLETION,
          SCHEDULER_EVENT_CLASS.ARRIVAL,
        ];
        assert(equivalent(order, expected), `scheduler priority 순서가 다릅니다: ${order.join(",")}`);
        assert(SCHEDULER_PRIORITY.PAUSE === 0 && SCHEDULER_PRIORITY.ARRIVAL === 5, "canonical priority 값이 바뀌었습니다.");
        assertJsonRoundTrip(scheduler.snapshot(), "Scheduler");

        const beforeInvalidPayload = scheduler.snapshot();
        let invalidPayloadRejected = false;
        try {
          scheduler.schedule({
            stableId: "invalid:payload",
            eventClass: SCHEDULER_EVENT_CLASS.ARRIVAL,
            simulationTimeMs: 100,
            payload: undefined,
          });
        } catch {
          invalidPayloadRejected = true;
        }
        assert(invalidPayloadRejected, "JSON으로 직렬화할 수 없는 queue payload가 허용됐습니다.");
        assert(equivalent(beforeInvalidPayload, scheduler.snapshot()), "invalid payload 거절이 scheduler state를 바꿨습니다.");

        let pastQueueRejected = false;
        try {
          new Scheduler({
            simulationTimeMs: 100,
            nextInsertionSequence: 1,
            queue: [{
              stableId: "past:item",
              eventClass: SCHEDULER_EVENT_CLASS.ARRIVAL,
              simulationTimeMs: 80,
              priority: SCHEDULER_PRIORITY.ARRIVAL,
              insertionSequence: 0,
              generationId: 0,
              payload: null,
            }],
          });
        } catch {
          pastQueueRejected = true;
        }
        assert(pastQueueRejected, "복원 cursor보다 과거인 queue item이 허용됐습니다.");
        return { order, invalidPayloadRejected, pastQueueRejected };
      },
    ),
    runCase(
      "scheduler-pause-deferral-resume",
      "pause 승인 뒤 같은 timestamp remainder는 dequeue하지 않고 resume에서 한 번 실행한다",
      "Requirements 19.2, 19.3, 19.4, 19.6",
      () => {
        const scheduler = new Scheduler();
        for (const [id, eventClass] of [
          ["arrival", SCHEDULER_EVENT_CLASS.ARRIVAL],
          ["input", SCHEDULER_EVENT_CLASS.PLAYER_INPUT],
          ["zero", SCHEDULER_EVENT_CLASS.TIMER_ZERO],
          ["pause", SCHEDULER_EVENT_CLASS.PAUSE],
          ["timeout", SCHEDULER_EVENT_CLASS.TIMEOUT],
          ["cook", SCHEDULER_EVENT_CLASS.COOK_COMPLETION],
        ]) scheduler.schedule(event(id, eventClass));

        const firstPass = [];
        const paused = scheduler.runDue(100, (item) => {
          firstPass.push(item.stableId);
          return item.eventClass === SCHEDULER_EVENT_CLASS.PAUSE
            ? SCHEDULER_CONTROL.PAUSE_ACCEPTED
            : undefined;
        });
        assert(equivalent(firstPass, ["pause"]), "pause 뒤 같은 batch item이 실행됐습니다.");
        assert(paused.paused && scheduler.size === 5 && scheduler.simulationTimeMs === 100, "pause가 remainder를 같은 timestamp에 보존하지 않았습니다.");
        assert(scheduler.runDue(100, () => { throw new Error("PAUSED에서 실행되면 안 됩니다."); }).executed.length === 0, "PAUSED queue가 실행됐습니다.");

        assert(scheduler.resume(), "명시 resume이 수락되지 않았습니다.");
        const resumed = [];
        scheduler.runDue(100, (item) => resumed.push(item.stableId));
        assert(equivalent(resumed, ["zero", "timeout", "input", "cook", "arrival"]), "resume 순서 또는 실행 횟수가 잘못됐습니다.");
        const deferredTrace = scheduler.getTrace().filter((record) => record.action === "DEFERRED");
        assert(deferredTrace.length === 5, "deferred scheduler trace가 remainder 전체를 기록하지 않았습니다.");
        return { firstPass, resumed, deferred: deferredTrace.length };
      },
    ),
    runCase(
      "scheduler-generation-cancellation",
      "generation restart가 old queue item을 취소하고 새 generation item만 실행한다",
      "Requirements 19.7",
      () => {
        const scheduler = new Scheduler({ generationId: 4 });
        scheduler.schedule(event("old:arrival", SCHEDULER_EVENT_CLASS.ARRIVAL, 20));
        const restart = scheduler.restartGeneration({ simulationTimeMs: 0 });
        assert(restart.generationId === 5 && restart.cancelled.length === 1, "restart가 old generation queue를 취소하지 않았습니다.");
        scheduler.schedule(event("new:arrival", SCHEDULER_EVENT_CLASS.ARRIVAL, 20));
        const executed = [];
        scheduler.runDue(20, (item) => executed.push(item.stableId));
        assert(equivalent(executed, ["new:arrival"]), "old generation callback이 실행됐습니다.");
        assert(scheduler.getTrace().some((record) => record.action === "CANCELLED" && record.reason === "GENERATION_RESTART"), "generation cancellation trace가 없습니다.");
        return { generationId: scheduler.generationId, executed };
      },
    ),
    runCase(
      "rng-known-vector-and-rejection",
      "FNV-1a와 rejection sampler가 canonical vector 및 unbiased acceptance limit를 따른다",
      "Requirements 6.14, 7.7, 10.10, 15.6, 23.4",
      () => {
        assert(fnv1a32(utf8Bytes("hello")) === 0x4f9f2cab, "FNV-1a 32-bit known vector가 다릅니다.");
        const source = [0xffff_ffff, 7];
        const sampled = sampleUint32Below(() => source.shift(), 10);
        assert(sampled.acceptanceLimit === 4_294_967_290, "rejection acceptance limit가 floor(2^32/n)*n이 아닙니다.");
        assert(sampled.value === 7 && sampled.draws === 2 && sampled.rejectedDraws === 1, "limit 이상 draw가 거절되지 않았습니다.");

        for (let seed = 0; seed < 64; seed += 1) {
          const registry = new RngRegistry(seed);
          for (const upper of [1, 2, 3, 10, 100, 65_537, 2_147_483_649]) {
            const value = registry.nextInt("market", upper);
            assert(value >= 0 && value < upper, `seed ${seed}, upper ${upper} 범위를 벗어났습니다.`);
          }
        }
        return { fnvHello: "4f9f2cab", rejection: sampled };
      },
    ),
    runCase(
      "rng-replay-and-cursors",
      "동일 seed/state/action trace가 output과 모든 stream cursor를 재현한다",
      "Requirements 6.14, 7.7, 10.10, 15.6, 23.4",
      () => {
        for (const seed of [0, 1, 0x1234abcd, 0xffff_ffff]) {
          const initial = createRngRegistryState(seed);
          const first = RngRegistry.fromState(assertJsonRoundTrip(initial, `RNG initial ${seed}`));
          const second = RngRegistry.fromState(assertJsonRoundTrip(initial, `RNG initial copy ${seed}`));
          const firstOutput = runRngTrace(first);
          const secondOutput = runRngTrace(second);
          assert(equivalent(firstOutput, secondOutput), `seed ${seed} output이 재현되지 않았습니다.`);
          assert(equivalent(first.snapshot(), second.snapshot()), `seed ${seed} cursor/state가 재현되지 않았습니다.`);
        }
        const sample = new RngRegistry(0x1234abcd);
        const output = runRngTrace(sample);
        return { output, cursors: Object.fromEntries(CORE_RNG_STREAMS.map((name) => [name, sample.getStreamState(name).drawCount])) };
      },
    ),
    runCase(
      "rng-stream-independence",
      "한 stream의 추가 draw가 다른 core stream output/state를 바꾸지 않는다",
      "Requirements 23.4, 27.4, 31.6",
      () => {
        for (const seed of [0, 7, 42, 0xdeadbeef, 0xffff_ffff]) {
          const baseline = new RngRegistry(seed);
          const variant = new RngRegistry(seed);
          variant.nextUint32("market");
          for (const stream of CORE_RNG_STREAMS.filter((name) => name !== "market")) {
            const baselineOutput = baseline.nextInt(stream, 10_003);
            const variantOutput = variant.nextInt(stream, 10_003);
            assert(baselineOutput === variantOutput, `${stream} output이 market 추가 draw에 오염됐습니다.`);
            assert(equivalent(baseline.getStreamState(stream), variant.getStreamState(stream)), `${stream} state가 market 추가 draw에 오염됐습니다.`);
          }
        }
        return { checkedSeeds: 5, isolatedFrom: "market" };
      },
    ),
    runCase(
      "optional-stream-off-isolation",
      "flag off optional stream은 생성·소비되지 않고 core streams가 그대로다",
      "Requirements 27.4, 31.6",
      () => {
        const registry = new RngRegistry(99, {
          optionalStreamFlags: { staff: false, supplier: false, additionalEvent: false },
        });
        assert(equivalent(registry.streamNames(), [...CORE_RNG_STREAMS].sort()), "flag off optional stream이 생성됐습니다.");
        const before = registry.snapshot();
        let rejected = false;
        try {
          registry.nextUint32("staff");
        } catch {
          rejected = true;
        }
        assert(rejected, "생성되지 않은 optional stream draw가 허용됐습니다.");
        assert(equivalent(before, registry.snapshot()), "optional stream 거절이 core state를 소비했습니다.");
        assert(!registry.ensureOptionalStream("staff", false), "false flag가 optional stream을 생성했습니다.");
        assert(!registry.hasStream("staff"), "false flag 뒤 optional stream이 존재합니다.");
        assert(registry.ensureOptionalStream("staff", true), "true flag가 optional stream을 생성하지 못했습니다.");
        const coreBeforeOptionalDraw = Object.fromEntries(CORE_RNG_STREAMS.map((name) => [name, registry.getStreamState(name)]));
        registry.nextUint32("staff");
        const coreAfterOptionalDraw = Object.fromEntries(CORE_RNG_STREAMS.map((name) => [name, registry.getStreamState(name)]));
        assert(equivalent(coreBeforeOptionalDraw, coreAfterOptionalDraw), "optional draw가 core stream을 변경했습니다.");
        return { offStreams: ["staff", "supplier", "additionalEvent"], enabledForCheck: "staff" };
      },
    ),
    runCase(
      "deterministic-trace-formatters",
      "scheduler/RNG trace formatter가 cursor와 ordering 정보를 안정적으로 출력한다",
      "Requirements 23.2, 23.4",
      () => {
        const scheduler = new Scheduler();
        scheduler.schedule(event("trace:pause", SCHEDULER_EVENT_CLASS.PAUSE, 20));
        scheduler.runDue(20, () => undefined);
        const rng = new RngRegistry(123);
        rng.nextInt("market", 17);
        const schedulerText = formatSchedulerTrace(scheduler.getTrace());
        const rngText = formatRngTrace(rng.getTrace());
        const combined = formatDeterministicTrace({ scheduler: scheduler.getTrace(), rng: rng.getTrace() });
        assert(schedulerText.includes("priority=0") && schedulerText.includes("stableId=trace:pause"), "scheduler trace formatter에 queue key가 없습니다.");
        assert(rngText.includes("stream=market") && rngText.includes("draws=0->1"), "RNG trace formatter에 stream cursor가 없습니다.");
        assert(combined === `${schedulerText}\n${rngText}`, "combined trace 순서가 scheduler→RNG가 아닙니다.");
        return { schedulerText, rngText };
      },
    ),
  ];

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}

export function publishDeterministicCoreReport(root, report) {
  if (!root?.body || typeof root.createElement !== "function") return report;
  root.querySelector("#deterministic-core-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "deterministic-core-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");

  const heading = root.createElement("h2");
  heading.textContent = `Deterministic core: ${report.status}`;
  section.append(heading);
  const summary = root.createElement("p");
  summary.textContent = `${report.passed}/${report.total} 검사 통과`;
  section.append(summary);
  const list = root.createElement("ol");
  for (const result of report.results) {
    const item = root.createElement("li");
    item.className = result.status === "PASS" ? "qa-pass" : "qa-fail";
    item.textContent = `${result.status} — ${result.description}`;
    if (result.error) {
      const error = root.createElement("pre");
      error.textContent = result.error;
      item.append(error);
    }
    list.append(item);
  }
  section.append(list);
  root.body.append(section);
  root.body.dataset.deterministicCoreQa = report.status.toLowerCase();
  root.dispatchEvent(new CustomEvent("deterministic-core:qa-complete", { detail: report }));
  console.group(`QA: ${QA_ID} — ${report.status}`);
  console.table(report.results);
  console.groupEnd();
  return report;
}
