# Canonical content data

이 디렉터리의 runtime 콘텐츠는 `content-manifest.json`이 선언하는 version 1 계약을 따릅니다. ID와 한국어 표시 문자열을 분리하며, loader/validator는 type·범위·참조·불변식을 자동 보정 없이 검사합니다.

- `ingredients.json`: 재료 10종, 시장 기준가·수량 범위·0..100 Quality 분포
- `recipes.json`: Recipe 6종, 시작 Recipe 2종, 복수 재료·가격·Timing·해금
- `upgrades.json`: kitchen/hall/storage Must stage 각 1개
- `guests.json`: Guest archetype 6종과 Recipe 선호 가중치
- `events.json`: Day 1 고정 소개 사건과 Day 2..14 Must 사건 pool
- `dialogue.json`: 주인장/손님용 짧은 canonical 대사
- `balance.json`: 캠페인·경제·Service·계약·World 고정 상수
- `content-manifest.json`: 필수 파일·schema·content version 목록

검증은 `node tools/validate-data.mjs`, 재현 가능한 migration 확인은 `node tools/migrate-canonical-data.mjs --check`로 실행합니다. Legacy의 `예:` 값, 빈 문자열, 0..1 ratio는 canonical 값으로 추정하거나 coercion하지 않습니다. Migration 근거와 전후 ID mapping은 `reports/canonical-data-migration.json`에 보존됩니다.
