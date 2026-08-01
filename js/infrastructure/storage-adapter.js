import { createSaveEnvelope, readSaveEnvelope } from "./save-system.js";

export const SAVE_STORAGE_KEYS = Object.freeze({
  CURRENT: "dungeonRestaurant.save.current",
  PREVIOUS: "dungeonRestaurant.save.previous",
  TEMP: "dungeonRestaurant.save.temp",
  AUDIO_SETTINGS: "dungeonRestaurant.settings.audio.v1",
});

const MESSAGE_BY_CODE = Object.freeze({
  STORAGE_WRITE_FAILED: "저장소 쓰기(quota 등)에 실패했습니다.",
  STORAGE_ABSENT: "저장된 데이터가 없습니다.",
});

function failure(code, details = undefined) {
  return Object.freeze({ ok: false, code, message: MESSAGE_BY_CODE[code] ?? code, ...(details ? { details } : {}) });
}

function success(value) {
  return Object.freeze({ ok: true, ...value });
}

/**
 * Task 28 — localStorage(또는 동일 인터페이스의 주입된 backend)를 감싸 current/previous/temp
 * 3-key 회전 프로토콜과 손상 raw 보존을 구현한다. 물리 write는 여기서만 일어난다.
 */
export class StorageAdapter {
  constructor({ storage }) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" ||
        typeof storage.removeItem !== "function") {
      throw new TypeError("StorageAdapter에는 getItem/setItem/removeItem을 갖춘 storage가 필요합니다.");
    }
    this.storage = storage;
  }

  _rawGet(key) {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  _rawSet(key, value) {
    try {
      this.storage.setItem(key, value);
      return success({});
    } catch (error) {
      return failure("STORAGE_WRITE_FAILED", { key, error: error instanceof Error ? error.message : String(error) });
    }
  }

  _rawRemove(key) {
    try {
      this.storage.removeItem(key);
    } catch {
      // best-effort: temp 삭제 실패는 다음 저장에서 덮어써지므로 치명적이지 않다.
    }
  }

  /** raw 문자열을 그대로 보존한 채 parse/hash/schema까지 검증한다. 손상이면 raw를 함께 돌려준다. */
  async readSlot(key) {
    const raw = this._rawGet(key);
    if (raw === null) return failure("STORAGE_ABSENT", { key });
    const read = await readSaveEnvelope(raw);
    if (!read.ok) return failure(read.code, { key, raw, ...(read.details ?? {}) });
    return success({ key, raw, envelope: read.envelope, payload: read.payload });
  }

  readCurrent() {
    return this.readSlot(SAVE_STORAGE_KEYS.CURRENT);
  }

  readPrevious() {
    return this.readSlot(SAVE_STORAGE_KEYS.PREVIOUS);
  }

  /**
   * design 7.6의 저장 순서 3~6단계: 기존 valid current를 previous로 복사→read-back, temp에
   * 쓰고 read-back, temp raw를 current로 승격→read-back, 성공 후 temp 삭제. 중간 실패 시
   * 이미 있던 valid current/previous raw를 절대 덮어쓰지 않는다.
   */
  async writeCurrentWithRotation(snapshot) {
    const created = await createSaveEnvelope(snapshot);
    if (!created.ok) return created;
    const nextRaw = JSON.stringify(created.envelope);

    const existingCurrent = await this.readSlot(SAVE_STORAGE_KEYS.CURRENT);
    if (existingCurrent.ok) {
      const previousWrite = this._rawSet(SAVE_STORAGE_KEYS.PREVIOUS, existingCurrent.raw);
      if (!previousWrite.ok) return previousWrite;
      const previousReadback = await this.readSlot(SAVE_STORAGE_KEYS.PREVIOUS);
      if (!previousReadback.ok || previousReadback.raw !== existingCurrent.raw) {
        return failure("STORAGE_WRITE_FAILED", { key: SAVE_STORAGE_KEYS.PREVIOUS, stage: "previous-readback" });
      }
    }

    const tempWrite = this._rawSet(SAVE_STORAGE_KEYS.TEMP, nextRaw);
    if (!tempWrite.ok) return tempWrite;
    const tempReadback = await this.readSlot(SAVE_STORAGE_KEYS.TEMP);
    if (!tempReadback.ok || tempReadback.raw !== nextRaw) {
      return failure("STORAGE_WRITE_FAILED", { key: SAVE_STORAGE_KEYS.TEMP, stage: "temp-readback" });
    }

    const currentWrite = this._rawSet(SAVE_STORAGE_KEYS.CURRENT, tempReadback.raw);
    if (!currentWrite.ok) return currentWrite;
    const currentReadback = await this.readSlot(SAVE_STORAGE_KEYS.CURRENT);
    if (!currentReadback.ok || currentReadback.raw !== nextRaw) {
      return failure("STORAGE_WRITE_FAILED", { key: SAVE_STORAGE_KEYS.CURRENT, stage: "current-readback" });
    }

    this._rawRemove(SAVE_STORAGE_KEYS.TEMP);
    return success({ envelope: created.envelope, payload: created.payload });
  }

  /** current가 손상됐을 때 valid previous를 current로 승격한다(같은 read-back 보장). */
  async recoverFromPrevious() {
    const previous = await this.readSlot(SAVE_STORAGE_KEYS.PREVIOUS);
    if (!previous.ok) return previous;
    const write = this._rawSet(SAVE_STORAGE_KEYS.CURRENT, previous.raw);
    if (!write.ok) return write;
    const readback = await this.readSlot(SAVE_STORAGE_KEYS.CURRENT);
    if (!readback.ok || readback.raw !== previous.raw) {
      return failure("STORAGE_WRITE_FAILED", { key: SAVE_STORAGE_KEYS.CURRENT, stage: "recovery-readback" });
    }
    return success({ envelope: readback.envelope, payload: readback.payload, recoveredFrom: "previous" });
  }

  /** current/previous 둘 다 손상됐을 때 표시용으로 두 raw를 함께 보존한다. */
  async diagnoseCorruption() {
    const current = await this.readSlot(SAVE_STORAGE_KEYS.CURRENT);
    const previous = await this.readSlot(SAVE_STORAGE_KEYS.PREVIOUS);
    return Object.freeze({
      current: current.ok ? { ok: true } : { ok: false, code: current.code, raw: current.details?.raw ?? null },
      previous: previous.ok ? { ok: true } : { ok: false, code: previous.code, raw: previous.details?.raw ?? null },
    });
  }
}

/** Node/브라우저 어디서든 쓸 수 있는 in-memory storage — 테스트와, localStorage 부재 환경 fallback. */
export class InMemoryStorage {
  constructor() {
    this._map = new Map();
  }

  getItem(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  }

  setItem(key, value) {
    this._map.set(key, String(value));
  }

  removeItem(key) {
    this._map.delete(key);
  }
}
