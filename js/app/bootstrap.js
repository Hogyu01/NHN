import { CommandBus } from "../core/command-bus.js";
import {
  createDiagnostic,
  diagnosticFromError,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import { GameStore } from "../core/store.js";
import { CANONICAL_CONTENT_SPECIFICATIONS } from "../infrastructure/canonical-content.js";
import { DataLoader } from "../infrastructure/data-loader.js";
import { CanvasScene } from "../ui/canvas-scene.js";
import { CreditsShell } from "../ui/credits-shell.js";
import { ErrorScreen } from "../ui/error-screen.js";
import { PrototypeHubAdapter } from "../ui/prototype-hub-adapter.js";
import { runPrototypeRegression } from "../qa/prototype-regression.js";
import {
  DEFAULT_BUILD_METADATA,
  validateBuildMetadata,
} from "./build-metadata.js";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_IDS,
  validateFeatureFlags,
} from "./feature-flags.js";
import { FeatureRegistry } from "./feature-registry.js";

const PROTOTYPE_QA_ROUTE = "prototype-baseline";
const DETERMINISTIC_CORE_QA_ROUTE = "deterministic-core";
const DATA_VALIDATION_QA_ROUTE = "data-validation";
const BOOTSTRAP_FEATURE_QA_ROUTE = "bootstrap-features";

export const BOOT_STAGE = Object.freeze({
  SHELL: "SHELL",
  BUILD_FLAGS: "BUILD_FLAGS",
  DATA: "DATA",
  MAP: "MAP",
  ASSET: "ASSET",
  SAVE: "SAVE",
  STORE: "STORE",
});

export const BOOT_STAGE_ORDER = Object.freeze([
  BOOT_STAGE.SHELL,
  BOOT_STAGE.BUILD_FLAGS,
  BOOT_STAGE.DATA,
  BOOT_STAGE.MAP,
  BOOT_STAGE.ASSET,
  BOOT_STAGE.SAVE,
  BOOT_STAGE.STORE,
]);

export const BOOT_STATUS = Object.freeze({
  IDLE: "IDLE",
  BOOTING: "BOOTING",
  READY: "READY",
  BLOCKED: "BLOCKED",
});

export const BOOT_STAGE_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  PASS: "PASS",
  SKIPPED: "SKIPPED",
  FAIL: "FAIL",
});

function requireElement(root, selector) {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`필수 DOM 요소를 찾을 수 없습니다: ${selector}`);
  }
  return element;
}

function showScreen(root, screenId) {
  root.querySelectorAll(".screen").forEach((element) => {
    element.classList.toggle("hidden", element.id !== screenId);
  });
}

function stageResult({ ok, value = undefined, status = undefined, code, diagnostics = [], details = undefined }) {
  return Object.freeze({
    ok,
    ...(value === undefined ? {} : { value }),
    ...(status === undefined ? {} : { status }),
    code,
    diagnostics: Object.freeze([...diagnostics]),
    ...(details === undefined ? {} : { details: freezeDeep(details) }),
  });
}

export function bootStagePass(value, details = undefined, code = "BOOT_STAGE_PASS") {
  return stageResult({ ok: true, value, status: BOOT_STAGE_STATUS.PASS, code, details });
}

export function bootStageSkipped(value, code, details = undefined) {
  return stageResult({ ok: true, value, status: BOOT_STAGE_STATUS.SKIPPED, code, details });
}

export function bootStageFailure(code, diagnostics, details = undefined) {
  return stageResult({ ok: false, code, diagnostics, details });
}

function bootDiagnostic(stageId, code, errorType, details = undefined, error = undefined) {
  const context = {
    severity: DIAGNOSTIC_SEVERITY.FATAL_BOOT,
    subsystem: "AppBootstrap",
    filename: stageId === BOOT_STAGE.DATA ? "data/content-manifest.json" : "js/app/bootstrap.js",
    errorType,
    code,
    fieldPath: `$boot.${stageId.toLowerCase()}`,
    details: { stageId, ...(details && typeof details === "object" ? details : {}) },
  };
  return error === undefined ? createDiagnostic(context) : diagnosticFromError(error, context);
}

/** Immutable, observable projection of stage order, status, and diagnostics. */
export class BootStateProjection {
  constructor({ onChange = null } = {}) {
    if (onChange !== null && typeof onChange !== "function") {
      throw new TypeError("BootStateProjection onChange는 함수 또는 null이어야 합니다.");
    }
    this.onChange = onChange;
    this.sequence = 0;
    this.status = BOOT_STATUS.IDLE;
    this.activeStage = null;
    this.canStart = false;
    this.diagnostics = [];
    this.stages = new Map(BOOT_STAGE_ORDER.map((stageId) => [stageId, {
      stageId,
      status: BOOT_STAGE_STATUS.PENDING,
      sequenceStarted: null,
      sequenceCompleted: null,
      code: null,
      details: null,
    }]));
  }

  begin(stageId) {
    const index = BOOT_STAGE_ORDER.indexOf(stageId);
    if (index < 0) throw new RangeError(`알 수 없는 boot stage입니다: ${stageId}`);
    if (this.status === BOOT_STATUS.BLOCKED || this.status === BOOT_STATUS.READY) {
      throw new Error(`완료된 boot projection에서 stage를 시작할 수 없습니다: ${stageId}`);
    }
    for (let prior = 0; prior < index; prior += 1) {
      const status = this.stages.get(BOOT_STAGE_ORDER[prior]).status;
      if (![BOOT_STAGE_STATUS.PASS, BOOT_STAGE_STATUS.SKIPPED].includes(status)) {
        throw new Error(`boot stage 순서 위반: ${stageId} before ${BOOT_STAGE_ORDER[prior]}`);
      }
    }
    const stage = this.stages.get(stageId);
    if (stage.status !== BOOT_STAGE_STATUS.PENDING) {
      throw new Error(`boot stage가 중복 시작됐습니다: ${stageId}`);
    }
    this.sequence += 1;
    stage.status = BOOT_STAGE_STATUS.RUNNING;
    stage.sequenceStarted = this.sequence;
    this.status = BOOT_STATUS.BOOTING;
    this.activeStage = stageId;
    this.#emit();
  }

  complete(stageId, { status = BOOT_STAGE_STATUS.PASS, code = "BOOT_STAGE_PASS", details = null, diagnostics = [] } = {}) {
    if (![BOOT_STAGE_STATUS.PASS, BOOT_STAGE_STATUS.SKIPPED].includes(status)) {
      throw new TypeError("완료 stage status는 PASS 또는 SKIPPED여야 합니다.");
    }
    const stage = this.stages.get(stageId);
    if (!stage || stage.status !== BOOT_STAGE_STATUS.RUNNING || this.activeStage !== stageId) {
      throw new Error(`실행 중이 아닌 boot stage를 완료할 수 없습니다: ${stageId}`);
    }
    this.sequence += 1;
    stage.status = status;
    stage.sequenceCompleted = this.sequence;
    stage.code = code;
    stage.details = details === null ? null : freezeDeep(details);
    this.diagnostics.push(...diagnostics);
    this.activeStage = null;
    this.#emit();
  }

  fail(stageId, { code, diagnostics = [], details = null }) {
    const stage = this.stages.get(stageId);
    if (!stage || stage.status !== BOOT_STAGE_STATUS.RUNNING || this.activeStage !== stageId) {
      throw new Error(`실행 중이 아닌 boot stage를 실패 처리할 수 없습니다: ${stageId}`);
    }
    this.sequence += 1;
    stage.status = BOOT_STAGE_STATUS.FAIL;
    stage.sequenceCompleted = this.sequence;
    stage.code = code;
    stage.details = details === null ? null : freezeDeep(details);
    this.diagnostics.push(...diagnostics);
    this.activeStage = null;
    this.status = BOOT_STATUS.BLOCKED;
    this.canStart = false;

    const failedIndex = BOOT_STAGE_ORDER.indexOf(stageId);
    for (let index = failedIndex + 1; index < BOOT_STAGE_ORDER.length; index += 1) {
      const skipped = this.stages.get(BOOT_STAGE_ORDER[index]);
      if (skipped.status !== BOOT_STAGE_STATUS.PENDING) continue;
      this.sequence += 1;
      skipped.status = BOOT_STAGE_STATUS.SKIPPED;
      skipped.sequenceStarted = this.sequence;
      skipped.sequenceCompleted = this.sequence;
      skipped.code = "BLOCKED_BY_PREVIOUS_STAGE";
      skipped.details = freezeDeep({ blockedBy: stageId });
    }
    this.#emit();
  }

  ready() {
    if (BOOT_STAGE_ORDER.some((stageId) => ![
      BOOT_STAGE_STATUS.PASS,
      BOOT_STAGE_STATUS.SKIPPED,
    ].includes(this.stages.get(stageId).status))) {
      throw new Error("모든 boot stage가 완료되기 전에 READY가 요청됐습니다.");
    }
    this.status = BOOT_STATUS.READY;
    this.activeStage = null;
    this.canStart = true;
    this.#emit();
  }

  snapshot() {
    return freezeDeep({
      status: this.status,
      activeStage: this.activeStage,
      canStart: this.canStart,
      sequence: this.sequence,
      stages: BOOT_STAGE_ORDER.map((stageId) => ({ ...this.stages.get(stageId) })),
      diagnostics: [...this.diagnostics],
    });
  }

  #emit() {
    if (!this.onChange) return;
    try {
      this.onChange(this.snapshot());
    } catch {
      // Projection observers are non-authoritative and cannot alter boot ordering.
    }
  }
}

function normalizeStageResult(raw) {
  if (raw === undefined) return bootStagePass(undefined);
  if (!raw || typeof raw !== "object" || typeof raw.ok !== "boolean") {
    return bootStagePass(raw);
  }
  return stageResult({
    ok: raw.ok,
    value: raw.value,
    status: raw.status ?? (raw.ok ? BOOT_STAGE_STATUS.PASS : BOOT_STAGE_STATUS.FAIL),
    code: raw.code ?? (raw.ok ? "BOOT_STAGE_PASS" : "BOOT_STAGE_FAILED"),
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
    details: raw.details,
  });
}

/** Executes the fixed shell→build/flag→data→Map→asset→save→store sequence. */
export async function executeBootPipeline({ stages, projection = new BootStateProjection() }) {
  if (!stages || typeof stages !== "object") throw new TypeError("boot stages object가 필요합니다.");
  const values = Object.create(null);

  for (const stageId of BOOT_STAGE_ORDER) {
    const execute = stages[stageId];
    if (typeof execute !== "function") throw new TypeError(`boot stage callback이 없습니다: ${stageId}`);
    projection.begin(stageId);
    let outcome;
    try {
      outcome = normalizeStageResult(await execute(Object.freeze({ ...values })));
    } catch (error) {
      const diagnostic = bootDiagnostic(stageId, "BOOT_STAGE_EXCEPTION", "BootStageError", undefined, error);
      outcome = bootStageFailure(diagnostic.code, [diagnostic]);
    }

    if (!outcome.ok) {
      const diagnostics = outcome.diagnostics.length > 0
        ? outcome.diagnostics
        : [bootDiagnostic(stageId, outcome.code, "BootStageError", outcome.details)];
      projection.fail(stageId, {
        code: outcome.code,
        diagnostics,
        details: outcome.details ?? null,
      });
      return Object.freeze({
        ok: false,
        code: outcome.code,
        failedStage: stageId,
        values: Object.freeze({ ...values }),
        diagnostics: Object.freeze([...diagnostics]),
        projection: projection.snapshot(),
      });
    }

    values[stageId] = outcome.value;
    projection.complete(stageId, {
      status: outcome.status,
      code: outcome.code,
      details: outcome.details ?? null,
      diagnostics: outcome.diagnostics,
    });
  }

  projection.ready();
  return Object.freeze({
    ok: true,
    code: "BOOT_READY",
    failedStage: null,
    values: Object.freeze({ ...values }),
    diagnostics: Object.freeze([...projection.snapshot().diagnostics]),
    projection: projection.snapshot(),
  });
}

/** Mounts routes that must survive every later boot failure. */
export function createStartupShell(root = document) {
  const startButton = requireElement(root, "#btn-start");
  const credits = new CreditsShell({ root });
  const errorScreen = new ErrorScreen({
    root,
    showScreen: (screenId) => showScreen(root, screenId),
  });
  startButton.disabled = true;
  startButton.setAttribute("aria-disabled", "true");
  root.documentElement.dataset.credits = "closed";
  root.documentElement.dataset.campaignStart = "booting";
  return Object.freeze({
    credits,
    errorScreen,
    showScreen: (screenId) => showScreen(root, screenId),
    setStartEnabled(enabled) {
      startButton.disabled = !enabled;
      startButton.setAttribute("aria-disabled", String(!enabled));
      root.documentElement.dataset.campaignStart = enabled ? "available" : "blocked";
    },
  });
}

export class AppBootstrap {
  constructor({
    root = document,
    buildMetadata = DEFAULT_BUILD_METADATA,
    featureFlags = DEFAULT_FEATURE_FLAGS,
    gateArtifacts = [],
    dataLoader = new DataLoader(),
    stageOverrides = {},
  } = {}) {
    if (!root || typeof root.querySelector !== "function") throw new TypeError("AppBootstrap root document가 필요합니다.");
    if (!dataLoader || typeof dataLoader.loadAll !== "function") throw new TypeError("AppBootstrap DataLoader가 필요합니다.");
    if (!stageOverrides || typeof stageOverrides !== "object" || Array.isArray(stageOverrides)) {
      throw new TypeError("stageOverrides는 object여야 합니다.");
    }
    for (const stageId of Object.keys(stageOverrides)) {
      if (!BOOT_STAGE_ORDER.includes(stageId) || typeof stageOverrides[stageId] !== "function") {
        throw new TypeError(`유효하지 않은 boot stage override입니다: ${stageId}`);
      }
    }

    this.root = root;
    this.buildMetadataInput = buildMetadata;
    this.featureFlagsInput = featureFlags;
    this.gateArtifacts = gateArtifacts;
    this.dataLoader = dataLoader;
    this.stageOverrides = stageOverrides;
    this.shell = null;
    this.scene = null;
    this.hub = null;
    this.store = null;
    this.commandBus = null;
    this.featureRegistry = null;
    this.canonicalContent = null;
    this.bootResult = null;
    this._startPromise = null;
    this._interactionsBound = false;
    this._destroyed = false;
    this._runtimeDiagnostics = [];

    this.projection = new BootStateProjection({
      onChange: (snapshot) => this.#publishProjection(snapshot),
    });
  }

  start() {
    if (!this._startPromise) this._startPromise = this.#start();
    return this._startPromise;
  }

  getBootState() {
    return this.projection.snapshot();
  }

  async #start() {
    const stages = this.#createStages();
    const result = await executeBootPipeline({ stages, projection: this.projection });
    this.bootResult = result;

    if (!result.ok) {
      this.hub?.stop({ deactivate: true });
      if (this.shell && result.diagnostics.length > 0) {
        this.shell.errorScreen.show(result.diagnostics, { blockStart: true });
      }
      return result;
    }

    this.#bindPrototypeInteractions();
    this.shell.errorScreen.clear({ enableStart: true });
    this.root.documentElement.dataset.buildId = this.buildMetadataInput.buildId;
    this.root.documentElement.dataset.featureFlagsEnabled = String(
      FEATURE_IDS.filter((featureId) => this.featureRegistry.flags[featureId]).length,
    );
    this.root.documentElement.dataset.phaseBgm = String(this.featureRegistry.flags.phaseBgm);
    this.root.documentElement.dataset.extendedAudio = String(this.featureRegistry.flags.extendedAudio);
    return result;
  }

  #createStages() {
    const defaults = {
      [BOOT_STAGE.SHELL]: async () => {
        this.shell = createStartupShell(this.root);
        return bootStagePass(this.shell, { routes: ["start", "error", "credits"] }, "SHELL_READY");
      },
      [BOOT_STAGE.BUILD_FLAGS]: async () => {
        const metadata = validateBuildMetadata(this.buildMetadataInput);
        if (!metadata.ok) {
          const diagnostic = bootDiagnostic(
            BOOT_STAGE.BUILD_FLAGS,
            metadata.code,
            "BUILD_METADATA_ERROR",
            { issues: metadata.issues },
          );
          return bootStageFailure(metadata.code, [diagnostic]);
        }
        const flags = validateFeatureFlags(this.featureFlagsInput);
        if (!flags.ok) {
          const diagnostic = bootDiagnostic(
            BOOT_STAGE.BUILD_FLAGS,
            flags.code,
            "FEATURE_FLAG_SCHEMA_ERROR",
            { issues: flags.issues },
          );
          return bootStageFailure(flags.code, [diagnostic]);
        }
        this.featureRegistry = new FeatureRegistry({
          flags: flags.value,
          buildMetadata: metadata.value,
          gateArtifacts: this.gateArtifacts,
        });
        return bootStagePass({
          buildMetadata: metadata.value,
          featureFlags: flags.value,
          featureRegistry: this.featureRegistry,
        }, {
          buildId: metadata.value.buildId,
          requestedFeatureCount: FEATURE_IDS.filter((featureId) => flags.value[featureId]).length,
          defaultOffCount: FEATURE_IDS.filter((featureId) => !flags.value[featureId]).length,
        }, "BUILD_FLAGS_VALID");
      },
      [BOOT_STAGE.DATA]: async () => {
        const report = await this.dataLoader.loadAll(CANONICAL_CONTENT_SPECIFICATIONS);
        if (report.blocked) {
          return bootStageFailure("CANONICAL_DATA_BLOCKED", report.diagnostics, {
            accepted: report.accepted.length,
            rejected: report.rejected.length,
          });
        }
        this.canonicalContent = report;
        return stageResult({
          ok: true,
          value: report,
          status: BOOT_STAGE_STATUS.PASS,
          code: report.ok ? "CANONICAL_DATA_VALID" : "CANONICAL_DATA_VALID_WITH_QUARANTINE",
          diagnostics: report.diagnostics,
          details: {
            accepted: report.accepted.length,
            quarantined: report.quarantined.length,
          },
        });
      },
      [BOOT_STAGE.MAP]: async () => bootStageSkipped(
        Object.freeze({ registry: null, activeMap: null }),
        "MAP_SYSTEM_DEFERRED_TO_TASK_7",
        { boundaryEstablished: true },
      ),
      [BOOT_STAGE.ASSET]: async () => {
        const canvas = requireElement(this.root, "#game-canvas");
        const panelOverlay = requireElement(this.root, "#panel-overlay");
        const panelTitle = requireElement(this.root, "#panel-title");
        const panelBody = requireElement(this.root, "#panel-body");
        const panelCloseButton = requireElement(this.root, "#btn-panel-close");
        const spriteUrl = new URL("../../assets/sprites/player_walk.png", import.meta.url);
        this.scene = new CanvasScene({ canvas, spriteUrl });
        const sprite = await this.scene.loadSprite();
        this.hub = new PrototypeHubAdapter({
          scene: this.scene,
          panelOverlay,
          panelTitle,
          panelBody,
          panelCloseButton,
          inputTarget: this.root.defaultView,
        });
        return bootStagePass({ scene: this.scene, hub: this.hub }, {
          assetId: "prototype.player_walk.l0",
          width: sprite.width,
          height: sprite.height,
        }, "PROTOTYPE_ASSET_READY");
      },
      [BOOT_STAGE.SAVE]: async () => bootStageSkipped(
        Object.freeze({ checkpoint: null, recovery: "NEW_CAMPAIGN" }),
        "SAVE_SYSTEM_DEFERRED_TO_TASK_27",
        { boundaryEstablished: true, recovery: "NEW_CAMPAIGN" },
      ),
      [BOOT_STAGE.STORE]: async (context) => {
        const buildAndFlags = context[BOOT_STAGE.BUILD_FLAGS];
        const data = context[BOOT_STAGE.DATA];
        this.store = new GameStore({
          formatVersion: 1,
          revision: 0,
          runtimePhase: "TITLE",
          checkpointPhase: null,
          generationId: 0,
          featureFlags: buildAndFlags.featureFlags,
          extensions: {},
          boot: {
            buildId: buildAndFlags.buildMetadata.buildId,
            contentVersion: buildAndFlags.buildMetadata.contentVersion,
            canonicalFiles: data.accepted.map((entry) => entry.filename),
          },
        });
        this.commandBus = new CommandBus({
          store: this.store,
          commandGuards: [this.featureRegistry.createCommandGuard()],
          onDiagnostic: (diagnostic) => this._runtimeDiagnostics.push(diagnostic),
        });
        return bootStagePass({ store: this.store, commandBus: this.commandBus }, {
          revision: this.store.revision,
          runtimePhase: this.store.runtimePhase,
          optionalNamespaceCount: Object.keys(this.store.getSnapshot().extensions).length,
        }, "STORE_READY");
      },
    };

    return Object.fromEntries(BOOT_STAGE_ORDER.map((stageId) => [
      stageId,
      this.stageOverrides[stageId]
        ? (context) => this.stageOverrides[stageId](Object.freeze({ app: this, context }))
        : defaults[stageId],
    ]));
  }

  #bindPrototypeInteractions() {
    if (this._interactionsBound) return;
    const startButton = requireElement(this.root, "#btn-start");
    const canvas = requireElement(this.root, "#game-canvas");
    const panelCloseButton = requireElement(this.root, "#btn-panel-close");

    this.enterPrototype = () => {
      if (this.shell.errorScreen.blocked || this.getBootState().status !== BOOT_STATUS.READY) return;
      this.shell.credits.close();
      showScreen(this.root, "screen-room");
      this.hub.start();
      canvas.focus({ preventScroll: true });
    };
    this.closePanel = () => this.hub.closePanel();
    this.handlePageHide = () => this.destroy();
    startButton.addEventListener("click", this.enterPrototype);
    panelCloseButton.addEventListener("click", this.closePanel);
    this.root.defaultView.addEventListener("pagehide", this.handlePageHide, { once: true });
    this._interactionsBound = true;
  }

  async runQaRoute() {
    if (!this.bootResult?.ok) return this.bootResult;
    const canvas = requireElement(this.root, "#game-canvas");
    const qaMode = new URL(this.root.defaultView.location.href).searchParams.get("qa");

    if (qaMode === PROTOTYPE_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.activate();
      const report = await runPrototypeRegression({ root: this.root, scene: this.scene, hub: this.hub });
      this.hub.reset();
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }
    if (qaMode === DETERMINISTIC_CORE_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.activate();
      const {
        publishDeterministicCoreReport,
        runDeterministicCoreProbe,
      } = await import("../qa/deterministic-core-probe.js");
      const report = runDeterministicCoreProbe();
      publishDeterministicCoreReport(this.root, report);
      this.hub.reset();
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }
    if (qaMode === DATA_VALIDATION_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.activate();
      const {
        publishDataValidationReport,
        runDataValidationProbe,
        runDataValidationShellSmoke,
      } = await import("../qa/data-validation-probe.js");
      const report = await runDataValidationProbe();
      const shellSmoke = runDataValidationShellSmoke({ root: this.root, shell: this.shell, report });
      publishDataValidationReport(this.root, report, shellSmoke);
      this.hub.stop();
      return Object.freeze({ ...report, shellSmoke });
    }
    if (qaMode === BOOTSTRAP_FEATURE_QA_ROUTE) {
      const {
        publishBootstrapFeatureReport,
        runBootstrapFeatureProbe,
        runBootstrapFeatureShellSmoke,
      } = await import("../qa/bootstrap-feature-probe.js");
      const report = await runBootstrapFeatureProbe();
      const shellSmoke = runBootstrapFeatureShellSmoke({ root: this.root, app: this, report });
      publishBootstrapFeatureReport(this.root, report, shellSmoke);
      return Object.freeze({ ...report, shellSmoke });
    }
    return null;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.hub?.destroy();
    this.shell?.credits.destroy();
    if (this._interactionsBound) {
      const startButton = this.root.querySelector("#btn-start");
      const panelCloseButton = this.root.querySelector("#btn-panel-close");
      startButton?.removeEventListener("click", this.enterPrototype);
      panelCloseButton?.removeEventListener("click", this.closePanel);
      this.root.defaultView?.removeEventListener("pagehide", this.handlePageHide);
    }
  }

  #publishProjection(snapshot) {
    const element = this.root.documentElement;
    element.dataset.bootStatus = snapshot.status.toLowerCase();
    element.dataset.bootStage = snapshot.activeStage ?? snapshot.stages.findLast?.(
      (stage) => stage.status === BOOT_STAGE_STATUS.PASS || stage.status === BOOT_STAGE_STATUS.SKIPPED,
    )?.stageId ?? "NONE";
    element.dataset.bootCanStart = String(snapshot.canStart);
    const EventConstructor = this.root.defaultView?.CustomEvent;
    if (typeof EventConstructor === "function") {
      this.root.dispatchEvent(new EventConstructor("app:boot-state", { detail: snapshot }));
    }
  }
}

/** Backward-compatible prototype entry facade backed by the staged AppBootstrap. */
export function bootstrapPrototypeApp(root = document, options = {}) {
  const app = new AppBootstrap({ root, ...options });
  const readyPromise = app.start();
  const qaPromise = readyPromise.then(async (result) => {
    if (!result.ok) return result;
    // Let main.js publish moduleBoot/app:boot-ready before legacy QA observes readiness.
    await Promise.resolve();
    return app.runQaRoute();
  });
  return Object.freeze({
    app,
    readyPromise,
    qaPromise,
    get scene() { return app.scene; },
    get hub() { return app.hub; },
    get shell() { return app.shell; },
    get store() { return app.store; },
    get commandBus() { return app.commandBus; },
    get featureRegistry() { return app.featureRegistry; },
    get bootState() { return app.getBootState(); },
  });
}
