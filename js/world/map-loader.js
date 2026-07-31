import {
  compareDiagnostics,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import { DataLoader } from "../infrastructure/data-loader.js";
import { VALIDATION_BOUNDARY } from "../infrastructure/data-validator.js";
import {
  BASE_MAP_ID,
  createMapLoadSpecification,
  MAP_ROLE,
  MAP_SCHEMA_NAME,
} from "./map-schema.js";
import { validateMapAccessibility } from "./map-accessibility.js";
import { MapRegistry } from "./map-registry.js";
import { createMapDiagnostic, MapValidator } from "./map-validator.js";

const ROLE_PRIORITY = Object.freeze({
  [MAP_ROLE.BASE]: 0,
  [MAP_ROLE.PROTOTYPE]: 1,
  [MAP_ROLE.OPTIONAL]: 2,
});

function boundaryForRole(role) {
  return role === MAP_ROLE.BASE ? VALIDATION_BOUNDARY.MAP_BASE : VALIDATION_BOUNDARY.MAP_OPTIONAL;
}

function blockingDiagnostic(diagnostic) {
  return diagnostic.severity === DIAGNOSTIC_SEVERITY.FATAL_BOOT ||
    diagnostic.severity === DIAGNOSTIC_SEVERITY.BLOCKING_STATE ||
    diagnostic.severity === DIAGNOSTIC_SEVERITY.INTERNAL_INVARIANT;
}

function uniqueDiagnostics(diagnostics) {
  const unique = new Map();
  for (const diagnostic of diagnostics) unique.set(diagnostic.diagnosticId, diagnostic);
  return Object.freeze([...unique.values()].sort(compareDiagnostics));
}

function normalizeSpecifications(specifications) {
  if (!Array.isArray(specifications)) throw new TypeError("Map specifications는 배열이어야 합니다.");
  const seenFiles = new Set();
  return specifications.map((input, index) => {
    const specification = createMapLoadSpecification(input);
    if (seenFiles.has(specification.filename)) throw new Error(`중복 Map filename입니다: ${specification.filename}`);
    seenFiles.add(specification.filename);
    return Object.freeze({ ...specification, index });
  }).sort((left, right) =>
    ROLE_PRIORITY[left.role] - ROLE_PRIORITY[right.role] || left.index - right.index);
}

function conformanceResult({ diagnostics, registry, specificationCount }) {
  const normalizedDiagnostics = uniqueDiagnostics(diagnostics);
  const quarantinedCount = registry.quarantineEntries().length;
  const hasBlocking = normalizedDiagnostics.some(blockingDiagnostic);
  return freezeDeep({
    ok: normalizedDiagnostics.length === 0,
    code: hasBlocking
      ? "MAP_REGISTRY_NONCONFORMANT_BLOCKING"
      : quarantinedCount > 0
        ? "MAP_REGISTRY_CONFORMANT_WITH_QUARANTINE"
        : "MAP_REGISTRY_CONFORMANT",
    canStart: !hasBlocking,
    specificationCount,
    registeredCount: registry.mapIds().length,
    maximumMaps: registry.maximumMaps,
    mapIds: registry.mapIds(),
    quarantinedCount,
    quarantined: registry.quarantineEntries(),
    diagnostics: normalizedDiagnostics,
    registrySnapshot: registry.snapshot(),
  });
}

/**
 * Loads all Map files before deciding outcome, registers only valid definitions, removes invalid
 * optional/Prototype references, and evaluates the active Map independently.
 */
export class MapLoader {
  constructor({
    mapValidator = new MapValidator(),
    dataLoader = null,
    registryFactory = null,
    accessibilityValidator = validateMapAccessibility,
  } = {}) {
    if (!mapValidator || typeof mapValidator.validateDefinition !== "function" ||
        typeof mapValidator.validateActiveMap !== "function") {
      throw new TypeError("MapLoader mapValidator 계약이 잘못됐습니다.");
    }
    this.mapValidator = mapValidator;
    this.dataLoader = dataLoader ?? new DataLoader({ validator: mapValidator.schemaValidator });
    if (!this.dataLoader || typeof this.dataLoader.loadAll !== "function") {
      throw new TypeError("MapLoader dataLoader는 loadAll을 제공해야 합니다.");
    }
    if (registryFactory !== null && typeof registryFactory !== "function") {
      throw new TypeError("registryFactory는 함수 또는 null이어야 합니다.");
    }
    if (typeof accessibilityValidator !== "function") {
      throw new TypeError("MapLoader accessibilityValidator는 함수여야 합니다.");
    }
    this.registryFactory = registryFactory ?? (() => new MapRegistry());
    this.accessibilityValidator = accessibilityValidator;
  }

  async load(specifications, {
    activeMapId = BASE_MAP_ID,
    requireBase = true,
    accessibilityValidator = this.accessibilityValidator,
  } = {}) {
    if (typeof accessibilityValidator !== "function") {
      throw new TypeError("Active_Map_Validity accessibilityValidator는 함수여야 합니다.");
    }
    const normalized = normalizeSpecifications(specifications);
    const registry = this.registryFactory();
    if (!registry || typeof registry.register !== "function") {
      throw new TypeError("registryFactory가 MapRegistry 계약을 반환하지 않았습니다.");
    }

    const conformanceDiagnostics = [];
    const baseSpecifications = normalized.filter((specification) => specification.role === MAP_ROLE.BASE);
    if (requireBase && baseSpecifications.length !== 1) {
      conformanceDiagnostics.push(createMapDiagnostic({
        severity: DIAGNOSTIC_SEVERITY.FATAL_BOOT,
        filename: "data/maps/map-manifest.json",
        mapId: BASE_MAP_ID,
        errorType: "INVARIANT_ERROR",
        code: "BASE_MAP_SPEC_CARDINALITY_INVALID",
        fieldPath: "$.maps",
        itemId: BASE_MAP_ID,
        details: { expected: 1, actual: baseSpecifications.length },
      }));
    }

    let loadReport = null;
    if (normalized.length > 0) {
      loadReport = await this.dataLoader.loadAll(normalized.map((specification) => ({
        filename: specification.filename,
        ...(specification.url === undefined ? {} : { url: specification.url }),
        schemaName: MAP_SCHEMA_NAME,
        boundary: boundaryForRole(specification.role),
      })));
      conformanceDiagnostics.push(...loadReport.diagnostics);
    }

    const specificationByFilename = new Map(normalized.map((specification) => [specification.filename, specification]));
    for (const rejected of loadReport?.rejected ?? []) {
      const specification = specificationByFilename.get(rejected.filename);
      if (specification && specification.role !== MAP_ROLE.BASE) {
        registry.quarantine({
          filename: rejected.filename,
          role: specification.role,
          mapId: specification.expectedMapId ?? null,
          diagnostics: rejected.diagnostics,
        });
      }
    }

    for (const accepted of loadReport?.accepted ?? []) {
      const specification = specificationByFilename.get(accepted.filename);
      const validation = this.mapValidator.validateDefinition({
        definition: accepted.data,
        filename: accepted.filename,
        role: specification.role,
        expectedMapId: specification.expectedMapId,
      });
      if (!validation.ok) {
        conformanceDiagnostics.push(...validation.diagnostics);
        if (specification.role !== MAP_ROLE.BASE) {
          registry.quarantine({
            filename: accepted.filename,
            role: specification.role,
            mapId: accepted.data.mapId ?? specification.expectedMapId ?? null,
            diagnostics: validation.diagnostics,
          });
        }
        continue;
      }

      const registration = registry.register({
        definition: validation.definition,
        filename: accepted.filename,
        role: specification.role,
      });
      if (!registration.ok) {
        conformanceDiagnostics.push(...registration.diagnostics);
        if (specification.role !== MAP_ROLE.BASE) {
          registry.quarantine({
            filename: accepted.filename,
            role: specification.role,
            mapId: accepted.data.mapId,
            diagnostics: registration.diagnostics,
          });
        }
      }
    }

    let optionalRemoved = true;
    const blockingReferenceKeys = new Set();
    while (optionalRemoved) {
      optionalRemoved = false;
      for (const record of registry.entries()) {
        const references = this.mapValidator.validateRegistryReferences({ record, registry });
        if (references.ok) continue;
        if (record.role === MAP_ROLE.BASE) {
          for (const diagnostic of references.diagnostics) {
            if (!blockingReferenceKeys.has(diagnostic.diagnosticId)) {
              blockingReferenceKeys.add(diagnostic.diagnosticId);
              conformanceDiagnostics.push(diagnostic);
            }
          }
        } else {
          conformanceDiagnostics.push(...references.diagnostics);
          registry.removeToQuarantine(record.mapId, references.diagnostics);
          optionalRemoved = true;
        }
      }

      for (const record of registry.entries()) {
        if (record.role === MAP_ROLE.BASE) continue;
        const optionalValidity = this.mapValidator.validateActiveMap({
          registry,
          activeMapId: record.mapId,
          accessibilityValidator,
        });
        if (optionalValidity.ok) continue;
        conformanceDiagnostics.push(...optionalValidity.diagnostics);
        registry.removeToQuarantine(record.mapId, optionalValidity.diagnostics);
        optionalRemoved = true;
      }
    }

    const activeMapValidity = this.mapValidator.validateActiveMap({
      registry,
      activeMapId,
      accessibilityValidator,
    });
    const registryConformance = conformanceResult({
      diagnostics: conformanceDiagnostics,
      registry,
      specificationCount: normalized.length,
    });
    const diagnostics = uniqueDiagnostics([
      ...registryConformance.diagnostics,
      ...activeMapValidity.diagnostics,
    ]);
    const blocked = diagnostics.some(blockingDiagnostic) || !activeMapValidity.ok;
    registry.seal();
    const quarantinedCount = registry.quarantineEntries().length;

    return Object.freeze({
      ok: !blocked && diagnostics.length === 0,
      code: blocked
        ? "MAP_LOAD_BLOCKED"
        : quarantinedCount > 0
          ? "MAP_LOAD_VALID_WITH_QUARANTINE"
          : "MAP_LOAD_VALID",
      blocked,
      canStart: !blocked,
      activeMapId,
      activeMap: activeMapValidity.ok ? registry.get(activeMapId) : null,
      registry,
      registryConformance,
      activeMapValidity,
      quarantined: registry.quarantineEntries(),
      diagnostics,
    });
  }

  /** In-memory adapter used by QA and deterministic tooling; production still follows JSON parse. */
  async loadDefinitions(entries, options = {}) {
    if (!Array.isArray(entries)) throw new TypeError("Map definition entries는 배열이어야 합니다.");
    const memory = new Map();
    const specifications = entries.map((entry) => {
      if (!entry || typeof entry !== "object" || !("data" in entry)) {
        throw new TypeError("각 in-memory Map entry에는 data가 필요합니다.");
      }
      const expectedMapId = entry.expectedMapId ?? entry.data?.mapId;
      const specification = createMapLoadSpecification({
        filename: entry.filename,
        role: entry.role,
        ...(expectedMapId === undefined ? {} : { expectedMapId }),
      });
      memory.set(specification.filename, JSON.stringify(entry.data));
      return specification;
    });
    const dataLoader = new DataLoader({
      validator: this.mapValidator.schemaValidator,
      loadText: async ({ filename }) => {
        if (!memory.has(filename)) throw new Error(`in-memory Map이 없습니다: ${filename}`);
        return memory.get(filename);
      },
    });
    const nested = new MapLoader({
      mapValidator: this.mapValidator,
      dataLoader,
      registryFactory: this.registryFactory,
      accessibilityValidator: this.accessibilityValidator,
    });
    return nested.load(specifications, options);
  }
}

/** Convenience result adapter used by AppBootstrap's fixed MAP stage. */
export function mapLoadReportToBootOutcome(report) {
  if (!report || typeof report.canStart !== "boolean") {
    throw new TypeError("Map load report 계약이 잘못됐습니다.");
  }
  const details = freezeDeep({
    activeMapId: report.activeMapId,
    registeredCount: report.registryConformance.registeredCount,
    quarantinedCount: report.quarantined.length,
    registryCode: report.registryConformance.code,
    activeValidityCode: report.activeMapValidity.code,
  });
  if (!report.canStart) {
    return freezeDeep({
      ok: false,
      code: "MAP_BOOT_BLOCKED",
      diagnostics: report.diagnostics,
      details,
    });
  }
  return freezeDeep({
    ok: true,
    value: report,
    code: report.quarantined.length > 0 ? "MAP_READY_WITH_QUARANTINE" : "MAP_READY",
    diagnostics: report.diagnostics,
    details,
  });
}
