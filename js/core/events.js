import { cloneValue, freezeDeep } from "./result.js";

/**
 * @typedef {object} DomainEvent
 * @property {string} eventId
 * @property {string | null} causeId
 * @property {number} revision
 * @property {number} simulationTimeMs
 * @property {string} commandId
 * @property {string} type
 * @property {Readonly<unknown>} payload
 */

/**
 * @typedef {object} EffectRequest
 * @property {string} effectId
 * @property {string | null} sourceEventId
 * @property {number} revision
 * @property {string} commandId
 * @property {string} type
 * @property {Readonly<unknown>} payload
 */

function requireDescriptorList(value, kind) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${kind} factory는 배열을 반환해야 합니다.`);
  }
  return value;
}

function normalizeDescriptor(descriptor, kind, index) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new TypeError(`${kind}[${index}]는 object여야 합니다.`);
  }
  if (typeof descriptor.type !== "string" || descriptor.type.trim() === "") {
    throw new TypeError(`${kind}[${index}].type은 비어 있지 않은 문자열이어야 합니다.`);
  }
  if (!("payload" in descriptor)) {
    throw new TypeError(`${kind}[${index}].payload가 필요합니다.`);
  }
  return freezeDeep(cloneValue(descriptor));
}

/**
 * Commit 전에 event 계획의 구조만 검증한다. 반환 객체는 아직 committed event가 아니다.
 *
 * @param {unknown} descriptors
 * @returns {readonly object[]}
 */
export function normalizeEventDescriptors(descriptors) {
  return Object.freeze(
    requireDescriptorList(descriptors, "event").map((descriptor, index) =>
      normalizeDescriptor(descriptor, "event", index),
    ),
  );
}

/**
 * @param {unknown} descriptors
 * @returns {readonly object[]}
 */
export function normalizeEffectDescriptors(descriptors) {
  return Object.freeze(
    requireDescriptorList(descriptors, "effect").map((descriptor, index) =>
      normalizeDescriptor(descriptor, "effect", index),
    ),
  );
}

/**
 * @param {readonly object[]} descriptors
 * @param {{commandId: string, causeId?: string, issuedAtSimulationMs: number}} command
 * @param {number} revision
 * @returns {readonly DomainEvent[]}
 */
export function createCommittedEvents(descriptors, command, revision) {
  return Object.freeze(
    descriptors.map((descriptor, index) =>
      freezeDeep({
        eventId: descriptor.eventId ?? `${command.commandId}:event:${index}`,
        causeId: descriptor.causeId ?? command.causeId ?? null,
        revision,
        simulationTimeMs: command.issuedAtSimulationMs,
        commandId: command.commandId,
        type: descriptor.type,
        payload: cloneValue(descriptor.payload),
      }),
    ),
  );
}

/**
 * @param {readonly object[]} descriptors
 * @param {{commandId: string}} command
 * @param {number} revision
 * @param {readonly DomainEvent[]} events
 * @returns {readonly EffectRequest[]}
 */
export function createEffectRequests(descriptors, command, revision, events) {
  return Object.freeze(
    descriptors.map((descriptor, index) => {
      const sourceEventId = Number.isInteger(descriptor.sourceEventIndex)
        ? events[descriptor.sourceEventIndex]?.eventId ?? null
        : descriptor.sourceEventId ?? null;
      return freezeDeep({
        effectId: descriptor.effectId ?? `${command.commandId}:effect:${index}`,
        sourceEventId,
        revision,
        commandId: command.commandId,
        type: descriptor.type,
        payload: cloneValue(descriptor.payload),
      });
    }),
  );
}

/**
 * 성공 commit 뒤 생성된 신호만 보관하는 session journal이다. 거절된 command는 append할 수 없다.
 */
export class EventEffectJournal {
  constructor() {
    this._events = [];
    this._effects = [];
    this._diagnostics = [];
  }

  /**
   * @param {readonly DomainEvent[]} events
   * @param {readonly EffectRequest[]} effects
   */
  appendCommitted(events, effects) {
    this._events.push(...events);
    this._effects.push(...effects);
  }

  /** @param {readonly import("./diagnostic.js").Diagnostic[]} diagnostics */
  appendDiagnostics(diagnostics) {
    this._diagnostics.push(...diagnostics);
  }

  snapshot() {
    return Object.freeze({
      events: Object.freeze([...this._events]),
      effects: Object.freeze([...this._effects]),
      diagnostics: Object.freeze([...this._diagnostics]),
    });
  }
}
