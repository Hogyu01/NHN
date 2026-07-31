import { cloneValue, freezeDeep } from "./result.js";

const UINT32_RANGE = 0x1_0000_0000;
const STREAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export const CORE_RNG_STREAMS = Object.freeze([
  "market",
  "contractOffer",
  "contractResolution",
  "demand",
  "event",
]);

function requireUint32(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError(`${field}는 uint32여야 합니다.`);
  }
  return value >>> 0;
}

function requireSafeNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field}는 0 이상의 safe integer여야 합니다.`);
  }
  return value;
}

function requireStreamName(value) {
  if (typeof value !== "string" || !STREAM_NAME_PATTERN.test(value)) {
    throw new TypeError("RNG stream 이름이 유효하지 않습니다.");
  }
  return value;
}

export function utf8Bytes(text) {
  if (typeof text !== "string") throw new TypeError("UTF-8 입력은 문자열이어야 합니다.");
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new TypeError("RNG label에 짝이 없는 high surrogate가 있습니다.");
      }
      codePoint = 0x1_0000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      throw new TypeError("RNG label에 짝이 없는 low surrogate가 있습니다.");
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Object.freeze(bytes);
}

export function fnv1a32(bytes) {
  if (!bytes || typeof bytes[Symbol.iterator] !== "function") {
    throw new TypeError("FNV-1a 입력은 byte iterable이어야 합니다.");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError("FNV-1a 입력에는 byte만 허용됩니다.");
    }
    hash = Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0;
  }
  return hash;
}

export function hashStreamLabel(label) {
  return fnv1a32(utf8Bytes(requireStreamName(label)));
}

export function splitmix32Step(state) {
  const normalizedState = requireUint32(state, "splitmix32 state");
  const nextState = (normalizedState + 0x9e3779b9) >>> 0;
  let value = nextState;
  value = Math.imul((value ^ (value >>> 16)) >>> 0, 0x21f0aaad) >>> 0;
  value = Math.imul((value ^ (value >>> 15)) >>> 0, 0x735a2d97) >>> 0;
  return Object.freeze({ state: nextState, value: (value ^ (value >>> 15)) >>> 0 });
}

export function rotl32(value, shift) {
  const normalized = requireUint32(value, "rotate value");
  if (!Number.isInteger(shift) || shift < 1 || shift > 31) {
    throw new TypeError("rotate shift는 1..31 정수여야 합니다.");
  }
  return ((normalized << shift) | (normalized >>> (32 - shift))) >>> 0;
}

export function xoshiro128ss(words) {
  if (!Array.isArray(words) || words.length !== 4) {
    throw new TypeError("xoshiro128** state는 uint32 4개 배열이어야 합니다.");
  }
  for (let index = 0; index < words.length; index += 1) {
    requireUint32(words[index], `xoshiro words[${index}]`);
  }

  const output = Math.imul(rotl32(Math.imul(words[1], 5) >>> 0, 7), 9) >>> 0;
  const temporary = (words[1] << 9) >>> 0;
  words[2] = (words[2] ^ words[0]) >>> 0;
  words[3] = (words[3] ^ words[1]) >>> 0;
  words[1] = (words[1] ^ words[2]) >>> 0;
  words[0] = (words[0] ^ words[3]) >>> 0;
  words[2] = (words[2] ^ temporary) >>> 0;
  words[3] = rotl32(words[3], 11);
  return output;
}

export function createRngStreamState(masterSeed, name) {
  const seed = requireUint32(masterSeed, "masterSeed");
  const streamName = requireStreamName(name);
  let expansionState = (seed ^ hashStreamLabel(streamName)) >>> 0;
  const words = [];
  for (let index = 0; index < 4; index += 1) {
    const expanded = splitmix32Step(expansionState);
    expansionState = expanded.state;
    words.push(expanded.value);
  }
  if (words.every((word) => word === 0)) words[0] = 0x9e3779b9;
  return freezeDeep({ name: streamName, words, drawCount: 0 });
}

function normalizeStreamState(input, expectedName) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`RNG stream ${expectedName} state가 plain object가 아닙니다.`);
  }
  const name = requireStreamName(input.name);
  if (name !== expectedName) {
    throw new RangeError(`RNG stream key와 state name이 다릅니다: ${expectedName}`);
  }
  if (!Array.isArray(input.words) || input.words.length !== 4) {
    throw new TypeError(`${expectedName}.words는 uint32 4개 배열이어야 합니다.`);
  }
  const words = input.words.map((word, index) => requireUint32(word, `${expectedName}.words[${index}]`));
  if (words.every((word) => word === 0)) {
    throw new RangeError(`${expectedName} xoshiro state는 all-zero일 수 없습니다.`);
  }
  return {
    name,
    words,
    drawCount: requireSafeNonNegativeInteger(input.drawCount, `${expectedName}.drawCount`),
  };
}

export function createRngRegistryState(masterSeed, { optionalStreamFlags = {} } = {}) {
  const seed = requireUint32(masterSeed, "masterSeed");
  if (!optionalStreamFlags || typeof optionalStreamFlags !== "object" || Array.isArray(optionalStreamFlags)) {
    throw new TypeError("optionalStreamFlags는 plain object여야 합니다.");
  }

  const streams = {};
  for (const name of CORE_RNG_STREAMS) streams[name] = cloneValue(createRngStreamState(seed, name));
  for (const name of Object.keys(optionalStreamFlags).sort()) {
    requireStreamName(name);
    const enabled = optionalStreamFlags[name];
    if (typeof enabled !== "boolean") {
      throw new TypeError(`optional stream flag ${name}은 boolean이어야 합니다.`);
    }
    if (CORE_RNG_STREAMS.includes(name)) {
      throw new RangeError(`core stream은 optional flag로 제어할 수 없습니다: ${name}`);
    }
    if (enabled) streams[name] = cloneValue(createRngStreamState(seed, name));
  }
  return freezeDeep({ masterSeed: seed, streams });
}

function normalizeRegistryState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("RNG registry state는 plain object여야 합니다.");
  }
  const masterSeed = requireUint32(input.masterSeed, "masterSeed");
  if (!input.streams || typeof input.streams !== "object" || Array.isArray(input.streams)) {
    throw new TypeError("RNG streams는 plain object여야 합니다.");
  }
  for (const coreName of CORE_RNG_STREAMS) {
    if (!Object.prototype.hasOwnProperty.call(input.streams, coreName)) {
      throw new RangeError(`필수 core RNG stream이 없습니다: ${coreName}`);
    }
  }
  const streams = {};
  for (const name of Object.keys(input.streams).sort()) {
    requireStreamName(name);
    streams[name] = normalizeStreamState(input.streams[name], name);
  }
  return { masterSeed, streams };
}

/**
 * Unbiased uint32 rejection sampler. `nextUint32` is deliberately injected so this exact helper
 * can be used by every stream without modulo-bias shortcuts.
 */
export function sampleUint32Below(nextUint32, upperExclusive) {
  if (typeof nextUint32 !== "function") {
    throw new TypeError("nextUint32 함수가 필요합니다.");
  }
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive < 1 || upperExclusive > UINT32_RANGE) {
    throw new RangeError("upperExclusive는 1..2^32 safe integer여야 합니다.");
  }
  const acceptanceLimit = Math.floor(UINT32_RANGE / upperExclusive) * upperExclusive;
  let draws = 0;
  let rejectedDraws = 0;
  while (true) {
    const raw = requireUint32(nextUint32(), "nextUint32 result");
    draws += 1;
    if (raw < acceptanceLimit) {
      return Object.freeze({
        value: raw % upperExclusive,
        draws,
        rejectedDraws,
        acceptanceLimit,
      });
    }
    rejectedDraws += 1;
  }
}

/** Independent named xoshiro128** streams with checkpointable words and draw counts. */
export class RngRegistry {
  constructor(stateOrMasterSeed, options = {}) {
    const initial = typeof stateOrMasterSeed === "number"
      ? createRngRegistryState(stateOrMasterSeed, options)
      : normalizeRegistryState(stateOrMasterSeed);
    this._state = cloneValue(initial);
    this._trace = [];
    this._nextTraceSequence = 0;
  }

  static fromState(state) {
    return new RngRegistry(state);
  }

  hasStream(name) {
    return Object.prototype.hasOwnProperty.call(this._state.streams, requireStreamName(name));
  }

  streamNames() {
    return Object.freeze(Object.keys(this._state.streams).sort());
  }

  ensureOptionalStream(name, flagEnabled) {
    const streamName = requireStreamName(name);
    if (CORE_RNG_STREAMS.includes(streamName)) {
      throw new RangeError(`${streamName}은 core stream이므로 optional 생성 대상이 아닙니다.`);
    }
    if (typeof flagEnabled !== "boolean") {
      throw new TypeError("optional stream feature flag는 boolean이어야 합니다.");
    }
    if (!flagEnabled) return false;
    if (!this.hasStream(streamName)) {
      this._state.streams[streamName] = cloneValue(
        createRngStreamState(this._state.masterSeed, streamName),
      );
    }
    return true;
  }

  nextUint32(name) {
    const stream = this._requireStream(name);
    const before = stream.drawCount;
    const value = this._nextRaw(stream);
    this._appendTrace(stream, {
      operation: "UINT32",
      drawCountBefore: before,
      drawCountAfter: stream.drawCount,
      value,
      rejectedDraws: 0,
    });
    return value;
  }

  nextInt(name, upperExclusive) {
    const stream = this._requireStream(name);
    const before = stream.drawCount;
    const sampled = sampleUint32Below(() => this._nextRaw(stream), upperExclusive);
    this._appendTrace(stream, {
      operation: "INT",
      drawCountBefore: before,
      drawCountAfter: stream.drawCount,
      value: sampled.value,
      upperExclusive,
      rejectedDraws: sampled.rejectedDraws,
      acceptanceLimit: sampled.acceptanceLimit,
    });
    return sampled.value;
  }

  percentage(name, percentage) {
    if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
      throw new RangeError("percentage는 0..100 정수여야 합니다.");
    }
    const stream = this._requireStream(name);
    const before = stream.drawCount;
    const sampled = sampleUint32Below(() => this._nextRaw(stream), 100);
    const value = sampled.value < percentage;
    this._appendTrace(stream, {
      operation: "PERCENTAGE",
      drawCountBefore: before,
      drawCountAfter: stream.drawCount,
      value,
      roll: sampled.value,
      percentage,
      upperExclusive: 100,
      rejectedDraws: sampled.rejectedDraws,
      acceptanceLimit: sampled.acceptanceLimit,
    });
    return value;
  }

  getStreamState(name) {
    return freezeDeep(cloneValue(this._requireStream(name)));
  }

  snapshot() {
    const streams = {};
    for (const name of Object.keys(this._state.streams).sort()) {
      streams[name] = cloneValue(this._state.streams[name]);
    }
    return freezeDeep({ masterSeed: this._state.masterSeed, streams });
  }

  getTrace() {
    return freezeDeep(cloneValue(this._trace));
  }

  clearTrace() {
    this._trace.length = 0;
  }

  _requireStream(name) {
    const streamName = requireStreamName(name);
    const stream = this._state.streams[streamName];
    if (!stream) throw new RangeError(`생성되지 않은 RNG stream입니다: ${streamName}`);
    return stream;
  }

  _nextRaw(stream) {
    if (stream.drawCount === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`${stream.name} drawCount가 safe integer 범위를 초과했습니다.`);
    }
    const value = xoshiro128ss(stream.words);
    stream.drawCount += 1;
    return value;
  }

  _appendTrace(stream, details) {
    if (this._nextTraceSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("RNG trace sequence가 safe integer 범위를 초과했습니다.");
    }
    this._trace.push({
      traceSequence: this._nextTraceSequence,
      stream: stream.name,
      ...details,
      wordsAfter: [...stream.words],
    });
    this._nextTraceSequence += 1;
  }
}
