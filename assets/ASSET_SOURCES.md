# 에셋 출처 및 라이선스

대회 제출용 AI 활용 기술 문서와 저작권 확인에 사용할 기록입니다. 외부 에셋을 추가할 때마다 이 문서를 함께 갱신합니다.

## 팀원 제작 에셋 배치 (2026-08-01 추가, 출처 확인 대기)

팀원이 만들어온 원본 8장(`~/Desktop/게임에셋/`)을 개별 타일/스프라이트/아이콘으로 잘라 `assets/`에 분류해 넣었다. 자른 목록과 매핑은 `assets/friend-asset-manifest.json`에 있다.

| 폴더 | 내용 | 개수 | 원본 파일 |
|---|---|---:|---|
| `assets/tiles/tileset/` | 나무/석재 바닥·벽·문·창문·벽난로·계단 (8×8 그리드, `tile_r{행}_c{열}`) | 64 | `581d4c7f30689f57.png` |
| `assets/tiles/furniture/` | 테이블·의자·카운터·조리대·화로·솥·게시판·선반·통·상자·자루·촛대·러그·식기 | 24 | `d6de3f6aecbc9ed9.png` |
| `assets/icons/dishes/` | 완성 요리 6종 | 6 | `2ec872ad24383013.png` |
| `assets/icons/ingredients/` | 고기·채소·버섯·허브·열매·광물 16종 | 16 | `Codex_..._08_51_25.png` |
| `assets/ui/` | 버튼 패널·게이지·테두리·체크/X 아이콘 | 14 | `Codex_..._08_51_10.png` |
| `assets/sprites/player_ai/` | 주인장 후보 4방향 걷기(각 4프레임) | 16 | `Codex_..._08_51_19.png` |
| `assets/sprites/guests_ai/rogue,knight,ranger,dwarf` | 손님 후보 4종(로그/기사/레인저/드워프) 4방향 정지 포즈 — 실제 `data/guests.json` 6종과 이름이 안 맞아 미사용 후보로 남겨둠 | 16 | `Codex_..._08_51_22.png` |

## 손님 6종 걷기 스프라이트 — `assets/sprites/guests_v2/` (2026-08-02, 확정)

`data/guests.json`이 정의한 손님 6종(`guest.human_adventurer`, `guest.dwarf_courier`, `guest.goblin_scholar`, `guest.slime_gourmand`, `guest.kobold_porter`, `guest.mushroom_traveler`) 이름에 정확히 맞춘 걷기 애니메이션 시트. 팀원이 직접 만들어 저장소에 놓았고(2026-08-02), 사용해도 된다고 확인받았다. **직접 손으로 크롭한 배치 2(`guests_ai/{archetype}/`)는 이 세트로 완전히 대체돼 삭제했다** — `guests_v2`가 이미 배경 투명 처리·1256×1256을 314×314씩 정확히 나눈 4×4 격자·`DOWN,LEFT,RIGHT,UP` 행 순서까지 다 되어 있어서 품질이 더 좋다.

| 파일 | 대응 archetype | 원본 정보 |
|---|---|---|
| `assets/sprites/guests_v2/human_adventurer_walk.png` | `guest.human_adventurer` (HUMAN) | 1256×1256, 4×4, frame 314×314 |
| `assets/sprites/guests_v2/dwarf_courier_walk.png` | `guest.dwarf_courier` (FRIENDLY_NON_HUMAN) | 〃 |
| `assets/sprites/guests_v2/goblin_scholar_walk.png` | `guest.goblin_scholar` (FRIENDLY_NON_HUMAN) | 〃 |
| `assets/sprites/guests_v2/slime_gourmand_walk.png` | `guest.slime_gourmand` (FRIENDLY_MONSTER) | 〃 |
| `assets/sprites/guests_v2/kobold_porter_walk.png` | `guest.kobold_porter` (FRIENDLY_NON_HUMAN) | 〃 |
| `assets/sprites/guests_v2/mushroom_traveler_walk.png` | `guest.mushroom_traveler` (FRIENDLY_NON_HUMAN) | 〃 |

격자·매핑 정의는 `assets/sprites/guests_v2/guest-sprites-v2.json`, 제작 메모는 `assets/sprites/guests_v2/README.md`에 있다. README에는 **"Generated with OpenAI built-in ImageGen on 2026-08-01"** 이라고 명시돼 있다 — 대회 제출용 AI 활용 공개 문서에 이 문구를 그대로 쓸 수 있다(단, 배치 1·3의 `Codex_...` 원본들도 같은 도구인지는 아직 별도 확인 필요).

이걸로 Requirement 34 AC1~2(최소 6종, 인간 1+·비인간/몬스터 3+)를 이름·종류 모두 만족한다.

## 팀원 제작 에셋 배치 3 (2026-08-02 추가) — 마지막 재료 아이콘 2종

`data/ingredients.json`의 `ingredient.griffin_egg`(표시 이름 "화염 도마뱀 고기", 고기류·매운맛)와 `ingredient.mimic_bean`(표시 이름 "산성 열매", 과일류·신맛)에 맞춰 받았다. 두 ID 모두 내부 코드명일 뿐 실제 표시 이름은 다르다는 점을 확인하고 요청했다.

| 파일 | 대응 ingredientId |
|---|---|
| `assets/icons/ingredients/ing-meat-fire-lizard.png` | `ingredient.griffin_egg` (화염 도마뱀 고기) |
| `assets/icons/ingredients/ing-fruit-acid.png` | `ingredient.mimic_bean` (산성 열매) |

이걸로 `data/ingredients.json` 10종 전부 대응하는 아이콘이 생겼다.

**남은 것 (에셋 내용 자체는 이제 완결, 아래는 여전히 결정/정리 작업):**
- **`Codex_..._08_51_*.png`, `2ec872ad...`, `581d4c7f...`, `d6de3f7a...` (배치 1·3 원본)의 생성 도구가 `guests_v2`와 같은 "OpenAI built-in ImageGen"인지 확인 필요.** `guests_v2/README.md`에 도구가 명시돼 있으니 같은 팀원이 같은 방식으로 만들었는지만 한 번 더 확인하면 배치 1·3도 출처 문서화가 끝난다.
- **아래 "확정한 기본 에셋 계열"(Kenney CC0 팩)과 계획이 겹친다.** 팀원 에셋을 실제로 쓸지 Kenney CC0를 기본으로 쓸지 아직 확정 안 됐다 — Task 32(PixiJS 렌더러) 통합 전에 하나로 정해야 한다.
- **정확한 격자로 안 잘려 있다(배치 1·3만 해당).** 원본이 AI가 만든 "레퍼런스 시트"라 칸 크기가 조금씩 들쭉날쭉해서, 자동 슬라이싱(윤곽 검출)으로 개별 파일마다 크기가 조금씩 다르다. `guests_v2`는 이미 정확한 314×314 격자라 해당 없음. 실제 32px 타일/64px 스프라이트로 맞추는 리사이즈는 Task 32에서 렌더러를 붙일 때 처리한다.
- **손님(`guests_v2`)·주인장(`player_ai`) 스프라이트가 9열(idle+걷기 8프레임) 계약이 아니라 4열(걷기 4프레임)이다.** idle을 frame 0 재사용으로 처리하거나 팀원에게 정지 프레임을 추가로 받아야 한다.
- **요리 6장과 실제 recipe ID(slime_stew 등) 매칭이 아직 안 됐다.**
- 마젠타 배경으로 받은 원본(배치 1·3)은 크로마키로 제거했지만 확대해 보면 아주 옅은 색 번짐이 한 겹 남아 있다 — 실사용 해상도(64px 이하)에서는 거의 안 보이는 수준이라 지금은 놔뒀다. `guests_v2`는 이미 깨끗하게 처리돼 있어 해당 없음.

## VFX·HUD 아이콘 — `assets/vfx/`, `assets/icons/hud/` (2026-08-02, 확정)

Kenney Particle Pack·Game Icons가 픽셀아트 톤과 안 맞아서(부드러운 블러 글로우, 흰색 벡터 실루엣) 대신 팀원이 같은 파이프라인으로 새로 그려줬다. 격자·프레임 정의는 `assets/feedback-assets.json`에 있다.

| 파일 | 용도 | 형식 |
|---|---|---|
| `assets/vfx/vfx-sale-success.png` | 판매 성공 반짝임 | 768×512, 3×2, frame 256×256, 6프레임, 12fps |
| `assets/vfx/vfx-cooking-success.png` | 조리 성공 김/반짝임 | 〃, 10fps |
| `assets/vfx/vfx-cooking-waste.png` | 조리 실패(Waste) 연기 | 〃, 10fps |
| `assets/vfx/vfx-order-failure.png` | 품절/시간초과 실망 표시 | 〃, 12fps |
| `assets/icons/hud/hud-gold.png` | 골드 아이콘 | 167×176 |
| `assets/icons/hud/hud-reputation.png` | 평판 아이콘(별+하트) | 176×168 |
| `assets/icons/hud/hud-timer.png` | 시간 아이콘(모래시계) | 118×176 |
| `assets/icons/hud/world-interaction-marker.png` | 상호작용 힌트 마커 | 101×176 |

전부 실제 투명 배경(코너 alpha=0)으로 이미 처리돼 있어 추가 크로마키 작업이 필요 없다.

## 확정한 기본 에셋 계열

| 용도 | 에셋 팩 | 제작자 | 라이선스 | 공식 주소 | 적용 상태 |
|---|---|---|---|---|---|
| 방·바닥·벽·가구·기본 아이콘 | Roguelike/RPG Pack | Kenney | CC0 1.0 | https://kenney.nl/assets/roguelike-rpg-pack | 사용 대상으로 확정 |
| 플레이어·모험가·손님 캐릭터 | Roguelike Characters | Kenney | CC0 1.0 | https://kenney.nl/assets/roguelike-characters | 보완 팩으로 확정 |
| 버튼·패널·게이지 | UI Pack (RPG Expansion) | Kenney | CC0 1.0 | https://kenney.nl/assets/ui-pack-rpg-expansion | 보완 팩으로 확정 |

세 팩 모두 Kenney 공식 배포 페이지에서 Creative Commons CC0로 표시되어 있다. CC0는 출처 표기를 의무화하지 않지만, 대회 제출 문서의 투명성을 위해 제작자와 주소를 기록한다.

## 폴더 정리 규칙

```text
assets/
├─ sprites/      # 플레이어·모험가·손님
├─ tiles/        # 바닥·벽·가구·게시판·조리대·카운터
├─ icons/        # 재료·요리·상태 아이콘
├─ ui/           # 버튼·패널·게이지
└─ ASSET_SOURCES.md
```

- 원본 파일 이름을 무작정 바꾸지 않는다.
- 게임에 실제 사용하는 파일만 저장소에 복사한다.
- 16×16 에셋은 정수 배율로 확대한다.
- 다른 출처의 에셋을 추가할 경우 제작자, 원본 URL, 라이선스, 수정 여부를 표에 추가한다.

## 필요한 에셋 체크리스트

### 방과 가구

- [x] 나무 또는 석재 바닥 타일 — `assets/tiles/tileset/`
- [x] 벽·모서리 타일 — `assets/tiles/tileset/`
- [x] 길드 게시판 — `assets/tiles/furniture/furniture-board.png`
- [x] 조리대·냄비·화로 — `furniture-stove.png`, `furniture-cauldron.png`, `furniture-prep-table.png`
- [x] 카운터·테이블·의자 — `furniture-counter.png`, `furniture-table.png`, `furniture-chair-*.png`
- [x] 문·상자·촛불 장식 — 타일셋 문/난로, `furniture-crate.png`, `furniture-chandelier.png`

### 캐릭터

- [~] 플레이어 걷기 스프라이트 — `assets/sprites/player_ai/`에 4방향×4프레임 있으나 9열(idle+8프레임) 포맷·행 순서(UP/LEFT/DOWN/RIGHT) 재정리 필요
- [ ] 모험가 루카
- [x] 손님 유형 3종 이상 — `assets/sprites/guests_v2/`에 `data/guests.json` 6종 전부 4방향 걷기 애니메이션으로 있음 (인간 1, 비인간/몬스터 5)

### 재료와 요리 아이콘

- [x] 육류 — `assets/icons/ingredients/ing-meat-*.png`, `ing-sausage.png`
- [x] 채소·버섯 — `ing-carrot.png`, `ing-cabbage.png`, `ing-mushroom-*.png`
- [x] 약초·열매 — `ing-herb-*.png`, `ing-berry-*.png`
- [x] 광물·수정 — `ing-ore-stone.png`, `ing-crystal-*.png`, `ing-geode-purple.png`
- [x] 완성 요리 — `assets/icons/dishes/`

### UI

- [x] 기본 버튼/패널 — `assets/ui/ui-panel-wood-*.png`, `ui-panel-dark-*.png`
- [x] 정보 패널 — `ui-panel-dark-large.png`
- [x] 인내심 게이지 — `ui-bar-*.png`
- [x] 일반·고급·희귀 등급 테두리 — `ui-frame-silver/gold/purple.png`
- [x] 성공·실패 상태 아이콘 — `ui-icon-check.png`, `ui-icon-cross.png`

## 기존 파일 확인 필요

`assets/sprites/player_walk.png`는 코드에서 LPC 워크사이클 스프라이트로 설명되어 있으나 저장소 안에 원출처와 라이선스 기록이 없다. 최종 제출 전 제작자·생성 도구·라이선스를 확인해 이 문서에 추가하거나, 위의 CC0 Kenney 캐릭터 에셋으로 교체해야 한다.
