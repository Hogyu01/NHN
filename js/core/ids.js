import { cloneValue, freezeDeep } from "./result.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MAX_PADDED_COUNTER = 9_999_999_999;
const EXHAUSTED_COUNTER = MAX_PADDED_COUNTER + 1;

export const REQUIRED_ID_KINDS = Object.freeze([
  "cmd",
  "tx",
  "cause",
  "lot",
  "reservation",
  "slot",
  "guest",
  "entity",
  "order",
  "cook",
  "dish",
  "event",
  "result",
  "diagnostic",
]);

function requireSafeNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field}는 0 이상의 safe integer여야 합니다.`);
  }
  return value;
}

function requireDay(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("day는 1 이상의 safe integer여야 합니다.");
  }
  return value;
}

function requireCampaignId(value) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError("campaignId가 stable identifier 형식이 아닙니다.");
  }
  return value;
}

function requireKind(value) {
  if (typeof value !== "string" || !KIND_PATTERN.test(value)) {
    throw new TypeError("ID kind가 유효하지 않습니다.");
  }
  return value;
}

function normalizeCounters(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("idCounters는 plain object여야 합니다.");
  }

  const counters = Object.fromEntries(REQUIRED_ID_KINDS.map((kind) => [kind, 0]));
  for (const kind of Object.keys(input).sort()) {
    requireKind(kind);
    const counter = requireSafeNonNegativeInteger(input[kind], `idCounters.${kind}`);
    if (counter > EXHAUSTED_COUNTER) {
      throw new RangeError(`${kind} ID counter가 10자리 범위를 초과했습니다.`);
    }
    counters[kind] = counter;
  }
  return counters;
}

/**
 * A campaign ID derived only from explicit deterministic inputs. This helper does not read a
 * clock, locale, storage, or random source.
 */
export function createCampaignId(masterSeed, creationSequence) {
  if (!Number.isInteger(masterSeed) || masterSeed < 0 || masterSeed > 0xffff_ffff) {
    throw new TypeError("masterSeed는 uint32여야 합니다.");
  }
  requireSafeNonNegativeInteger(creationSequence, "creationSequence");
  if (creationSequence > MAX_PADDED_COUNTER) {
    throw new RangeError("creationSequence가 10자리 범위를 초과했습니다.");
  }
  return `campaign:${masterSeed.toString(16).padStart(8, "0")}:${String(creationSequence).padStart(10, "0")}`;
}

export function createIdServiceState({
  campaignId,
  day = 1,
  generationId = 0,
  counters = {},
}) {
  return freezeDeep({
    campaignId: requireCampaignId(campaignId),
    day: requireDay(day),
    generationId: requireSafeNonNegativeInteger(generationId, "generationId"),
    counters: normalizeCounters(counters),
  });
}

/**
 * Deterministic ID allocator. Counter mutation is isolated in this service so a transaction can
 * clone its plain snapshot and discard it on rejection.
 */
export class IdService {
  constructor(state) {
    this._state = cloneValue(createIdServiceState(state));
  }

  static fromState(state) {
    return new IdService(state);
  }

  get campaignId() {
    return this._state.campaignId;
  }

  get day() {
    return this._state.day;
  }

  get generationId() {
    return this._state.generationId;
  }

  setDay(day) {
    this._state.day = requireDay(day);
    return this._state.day;
  }

  peekCounter(kind) {
    const normalizedKind = requireKind(kind);
    return this._state.counters[normalizedKind] ?? 0;
  }

  next(kind, { day = this._state.day } = {}) {
    const normalizedKind = requireKind(kind);
    const normalizedDay = requireDay(day);
    const counter = this.peekCounter(normalizedKind);
    if (counter > MAX_PADDED_COUNTER) {
      throw new RangeError(`${normalizedKind} ID counter가 소진되었습니다.`);
    }

    const id = [
      this._state.campaignId,
      normalizedKind,
      normalizedDay,
      String(counter).padStart(10, "0"),
    ].join(":");
    this._state.counters[normalizedKind] = counter + 1;
    return id;
  }

  advanceGeneration() {
    const next = this._state.generationId + 1;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("generationId가 safe integer 범위를 초과했습니다.");
    }
    this._state.generationId = next;
    return next;
  }

  snapshot() {
    return freezeDeep(cloneValue(this._state));
  }
}
