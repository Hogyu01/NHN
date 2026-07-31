/*
 * Domain/core result contracts. This module intentionally has no browser or I/O dependency.
 */

/** @typedef {{ok: true, details?: unknown}} ValidationSuccess */
/** @typedef {{ok: false, code: string, diagnostics: readonly object[], details?: unknown}} ValidationFailure */
/** @typedef {ValidationSuccess | ValidationFailure} ValidationResult */

/**
 * @typedef {object} CommandSuccess
 * @property {true} ok
 * @property {number} revision
 * @property {readonly import("./events.js").DomainEvent[]} events
 * @property {readonly import("./events.js").EffectRequest[]} effects
 * @property {readonly import("./diagnostic.js").Diagnostic[]} diagnostics
 */

/**
 * @typedef {object} CommandFailure
 * @property {false} ok
 * @property {number} revision
 * @property {string} code
 * @property {readonly import("./diagnostic.js").Diagnostic[]} diagnostics
 * @property {readonly []} events
 * @property {readonly []} effects
 */

/** @typedef {CommandSuccess | CommandFailure} CommandResult */

const EMPTY_LIST = Object.freeze([]);

/**
 * Domain state is a serializable object graph. Accessors and host objects are rejected so
 * transaction snapshots cannot execute ambient behavior while cloning.
 *
 * @template T
 * @param {T} value
 * @param {WeakMap<object, object>} [seen]
 * @returns {T}
 */
export function cloneValue(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(`지원하지 않는 domain 값입니다: ${typeof value}`);
    }
    return value;
  }

  if (seen.has(value)) {
    return /** @type {T} */ (seen.get(value));
  }

  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneValue(item, seen));
    }
    return /** @type {T} */ (copy);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Domain 값은 plain object 또는 array여야 합니다.");
  }

  const copy = prototype === null ? Object.create(null) : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`Domain 값의 accessor는 허용되지 않습니다: ${key}`);
    }
    copy[key] = cloneValue(descriptor.value, seen);
  }
  return /** @type {T} */ (copy);
}

/**
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [seen]
 * @returns {Readonly<T>}
 */
export function freezeDeep(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return /** @type {Readonly<T>} */ (value);
  }

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeDeep(value[key], seen);
  }
  return /** @type {Readonly<T>} */ (Object.freeze(value));
}

/**
 * @param {unknown} [details]
 * @returns {ValidationSuccess}
 */
export function validationSuccess(details) {
  return details === undefined
    ? Object.freeze({ ok: true })
    : freezeDeep({ ok: true, details: cloneValue(details) });
}

/**
 * @param {string} code
 * @param {readonly object[]} [diagnostics]
 * @param {unknown} [details]
 * @returns {ValidationFailure}
 */
export function validationFailure(code, diagnostics = EMPTY_LIST, details) {
  const result = {
    ok: false,
    code,
    diagnostics: Object.freeze([...diagnostics]),
  };
  if (details !== undefined) {
    result.details = freezeDeep(cloneValue(details));
  }
  return Object.freeze(result);
}

/**
 * @param {number} revision
 * @param {readonly import("./events.js").DomainEvent[]} [events]
 * @param {readonly import("./events.js").EffectRequest[]} [effects]
 * @param {readonly import("./diagnostic.js").Diagnostic[]} [diagnostics]
 * @returns {CommandSuccess}
 */
export function commandSuccess(
  revision,
  events = EMPTY_LIST,
  effects = EMPTY_LIST,
  diagnostics = EMPTY_LIST,
) {
  return Object.freeze({
    ok: true,
    revision,
    events: Object.freeze([...events]),
    effects: Object.freeze([...effects]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

/**
 * A rejected command always carries empty event/effect collections. This makes full rejection
 * observable without consulting an adapter queue.
 *
 * @param {number} revision
 * @param {string} code
 * @param {readonly import("./diagnostic.js").Diagnostic[]} [diagnostics]
 * @returns {CommandFailure}
 */
export function commandFailure(revision, code, diagnostics = EMPTY_LIST) {
  return Object.freeze({
    ok: false,
    revision,
    code,
    diagnostics: Object.freeze([...diagnostics]),
    events: EMPTY_LIST,
    effects: EMPTY_LIST,
  });
}
