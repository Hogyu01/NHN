import { canonicalStringify, sha256Hex } from "./canonical-json.js";
import { validateSavePayload } from "./save-validator.js";

export const SAVE_FORMAT_VERSION = 1;

export const SAVE_CHECKPOINT_PHASE = Object.freeze({
  PLANNING_READY: "PLANNING_READY",
  TERMINAL: "TERMINAL",
});

const SAVED_SLICES = Object.freeze([
  "campaign",
  "recipes",
  "menu",
  "saleSlots",
  "facilities",
  "progression",
  "events",
  "market",
  "contracts",
  "economy",
  "inventory",
  "inventoryAccounting",
  "sales",
  "rng",
  "idCounters",
  "extensions",
]);

const MESSAGE_BY_CODE = Object.freeze({
  SAVE_PHASE_FORBIDDEN: "PLANNING_READY 또는 TERMINAL checkpoint에서만 저장할 수 있습니다.",
  SAVE_PAYLOAD_INVALID: "저장 payload가 field/type/ID/range/reference/invariant 검사를 통과하지 못했습니다.",
  SAVE_ENVELOPE_PARSE_FAILED: "저장 데이터를 JSON으로 해석할 수 없습니다.",
  SAVE_ENVELOPE_SCHEMA_INVALID: "저장 envelope 형식이 올바르지 않습니다.",
  SAVE_HASH_MISMATCH: "저장 payload의 SHA-256 hash가 일치하지 않습니다.",
  SAVE_FORMAT_VERSION_UNSUPPORTED: "지원하지 않는 저장 formatVersion입니다.",
});

function failure(code, details = undefined) {
  return Object.freeze({ ok: false, code, message: MESSAGE_BY_CODE[code] ?? code, ...(details ? { details } : {}) });
}

function success(value) {
  return Object.freeze({ ok: true, ...value });
}

/**
 * checkpointPhase가 PLANNING_READY 또는 TERMINAL일 때만 저장을 허용한다(Requirement 18.5).
 * Service/Settlement 중간 저장은 항상 SAVE_PHASE_FORBIDDEN으로 거절한다.
 */
export function assertSaveable(snapshot) {
  if (!Object.values(SAVE_CHECKPOINT_PHASE).includes(snapshot.checkpointPhase)) {
    return failure("SAVE_PHASE_FORBIDDEN", { checkpointPhase: snapshot.checkpointPhase });
  }
  return success({});
}

/**
 * GameStore snapshot에서 저장 대상 slice만 뽑는다. revision/generationId/runtimePhase/service/
 * boot/featureFlags는 매 boot마다 새로 만들어지므로 제외한다(Camera도 애초에 domain state가
 * 아니라 world 계층 파생값이라 여기 없다).
 */
export function buildSavePayload(snapshot) {
  const payload = {
    formatVersion: SAVE_FORMAT_VERSION,
    checkpointPhase: snapshot.checkpointPhase,
    activeMapId: snapshot.boot?.maps?.activeMapId ?? "map.base_restaurant",
  };
  for (const slice of SAVED_SLICES) {
    if (snapshot[slice] !== undefined) payload[slice] = snapshot[slice];
  }
  // SAVE_STATE_CORE_V1 schema는 SaleSlot 배열을 menu.saleSlots에 요구한다(runtime GameStore는
  // menu/saleSlots를 별도 top-level slice로 둔다) — 기존 검증기를 바꾸지 않고 여기서 맞춘다.
  if (snapshot.menu && snapshot.saleSlots) {
    payload.menu = { ...snapshot.menu, saleSlots: snapshot.saleSlots.slots };
  }
  if (snapshot.inventory) {
    payload.inventory = {
      ...snapshot.inventory,
      lots: snapshot.inventory.lots.map((lot) => {
        const reservedQuantity = snapshot.inventory.reservations
          .filter((reservation) => reservation.lotId === lot.lotId)
          .reduce((sum, reservation) => sum + reservation.quantity, 0);
        return { ...lot, unreservedQuantity: lot.quantity - reservedQuantity };
      }),
    };
  }
  return payload;
}

/** payload를 canonical JSON + SHA-256으로 봉인해 SaveEnvelope를 만든다. */
export async function createSaveEnvelope(snapshot) {
  const saveable = assertSaveable(snapshot);
  if (!saveable.ok) return saveable;
  const payload = buildSavePayload(snapshot);
  const report = validateSavePayload(payload);
  if (!report.ok) return failure("SAVE_PAYLOAD_INVALID", { diagnostics: report.diagnostics });
  const payloadCanonicalJson = canonicalStringify(payload);
  const payloadSha256 = await sha256Hex(payloadCanonicalJson);
  return success({
    envelope: Object.freeze({
      formatVersion: SAVE_FORMAT_VERSION,
      checkpointPhase: payload.checkpointPhase,
      payloadCanonicalJson,
      payloadSha256,
      writtenAtIso: new Date().toISOString(),
    }),
    payload,
  });
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * envelope(raw 문자열 또는 이미 parse된 object)을 parse→hash 검증→schema/invariant 검증
 * 순서로 읽는다. 셋 중 하나라도 실패하면 원본을 훼손하지 않고 실패 code만 돌려준다.
 */
export async function readSaveEnvelope(raw) {
  let envelope;
  try {
    envelope = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    return failure("SAVE_ENVELOPE_PARSE_FAILED", { error: error instanceof Error ? error.message : String(error) });
  }
  if (!isPlainRecord(envelope) ||
      !Number.isSafeInteger(envelope.formatVersion) ||
      typeof envelope.checkpointPhase !== "string" ||
      typeof envelope.payloadCanonicalJson !== "string" ||
      typeof envelope.payloadSha256 !== "string") {
    return failure("SAVE_ENVELOPE_SCHEMA_INVALID");
  }
  if (envelope.formatVersion !== SAVE_FORMAT_VERSION) {
    return failure("SAVE_FORMAT_VERSION_UNSUPPORTED", { formatVersion: envelope.formatVersion });
  }
  const recomputedHash = await sha256Hex(envelope.payloadCanonicalJson);
  if (recomputedHash !== envelope.payloadSha256) {
    return failure("SAVE_HASH_MISMATCH", { expected: envelope.payloadSha256, actual: recomputedHash });
  }
  let payload;
  try {
    payload = JSON.parse(envelope.payloadCanonicalJson);
  } catch (error) {
    return failure("SAVE_ENVELOPE_PARSE_FAILED", { error: error instanceof Error ? error.message : String(error) });
  }
  const report = validateSavePayload(payload);
  if (!report.ok) return failure("SAVE_PAYLOAD_INVALID", { diagnostics: report.diagnostics });
  return success({ envelope, payload });
}

/** 정규화를 두 번 적용해도(envelope→payload→envelope) canonical JSON이 동일한지 확인한다. */
export async function isNormalizationIdempotent(snapshot) {
  const first = await createSaveEnvelope(snapshot);
  if (!first.ok) return false;
  const reread = await readSaveEnvelope(first.envelope);
  if (!reread.ok) return false;
  const second = canonicalStringify(buildSavePayload({ ...snapshot, ...reread.payload }));
  return second === first.envelope.payloadCanonicalJson;
}
