import { CommandBus } from "../core/command-bus.js";
import { Scheduler } from "../core/scheduler.js";
import {
  createDiagnostic,
  diagnosticFromError,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import { GameStore } from "../core/store.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";
import { createEconomyState } from "../domain/economy.js";
import { registerDirectServiceSystem } from "../domain/direct-service.js";
import {
  createInventoryAccountingState,
  registerInventoryAccounting,
} from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import {
  DAY_LOOP_TRIGGER,
  registerDayLoopController,
} from "../domain/day-loop.js";
import { createMenuState, registerMenuSystem } from "../domain/menu.js";
import { registerOrderSystem } from "../domain/orders.js";
import { registerServiceCleanupSystem } from "../domain/service-cleanup.js";
import { registerCampaignOutcomeSystem } from "../domain/terminal-result.js";
import { registerDayInitializationSystem } from "../domain/day-initialization.js";
import { CampaignManager } from "../domain/campaign.js";
import { registerGuestFlowSystem } from "../world/guest-flow.js";
import { registerGuestOutcomeSystem } from "../world/guest-outcomes.js";
import { createGuestPassabilityGrid } from "../world/passability-grid.js";
import { StorageAdapter } from "../infrastructure/storage-adapter.js";
import { createRecipeState, RecipeSystem } from "../domain/recipe.js";
import { createSaleSlotsState } from "../domain/sale-slots.js";
import { createSalesState } from "../domain/sales.js";
import { createServiceTimerState, RUNTIME_PHASE } from "../domain/timer-state.js";
import { CANONICAL_CONTENT_SPECIFICATIONS } from "../infrastructure/canonical-content.js";
import { DataLoader } from "../infrastructure/data-loader.js";
import { BASE_MAP_ID, navigationPointToWorld } from "../world/map-schema.js";
import { MapLoader, mapLoadReportToBootOutcome } from "../world/map-loader.js";
import { PixiSceneAdapter } from "../render/pixi-scene-adapter.js";
import { GuestMotionTracker } from "../render/guest-motion-tracker.js";
import { VfxSystem } from "../render/vfx-system.js";
import { AudioSystem } from "../infrastructure/audio-system.js";
import { AUDIO_CUE, MUST_CUE_EVENT_BINDINGS } from "../infrastructure/audio-cues.js";
import { CreditsShell } from "../ui/credits-shell.js";
import { ErrorScreen } from "../ui/error-screen.js";
import { SettingsOverlay, SettlementOverlay } from "../ui/management-ui.js";
import { OnboardingGuide } from "../ui/onboarding.js";
import { PrototypeHubAdapter } from "../ui/prototype-hub-adapter.js";
import { WORLD_INTERACTION_COMMAND_TYPE } from "../world/interaction-router.js";
import { SimulationLoop } from "./simulation-loop.js";
import { createRuntimeComposition } from "./runtime-composition.js";
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

// assets/feedback-assets.json과 같은 값이다 — fetch 왕복 없이 boot 초기(STORE stage)에 바로
// VfxSystem을 만들 수 있게 여기 그대로 옮겨 적었다.
const VFX_SHEET_CONFIG = Object.freeze({
  vfxSheet: Object.freeze({ width: 192, height: 128, columns: 3, rows: 2, frameWidth: 64, frameHeight: 64, frameCount: 6 }),
  vfx: Object.freeze([
    Object.freeze({ id: "vfx.sale_success", fps: 12, anchor: "CENTER" }),
    Object.freeze({ id: "vfx.cooking_success", fps: 10, anchor: "BOTTOM_CENTER" }),
    Object.freeze({ id: "vfx.cooking_waste", fps: 10, anchor: "BOTTOM_CENTER" }),
    Object.freeze({ id: "vfx.order_failure", fps: 12, anchor: "BOTTOM_CENTER" }),
  ]),
});

const PROTOTYPE_QA_ROUTE = "prototype-baseline";
const DETERMINISTIC_CORE_QA_ROUTE = "deterministic-core";
const DATA_VALIDATION_QA_ROUTE = "data-validation";
const BOOTSTRAP_FEATURE_QA_ROUTE = "bootstrap-features";
const MAP_VALIDATION_QA_ROUTE = "map-validation";
const PLAYER_WORLD_QA_ROUTE = "player-world";
const DAY_LOOP_QA_ROUTE = "day-loop";
const ONE_DAY_QA_ROUTE = "one-day";
const TIMER_SYSTEM_QA_ROUTE = "timer-system";
const PIXI_RENDERER_QA_ROUTE = "pixi-renderer";
const MANAGEMENT_UI_QA_ROUTE = "management-ui";

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
  root.documentElement.dataset.modalOpen = "closed";
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
    mapLoader = new MapLoader(),
    mapSpecifications = [],
    stageOverrides = {},
  } = {}) {
    if (!root || typeof root.querySelector !== "function") throw new TypeError("AppBootstrap root document가 필요합니다.");
    if (!dataLoader || typeof dataLoader.loadAll !== "function") throw new TypeError("AppBootstrap DataLoader가 필요합니다.");
    if (!mapLoader || typeof mapLoader.load !== "function") throw new TypeError("AppBootstrap MapLoader가 필요합니다.");
    if (!Array.isArray(mapSpecifications)) throw new TypeError("mapSpecifications는 배열이어야 합니다.");
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
    this.mapLoader = mapLoader;
    this.mapSpecifications = Object.freeze([...mapSpecifications]);
    this.stageOverrides = stageOverrides;
    this.shell = null;
    this.scene = null;
    this.hub = null;
    this.storageAdapter = null;
    this.store = null;
    this.commandBus = null;
    this.cashTransactionAPI = null;
    this.inventoryAccountingAPI = null;
    this.marketSystem = null;
    this.facilitySystem = null;
    this.contractSystem = null;
    this.recipeSystem = null;
    this.menuSystem = null;
    this.dayLoopController = null;
    this.directServiceSystem = null;
    this.orderSystem = null;
    this.serviceCleanupSystem = null;
    this.campaignOutcomeSystem = null;
    this.dayInitializationSystem = null;
    this.campaignManager = null;
    this.guestFlowSystem = null;
    this.guestOutcomeSystem = null;
    this.guestMotionTracker = null;
    this.vfxSystem = null;
    this.audioSystem = null;
    this.settingsOverlay = null;
    this.scheduler = null;
    this.simulationLoop = null;
    this.reputationSystem = null;
    this.unlockPublisher = null;
    this.eventSystem = null;
    this.featureRegistry = null;
    this.canonicalContent = null;
    this.mapLoadReport = null;
    this.mapRegistry = null;
    this.bootResult = null;
    this._startPromise = null;
    this._interactionsBound = false;
    this._destroyed = false;
    this._runtimeDiagnostics = [];
    this._saveQueued = false;
    this._lastSavedRevision = -1;

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
    const startButton = requireElement(this.root, "#btn-start");
    const newGameButton = requireElement(this.root, "#btn-new-game");
    startButton.textContent = this.store.runtimePhase === RUNTIME_PHASE.TERMINAL
      ? "결과 보기"
      : this.store.runtimePhase === RUNTIME_PHASE.TITLE
        ? "시작하기"
        : "이어하기";
    newGameButton.classList.toggle("hidden", this.store.runtimePhase === RUNTIME_PHASE.TITLE);
    this.shell.errorScreen.clear({ enableStart: true });
    this.root.documentElement.dataset.buildId = this.buildMetadataInput.buildId;
    this.root.documentElement.dataset.featureFlagsEnabled = String(
      FEATURE_IDS.filter((featureId) => this.featureRegistry.flags[featureId]).length,
    );
    this.root.documentElement.dataset.phaseBgm = String(this.featureRegistry.flags.phaseBgm);
    this.root.documentElement.dataset.extendedAudio = String(this.featureRegistry.flags.extendedAudio);
    const mapStage = result.projection.stages.find((stage) => stage.stageId === BOOT_STAGE.MAP);
    this.root.documentElement.dataset.mapStageStatus = mapStage?.status?.toLowerCase() ?? "unknown";
    this.root.documentElement.dataset.mapStageCode = mapStage?.code ?? "UNKNOWN";
    this.root.documentElement.dataset.mapRegisteredCount = String(
      this.mapLoadReport?.registryConformance.registeredCount ?? 0,
    );
    this.root.documentElement.dataset.mapQuarantinedCount = String(
      this.mapLoadReport?.quarantined.length ?? 0,
    );
    this.root.documentElement.dataset.activeMapValidity = this.mapLoadReport?.activeMapValidity.code ?? "NOT_RUN";
    const worldSnapshot = this.hub.getWorldSnapshot();
    this.root.documentElement.dataset.runtimeMapId = worldSnapshot.mapId;
    this.root.documentElement.dataset.playerCollision = `${worldSnapshot.player.collisionWidth}x${worldSnapshot.player.collisionHeight}`;
    this.root.documentElement.dataset.playerStartMilliPx = `${worldSnapshot.player.footMilliPx.x},${worldSnapshot.player.footMilliPx.y}`;
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
      [BOOT_STAGE.MAP]: async () => {
        let specifications = this.mapSpecifications;
        let activeMapId = BASE_MAP_ID;
        let manifestFilename = null;
        let manifestCode = "EXPLICIT_MAP_SPECIFICATIONS";
        if (specifications.length === 0) {
          const {
            MapManifestLoader,
          } = await import("../world/map-manifest.js");
          const manifestReport = await new MapManifestLoader().load();
          this.mapManifestReport = manifestReport;
          if (!manifestReport.ok) {
            return bootStageFailure(manifestReport.code, manifestReport.diagnostics, {
              manifestFilename: manifestReport.filename,
              specificationCount: 0,
            });
          }
          specifications = manifestReport.specifications;
          activeMapId = manifestReport.manifest.activeMapId;
          manifestFilename = manifestReport.filename;
          manifestCode = manifestReport.code;
        }
        const report = await this.mapLoader.load(specifications, {
          activeMapId,
          requireBase: true,
        });
        this.mapLoadReport = report;
        this.mapRegistry = report.registry;
        const outcome = mapLoadReportToBootOutcome(report);
        return stageResult({
          ok: outcome.ok,
          value: outcome.value,
          status: outcome.ok ? BOOT_STAGE_STATUS.PASS : BOOT_STAGE_STATUS.FAIL,
          code: outcome.code,
          diagnostics: outcome.diagnostics,
          details: {
            ...outcome.details,
            manifestFilename,
            manifestCode,
            specificationCount: specifications.length,
          },
        });
      },
      [BOOT_STAGE.ASSET]: async () => {
        const canvas = requireElement(this.root, "#game-canvas");
        const panelOverlay = requireElement(this.root, "#panel-overlay");
        const panelTitle = requireElement(this.root, "#panel-title");
        const panelBody = requireElement(this.root, "#panel-body");
        const panelCloseButton = requireElement(this.root, "#btn-panel-close");
        const assetBaseUrl = new URL("../../", import.meta.url);
        this.scene = new PixiSceneAdapter({ canvas, assetBaseUrl });
        const ready = await this.scene.loadSprite();
        this.hub = new PrototypeHubAdapter({
          scene: this.scene,
          panelOverlay,
          panelTitle,
          panelBody,
          panelCloseButton,
          mapDefinition: this.mapLoadReport.activeMap,
          inputTarget: this.root.defaultView,
          getApp: () => (this.commandBus ? this : null),
          onInteractionCommand: (command) => this.#queueWorldInteraction(command),
          externalFrameDriver: true,
        });
        return bootStagePass({ scene: this.scene, hub: this.hub }, {
          rendererPackage: "pixi.js",
          rendererVersion: "8.19.0",
          ready: ready.ready === true,
        }, "PROTOTYPE_ASSET_READY");
      },
      [BOOT_STAGE.SAVE]: async () => {
        const win = this.root.defaultView;
        const requestUrl = new URL(win.location.href);
        const newCampaignRequested = requestUrl.searchParams.get("newGame") === "1";
        const consumeNewCampaignRequest = () => {
          if (!newCampaignRequested) return;
          requestUrl.searchParams.delete("newGame");
          win.history.replaceState(null, "", `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`);
        };
        let storage;
        try {
          storage = win.localStorage;
        } catch {
          storage = null;
        }
        if (!storage) {
          consumeNewCampaignRequest();
          return bootStagePass(
            Object.freeze({ checkpoint: null, recovery: "NEW_CAMPAIGN" }),
            { reason: "STORAGE_UNAVAILABLE" },
            "SAVE_STORAGE_UNAVAILABLE",
          );
        }
        this.storageAdapter = new StorageAdapter({ storage });
        if (newCampaignRequested) {
          const cleared = this.storageAdapter.clearCampaign();
          if (!cleared.ok) throw Object.assign(new Error(cleared.message), { code: cleared.code });
          consumeNewCampaignRequest();
          return bootStagePass(
            Object.freeze({ checkpoint: null, recovery: "NEW_CAMPAIGN" }),
            { clearedKeys: cleared.clearedKeys },
            "SAVE_NEW_CAMPAIGN_RESET",
          );
        }
        const current = await this.storageAdapter.readCurrent();
        if (current.ok) {
          return bootStagePass(
            Object.freeze({ checkpoint: current.payload, recovery: "CONTINUE" }),
            { checkpointPhase: current.payload.checkpointPhase },
            "SAVE_CHECKPOINT_FOUND",
          );
        }
        if (current.code === "STORAGE_ABSENT") {
          return bootStagePass(
            Object.freeze({ checkpoint: null, recovery: "NEW_CAMPAIGN" }),
            {},
            "SAVE_NO_CHECKPOINT",
          );
        }
        const recovered = await this.storageAdapter.recoverFromPrevious();
        if (recovered.ok) {
          return bootStagePass(
            Object.freeze({ checkpoint: recovered.payload, recovery: "RECOVERED_FROM_PREVIOUS" }),
            { currentCorruption: current.code },
            "SAVE_CURRENT_CORRUPT_RECOVERED",
          );
        }
        const diagnosis = await this.storageAdapter.diagnoseCorruption();
        return bootStagePass(
          Object.freeze({ checkpoint: null, recovery: "BOTH_CORRUPT" }),
          { diagnosis },
          "SAVE_BOTH_CORRUPT",
        );
      },
      [BOOT_STAGE.STORE]: async (context) => {
        const buildAndFlags = context[BOOT_STAGE.BUILD_FLAGS];
        const data = context[BOOT_STAGE.DATA];
        const maps = context[BOOT_STAGE.MAP];
        const [
          idModule,
          rngModule,
          marketModule,
          contractModule,
          facilityModule,
          reputationModule,
          unlocksModule,
          eventModule,
          settlementModule,
        ] = await Promise.all([
          import("../core/ids.js"),
          import("../core/rng.js"),
          import("../domain/market.js"),
          import("../domain/contract.js"),
          import("../domain/facility.js"),
          import("../domain/reputation.js"),
          import("../domain/unlocks.js"),
          import("../domain/events.js"),
          import("../domain/settlement.js"),
        ]);
        const canonicalDocuments = new Map(
          data.accepted.map((entry) => [entry.filename, entry.data]),
        );
        const ingredientDocument = canonicalDocuments.get("data/ingredients.json");
        const recipeDocument = canonicalDocuments.get("data/recipes.json");
        const facilityDocument = canonicalDocuments.get("data/upgrades.json");
        const eventDocument = canonicalDocuments.get("data/events.json");
        const balanceDocument = canonicalDocuments.get("data/balance.json");
        const guestDocument = canonicalDocuments.get("data/guests.json");
        if (!ingredientDocument || !recipeDocument || !facilityDocument || !eventDocument ||
            !balanceDocument || !guestDocument) {
          throw new Error("MarketSystem, ContractSystem, Recipe/MenuSystem, ReputationSystem, EventSystem, DayLoopController(DemandSystem) composition에 canonical ingredients/recipes/upgrades/events/balance/guests가 필요합니다.");
        }
        // Task 33 — ManagementUI가 이름/가격 표시용으로 조회한다(GameStore state가 아니라
        // 정적 catalog 참조라 여기서 한 번만 저장해둔다).
        this.ingredientCatalog = ingredientDocument.ingredients;
        this.recipeCatalog = recipeDocument.recipes;

        const masterSeed = 0x4e484e01;
        const day = 1;
        const generationId = 0;
        const campaignId = idModule.createCampaignId(masterSeed, 0);
        const marketGeneration = marketModule.generateDailyMarket({
          rngState: rngModule.createRngRegistryState(masterSeed),
          day,
          ingredients: ingredientDocument.ingredients,
          purchaseLimitQuantity: balanceDocument.market.defaultPurchaseLimitQuantity,
        });
        const marketGenerationCheckpoint = Object.freeze({
          market: marketGeneration.market,
          rng: marketGeneration.rngState,
        });
        const contractGeneration = contractModule.generateDailyContractOffers({
          rngState: marketGenerationCheckpoint.rng,
          day,
          ingredients: ingredientDocument.ingredients,
          configuration: balanceDocument.contract,
          fixedCostG: balanceDocument.economy.fixedCostG,
        });
        const contractGenerationCheckpoint = Object.freeze({
          rng: contractGeneration.rngState,
        });
        const eventGeneration = eventModule.generateDailyEvent({
          rngState: contractGenerationCheckpoint.rng,
          day,
          eventDefinitions: eventDocument.events,
        });
        const unlockCatalog = unlocksModule.createUnlockCatalog({
          recipes: recipeDocument.recipes,
          facilities: facilityDocument.facilities,
        });
        const progression = unlocksModule.createProgressionState({ unlockCatalog });
        const events = eventModule.createEventState({ activeEvent: eventGeneration.event });
        const facilities = facilityModule.createFacilityState({
          facilities: facilityDocument.facilities,
        });
        const recipes = createRecipeState({
          recipes: recipeDocument.recipes,
          ingredientIds: ingredientDocument.ingredients.map((ingredient) => ingredient.ingredientId),
        });
        const menu = createMenuState({ day, recipes });
        const saleSlots = createSaleSlotsState({ day });
        const freshState = {
          formatVersion: 1,
          revision: 0,
          runtimePhase: "TITLE",
          checkpointPhase: null,
          generationId,
          campaign: {
            campaignId,
            masterSeed,
            day,
            consecutiveArrearsCount: 0,
            canonicalDayResults: [],
            settlementOutcomeSealedForDay: null,
            terminalResult: null,
            ...reputationModule.createReputationCampaignFields(
              balanceDocument.campaign.startReputation,
            ),
          },
          progression,
          events,
          facilities,
          economy: createEconomyState({
            cashG: balanceDocument.campaign.startCashG,
            debtG: balanceDocument.campaign.startDebtG,
          }),
          inventory: createInventoryState(),
          inventoryAccounting: createInventoryAccountingState(),
          recipes,
          menu,
          saleSlots,
          sales: createSalesState({ day }),
          service: createServiceTimerState({
            durationMs: balanceDocument.service.durationMs,
            cleanupOvertimeMs: balanceDocument.service.cleanupOvertimeMs,
          }),
          market: marketGeneration.market,
          contracts: contractGeneration.contracts,
          rng: eventGeneration.rngState,
          idCounters: idModule.createIdServiceState({
            campaignId,
            day,
            generationId,
          }),
          featureFlags: buildAndFlags.featureFlags,
          extensions: {},
          boot: {
            buildId: buildAndFlags.buildMetadata.buildId,
            contentVersion: buildAndFlags.buildMetadata.contentVersion,
            canonicalFiles: data.accepted.map((entry) => entry.filename),
            maps: maps?.registryConformance ? {
              activeMapId: maps.activeMapId,
              registeredMapIds: maps.registryConformance.mapIds,
              quarantinedCount: maps.quarantined.length,
              activeValidityCode: maps.activeMapValidity.code,
            } : null,
          },
        };
        const checkpoint = context[BOOT_STAGE.SAVE]?.checkpoint ?? null;
        let initialState = freshState;
        if (checkpoint) {
          const { saleSlots: _embeddedSaleSlots, ...restoredMenu } = checkpoint.menu;
          initialState = {
            ...freshState,
            formatVersion: checkpoint.formatVersion,
            runtimePhase: checkpoint.checkpointPhase === "TERMINAL" ? "TERMINAL" : "PLANNING",
            checkpointPhase: checkpoint.checkpointPhase,
            generationId: checkpoint.idCounters.generationId,
            campaign: checkpoint.campaign,
            recipes: checkpoint.recipes,
            menu: restoredMenu,
            saleSlots: checkpoint.saleSlots,
            facilities: checkpoint.facilities,
            progression: checkpoint.progression,
            events: checkpoint.events,
            market: checkpoint.market,
            contracts: checkpoint.contracts,
            economy: checkpoint.economy,
            inventory: checkpoint.inventory,
            inventoryAccounting: checkpoint.inventoryAccounting,
            sales: checkpoint.sales,
            rng: checkpoint.rng,
            idCounters: checkpoint.idCounters,
            extensions: checkpoint.extensions,
            service: createServiceTimerState({
              durationMs: balanceDocument.service.durationMs,
              cleanupOvertimeMs: balanceDocument.service.cleanupOvertimeMs,
            }),
          };
        }
        this.store = new GameStore(initialState);
        this.commandBus = new CommandBus({
          store: this.store,
          commandGuards: [this.featureRegistry.createCommandGuard()],
          onDiagnostic: (diagnostic) => this._runtimeDiagnostics.push(diagnostic),
        });
        this.cashTransactionAPI = registerCashTransactionAPI(this.commandBus);
        this.inventoryAccountingAPI = registerInventoryAccounting(this.commandBus);
        this.marketSystem = marketModule.registerMarketSystem(this.commandBus);
        this.facilitySystem = facilityModule.registerFacilitySystem(this.commandBus, {
          basePatienceMs: balanceDocument.service.basePatienceMs,
          minimumPatienceMs: balanceDocument.service.minimumPatienceMs,
          maximumPatienceMs: balanceDocument.service.maximumPatienceMs,
        });
        this.contractSystem = contractModule.registerContractSystem(this.commandBus);
        this.recipeSystem = new RecipeSystem();
        this.menuSystem = registerMenuSystem(this.commandBus);
        this.dayLoopController = registerDayLoopController(this.commandBus, {
          guestArchetypes: guestDocument.guestArchetypes,
        });
        this.directServiceSystem = registerDirectServiceSystem(this.commandBus, {
          wrongServePenaltyMs: balanceDocument.service.wrongServePenaltyMs,
          reactionDurationMs: balanceDocument.service.reactionFrameMs *
            balanceDocument.service.reactionFrameCount,
        });
        this.orderSystem = registerOrderSystem(this.commandBus);
        this.reputationSystem = reputationModule.registerReputationSystem(this.commandBus);
        this.unlockPublisher = unlocksModule.registerUnlockPublisher(this.commandBus);
        this.eventSystem = eventModule.registerEventSystem(this.commandBus, eventDocument.events);
        this.settlementSystem = settlementModule.registerSettlementSystem(this.commandBus);
        this.serviceCleanupSystem = registerServiceCleanupSystem(this.commandBus);
        this.campaignOutcomeSystem = registerCampaignOutcomeSystem(this.commandBus);
        this.dayInitializationSystem = registerDayInitializationSystem(this.commandBus, {
          ingredients: ingredientDocument.ingredients,
          eventDefinitions: eventDocument.events,
          balance: balanceDocument,
        });
        this.campaignManager = new CampaignManager({
          store: this.store,
          commandBus: this.commandBus,
          campaignOutcomeSystem: this.campaignOutcomeSystem,
          dayInitializationSystem: this.dayInitializationSystem,
          contractSystem: this.contractSystem,
          dayLoopController: this.dayLoopController,
        });
        this.guestFlowSystem = registerGuestFlowSystem(this.commandBus, {
          seatPoints: this.mapLoadReport.activeMap.navigation.seatPoints,
          spawnPoint: this.mapLoadReport.activeMap.navigation.spawnPoint,
          guestPassabilityGrid: createGuestPassabilityGrid(this.mapLoadReport.activeMap),
        });
        this.guestOutcomeSystem = registerGuestOutcomeSystem(this.commandBus, {
          seatPoints: this.mapLoadReport.activeMap.navigation.seatPoints,
          exitPoint: this.mapLoadReport.activeMap.navigation.exitPoint,
          guestPassabilityGrid: createGuestPassabilityGrid(this.mapLoadReport.activeMap),
        });
        this.guestMotionTracker = new GuestMotionTracker({
          seatPoints: this.mapLoadReport.activeMap.navigation.seatPoints,
          spawnPoint: this.mapLoadReport.activeMap.navigation.spawnPoint,
          exitPoint: this.mapLoadReport.activeMap.navigation.exitPoint,
          guestPassabilityGrid: createGuestPassabilityGrid(this.mapLoadReport.activeMap),
        });
        this.commandBus.subscribeEvent("guest-flow.moving-to-seat", (event) => {
          this.guestMotionTracker.recordMovingToSeat({
            guestId: event.payload.guestId,
            seatId: event.payload.seatId,
            startedAtMs: event.simulationTimeMs,
            travelTimeMs: event.payload.travelTimeMs,
          });
        });
        this.commandBus.subscribeEvent("guest-flow.seated", (event) => {
          this.guestMotionTracker.clear(event.payload.guestId);
        });
        this.commandBus.subscribeEvent("guest-flow.moving-to-exit", (event) => {
          const guest = this.store.getSnapshot().service.guests.find((g) => g.guestId === event.payload.guestId);
          this.guestMotionTracker.recordMovingToExit({
            guestId: event.payload.guestId,
            seatId: guest?.seatId ?? null,
            startedAtMs: event.simulationTimeMs,
            travelTimeMs: event.payload.travelTimeMs,
          });
        });
        this.commandBus.subscribeEvent("guest-flow.exited", (event) => {
          this.guestMotionTracker.clear(event.payload.guestId);
        });
        this.commandBus.subscribeEvent("guest-flow.exit-path-fault", (event) => {
          this.guestMotionTracker.clear(event.payload.guestId);
        });
        this.vfxSystem = new VfxSystem(VFX_SHEET_CONFIG);
        const seatWorldPointForGuest = (guestId) => {
          const guest = this.store.getSnapshot().service.guests.find((g) => g.guestId === guestId);
          const seat = guest
            ? this.mapLoadReport.activeMap.navigation.seatPoints.find((point) => point.seatId === guest.seatId)
            : null;
          return seat ? navigationPointToWorld(seat) : navigationPointToWorld(this.mapLoadReport.activeMap.navigation.spawnPoint);
        };
        this.commandBus.subscribeEvent("direct-service.sale-committed", (event) => {
          const world = seatWorldPointForGuest(event.payload.guestId);
          this.vfxSystem.spawn({ vfxId: "vfx.sale_success", x: world.x, y: world.y, atMs: event.simulationTimeMs });
        });
        this.commandBus.subscribeEvent("*", () => this.#queueCheckpointSave());
        const stoveWorldPoint = () => {
          const stoveZone = this.mapLoadReport.activeMap.zones.find((zone) => zone.semantic === "stove");
          return stoveZone
            ? { x: stoveZone.rect.x + stoveZone.rect.width / 2, y: stoveZone.rect.y + stoveZone.rect.height / 2 }
            : { x: 0, y: 0 };
        };
        this.commandBus.subscribeEvent("direct-service.cook-completed", (event) => {
          const world = stoveWorldPoint();
          this.vfxSystem.spawn({ vfxId: "vfx.cooking_success", x: world.x, y: world.y, atMs: event.simulationTimeMs });
        });
        this.commandBus.subscribeEvent("direct-service.cook-failed", (event) => {
          const world = stoveWorldPoint();
          this.vfxSystem.spawn({ vfxId: "vfx.cooking_waste", x: world.x, y: world.y, atMs: event.simulationTimeMs });
        });
        this.commandBus.subscribeEvent("direct-service.dish-wasted", (event) => {
          const world = stoveWorldPoint();
          this.vfxSystem.spawn({ vfxId: "vfx.cooking_waste", x: world.x, y: world.y, atMs: event.simulationTimeMs });
        });
        this.commandBus.subscribeEvent("order.stockout", (event) => {
          const world = seatWorldPointForGuest(event.payload.guestId);
          this.vfxSystem.spawn({ vfxId: "vfx.order_failure", x: world.x, y: world.y, atMs: event.simulationTimeMs });
        });
        this.commandBus.subscribeEvent("order.timed-out", (event) => {
          const world = seatWorldPointForGuest(event.payload.guestId);
          this.vfxSystem.spawn({ vfxId: "vfx.order_failure", x: world.x, y: world.y, atMs: event.simulationTimeMs });
        });
        const win = this.root.defaultView;
        const AudioContextCtor = win?.AudioContext ?? win?.webkitAudioContext ?? null;
        this.audioSystem = new AudioSystem({
          audioContextFactory: AudioContextCtor ? () => new AudioContextCtor() : null,
          fetchImpl: win?.fetch ? win.fetch.bind(win) : null,
          storage: win?.localStorage ?? null,
        });
        this.audioSystem.resumeOnFirstGesture(win);
        Promise.all([
          this.audioSystem.registerBgm("assets/generated/audio/bgm-tavern.wav"),
          this.audioSystem.registerCue(AUDIO_CUE.PURCHASE, "assets/generated/audio/sfx-purchase.wav"),
          this.audioSystem.registerCue(AUDIO_CUE.COOK_SUCCESS, "assets/generated/audio/sfx-cook-success.wav"),
          this.audioSystem.registerCue(AUDIO_CUE.COOK_FAILURE, "assets/generated/audio/sfx-cook-failure.wav"),
          this.audioSystem.registerCue(AUDIO_CUE.ORDER_COMPLETE, "assets/generated/audio/sfx-order-complete.wav"),
          this.audioSystem.registerCue(AUDIO_CUE.SETTLEMENT, "assets/generated/audio/sfx-settlement.wav"),
        ]).catch(() => undefined);
        for (const eventType of Object.keys(MUST_CUE_EVENT_BINDINGS)) {
          this.commandBus.subscribeEvent(eventType, (event) => {
            this.audioSystem.handleDomainEvent(event);
          });
        }
        this.scheduler = new Scheduler();
        this.simulationLoop = new SimulationLoop({
          store: this.store,
          commandBus: this.commandBus,
          scheduler: this.scheduler,
          directServiceSystem: this.directServiceSystem,
          menuSystem: this.menuSystem,
          serviceCleanupSystem: this.serviceCleanupSystem,
          dayLoopController: this.dayLoopController,
          guestFlowSystem: this.guestFlowSystem,
          guestOutcomeSystem: this.guestOutcomeSystem,
          orderSystem: this.orderSystem,
          requestAnimationFrame: this.root.defaultView.requestAnimationFrame.bind(this.root.defaultView),
          cancelAnimationFrame: this.root.defaultView.cancelAnimationFrame.bind(this.root.defaultView),
          visibilityTarget: this.root,
          onPresentationFrame: (elapsedMs) => {
            if (this.hub?.running) this.hub.step(elapsedMs);
          },
        });
        this.commandBus.subscribeEvent("order.stockout", (event) => {
          this.simulationLoop.timerSystem.armGuestReaction({ guestId: event.payload.guestId });
        });
        this.commandBus.subscribeEvent("order.created", (event) => {
          this.simulationLoop.timerSystem.armOrderTimeout({
            orderId: event.payload.orderId,
            createdAtMs: event.payload.createdAtMs,
            patienceRemainingMs: event.payload.patienceRemainingMs,
          });
        });
        this.commandBus.subscribeEvent("order.timed-out", (event) => {
          this.simulationLoop.timerSystem.disarmOrderTimeout(event.payload.orderId, "ORDER_TIMED_OUT");
          this.simulationLoop.timerSystem.armGuestReaction({ guestId: event.payload.guestId });
        });
        this.commandBus.subscribeEvent("direct-service.sale-committed", (event) => {
          this.simulationLoop.timerSystem.disarmOrderTimeout(event.payload.orderId, "ORDER_SOLD");
          this.simulationLoop.timerSystem.armGuestReaction({ guestId: event.payload.guestId });
        });
        this.commandBus.subscribeEvent("direct-service.wrong-served", (event) => {
          const order = this.store.getSnapshot().service.orders.find(
            (candidate) => candidate.orderId === event.payload.targetOrderId,
          );
          if (order) {
            this.simulationLoop.timerSystem.armOrderTimeout({
              orderId: order.orderId,
              createdAtMs: order.createdAtMs,
              patienceRemainingMs: order.patienceRemainingMs,
            });
          }
        });
        this.commandBus.subscribeEvent("direct-service.wrong-serve-timeout", (event) => {
          const order = this.store.getSnapshot().service.orders.find(
            (candidate) => candidate.orderId === event.payload.targetOrderId,
          );
          this.simulationLoop.timerSystem.disarmOrderTimeout(event.payload.targetOrderId, "WRONG_SERVE_TIMEOUT");
          if (order) this.simulationLoop.timerSystem.armGuestReaction({ guestId: order.guestId });
        });
        this.commandBus.subscribeEvent("day-loop.service-started", (event) => {
          this.simulationLoop.timerSystem.armServiceTimer({
            serviceToken: event.payload.transitionToken,
            durationMs: event.payload.durationMs,
          });
          this.simulationLoop.timerSystem.armGuestArrivals({
            plans: this.store.getSnapshot().service.plans,
          });
        });
        this.commandBus.subscribeEvent("day-loop.service-results-closed", (event) => {
          const transitionToken = event.payload.transitionToken;
          this.simulationLoop.timerSystem.disarmServiceTimer(transitionToken);
          this.simulationLoop.timerSystem.disarmGuestArrivals({
            plans: this.store.getSnapshot().service.plans,
          });
          this.simulationLoop.timerSystem.disarmGuestOutcomes({
            guests: this.store.getSnapshot().service.guests,
          });
          this.simulationLoop.timerSystem.armCleanupCap({ serviceToken: transitionToken });
          // CommandBus는 post-commit event 전달 중 재진입 dispatch를 거절하므로(REENTRANT_
          // DISPATCH_FORBIDDEN), 실제 cleanup dispatch는 이 handler 바깥, 다음 macrotask로
          // 미룬다. handler 자신은 아무것도 await하지 않고 즉시 반환해야 한다.
          this.root.defaultView.setTimeout(() => {
            this.simulationLoop.timerSystem.runCleanupToCompletion({ transitionToken })
              .catch((error) => this._runtimeDiagnostics.push(diagnosticFromError(error, {
                severity: DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT,
                subsystem: "app.simulation-loop",
                code: "CLEANUP_ORCHESTRATION_FAILED",
                errorType: "ServiceCleanupError",
              })));
          }, 0);
        });
        this.commandBus.subscribeEvent("settlement.day-sealed", () => {
          // 같은 reentrant-dispatch 제약(REENTRANT_DISPATCH_FORBIDDEN) 때문에 다음
          // macrotask로 미룬다 — Task 26의 cleanup 자동화와 동일한 이유다.
          this.root.defaultView.setTimeout(() => {
            this.campaignManager.advanceAfterSettlement()
              .then((outcome) => {
                if (!outcome.ok) {
                  this._runtimeDiagnostics.push(createDiagnostic({
                    diagnosticId: `campaign-manager:advance-failed:${this.store.revision}`,
                    severity: DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT,
                    subsystem: "app.campaign-manager",
                    code: "CAMPAIGN_ADVANCE_FAILED",
                    errorType: "CampaignAdvanceError",
                    details: outcome,
                  }));
                }
              })
              .catch((error) => this._runtimeDiagnostics.push(diagnosticFromError(error, {
                severity: DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT,
                subsystem: "app.campaign-manager",
                code: "CAMPAIGN_ADVANCE_THREW",
                errorType: "CampaignAdvanceError",
              })));
          }, 0);
        });
        this.simulationLoop.start();
        return bootStagePass({
          store: this.store,
          commandBus: this.commandBus,
          cashTransactionAPI: this.cashTransactionAPI,
          inventoryAccountingAPI: this.inventoryAccountingAPI,
          marketSystem: this.marketSystem,
          facilitySystem: this.facilitySystem,
          contractSystem: this.contractSystem,
          recipeSystem: this.recipeSystem,
          menuSystem: this.menuSystem,
          dayLoopController: this.dayLoopController,
          directServiceSystem: this.directServiceSystem,
          orderSystem: this.orderSystem,
          serviceCleanupSystem: this.serviceCleanupSystem,
          campaignOutcomeSystem: this.campaignOutcomeSystem,
          dayInitializationSystem: this.dayInitializationSystem,
          campaignManager: this.campaignManager,
          guestFlowSystem: this.guestFlowSystem,
          guestOutcomeSystem: this.guestOutcomeSystem,
          scheduler: this.scheduler,
          simulationLoop: this.simulationLoop,
          reputationSystem: this.reputationSystem,
          unlockPublisher: this.unlockPublisher,
          eventSystem: this.eventSystem,
          settlementSystem: this.settlementSystem,
        }, {
          revision: this.store.revision,
          runtimePhase: this.store.runtimePhase,
          marketOfferCount: marketGeneration.market.offers.length,
          marketDrawsConsumed: marketGeneration.drawsConsumed,
          facilityDefinitionCount: facilities.definitions.length,
          purchasedFacilityCount: facilities.purchasedFacilityIds.length,
          contractOfferCount: contractGeneration.contracts.offers.length,
          contractOfferDrawsConsumed: contractGeneration.drawsConsumed,
          unlockedRecipeCount: recipes.unlockedRecipeIds.length,
          menuDraftEntryCount: menu.draftEntries.length,
          serviceLifecycle: this.store.getSnapshot().service.lifecycle,
          serviceDurationMs: this.store.getSnapshot().service.durationMs,
          unlockThresholdCount: progression.unlockCatalog.length,
          activeEventCount: events.activeEvent === null ? 0 : 1,
          eventDrawsConsumed: eventGeneration.drawsConsumed,
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
    const newGameButton = requireElement(this.root, "#btn-new-game");
    const canvas = requireElement(this.root, "#game-canvas");
    const panelCloseButton = requireElement(this.root, "#btn-panel-close");
    const pauseButton = requireElement(this.root, "#btn-pause");
    const settingsButton = requireElement(this.root, "#btn-settings");

    let storage = null;
    try {
      storage = this.root.defaultView?.localStorage ?? null;
    } catch {
      storage = null;
    }
    this.onboardingGuide = new OnboardingGuide({
      root: this.root,
      overlay: requireElement(this.root, "#onboarding-overlay"),
      list: requireElement(this.root, "#onboarding-list"),
      closeButton: requireElement(this.root, "#btn-onboarding-close"),
      storage,
    });
    this.settlementOverlay = new SettlementOverlay({
      root: this.root,
      overlay: requireElement(this.root, "#settlement-overlay"),
      body: requireElement(this.root, "#settlement-body"),
      closeButton: requireElement(this.root, "#btn-settlement-close"),
      onClose: () => canvas.focus({ preventScroll: true }),
    });
    this.settingsOverlay = new SettingsOverlay({
      root: this.root,
      overlay: requireElement(this.root, "#settings-overlay"),
      closeButton: requireElement(this.root, "#btn-settings-close"),
      audioSystem: this.audioSystem,
    });
    this.commandBus.subscribeEvent("settlement.day-sealed", (event) => {
      const sealed = this.store.getSnapshot().campaign.canonicalDayResults
        .find((result) => result.resultId === event.payload.resultId);
      if (sealed) this.settlementOverlay.open(sealed, { totalDays: 14 });
    });

    this.enterPrototype = async () => {
      if (this.shell.errorScreen.blocked || this.getBootState().status !== BOOT_STATUS.READY) return null;
      if (this.store.runtimePhase === "TITLE") {
        const snapshot = this.store.getSnapshot();
        const transition = await this.dayLoopController.transition({
          commandId: `${snapshot.campaign.campaignId}:day-loop:title-ready:${snapshot.generationId}`,
          expectedRevision: this.store.revision,
          generationId: this.store.generationId,
          issuedAtSimulationMs: 0,
          payload: { trigger: DAY_LOOP_TRIGGER.NEW_CAMPAIGN_READY },
        });
        if (!transition.ok) {
          this._runtimeDiagnostics.push(...transition.diagnostics);
          return transition;
        }
        if (this.onboardingGuide.shouldShow()) await this.onboardingGuide.show();
      }
      this.shell.credits.close();
      showScreen(this.root, "screen-room");
      const activeMap = this.mapLoadReport.activeMap;
      const authoredStart = activeMap.navigation?.playerStart;
      const currentPlayer = this.hub.getState().player;
      const authoredStartX = authoredStart
        ? authoredStart.tileX * activeMap.tileSize + authoredStart.offsetX
        : null;
      const authoredStartY = authoredStart
        ? authoredStart.tileY * activeMap.tileSize + authoredStart.offsetY
        : null;
      const welcomePoint = activeMap.navigation?.approachPoints?.find(
        (point) => point.pointId === "approach.zone.stove",
      );
      if (welcomePoint && currentPlayer.x === authoredStartX && currentPlayer.y === authoredStartY) {
        this.hub.setPlayerPosition(
          welcomePoint.tileX * activeMap.tileSize + welcomePoint.offsetX,
          welcomePoint.tileY * activeMap.tileSize + welcomePoint.offsetY + activeMap.tileSize * 2,
        );
      }
      this.hub.start();
      this.audioSystem?.startBgm();
      canvas.focus({ preventScroll: true });
      return Object.freeze({ ok: true, runtimePhase: this.store.runtimePhase });
    };
    this.closePanel = () => this.hub.closePanel();
    this.togglePause = async () => {
      const phase = this.store.runtimePhase;
      if (phase === RUNTIME_PHASE.SERVICE) await this.simulationLoop.pause();
      else if (phase === RUNTIME_PHASE.PAUSED) await this.simulationLoop.resume();
      canvas.focus({ preventScroll: true });
    };
    this.handlePageHide = () => this.destroy();
    this.openSettings = () => {
      this.shell.credits.close();
      this.settingsOverlay.open(settingsButton);
    };
    this.startNewCampaign = () => {
      const win = this.root.defaultView;
      if (!win) return;
      const url = new URL(win.location.href);
      url.searchParams.delete("qa");
      url.searchParams.set("newGame", "1");
      win.location.assign(url.href);
    };
    startButton.addEventListener("click", this.enterPrototype);
    newGameButton.addEventListener("click", this.startNewCampaign);
    panelCloseButton.addEventListener("click", this.closePanel);
    pauseButton.addEventListener("click", this.togglePause);
    settingsButton.addEventListener("click", this.openSettings);
    this.root.defaultView.addEventListener("pagehide", this.handlePageHide, { once: true });
    this._interactionsBound = true;
  }

  async runQaRoute() {
    if (!this.bootResult?.ok) return this.bootResult;
    const canvas = requireElement(this.root, "#game-canvas");
    const qaMode = new URL(this.root.defaultView.location.href).searchParams.get("qa");

    if (qaMode === DAY_LOOP_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const {
        runDayLoopBrowserProbe,
      } = await import("../qa/day-loop-probe.js");
      const report = await runDayLoopBrowserProbe({
        root: this.root,
        hub: this.hub,
        baseMap: this.mapLoadReport.activeMap,
        store: this.store,
        dayLoopController: this.dayLoopController,
        menuSystem: this.menuSystem,
      });
      this.hub.reset();
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }

    if (qaMode === ONE_DAY_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const { runOneDayBrowserProbe } = await import("../qa/one-day-probe.js");
      const report = await runOneDayBrowserProbe({ root: this.root, app: this });
      this.hub.reset();
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }

    if (qaMode === TIMER_SYSTEM_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const { runTimerSystemBrowserProbe } = await import("../qa/timer-system-probe.js");
      const report = await runTimerSystemBrowserProbe({ root: this.root, app: this });
      this.hub.reset();
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }

    if (qaMode === MANAGEMENT_UI_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const { runManagementUiBrowserProbe } = await import("../qa/management-ui-browser-probe.js");
      return runManagementUiBrowserProbe({ root: this.root, app: this });
    }

    if (qaMode === PIXI_RENDERER_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const { runPixiRendererBrowserProbe } = await import("../qa/pixi-renderer-browser-probe.js");
      return runPixiRendererBrowserProbe({ root: this.root, app: this });
    }

    if (qaMode === PROTOTYPE_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.usePrototypeRegressionMap();
      this.hub.activate();
      const { CanvasScene } = await import("../qa/raw-canvas-fixture.js");
      const fixtureCanvas = this.root.createElement("canvas");
      fixtureCanvas.width = 480;
      fixtureCanvas.height = 480;
      fixtureCanvas.dataset.qaFixture = "raw-canvas-l0";
      const rawCanvasFixture = new CanvasScene({
        canvas: fixtureCanvas,
        spriteUrl: new URL("../../assets/sprites/player_walk.png", import.meta.url),
      });
      const { runPrototypeRegression } = await import("../qa/prototype-regression.js");
      const report = await runPrototypeRegression({ root: this.root, scene: rawCanvasFixture, hub: this.hub });
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }
    if (qaMode === PLAYER_WORLD_QA_ROUTE) {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const {
        runPlayerWorldBrowserProbe,
      } = await import("../qa/player-world-probe.js");
      const report = await runPlayerWorldBrowserProbe({
        root: this.root,
        hub: this.hub,
        shell: this.shell,
        baseMap: this.mapLoadReport.activeMap,
      });
      this.hub.reset();
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }
    if (qaMode === "camera-input") {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const {
        runCameraInputBrowserProbe,
      } = await import("../qa/camera-input-probe.js");
      const report = await runCameraInputBrowserProbe({
        root: this.root,
        hub: this.hub,
        baseMap: this.mapLoadReport.activeMap,
      });
      this.hub.reset();
      const camera = this.hub.getCameraTransform();
      this.root.documentElement.dataset.runtimeCameraOrigin = `${camera.origin.x},${camera.origin.y}`;
      this.root.documentElement.dataset.inputTransform = "client-rect-480-camera-world";
      this.hub.start();
      canvas.focus({ preventScroll: true });
      return report;
    }
    if (qaMode === "world-interaction") {
      showScreen(this.root, "screen-room");
      this.hub.setMapDefinition(this.mapLoadReport.activeMap);
      this.hub.activate();
      const {
        runWorldInteractionBrowserProbe,
      } = await import("../qa/world-interaction-probe.js");
      const report = await runWorldInteractionBrowserProbe({
        root: this.root,
        hub: this.hub,
        shell: this.shell,
        baseMap: this.mapLoadReport.activeMap,
      });
      this.hub.reset();
      const interaction = this.hub.getInteractionSnapshot();
      this.root.documentElement.dataset.worldInteractionOrdering = "world-distance-priority-entity-id";
      this.root.documentElement.dataset.worldInteractionAuthoredTargets = String(interaction.router.authoredTargetCount);
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
    if (qaMode === MAP_VALIDATION_QA_ROUTE) {
      const {
        publishMapValidationReport,
        runMapValidationProbe,
        runMapValidationShellSmoke,
      } = await import("../qa/map-validation-probe.js");
      const report = await runMapValidationProbe();
      const shellSmoke = runMapValidationShellSmoke({ root: this.root, app: this, report });
      publishMapValidationReport(this.root, report, shellSmoke);
      return Object.freeze({ ...report, shellSmoke });
    }
    return null;
  }

  #queueCheckpointSave() {
    if (!this.storageAdapter || this._saveQueued) return;
    this._saveQueued = true;
    this.root.defaultView.setTimeout(async () => {
      this._saveQueued = false;
      const snapshot = this.store?.getSnapshot();
      if (!snapshot || snapshot.revision === this._lastSavedRevision ||
          !["PLANNING_READY", "TERMINAL"].includes(snapshot.checkpointPhase)) return;
      try {
        const saved = await this.storageAdapter.writeCurrentWithRotation(snapshot);
        if (saved.ok) {
          this._lastSavedRevision = snapshot.revision;
          this.root.documentElement.dataset.saveStatus = "saved";
          return;
        }
        this.root.documentElement.dataset.saveDetail = (saved.details?.diagnostics ?? [])
          .map((diagnostic) => `${diagnostic.code ?? "UNKNOWN"}:${diagnostic.path ?? diagnostic.details?.path ?? diagnostic.field ?? diagnostic.details?.field ?? "?"}`)
          .slice(0, 4)
          .join("|");
        throw Object.assign(new Error(saved.code), { code: saved.code });
      } catch (error) {
        this.root.documentElement.dataset.saveStatus = "failed";
        this.root.documentElement.dataset.saveCode = error?.code ?? "CHECKPOINT_SAVE_FAILED";
        this._runtimeDiagnostics.push(diagnosticFromError(error, {
          severity: DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT,
          subsystem: "app.save-lifecycle",
          code: error?.code ?? "CHECKPOINT_SAVE_FAILED",
          errorType: "CheckpointSaveError",
        }));
      }
    }, 0);
  }

  #setActionStatus(message, tone = "neutral") {
    const status = this.root.querySelector("#hud-action-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  #queueWorldInteraction(command) {
    this.root.defaultView.setTimeout(async () => {
      try {
        const composition = createRuntimeComposition(this);
        let result = null;
        if (command.type === WORLD_INTERACTION_COMMAND_TYPE.GUEST_ORDER) {
          const target = this.hub.guestOrderTargets.find(
            (candidate) => candidate.targetId === command.payload.targetId,
          );
          const guest = target
            ? this.store.getSnapshot().service.guests.find((candidate) => candidate.entityId === target.entityId)
            : null;
          if (!guest) {
            this.#setActionStatus("주문할 손님을 찾지 못했습니다.", "danger");
            return;
          }
          result = await composition.createOrder({ guestId: guest.guestId });
          this.#setActionStatus(
            result.ok ? "주문을 접수했습니다. 화로에서 조리하세요." : `주문 접수 실패 (${result.code})`,
            result.ok ? "success" : "danger",
          );
        } else if (command.type === WORLD_INTERACTION_COMMAND_TYPE.TABLE_SERVICE) {
          const tableTarget = this.hub.interactionRouter.authoredTableTargets.find(
            (candidate) => candidate.targetId === command.payload.targetId,
          );
          const snapshot = this.store.getSnapshot();
          const seatIds = new Set(this.mapLoadReport.activeMap.navigation.seatPoints
            .filter((seat) => seat.tableId === tableTarget?.tableId)
            .map((seat) => seat.seatId));
          const guestIds = new Set(snapshot.service.guests
            .filter((guest) => seatIds.has(guest.seatId))
            .map((guest) => guest.guestId));
          const order = snapshot.service.orders.find(
            (candidate) => candidate.state === "ACTIVE" && guestIds.has(candidate.guestId),
          );
          if (!order) {
            this.#setActionStatus("이 테이블에는 서빙할 주문이 없습니다.", "danger");
            return;
          }
          result = await composition.serveOrder({ targetOrderId: order.orderId });
          this.#setActionStatus(
            result.ok ? "요리를 서빙했습니다." : `서빙 실패 (${result.code})`,
            result.ok ? "success" : "danger",
          );
        }
        this.hub.render();
      } catch (error) {
        this.#setActionStatus("상호작용을 처리하지 못했습니다.", "danger");
        this._runtimeDiagnostics.push(diagnosticFromError(error, {
          severity: DIAGNOSTIC_SEVERITY.DEGRADED_EFFECT,
          subsystem: "app.world-interaction",
          code: "WORLD_INTERACTION_FAILED",
          errorType: "WorldInteractionError",
        }));
      }
    }, 0);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.simulationLoop?.stop();
    this.hub?.destroy();
    this.shell?.credits.destroy();
    this.settingsOverlay?.destroy();
    this.settlementOverlay?.destroy();
    this.onboardingGuide?.destroy();
    this.audioSystem?.destroy();
    if (this._interactionsBound) {
      const startButton = this.root.querySelector("#btn-start");
      const newGameButton = this.root.querySelector("#btn-new-game");
      const panelCloseButton = this.root.querySelector("#btn-panel-close");
      const pauseButton = this.root.querySelector("#btn-pause");
      const settingsButton = this.root.querySelector("#btn-settings");
      startButton?.removeEventListener("click", this.enterPrototype);
      newGameButton?.removeEventListener("click", this.startNewCampaign);
      panelCloseButton?.removeEventListener("click", this.closePanel);
      pauseButton?.removeEventListener("click", this.togglePause);
      settingsButton?.removeEventListener("click", this.openSettings);
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
    get dayLoopController() { return app.dayLoopController; },
    get directServiceSystem() { return app.directServiceSystem; },
    get marketSystem() { return app.marketSystem; },
    get menuSystem() { return app.menuSystem; },
    get orderSystem() { return app.orderSystem; },
    get serviceCleanupSystem() { return app.serviceCleanupSystem; },
    get campaignOutcomeSystem() { return app.campaignOutcomeSystem; },
    get dayInitializationSystem() { return app.dayInitializationSystem; },
    get campaignManager() { return app.campaignManager; },
    get guestFlowSystem() { return app.guestFlowSystem; },
    get guestOutcomeSystem() { return app.guestOutcomeSystem; },
    get settlementSystem() { return app.settlementSystem; },
    get scheduler() { return app.scheduler; },
    get simulationLoop() { return app.simulationLoop; },
    get featureRegistry() { return app.featureRegistry; },
    get bootState() { return app.getBootState(); },
  });
}
