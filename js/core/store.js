import { cloneValue, freezeDeep } from "./result.js";

const DEFAULT_PROCESSED_COMMAND_CAPACITY = 65_536;

export class StoreCommitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreCommitError";
    this.code = code;
  }
}

function assertRootState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("GameStore root state는 object여야 합니다.");
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new TypeError("state.revision은 0 이상의 safe integer여야 합니다.");
  }
  if (!Number.isSafeInteger(state.generationId) || state.generationId < 0) {
    throw new TypeError("state.generationId는 0 이상의 safe integer여야 합니다.");
  }
  if (typeof state.runtimePhase !== "string" || state.runtimePhase.trim() === "") {
    throw new TypeError("state.runtimePhase는 비어 있지 않은 문자열이어야 합니다.");
  }
}

/**
 * Revisioned immutable root state store.
 *
 * `commit` performs exactly one root pointer replacement. Candidate state must retain the current
 * revision; only GameStore assigns the next revision. Processed command IDs are committed in the
 * same synchronous boundary and can be restored through constructor metadata by a future save
 * adapter.
 */
export class GameStore {
  constructor(initialState, {
    processedCommandIds = [],
    processedCommandCapacity = DEFAULT_PROCESSED_COMMAND_CAPACITY,
  } = {}) {
    assertRootState(initialState);
    if (!Number.isSafeInteger(processedCommandCapacity) || processedCommandCapacity < 1) {
      throw new TypeError("processedCommandCapacity는 1 이상의 safe integer여야 합니다.");
    }

    this._snapshot = freezeDeep(cloneValue(initialState));
    this._processedCommandCapacity = processedCommandCapacity;
    this._processedCommandIds = new Set(processedCommandIds);
    if (this._processedCommandIds.size > processedCommandCapacity) {
      throw new TypeError("초기 processed command ID가 capacity를 초과했습니다.");
    }
    this._commitCount = 0;
  }

  getSnapshot() {
    return this._snapshot;
  }

  get revision() {
    return this._snapshot.revision;
  }

  get generationId() {
    return this._snapshot.generationId;
  }

  get runtimePhase() {
    return this._snapshot.runtimePhase;
  }

  get commitCount() {
    return this._commitCount;
  }

  hasProcessedCommand(commandId) {
    return this._processedCommandIds.has(commandId);
  }

  canCommitCommand(commandId) {
    if (this.hasProcessedCommand(commandId)) {
      return Object.freeze({ ok: false, code: "DUPLICATE_COMMAND" });
    }
    if (this._processedCommandIds.size >= this._processedCommandCapacity) {
      return Object.freeze({ ok: false, code: "PROCESSED_COMMAND_CAPACITY_EXCEEDED" });
    }
    return Object.freeze({ ok: true });
  }

  getCommandMetadata() {
    return Object.freeze({
      processedCommandIds: Object.freeze([...this._processedCommandIds]),
      processedCommandCapacity: this._processedCommandCapacity,
    });
  }

  /**
   * @param {Readonly<object>} candidateState
   * @param {{commandId: string, expectedRevision: number}} command
   * @returns {Readonly<object>}
   */
  commit(candidateState, command) {
    if (command.expectedRevision !== this.revision) {
      throw new StoreCommitError("STALE_REVISION", "commit 직전에 revision이 변경되었습니다.");
    }

    const commandCapacity = this.canCommitCommand(command.commandId);
    if (!commandCapacity.ok) {
      throw new StoreCommitError(commandCapacity.code, "command ID를 commit할 수 없습니다.");
    }

    assertRootState(candidateState);
    if (candidateState.revision !== this.revision) {
      throw new StoreCommitError(
        "REVISION_WRITE_FORBIDDEN",
        "transaction candidate가 revision을 직접 변경했습니다.",
      );
    }

    const nextRevision = this.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new StoreCommitError("REVISION_OVERFLOW", "revision safe integer 범위를 초과했습니다.");
    }

    const committedSnapshot = freezeDeep({ ...candidateState, revision: nextRevision });

    // No user callback runs inside this boundary. Set.add cannot invoke domain code.
    this._snapshot = committedSnapshot;
    this._processedCommandIds.add(command.commandId);
    this._commitCount += 1;
    return committedSnapshot;
  }
}
