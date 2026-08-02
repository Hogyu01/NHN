/**
 * Task 32 — design.md 10.2/11.1. 순수 frame-index 계산만 한다: PixiJS Ticker delta, RAF
 * timestamp, wall-clock, renderer frame count을 전혀 읽지 않고 snapshot의 `simulationTimeMs`/
 * `animationElapsedMs`, `direction`, `moving`만 입력으로 받는다. row 순서는 시트마다 다를 수
 * 있어(주인장 UP/LEFT/DOWN/RIGHT, 손님 DOWN/LEFT/RIGHT/UP) `directionRowOrder`로 넘겨받는다.
 */

export const WALK_FRAME_CADENCE_MS = 120;

/** direction(대문자/소문자 무관) → row index. directionRowOrder에 없으면 0으로 방어한다. */
export function resolveDirectionRow(directionRowOrder, direction) {
  const normalized = typeof direction === "string" ? direction.toUpperCase() : "DOWN";
  const index = directionRowOrder.findIndex((entry) => entry.toUpperCase() === normalized);
  return index >= 0 ? index : 0;
}

/**
 * idle이 있는 9열 시트(idleColumn 0, walkColumns 1..8)용. moving=false면 idleColumn을,
 * moving=true면 animationElapsedMs를 120ms cadence로 나눠 8프레임을 순환한다.
 */
export function resolveWalkColumnWithIdle({ moving, animationElapsedMs, idleColumn = 0, walkColumnCount = 8 }) {
  if (!moving) return idleColumn;
  const elapsedFrames = Math.floor(Math.max(0, animationElapsedMs) / WALK_FRAME_CADENCE_MS);
  return idleColumn + 1 + (elapsedFrames % walkColumnCount);
}

/**
 * idle 프레임이 따로 없는 4열 걷기 시트(손님 guests_v2)용. moving=false면 frame 0을 그대로
 * idle로 재사용하고, moving=true면 4프레임을 120ms cadence로 순환한다.
 */
export function resolveWalkColumnNoIdle({ moving, animationElapsedMs, frameCount = 4 }) {
  if (!moving) return 0;
  const elapsedFrames = Math.floor(Math.max(0, animationElapsedMs) / WALK_FRAME_CADENCE_MS);
  return elapsedFrames % frameCount;
}

/**
 * sheet 메타(frameWidth/frameHeight/directionRowOrder/hasIdleColumn/walkColumnCount)와
 * entity 상태(direction/moving/animationElapsedMs)로부터 texture rect(x,y,width,height)를
 * 계산하는 순수 함수. PixiWorldRenderer가 이 rect로 PIXI.Rectangle을 만들어 텍스처를 자른다.
 */
export function resolveSpriteFrameRect(sheet, entity) {
  const row = resolveDirectionRow(sheet.directionRowOrder, entity.direction);
  const column = sheet.hasIdleColumn
    ? resolveWalkColumnWithIdle({
      moving: entity.moving,
      animationElapsedMs: entity.animationElapsedMs,
      idleColumn: sheet.idleColumn ?? 0,
      walkColumnCount: sheet.walkColumnCount ?? 8,
    })
    : resolveWalkColumnNoIdle({
      moving: entity.moving,
      animationElapsedMs: entity.animationElapsedMs,
      frameCount: sheet.walkColumnCount ?? 4,
    });
  return Object.freeze({
    x: column * sheet.frameWidth,
    y: row * sheet.frameHeight,
    width: sheet.frameWidth,
    height: sheet.frameHeight,
  });
}
