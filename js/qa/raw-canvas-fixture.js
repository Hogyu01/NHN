/**
 * Task 32 — Requirement 35 AC18. Tasks 1~19 회귀 확인에 필요한 raw Canvas2D/L0 placeholder
 * 경로를 production bootstrap과 public asset registry에서 분리된 QA 전용 진입점으로 옮긴다.
 * production은 `js/render/pixi-scene-adapter.js`(PixiWorldRenderer)만 쓴다 — 이 파일은
 * public URL·제출 영상·release bundle의 fallback으로 등록하지 않는다.
 */
export { CanvasScene, CANVAS_LOGICAL_SIZE, PLAYER_SPRITE_CONTRACT } from "../ui/canvas-scene.js";
