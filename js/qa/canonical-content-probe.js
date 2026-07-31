import { DataValidator } from "../infrastructure/data-validator.js";

const QA_ID = "canonical-content-v1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function acceptedDocuments(loadReport) {
  return loadReport.accepted.map((entry) => ({
    filename: entry.filename,
    schemaName: entry.schemaName,
    boundary: entry.boundary,
    data: clone(entry.data),
  }));
}

function documentData(documents, filename) {
  const document = documents.find((entry) => entry.filename === filename);
  if (!document) throw new Error(`probe document가 없습니다: ${filename}`);
  return document.data;
}

function mutateAndValidate(loadReport, mutate) {
  const documents = acceptedDocuments(loadReport);
  mutate(Object.fromEntries(documents.map((entry) => [entry.filename, entry.data])));
  return new DataValidator().validateDocuments(documents);
}

function hasCode(report, code) {
  return report.diagnostics.some((diagnostic) => diagnostic.code === code);
}

function scan(value, predicate, path = "$") {
  if (predicate(value, path)) return path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = scan(value[index], predicate, `${path}[${index}]`);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const found = scan(child, predicate, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Task 5 canonical content acceptance and mutation matrix. It runs the production DataValidator
 * against actual loader results; no alternative schema or coercing fixture is used.
 *
 * **Validates: Requirements 3.1, 3.2, 6.3, 6.4, 7.1, 7.2, 7.3, 13.1, 14.1,
 * 14.5, 15.1, 15.2, 20.1, 20.2, 20.3, 20.4, 32.1, 32.2, 34.1, 34.2, 34.15**
 */
export async function runCanonicalContentProbe(loadReport) {
  const results = await Promise.all([
    runCase(
      "canonical-loader-pass",
      "manifest, seven canonical content files, and migration report load with zero diagnostics",
      "Requirements 20.1, 20.4",
      () => {
        assert(loadReport.ok, `canonical loader가 ${loadReport.diagnostics.length} diagnostics를 반환했습니다.`);
        assert(loadReport.accepted.length === 9, `expected 9 accepted documents, got ${loadReport.accepted.length}`);
        return { accepted: loadReport.accepted.length, diagnostics: loadReport.diagnostics.length };
      },
    ),
    runCase(
      "canonical-counts-and-composition",
      "ingredient 10, Recipe 6/start 2+, Guest 6/human 1+/friendly 3+, Must facility 3을 보존한다",
      "Requirements 13.1, 14.1, 32.2, 34.1, 34.2",
      () => {
        const documents = acceptedDocuments(loadReport);
        const ingredients = documentData(documents, "data/ingredients.json");
        const recipes = documentData(documents, "data/recipes.json");
        const guests = documentData(documents, "data/guests.json");
        const facilities = documentData(documents, "data/upgrades.json");
        const starting = recipes.recipes.filter((entry) => entry.unlock.type === "STARTING").length;
        const human = guests.guestArchetypes.filter((entry) => entry.classification === "HUMAN").length;
        const friendly = guests.guestArchetypes.filter((entry) => entry.classification !== "HUMAN").length;
        assert(ingredients.ingredients.length === 10, "ingredient count가 10이 아닙니다.");
        assert(recipes.recipes.length === 6 && starting >= 2, "Recipe count/start contract가 잘못됐습니다.");
        assert(guests.guestArchetypes.length === 6 && human >= 1 && friendly >= 3, "Guest composition이 잘못됐습니다.");
        assert(facilities.facilities.length === 3, "Must facility count가 3이 아닙니다.");
        return { ingredients: 10, recipes: 6, starting, guests: 6, human, friendly, facilities: 3 };
      },
    ),
    runCase(
      "fixed-balance-contract",
      "14일/300G/500G/30→70/40G/105초/기본 6명과 계약 risk table을 exact 값으로 유지한다",
      "Requirements 3.1, 3.2, 6.4, 7.2, 20.2",
      () => {
        const documents = acceptedDocuments(loadReport);
        const balance = documentData(documents, "data/balance.json");
        assert(balance.campaign.days === 14, "campaign days가 14가 아닙니다.");
        assert(balance.campaign.startCashG === 300 && balance.campaign.startDebtG === 500, "start economy가 다릅니다.");
        assert(balance.campaign.startReputation === 30 && balance.campaign.targetReputation === 70, "reputation goal이 다릅니다.");
        assert(balance.economy.fixedCostG === 40, "fixed cost가 40G가 아닙니다.");
        assert(balance.service.durationMs === 105000 && balance.service.defaultGuestCount === 6, "service default가 다릅니다.");
        assert(JSON.stringify(balance.contract.riskTiers) === JSON.stringify([
          { risk: "LOW", successRate: 90, discountPercent: 5 },
          { risk: "MEDIUM", successRate: 70, discountPercent: 15 },
          { risk: "HIGH", successRate: 50, discountPercent: 30 },
        ]), "contract risk table이 다릅니다.");
        return { campaignDays: 14, fixedCostG: 40, serviceDurationMs: 105000 };
      },
    ),
    runCase(
      "no-legacy-coercion-or-placeholder",
      "legacy Korean keys, normalized ratio, 빈/예시 문자열이 canonical payload에 남지 않는다",
      "Requirements 20.1, 20.2",
      () => {
        const documents = acceptedDocuments(loadReport)
          .filter((entry) => entry.filename.startsWith("data/"));
        const legacyKeys = new Set(["이름", "카테고리", "확률_일반", "확률_고급", "확률_희귀", "필요_재료", "효과_설명"]);
        const keyPath = scan(documents, (_value, path) => legacyKeys.has(path.split(".").at(-1)));
        const placeholderPath = scan(documents, (value) =>
          typeof value === "string" && (value.trim() === "" || value.startsWith("예:")));
        assert(!keyPath, `legacy key가 남았습니다: ${keyPath}`);
        assert(!placeholderPath, `placeholder string이 남았습니다: ${placeholderPath}`);
        return { legacyKeyPath: null, placeholderPath: null };
      },
    ),
    runCase(
      "reference-integrity",
      "Recipe/Guest/Dialogue/manifest references have zero dangling targets",
      "Requirements 14.5, 20.1",
      () => {
        const dangling = loadReport.diagnostics.filter((entry) => entry.errorType === "REFERENCE_ERROR");
        assert(dangling.length === 0, `dangling references=${dangling.length}`);
        return { danglingReferences: 0 };
      },
    ),
    runCase(
      "version-mutation-rejected",
      "각 canonical data file의 schemaVersion 변경을 coercion 없이 거절한다",
      "Requirement 20.1",
      () => {
        const filenames = [
          "data/ingredients.json",
          "data/recipes.json",
          "data/upgrades.json",
          "data/dialogue.json",
          "data/guests.json",
          "data/events.json",
          "data/balance.json",
        ];
        for (const filename of filenames) {
          const report = mutateAndValidate(loadReport, (byFilename) => {
            byFilename[filename].schemaVersion = 2;
          });
          assert(hasCode(report, "FIELD_CONST_MISMATCH"), `${filename} schemaVersion mutation이 거절되지 않았습니다.`);
        }
        return { mutatedFiles: filenames.length };
      },
    ),
    runCase(
      "semantic-mutation-matrix",
      "starting Recipe, Guest composition, facility kind, Day 1 event, contract table 위반을 각각 거절한다",
      "Requirements 6.4, 13.1, 14.1, 15.1, 34.2",
      () => {
        const mutations = [
          ["CANONICAL_STARTING_RECIPE_COUNT_INVALID", (files) => {
            files["data/recipes.json"].recipes[1].unlock = { type: "REPUTATION", reputationThreshold: 35 };
          }],
          ["GUEST_COMPOSITION_INVALID", (files) => {
            for (const guest of files["data/guests.json"].guestArchetypes) guest.classification = "HUMAN";
          }],
          ["FACILITY_KIND_CARDINALITY_INVALID", (files) => {
            files["data/upgrades.json"].facilities[1].kind = "KITCHEN";
          }],
          ["EVENT_DAY_ONE_INTRO_INVALID", (files) => {
            files["data/events.json"].events[0].selection = "RANDOM_DAY_2_14";
          }],
          ["CONTRACT_RISK_TABLE_INVALID", (files) => {
            files["data/balance.json"].contract.riskTiers[0].successRate = 89;
          }],
          ["CONTENT_MANIFEST_CONTRACT_MISMATCH", (files) => {
            files["data/content-manifest.json"].files.pop();
          }],
        ];
        for (const [code, mutate] of mutations) {
          const report = mutateAndValidate(loadReport, mutate);
          assert(hasCode(report, code), `${code} mutation이 지정 invariant로 거절되지 않았습니다.`);
        }
        return { mutations: mutations.length };
      },
    ),
    runCase(
      "combat-domain-absent",
      "Guest canonical payload와 schema가 combat/attack/damage/loot 상태를 포함하지 않는다",
      "Requirement 34.15",
      () => {
        const documents = acceptedDocuments(loadReport);
        const guests = documentData(documents, "data/guests.json");
        const forbidden = /^(combat|attack|damage|loot)$/i;
        const found = scan(guests, (value, path) => {
          const key = path.split(".").at(-1)?.replace(/\[\d+\]$/, "");
          return forbidden.test(key ?? "") || (typeof value === "string" && forbidden.test(value));
        });
        assert(!found, `forbidden Guest domain token: ${found}`);
        const mutation = mutateAndValidate(loadReport, (files) => {
          files["data/guests.json"].guestArchetypes[0].attack = "NONE";
        });
        assert(hasCode(mutation, "FIELD_UNKNOWN"), "combat field 추가가 schema에서 거절되지 않았습니다.");
        return { forbiddenToken: null };
      },
    ),
  ]);

  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: QA_ID,
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results: Object.freeze(results),
  });
}
