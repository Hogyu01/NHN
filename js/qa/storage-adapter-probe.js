import { freezeDeep } from "../core/result.js";
import { InMemoryStorage, SAVE_STORAGE_KEYS, StorageAdapter } from "../infrastructure/storage-adapter.js";
import { buildFixtureSnapshot } from "./save-system-probe.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id, description, validates, status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runStorageAdapterProbe({ recipes, facilities, ingredients, balance }) {
  const results = [];
  const fixtureBase = { canonicalRecipes: recipes, canonicalFacilities: facilities, canonicalIngredients: ingredients, balance };

  results.push(await runCase(
    "write-then-readback-round-trip",
    "current에 쓴 뒤 read-back하면 같은 envelope/payload를 돌려준다",
    "Requirement 18.1~18.4",
    async () => {
      const adapter = new StorageAdapter({ storage: new InMemoryStorage() });
      const snapshot = buildFixtureSnapshot(fixtureBase);
      const written = await adapter.writeCurrentWithRotation(snapshot);
      assert(written.ok, `쓰기 실패: ${written.code}`);
      const read = await adapter.readCurrent();
      assert(read.ok, `read-back 실패: ${read.code}`);
      assert(read.payload.checkpointPhase === "PLANNING_READY", "checkpointPhase가 다릅니다.");
      return { payloadSha256: read.envelope.payloadSha256 };
    },
  ));

  results.push(await runCase(
    "second-write-rotates-previous-and-clears-temp",
    "두 번째 저장은 이전 current를 previous로 옮기고 temp를 남기지 않는다",
    "Requirement 18.1, 18.3",
    async () => {
      const storage = new InMemoryStorage();
      const adapter = new StorageAdapter({ storage });
      const first = await adapter.writeCurrentWithRotation(buildFixtureSnapshot(fixtureBase));
      assert(first.ok, "첫 저장 실패");
      const firstHash = first.envelope.payloadSha256;
      const second = await adapter.writeCurrentWithRotation(
        buildFixtureSnapshot({ ...fixtureBase, seed: 0x28 }),
      );
      assert(second.ok, "두 번째 저장 실패");
      const previous = await adapter.readPrevious();
      assert(previous.ok && previous.envelope.payloadSha256 === firstHash, "previous가 첫 저장으로 회전되지 않았습니다.");
      assert(storage.getItem(SAVE_STORAGE_KEYS.TEMP) === null, "temp가 삭제되지 않았습니다.");
      return { previousHash: previous.envelope.payloadSha256 };
    },
  ));

  results.push(await runCase(
    "corrupt-current-recovers-from-previous",
    "current raw가 손상되면 valid previous로 복구할 수 있다",
    "Requirement 18.9~18.11",
    async () => {
      const storage = new InMemoryStorage();
      const adapter = new StorageAdapter({ storage });
      await adapter.writeCurrentWithRotation(buildFixtureSnapshot(fixtureBase));
      await adapter.writeCurrentWithRotation(buildFixtureSnapshot({ ...fixtureBase, seed: 0x28 }));
      storage.setItem(SAVE_STORAGE_KEYS.CURRENT, "{not valid json");
      const corrupted = await adapter.readCurrent();
      assert(!corrupted.ok, "손상된 current가 그대로 통과했습니다.");
      assert(corrupted.details.raw === "{not valid json", "손상 raw가 보존되지 않았습니다.");
      const recovered = await adapter.recoverFromPrevious();
      assert(recovered.ok, `복구 실패: ${recovered.code}`);
      const readAfter = await adapter.readCurrent();
      assert(readAfter.ok, "복구 후 current를 읽지 못했습니다.");
      return { recoveredFrom: recovered.recoveredFrom };
    },
  ));

  results.push(await runCase(
    "both-corrupt-preserves-both-raw-strings",
    "current/previous 둘 다 손상이면 두 raw 문자열을 모두 보존한다",
    "Requirement 18.10~18.12",
    async () => {
      const storage = new InMemoryStorage();
      const adapter = new StorageAdapter({ storage });
      storage.setItem(SAVE_STORAGE_KEYS.CURRENT, "current-garbage");
      storage.setItem(SAVE_STORAGE_KEYS.PREVIOUS, "previous-garbage");
      const diagnosis = await adapter.diagnoseCorruption();
      assert(!diagnosis.current.ok && diagnosis.current.raw === "current-garbage", "current raw가 보존되지 않았습니다.");
      assert(!diagnosis.previous.ok && diagnosis.previous.raw === "previous-garbage", "previous raw가 보존되지 않았습니다.");
      return diagnosis;
    },
  ));

  results.push(await runCase(
    "write-failure-does-not-clobber-existing-valid-current",
    "temp 승격 단계에서 쓰기가 실패하면 기존 valid current를 그대로 유지한다",
    "Requirement 18.3, 18.4",
    async () => {
      const storage = new InMemoryStorage();
      const adapter = new StorageAdapter({ storage });
      const first = await adapter.writeCurrentWithRotation(buildFixtureSnapshot(fixtureBase));
      assert(first.ok, "첫 저장 실패");
      const originalRaw = storage.getItem(SAVE_STORAGE_KEYS.CURRENT);
      const realSetItem = storage.setItem.bind(storage);
      storage.setItem = (key, value) => {
        if (key === SAVE_STORAGE_KEYS.CURRENT) throw new Error("QUOTA_EXCEEDED");
        return realSetItem(key, value);
      };
      const second = await adapter.writeCurrentWithRotation(buildFixtureSnapshot({ ...fixtureBase, seed: 0x28 }));
      assert(!second.ok, "실패해야 할 쓰기가 성공했습니다.");
      assert(storage.getItem(SAVE_STORAGE_KEYS.CURRENT) === originalRaw, "실패 뒤 기존 valid current가 훼손됐습니다.");
      return { code: second.code };
    },
  ));

  results.push(await runCase(
    "clear-campaign-removes-save-slots-only",
    "새 게임은 current/previous/temp 저장만 지우고 별도 설정은 유지한다",
    "New campaign reset",
    async () => {
      const storage = new InMemoryStorage();
      const adapter = new StorageAdapter({ storage });
      storage.setItem(SAVE_STORAGE_KEYS.CURRENT, "current");
      storage.setItem(SAVE_STORAGE_KEYS.PREVIOUS, "previous");
      storage.setItem(SAVE_STORAGE_KEYS.TEMP, "temp");
      storage.setItem(SAVE_STORAGE_KEYS.AUDIO_SETTINGS, "audio");
      const cleared = adapter.clearCampaign();
      assert(cleared.ok, `저장 삭제 실패: ${cleared.code}`);
      assert(storage.getItem(SAVE_STORAGE_KEYS.CURRENT) === null, "current가 남았습니다.");
      assert(storage.getItem(SAVE_STORAGE_KEYS.PREVIOUS) === null, "previous가 남았습니다.");
      assert(storage.getItem(SAVE_STORAGE_KEYS.TEMP) === null, "temp가 남았습니다.");
      assert(storage.getItem(SAVE_STORAGE_KEYS.AUDIO_SETTINGS) === "audio", "오디오 설정까지 삭제됐습니다.");
      return { clearedKeys: cleared.clearedKeys };
    },
  ));

  const passed = results.filter((result) => result.status === "PASS").length;
  return freezeDeep({
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    results,
  });
}
