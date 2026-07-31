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

## Task 18 runtime 계약

`ReputationSystem`만 `campaign.reputation`을 변경하며 값은 정수 `0..100`으로 clamp되고 처리한 `Cause_Id`는 캠페인에 보존됩니다. 평판 threshold는 `previous < threshold && next >= threshold`인 실제 crossing에서만 한 번 자격화되고, Recipe·facility는 `crossedDay + 1` 이후 첫 Planning의 `UnlockPublisher` 원자 transaction에서 게시됩니다. 새 캠페인의 pending/published unlock은 항상 비어 있습니다.

`EventSystem`은 Day 1에 `FIXED_DAY_1` 사건 하나를 RNG draw 없이 적용하고, Day 2..14에는 전용 `event` stream으로 `RANDOM_DAY_2_14` pool에서 하루 정확히 하나를 선택합니다. day 초기화는 이전 active modifier를 누적하지 않고 새 modifier로 원자 교체하며, campaign day와 event 생성 day가 다르면 projection은 zero modifier를 반환합니다.

Task 18의 동적 invariant/property sweep과 정적 composition 감사는 `node tools/validate-reputation-events.mjs`로 실행합니다. 이 validator는 평판 경계·중복 cause·threshold crossing·다음 Planning 게시·Day 1 고정 사건·14일 replay·RNG stream isolation·원자 거절을 함께 검사합니다.

## Task 19 runtime 계약

`FacilitySystem`은 canonical `upgrades.json`의 kitchen/hall/storage Must stage를 각각 정확히 하나만 승인합니다. 구매는 Planning에서만 가능한 단일 원자 transaction이며 Task 13 `CashTransactionAPI`를 통해 `FACILITY_INVESTMENT` ledger와 facility investment 기록을 함께 append합니다. 중복 구매, 미게시 unlock, Available Cash 부족, stale revision, 잘못된 phase/day/reference는 cash·ledger·facility·market·ID 및 event를 전혀 변경하지 않고 거절됩니다.

성공한 구매는 같은 날 즉시 반영됩니다. kitchen은 모든 Recipe의 success/normal timing window를 각각 120ms 늘리고, hall은 patience를 5,000ms 늘리며, storage는 `MarketSystem`이 실제 검사하는 purchase limit를 12 늘립니다. 구매 가능 여부는 Task 18이 threshold crossing 다음 Planning에 게시한 `progression.unlockedFacilityIds`를 기준으로 하며, 이 세 Must 효과는 비공간적이어서 authored Map definition/geometry를 변경하지 않습니다.

Task 19의 동적 example/Property 25 sweep과 정적 composition 감사는 `node tools/validate-facility.mjs`로 실행합니다. validator는 128개 generated sample, exact 효과, investment ledger 대사, 실제 Market 구매 한도, 다음 Planning unlock, 원자 거절 및 authored Map deep-equal을 함께 검사합니다.