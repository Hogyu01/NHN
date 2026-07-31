import { CommandBus } from "../core/command-bus.js";
import { DIAGNOSTIC_SEVERITY } from "../core/diagnostic.js";
import { GameStore } from "../core/store.js";
import { defineAtomicTransaction } from "../core/transaction.js";
import { validationFailure, validationSuccess } from "../core/result.js";

const COMMAND_TYPE = "ProbeAtomicMutation";
const READ_SET = Object.freeze(["wallet", "inventory", "idCounters", "rng"]);
const WRITE_SET = Object.freeze(["wallet", "inventory", "idCounters", "rng"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function equivalent(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function createInitialState(runtimePhase = "PLANNING") {
  return {
    revision: 0,
    runtimePhase,
    generationId: 3,
    wallet: { cashG: 20 },
    inventory: { itemIds: [] },
    idCounters: { tx: 0 },
    rng: { market: { cursor: 0 } },
    untouched: { marker: "structurally-shared" },
  };
}

function createTransaction() {
  return defineAtomicTransaction({
    name: "qa.atomic-probe",
    readSet: READ_SET,
    writeSet: WRITE_SET,
    allowedPhases: ["PLANNING"],
    validatePayload(ctx) {
      const payload = ctx.command.payload;
      return Boolean(
        payload &&
        Number.isSafeInteger(payload.amountG) &&
        payload.amountG > 0 &&
        typeof payload.failPostcondition === "boolean"
      );
    },
    preflight(ctx) {
      return ctx.command.payload.amountG <= ctx.read("wallet").cashG
        ? validationSuccess()
        : validationFailure("INSUFFICIENT_PROBE_CASH");
    },
    mutate(draft) {
      const { amountG } = draft.command.payload;
      draft.write("wallet").cashG -= amountG;
      draft.write("inventory").itemIds.push(`probe-item-${amountG}`);
      draft.write("idCounters").tx += 1;
      draft.write("rng").market.cursor += 1;
    },
    postconditions(before, after, ctx) {
      if (ctx.command.payload.failPostcondition) {
        return validationFailure("PROBE_POSTCONDITION_FAILED");
      }
      const amountG = ctx.command.payload.amountG;
      return after.wallet.cashG === before.wallet.cashG - amountG &&
        after.inventory.itemIds.length === before.inventory.itemIds.length + 1 &&
        after.idCounters.tx === before.idCounters.tx + 1 &&
        after.rng.market.cursor === before.rng.market.cursor + 1;
    },
    events(_before, after) {
      return [{
        type: "probe.committed",
        payload: { cashG: after.wallet.cashG },
      }];
    },
    effects() {
      return [{
        type: "probe.effect",
        sourceEventIndex: 0,
        payload: { cue: "probe" },
      }];
    },
  });
}

function createCommand(overrides = {}) {
  return {
    commandId: "qa:atomic:command:1",
    expectedRevision: 0,
    type: COMMAND_TYPE,
    payload: { amountG: 4, failPostcondition: false },
    issuedAtSimulationMs: 120,
    generationId: 3,
    readSet: [...READ_SET],
    writeSet: [...WRITE_SET],
    ...overrides,
  };
}

function createHarness({ runtimePhase = "PLANNING", failingEffect = false } = {}) {
  const store = new GameStore(createInitialState(runtimePhase));
  const bus = new CommandBus({
    store,
    invariants: [(_before, after) => after.wallet.cashG >= 0],
  });
  bus.register(COMMAND_TYPE, createTransaction());
  let effectCalls = 0;
  bus.registerEffectHandler("probe.effect", () => {
    effectCalls += 1;
    if (failingEffect) throw new Error("의도한 effect adapter 실패");
  });
  return { store, bus, getEffectCalls: () => effectCalls };
}

async function assertRejectedUnchanged({ id, command, runtimePhase = "PLANNING", expectedCode }) {
  const harness = createHarness({ runtimePhase });
  const before = harness.store.getSnapshot();
  const beforeSignals = harness.bus.getSignalSnapshot();
  const beforeMetadata = harness.store.getCommandMetadata();
  const result = await harness.bus.dispatch(command);

  assert(!result.ok, `${id}: command가 거절되지 않았습니다.`);
  if (expectedCode) assert(result.code === expectedCode, `${id}: code가 ${result.code}입니다.`);
  assert(harness.store.getSnapshot() === before, `${id}: 거절 시 root pointer가 바뀌었습니다.`);
  assert(harness.store.revision === before.revision, `${id}: revision이 바뀌었습니다.`);
  assert(equivalent(harness.store.getSnapshot(), before), `${id}: state slice가 바뀌었습니다.`);
  assert(equivalent(harness.store.getSnapshot().idCounters, before.idCounters), `${id}: ID counter가 바뀌었습니다.`);
  assert(equivalent(harness.store.getSnapshot().rng, before.rng), `${id}: RNG cursor가 바뀌었습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), beforeSignals), `${id}: event/effect queue가 바뀌었습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), beforeMetadata), `${id}: command metadata가 바뀌었습니다.`);
  assert(harness.getEffectCalls() === 0, `${id}: 거절된 command의 effect가 실행됐습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${id}: 실패 result에 signal이 있습니다.`);

  return { code: result.code, revision: result.revision };
}

async function runCase(id, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Runtime QA probe for Task 2. It uses production GameStore/CommandBus/AtomicTransaction code and
 * intentionally violates one guard per case. No independent test framework or mock store is used.
 */
export async function runCoreInvariantProbe() {
  const cases = [
    runCase("command-id-guard", () => assertRejectedUnchanged({
      id: "command-id-guard",
      command: createCommand({ commandId: "" }),
      expectedCode: "INVALID_COMMAND_ID",
    })),
    runCase("stale-revision-guard", () => assertRejectedUnchanged({
      id: "stale-revision-guard",
      command: createCommand({ expectedRevision: 1 }),
      expectedCode: "STALE_REVISION",
    })),
    runCase("generation-guard", () => assertRejectedUnchanged({
      id: "generation-guard",
      command: createCommand({ generationId: 4 }),
      expectedCode: "STALE_GENERATION",
    })),
    runCase("phase-guard", () => assertRejectedUnchanged({
      id: "phase-guard",
      runtimePhase: "SERVICE",
      command: createCommand(),
      expectedCode: "ILLEGAL_PHASE",
    })),
    runCase("payload-guard", () => assertRejectedUnchanged({
      id: "payload-guard",
      command: createCommand({ payload: { amountG: 0, failPostcondition: false } }),
      expectedCode: "INVALID_PAYLOAD",
    })),
    runCase("read-set-guard", () => assertRejectedUnchanged({
      id: "read-set-guard",
      command: createCommand({ readSet: READ_SET.slice(0, -1) }),
      expectedCode: "READ_SET_MISMATCH",
    })),
    runCase("write-set-guard", () => assertRejectedUnchanged({
      id: "write-set-guard",
      command: createCommand({ writeSet: WRITE_SET.slice(0, -1) }),
      expectedCode: "WRITE_SET_MISMATCH",
    })),
    runCase("preflight-guard", () => assertRejectedUnchanged({
      id: "preflight-guard",
      command: createCommand({ payload: { amountG: 21, failPostcondition: false } }),
      expectedCode: "INSUFFICIENT_PROBE_CASH",
    })),
    runCase("postcondition-id-rng-rollback", () => assertRejectedUnchanged({
      id: "postcondition-id-rng-rollback",
      command: createCommand({ payload: { amountG: 4, failPostcondition: true } }),
      expectedCode: "PROBE_POSTCONDITION_FAILED",
    })),
    runCase("single-commit-and-duplicate-idempotency", async () => {
      const harness = createHarness();
      const before = harness.store.getSnapshot();
      const command = createCommand();
      const first = await harness.bus.dispatch(command);
      assert(first.ok, "유효 command가 실패했습니다.");
      const afterFirst = harness.store.getSnapshot();
      assert(afterFirst !== before, "성공 commit이 root pointer를 교체하지 않았습니다.");
      assert(harness.store.commitCount === 1 && afterFirst.revision === 1, "root/revision이 한 번 commit되지 않았습니다.");
      assert(afterFirst.untouched === before.untouched, "untouched slice가 구조 공유되지 않았습니다.");
      assert(afterFirst.wallet !== before.wallet, "write slice가 draft clone되지 않았습니다.");
      assert(afterFirst.idCounters.tx === 1 && afterFirst.rng.market.cursor === 1, "ID/RNG cursor가 commit되지 않았습니다.");
      assert(Object.isFrozen(afterFirst) && Object.isFrozen(afterFirst.wallet), "committed snapshot이 immutable하지 않습니다.");
      assert(first.events.length === 1 && first.effects.length === 1, "성공 signal 수가 잘못됐습니다.");
      assert(first.events[0].revision === 1 && first.effects[0].revision === 1, "signal revision이 commit과 다릅니다.");
      assert(harness.getEffectCalls() === 1, "첫 effect가 정확히 한 번 실행되지 않았습니다.");

      const signalsAfterFirst = harness.bus.getSignalSnapshot();
      const duplicate = await harness.bus.dispatch(command);
      assert(!duplicate.ok && duplicate.code === "DUPLICATE_COMMAND", "duplicate가 우선 거절되지 않았습니다.");
      assert(harness.store.getSnapshot() === afterFirst, "duplicate가 root state를 바꿨습니다.");
      assert(harness.store.commitCount === 1, "duplicate가 추가 commit을 만들었습니다.");
      assert(equivalent(harness.bus.getSignalSnapshot(), signalsAfterFirst), "duplicate가 두 번째 event/effect를 만들었습니다.");
      assert(harness.getEffectCalls() === 1, "duplicate가 두 번째 effect를 실행했습니다.");

      let immutable = false;
      try {
        afterFirst.wallet.cashG = 999;
      } catch {
        immutable = true;
      }
      assert(immutable && afterFirst.wallet.cashG === 16, "snapshot 외부 mutation이 허용됐습니다.");
      return { revision: afterFirst.revision, commitCount: harness.store.commitCount, effectCalls: harness.getEffectCalls() };
    }),
    runCase("degraded-effect-isolation", async () => {
      const harness = createHarness({ failingEffect: true });
      const result = await harness.bus.dispatch(createCommand({ commandId: "qa:atomic:effect-failure" }));
      assert(result.ok, "effect 실패가 domain command를 rollback했습니다.");
      assert(harness.store.revision === 1 && harness.store.getSnapshot().wallet.cashG === 16, "effect 실패 뒤 committed state가 사라졌습니다.");
      assert(result.diagnostics.length === 1, "effect 실패 diagnostic이 없습니다.");
      assert(result.diagnostics[0].severity === DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT, "effect 실패 severity가 DEGRADED_EFFECT가 아닙니다.");
      const signals = harness.bus.getSignalSnapshot();
      assert(signals.events.length === 1 && signals.effects.length === 1, "effect 실패가 committed signal을 지웠습니다.");
      assert(signals.diagnostics.length === 1, "degraded diagnostic이 journal에 격리되지 않았습니다.");
      return { revision: result.revision, code: result.diagnostics[0].code };
    }),
  ];

  const results = await Promise.all(cases);
  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: "core-atomic-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}
