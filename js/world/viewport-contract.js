/**
 * Task 35 — production 쪽(InputTransform/Camera viewport 등)이 필요로 하는 480×480 logical
 * canvas 크기. `js/ui/canvas-scene.js`(raw Canvas2D/L0 QA fixture, `js/qa/raw-canvas-fixture.js`
 * 전용)에서 더 이상 가져오지 않기 위해 분리했다 — production 진입점이 raw Canvas/L0 파일을
 * import하면 안 된다.
 */
export const CANVAS_LOGICAL_SIZE = Object.freeze({ width: 480, height: 480 });
