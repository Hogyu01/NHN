import {
  createDiagnostic,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { CommandBus } from "../core/command-bus.js";
import { GameStore } from "../core/store.js";
import { defineAtomicTransaction } from "../core/transaction.js";
import { validationSuccess } from "../core/result.js";
import {
  BOOT_STAGE,
  BOOT_STAGE_ORDER,
  BOOT_STAGE_STATUS,
  BOOT_STATUS,
  BootStateProjection,
  bootStageFailure,
  bootStagePass,
  bootStageSkipped,
  executeBootPipeline,
} from "../app/bootstrap.js";
import { DEFAULT_BUILD_METADATA } from "../app/build-metadata.js";
import {
  createFeatureFlags,
  DEFAULT_FEATURE_FLAGS,
  FEATURE_GATE_KIND,
  FEATURE_IDS,
} from "../app/feature-flags.js";
import {
  FEATURE_GATE_ARTIFACT_SCHEMA_VERSION,
  FEATURE_GATE_STATUS,
  FeatureRegistry,
} from "../app/feature-registry.js";

const QA_ID = "bootstrap-features";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCase(id, description, validates, execute) {
  return Promise.resolve().then(execute).then(
    (details) => Object.freeze({ id, description, validates, status: "PASS", details }),
    (error) => Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function gateArtifact(gateKind, {
  buildId = DEFAULT_BUILD_METADATA.buildId,
  status = FEATURE_GATE_STATUS.PASS,
} = {}) {
  return Object.freeze({
    schemaVersion: FEATURE_GATE_ARTIFACT_SCHEMA_VERSION,
    gateId: `gate.${gateKind.toLowerCase()}.qa`,
    gateKind,
    buildId,
    status,
  });
}

function createProbeTransaction(counter) {
  return defineAtomicTransaction({
    name: "qa.feature-guard-probe",
    readSet: ["featureState"],
    writeSet: ["featureState"],
    allowedPhases: ["TITLE"],
    validatePayload() {
      return validationSuccess();
    },
    preflight() {
      counter.preflight += 1;
      return validationSuccess();
    },
    mutate(draft) {
      counter.mutate += 1;
      draft.write("featureState").count += 1;
    },
    postconditions(before, after) {
      return after.featureState.count === before.featureState.count + 1;
    },
  });
}

async function dispatchGuardedFeatureCommand(flags) {
  const registry = new FeatureRegistry({
    flags,
    buildMetadata: DEFAULT_BUILD_METADATA,
    gateArtifacts: [],
  });
  registry.declareCommand({
    featureId: "staff",
    type: "qa.feature.staff-command",
    writeSet: ["featureState"],
  });
  const store = new GameStore({
    revision: 0,
    generationId: 0,
    runtimePhase: "TITLE",
    featureState: { count: 0 },
  });
  const bus = new CommandBus({
    store,
    commandGuards: [registry.createCommandGuard()],
  });
  const counter = { preflight: 0, mutate: 0 };
  bus.register("qa.feature.staff-command", createProbeTransaction(counter));
  const before = store.getSnapshot();
  const signalsBefore = bus.getSignalSnapshot();
  const result = await bus.dispatch({
    commandId: "qa:feature:command:0001",
    expectedRevision: 0,
    generationId: 0,
    issuedAtSimulationMs: 0,
    type: "qa.feature.staff-command",
    payload: {},
    readSet: ["featureState"],
    writeSet: ["featureState"],
  });
  assert(store.getSnapshot() === before, "feature guard 거절 뒤 root pointer가 바뀌었습니다.");
  assert(store.revision === 0 && store.commitCount === 0, "feature guard 거절 뒤 commit이 발생했습니다.");
  assert(counter.preflight === 0 && counter.mutate === 0, "feature guard가 transaction prepare/draft보다 늦게 실행됐습니다.");
  assert(result.events.length === 0 && result.effects.length === 0, "거절된 feature command가 signal을 만들었습니다.");
  assert(JSON.stringify(bus.getSignalSnapshot()) === JSON.stringify(signalsBefore), "거절된 feature command가 journal을 바꿨습니다.");
  return { result, counter };
}

function stageCallbacks(onStage, outcomeFor = () => null) {
  return Object.fromEntries(BOOT_STAGE_ORDER.map((stageId) => [stageId, async () => {
    onStage(stageId);
    const selected = outcomeFor(stageId);
    if (selected) return selected;
    if (stageId === BOOT_STAGE.MAP || stageId === BOOT_STAGE.SAVE) {
      return bootStageSkipped({ stageId }, `${stageId}_DEFERRED`, { boundaryEstablished: true });
    }
    return bootStagePass({ stageId }, { stageId }, `${stageId}_READY`);
  }]));
}

/**
 * Task 6 bounded examples and exhaustive flag/gate combinations using production modules.
 * Property 35: Input context와 feature flag 격리.
 * **Validates: Requirements 12.7, 20.4, 20.6, 22.9, 26.7, 27.4, 28.7, 29.4, 30.3, 30.5, 31.6**
 */
export async function runBootstrapFeatureProbe() {
  const results = await Promise.all([
    runCase(
      "default-off-schema",
      "등록된 optional feature 10개가 누락 없이 boolean false로 시작한다",
      "Requirements 12.7, 26.7, 27.4, 28.7, 29.4, 30.5, 31.6",
      () => {
        assert(FEATURE_IDS.length === 10, `feature count가 ${FEATURE_IDS.length}입니다.`);
        assert(FEATURE_IDS.every((featureId) => DEFAULT_FEATURE_FLAGS[featureId] === false), "default true feature가 있습니다.");
        assert(Object.isFrozen(DEFAULT_FEATURE_FLAGS), "default flags가 immutable하지 않습니다.");
        return { featureIds: FEATURE_IDS, enabled: 0 };
      },
    ),
    runCase(
      "audio-flags-independent",
      "phaseBgm과 extendedAudio 네 조합이 서로의 값을 암묵 변경하지 않는다",
      "Requirements 22.9, 30.3, 30.5",
      () => {
        const combinations = [];
        for (const extendedAudio of [false, true]) {
          for (const phaseBgm of [false, true]) {
            const flags = createFeatureFlags({ extendedAudio, phaseBgm });
            assert(flags.extendedAudio === extendedAudio, "extendedAudio 값이 독립적으로 보존되지 않았습니다.");
            assert(flags.phaseBgm === phaseBgm, "phaseBgm 값이 독립적으로 보존되지 않았습니다.");
            combinations.push({ extendedAudio, phaseBgm });
          }
        }
        return { combinations };
      },
    ),
    runCase(
      "all-features-require-gate",
      "flag on이어도 gate artifact가 없으면 모든 optional module install을 거절한다",
      "Requirements 12.7, 26.7, 27.4, 28.7, 29.4, 30.5, 31.6",
      () => {
        const codes = {};
        for (const featureId of FEATURE_IDS) {
          let installCalls = 0;
          const registry = new FeatureRegistry({
            flags: createFeatureFlags({ [featureId]: true }),
            buildMetadata: DEFAULT_BUILD_METADATA,
            gateArtifacts: [],
          });
          const result = registry.registerModule({
            featureId,
            moduleId: `qa.module.${featureId}`,
            install() { installCalls += 1; },
          });
          assert(!result.ok && result.code === "FEATURE_GATE_ARTIFACT_MISSING", `${featureId}가 gate 없이 등록됐습니다.`);
          assert(installCalls === 0, `${featureId} install callback이 거절 전에 실행됐습니다.`);
          codes[featureId] = result.code;
        }
        return { codes };
      },
    ),
    runCase(
      "missing-build-id-rejected",
      "PASS gate가 있어도 build ID가 없으면 optional registration을 거절한다",
      "Requirements 25.7, 31.6",
      () => {
        let installCalls = 0;
        const registry = new FeatureRegistry({
          flags: createFeatureFlags({ staff: true }),
          buildMetadata: null,
          gateArtifacts: [gateArtifact(FEATURE_GATE_KIND.MUST)],
        });
        const result = registry.registerModule({
          featureId: "staff",
          moduleId: "qa.module.staff",
          install() { installCalls += 1; },
        });
        assert(!result.ok && result.code === "FEATURE_BUILD_ID_MISSING", `code=${result.code}`);
        assert(installCalls === 0, "build ID 거절 전에 install이 실행됐습니다.");
        return { code: result.code };
      },
    ),
    runCase(
      "gate-status-and-build-parity",
      "FAIL/NOT_RUN 또는 다른 build의 gate는 활성화를 허용하지 않는다",
      "Requirements 25.7, 31.6",
      () => {
        const flags = createFeatureFlags({ staff: true });
        const failed = new FeatureRegistry({
          flags,
          buildMetadata: DEFAULT_BUILD_METADATA,
          gateArtifacts: [gateArtifact(FEATURE_GATE_KIND.MUST, { status: FEATURE_GATE_STATUS.FAIL })],
        }).evaluateActivation("staff");
        const stale = new FeatureRegistry({
          flags,
          buildMetadata: DEFAULT_BUILD_METADATA,
          gateArtifacts: [gateArtifact(FEATURE_GATE_KIND.MUST, { buildId: "other.build" })],
        }).evaluateActivation("staff");
        assert(!failed.ok && failed.code === "FEATURE_GATE_NOT_PASSED", `FAIL gate code=${failed.code}`);
        assert(!stale.ok && stale.code === "FEATURE_GATE_BUILD_MISMATCH", `stale gate code=${stale.code}`);
        return { failed: failed.code, stale: stale.code };
      },
    ),
    runCase(
      "current-build-pass-registers",
      "required current-build PASS gate에서만 Should/Could module을 각각 한 번 설치한다",
      "Requirements 12.7, 31.6",
      () => {
        let shouldCalls = 0;
        let couldCalls = 0;
        const shouldRegistry = new FeatureRegistry({
          flags: createFeatureFlags({ staff: true }),
          buildMetadata: DEFAULT_BUILD_METADATA,
          gateArtifacts: [gateArtifact(FEATURE_GATE_KIND.MUST)],
        });
        const should = shouldRegistry.registerModule({
          featureId: "staff",
          moduleId: "qa.module.staff",
          install() { shouldCalls += 1; },
        });
        const couldRegistry = new FeatureRegistry({
          flags: createFeatureFlags({ optionalMaps: true }),
          buildMetadata: DEFAULT_BUILD_METADATA,
          gateArtifacts: [gateArtifact(FEATURE_GATE_KIND.SHOULD)],
        });
        const could = couldRegistry.registerModule({
          featureId: "optionalMaps",
          moduleId: "qa.module.optionalMaps",
          install() { couldCalls += 1; },
        });
        assert(should.ok && could.ok && shouldCalls === 1 && couldCalls === 1, "current-build PASS 등록이 실패했습니다.");
        return { shouldGate: should.details.gateKind, couldGate: could.details.gateKind };
      },
    ),
    runCase(
      "feature-disabled-before-draft",
      "flag-off optional command를 FEATURE_DISABLED로 transaction prepare/draft 전에 거절한다",
      "Requirements 12.7, 26.7, 27.4, 28.7, 29.4, 30.5, 31.6",
      async () => {
        const { result, counter } = await dispatchGuardedFeatureCommand(DEFAULT_FEATURE_FLAGS);
        assert(!result.ok && result.code === "FEATURE_DISABLED", `flag-off code=${result.code}`);
        return { code: result.code, ...counter };
      },
    ),
    runCase(
      "enabled-command-without-gate-before-draft",
      "flag-on command도 gate 부재 시 transaction prepare/draft 전에 거절한다",
      "Requirements 12.7, 31.6",
      async () => {
        const { result, counter } = await dispatchGuardedFeatureCommand(createFeatureFlags({ staff: true }));
        assert(!result.ok && result.code === "FEATURE_GATE_ARTIFACT_MISSING", `gate-less code=${result.code}`);
        return { code: result.code, ...counter };
      },
    ),
    runCase(
      "fixed-boot-stage-order",
      "shell→build/flag→data→Map→asset→save→store 순서를 바꾸지 않는다",
      "Requirements 20.4, 20.6, 25.1",
      async () => {
        const observed = [];
        const projection = new BootStateProjection();
        const result = await executeBootPipeline({
          stages: stageCallbacks((stageId) => observed.push(stageId)),
          projection,
        });
        assert(result.ok && result.projection.status === BOOT_STATUS.READY, "유효 pipeline이 READY가 아닙니다.");
        assert(JSON.stringify(observed) === JSON.stringify(BOOT_STAGE_ORDER), `stage order=${observed.join(",")}`);
        assert(result.projection.stages.every((stage) => [BOOT_STAGE_STATUS.PASS, BOOT_STAGE_STATUS.SKIPPED].includes(stage.status)), "완료되지 않은 stage가 있습니다.");
        return { observed, status: result.projection.status };
      },
    ),
    runCase(
      "required-data-fault-short-circuits",
      "필수 data fault가 Map 이후 단계를 실행하지 않고 start를 차단한다",
      "Requirements 20.4, 20.6",
      async () => {
        const observed = [];
        const diagnostic = createDiagnostic({
          severity: DIAGNOSTIC_SEVERITY.FATAL_BOOT,
          subsystem: "DataLoader",
          filename: "data/recipes.json",
          errorType: "REFERENCE_ERROR",
          code: "REFERENCE_NOT_FOUND",
          fieldPath: "$.recipes[0].ingredientRequirements[0].ingredientId",
        });
        const result = await executeBootPipeline({
          stages: stageCallbacks(
            (stageId) => observed.push(stageId),
            (stageId) => stageId === BOOT_STAGE.DATA
              ? bootStageFailure("CANONICAL_DATA_BLOCKED", [diagnostic])
              : null,
          ),
          projection: new BootStateProjection(),
        });
        assert(!result.ok && result.failedStage === BOOT_STAGE.DATA, "data fault가 DATA 경계에서 차단되지 않았습니다.");
        assert(JSON.stringify(observed) === JSON.stringify([BOOT_STAGE.SHELL, BOOT_STAGE.BUILD_FLAGS, BOOT_STAGE.DATA]), "차단 뒤 stage callback이 실행됐습니다.");
        assert(result.projection.status === BOOT_STATUS.BLOCKED && !result.projection.canStart, "fault projection이 start를 허용합니다.");
        const later = result.projection.stages.slice(3);
        assert(later.every((stage) => stage.status === BOOT_STAGE_STATUS.SKIPPED && stage.code === "BLOCKED_BY_PREVIOUS_STAGE"), "후속 stage가 blocked skip이 아닙니다.");
        return { observed, failedStage: result.failedStage, laterStages: later.length };
      },
    ),
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    property: "Property 35: feature flag isolation",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}

export function runBootstrapFeatureShellSmoke({ root, app, report }) {
  assert(report?.status === "PASS", "bootstrap/feature probe가 PASS가 아닙니다.");
  const actualBoot = app.getBootState();
  assert(actualBoot.status === BOOT_STATUS.READY, "실제 browser boot가 READY가 아닙니다.");
  assert(JSON.stringify(actualBoot.stages.map((stage) => stage.stageId)) === JSON.stringify(BOOT_STAGE_ORDER), "실제 browser stage projection 순서가 다릅니다.");
  assert(app.store?.runtimePhase === "TITLE", "store가 TITLE에서 조립되지 않았습니다.");
  assert(Object.keys(app.store.getSnapshot().extensions).length === 0, "default-off boot에 extension state가 생성됐습니다.");
  assert(FEATURE_IDS.every((featureId) => app.store.getSnapshot().featureFlags[featureId] === false), "browser store에 default-on flag가 있습니다.");

  const injected = createDiagnostic({
    diagnosticId: "diagnostic:qa:bootstrap:data-fault",
    severity: DIAGNOSTIC_SEVERITY.FATAL_BOOT,
    subsystem: "DataLoader",
    filename: "data/recipes.json",
    errorType: "REFERENCE_ERROR",
    code: "REFERENCE_NOT_FOUND",
    fieldPath: "$.recipes[0].ingredientRequirements[0].ingredientId",
    details: { injectedAtStage: BOOT_STAGE.DATA },
  });
  app.hub?.stop({ deactivate: true });
  app.shell.errorScreen.show([injected], { blockStart: true });

  const errorScreen = root.querySelector("#screen-error");
  const startButton = root.querySelector("#btn-start");
  const creditsButton = root.querySelector("#btn-credits");
  const primary = errorScreen?.querySelector(".diagnostic-primary")?.textContent ?? "";
  assert(errorScreen && !errorScreen.classList.contains("hidden"), "injected data fault 뒤 error screen이 보이지 않습니다.");
  assert(startButton?.disabled && root.documentElement.dataset.campaignStart === "blocked", "injected data fault가 campaign start를 차단하지 않았습니다.");
  assert(primary.includes("data/recipes.json") && primary.includes("REFERENCE_ERROR"), "filename/errorType-first 표시가 아닙니다.");
  assert(creditsButton && !creditsButton.disabled, "fatal boot boundary에서 Credits가 비활성화됐습니다.");

  app.shell.credits.open(creditsButton);
  assert(!root.querySelector("#credits-overlay")?.classList.contains("hidden"), "fatal boot boundary에서 Credits가 열리지 않습니다.");
  app.shell.credits.close();
  assert(!errorScreen.classList.contains("hidden"), "Credits를 닫은 뒤 error route가 사라졌습니다.");
  root.documentElement.dataset.bootFaultInjection = "data";

  return Object.freeze({
    actualBootStatus: actualBoot.status,
    stageOrder: actualBoot.stages.map((stage) => stage.stageId),
    startBlocked: true,
    errorVisible: true,
    creditsAccessible: true,
    featureFlagsEnabled: 0,
  });
}

export function publishBootstrapFeatureReport(root, report, shellSmoke = null) {
  if (!root?.body || typeof root.createElement !== "function") return report;
  root.querySelector("#bootstrap-feature-qa-report")?.remove();
  const section = root.createElement("section");
  section.id = "bootstrap-feature-qa-report";
  section.className = `qa-report qa-report--${report.status.toLowerCase()}`;
  section.setAttribute("aria-live", "polite");

  const heading = root.createElement("h2");
  heading.textContent = `Bootstrap & feature registry: ${report.status}`;
  section.append(heading);
  const summary = root.createElement("p");
  summary.textContent = `${report.passed}/${report.total} 검사 통과${shellSmoke ? " · data fault shell PASS" : ""}`;
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
  root.body.dataset.bootstrapFeatureQa = report.status.toLowerCase();
  root.body.dataset.bootstrapFeatureQaPassed = String(report.passed);
  root.body.dataset.bootstrapFeatureQaTotal = String(report.total);
  root.dispatchEvent(new CustomEvent("bootstrap-features:qa-complete", {
    detail: { report, shellSmoke },
  }));
  console.group(`QA: ${QA_ID} — ${report.status}`);
  console.table(report.results);
  console.groupEnd();
  return report;
}
