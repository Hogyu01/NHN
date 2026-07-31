import { CommandBus } from "../core/command-bus.js";
import {
  createDiagnostic,
  diagnosticFromError,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import { GameStore } from "../core/store.js";
import { registerCashTransactionAPI } from "../domain/cash-transaction-api.js";
import { createEconomyState } from "../domain/economy.js";
import {
  createInventoryAccountingState,
  registerInventoryAccounting,
} from "../domain/inventory-accounting.js";
import { createInventoryState } from "../domain/inventory.js";
import { createMenuState, registerMenuSystem } from "../domain/menu.js";
import { createRecipeState, RecipeSystem } from "../domain/recipe.js";
import { createSaleSlotsState } from "../domain/sale-slots.js";
import { CANONICAL_CONTENT_SPECIFICATIONS } from "../infrastructure/canonical-content.js";
import { DataLoader } from "../infrastructure/data-loader.js";
import { BASE_MAP_ID } from "../world/map-schema.js";
import { MapLoader, mapLoadReportToBootOutcome } from "../world/map-loader.js";
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
const MAP_VALIDATION_QA_ROUTE = "map-validation";
const PLAYER_WORLD_QA_ROUTE = "player-world";

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
    this.store = null;
    this.commandBus = null;
    this.cashTransactionAPI = null;
    this.inventoryAccountingAPI = null;
    this.marketSystem = null;
    this.facilitySystem = null;
    this.contractSystem = null;
    this.recipeSystem = null;
    this.menuSystem = null;
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
        const spriteUrl = new URL("../../assets/sprites/player_walk.png", import.meta.url);
        this.scene = new CanvasScene({ canvas, spriteUrl });
        const sprite = await this.scene.loadSprite();
        this.hub = new PrototypeHubAdapter({
          scene: this.scene,
          panelOverlay,
          panelTitle,
          panelBody,
          panelCloseButton,
          mapDefinition: this.mapLoadReport.activeMap,
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
        ] = await Promise.all([
          import("../core/ids.js"),
          import("../core/rng.js"),
          import("../domain/market.js"),
          import("../domain/contract.js"),
          import("../domain/facility.js"),
          import("../domain/reputation.js"),
          import("../domain/unlocks.js"),
          import("../domain/events.js"),
        ]);
        const canonicalDocuments = new Map(
          data.accepted.map((entry) => [entry.filename, entry.data]),
        );
        const ingredientDocument = canonicalDocuments.get("data/ingredients.json");
        const recipeDocument = canonicalDocuments.get("data/recipes.json");
        const facilityDocument = canonicalDocuments.get("data/upgrades.json");
        const eventDocument = canonicalDocuments.get("data/events.json");
        const balanceDocument = canonicalDocuments.get("data/balance.json");
        if (!ingredientDocument || !recipeDocument || !facilityDocument || !eventDocument || !balanceDocument) {
          throw new Error("MarketSystem, ContractSystem, Recipe/MenuSystem, ReputationSystem과 EventSystem composition에 canonical ingredients/recipes/upgrades/events/balance가 필요합니다.");
        }

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
        this.store = new GameStore({
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
        });
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
        this.reputationSystem = reputationModule.registerReputationSystem(this.commandBus);
        this.unlockPublisher = unlocksModule.registerUnlockPublisher(this.commandBus);
        this.eventSystem = eventModule.registerEventSystem(this.commandBus, eventDocument.events);
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
          reputationSystem: this.reputationSystem,
          unlockPublisher: this.unlockPublisher,
          eventSystem: this.eventSystem,
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
      this.hub.usePrototypeRegressionMap();
      this.hub.activate();
      const report = await runPrototypeRegression({ root: this.root, scene: this.scene, hub: this.hub });
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
