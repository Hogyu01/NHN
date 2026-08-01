import { SAVE_FORMAT_VERSION } from "./save-system.js";

/**
 * Task 28 — vN→vN+1 순차 migration 함수 registry. 지금은 formatVersion 1 하나뿐이라 등록된
 * 함수가 없다: 새 formatVersion이 생기면 `migrations[oldVersion] = (payload) => nextPayload`
 * 형태로 이 자리에 추가한다. migrate 뒤에는 반드시 전체 validator를 다시 통과해야 temp로
 * 승격된다(save-system.js의 createSaveEnvelope/readSaveEnvelope가 그 검증을 맡는다).
 */
const MIGRATIONS = Object.freeze({});

export function migrateSavePayload(payload) {
  let current = payload;
  let version = current.formatVersion;
  const applied = [];
  while (version < SAVE_FORMAT_VERSION) {
    const migrate = MIGRATIONS[version];
    if (typeof migrate !== "function") {
      return Object.freeze({
        ok: false,
        code: "SAVE_MIGRATION_PATH_MISSING",
        message: `formatVersion ${version}에서 ${SAVE_FORMAT_VERSION}으로 가는 migration이 없습니다.`,
      });
    }
    current = migrate(current);
    applied.push(version);
    version = current.formatVersion;
  }
  return Object.freeze({ ok: true, payload: current, applied });
}
