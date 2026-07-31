import {
  createDiagnostic,
  DIAGNOSTIC_SEVERITY,
} from "../core/diagnostic.js";
import { freezeDeep } from "../core/result.js";
import { CAMERA_VIEWPORT_SIZE } from "./camera.js";

export const INPUT_TRANSFORM_CODE = Object.freeze({
  CANVAS_RECT_EMPTY: "CANVAS_RECT_EMPTY",
  CANVAS_RECT_INVALID: "CANVAS_RECT_INVALID",
  CANVAS_RECT_READ_FAILED: "CANVAS_RECT_READ_FAILED",
  INPUT_COORDINATE_INVALID: "INPUT_COORDINATE_INVALID",
  CAMERA_ORIGIN_INVALID: "CAMERA_ORIGIN_INVALID",
});

export const INPUT_TRANSFORM_SEQUENCE = Object.freeze([
  "CLIENT",
  "CANVAS_RECT_NORMALIZED",
  "VIEWPORT_LOGICAL_480",
  "CAMERA_ORIGIN",
  "WORLD",
]);

function transformFailure(code, errorType, details = undefined) {
  const diagnostic = createDiagnostic({
    severity: DIAGNOSTIC_SEVERITY.RECOVERABLE_COMMAND,
    subsystem: "InputTransform",
    errorType,
    code,
    fieldPath: "$canvas.rect",
    ...(details === undefined ? {} : { details }),
  });
  return freezeDeep({ ok: false, code, diagnostics: [diagnostic] });
}

function finitePoint(x, y) {
  return Number.isFinite(x) && Number.isFinite(y);
}

function normalizeViewport(viewport) {
  if (!viewport || !Number.isSafeInteger(viewport.width) || viewport.width < 1 ||
      !Number.isSafeInteger(viewport.height) || viewport.height < 1) {
    return null;
  }
  return { width: viewport.width, height: viewport.height };
}

function normalizeCameraOrigin(camera) {
  const origin = camera?.origin ?? camera;
  if (!origin || !Number.isSafeInteger(origin.x) || !Number.isSafeInteger(origin.y)) return null;
  return { x: origin.x, y: origin.y };
}

/** Copies host DOMRect data into a deterministic plain record and rejects zero-area rects. */
export function snapshotCanvasRect(rect) {
  if (!rect || !finitePoint(rect.left, rect.top) ||
      !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.CANVAS_RECT_INVALID,
      "CanvasRectError",
      { reason: "left/top/width/height must be finite numbers" },
    );
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.CANVAS_RECT_EMPTY,
      "CanvasRectError",
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    );
  }
  return freezeDeep({
    ok: true,
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
  });
}

/**
 * Normative inverse transform:
 * client → Canvas rect normalized → viewport logical → +camera origin → World.
 */
export function clientToWorld(
  clientX,
  clientY,
  rect,
  camera,
  viewport = CAMERA_VIEWPORT_SIZE,
) {
  if (!finitePoint(clientX, clientY)) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.INPUT_COORDINATE_INVALID,
      "InputCoordinateError",
      { clientX, clientY },
    );
  }
  const rectResult = snapshotCanvasRect(rect);
  if (!rectResult.ok) return rectResult;
  const resolvedViewport = normalizeViewport(viewport);
  if (!resolvedViewport) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.INPUT_COORDINATE_INVALID,
      "ViewportContractError",
      { viewport },
    );
  }
  const origin = normalizeCameraOrigin(camera);
  if (!origin) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.CAMERA_ORIGIN_INVALID,
      "CameraTransformError",
      { origin: camera?.origin ?? camera ?? null },
    );
  }

  const logicalX = (clientX - rectResult.rect.left) * resolvedViewport.width / rectResult.rect.width;
  const logicalY = (clientY - rectResult.rect.top) * resolvedViewport.height / rectResult.rect.height;
  const world = freezeDeep({ x: logicalX + origin.x, y: logicalY + origin.y });
  return freezeDeep({
    ok: true,
    x: world.x,
    y: world.y,
    world,
    viewport: { x: logicalX, y: logicalY },
    cameraOrigin: origin,
    rect: rectResult.rect,
    sequence: INPUT_TRANSFORM_SEQUENCE,
  });
}

/** Reverse presentation helper used to prove World→client→World round trips. */
export function worldToClient(
  worldX,
  worldY,
  rect,
  camera,
  viewport = CAMERA_VIEWPORT_SIZE,
) {
  if (!finitePoint(worldX, worldY)) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.INPUT_COORDINATE_INVALID,
      "InputCoordinateError",
      { worldX, worldY },
    );
  }
  const rectResult = snapshotCanvasRect(rect);
  if (!rectResult.ok) return rectResult;
  const resolvedViewport = normalizeViewport(viewport);
  if (!resolvedViewport) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.INPUT_COORDINATE_INVALID,
      "ViewportContractError",
      { viewport },
    );
  }
  const origin = normalizeCameraOrigin(camera);
  if (!origin) {
    return transformFailure(
      INPUT_TRANSFORM_CODE.CAMERA_ORIGIN_INVALID,
      "CameraTransformError",
      { origin: camera?.origin ?? camera ?? null },
    );
  }

  const logicalX = worldX - origin.x;
  const logicalY = worldY - origin.y;
  const client = freezeDeep({
    x: rectResult.rect.left + logicalX * rectResult.rect.width / resolvedViewport.width,
    y: rectResult.rect.top + logicalY * rectResult.rect.height / resolvedViewport.height,
  });
  return freezeDeep({
    ok: true,
    x: client.x,
    y: client.y,
    client,
    viewport: { x: logicalX, y: logicalY },
    cameraOrigin: origin,
    rect: rectResult.rect,
  });
}

/** Browser boundary that snapshots the live Canvas rect without leaking DOMRect into World code. */
export class CanvasRectAdapter {
  constructor(canvas) {
    if (!canvas || typeof canvas.getBoundingClientRect !== "function") {
      throw new TypeError("CanvasRectAdapter에는 getBoundingClientRect Canvas가 필요합니다.");
    }
    this.canvas = canvas;
  }

  read() {
    try {
      return snapshotCanvasRect(this.canvas.getBoundingClientRect());
    } catch (error) {
      return transformFailure(
        INPUT_TRANSFORM_CODE.CANVAS_RECT_READ_FAILED,
        "CanvasRectError",
        { message: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}

/** Live Canvas adapter whose downstream success payload is World_Coordinate-first. */
export class InputTransform {
  constructor({
    rectAdapter,
    cameraProvider,
    viewport = CAMERA_VIEWPORT_SIZE,
  }) {
    if (!rectAdapter || typeof rectAdapter.read !== "function") {
      throw new TypeError("InputTransform rectAdapter가 필요합니다.");
    }
    if (typeof cameraProvider !== "function") {
      throw new TypeError("InputTransform cameraProvider가 필요합니다.");
    }
    const resolvedViewport = normalizeViewport(viewport);
    if (!resolvedViewport) throw new TypeError("InputTransform viewport가 잘못됐습니다.");
    this.rectAdapter = rectAdapter;
    this.cameraProvider = cameraProvider;
    this.viewport = freezeDeep(resolvedViewport);
  }

  clientToWorld(clientX, clientY) {
    const rectResult = this.rectAdapter.read();
    if (!rectResult.ok) return rectResult;
    return clientToWorld(clientX, clientY, rectResult.rect, this.cameraProvider(), this.viewport);
  }

  worldToClient(worldX, worldY) {
    const rectResult = this.rectAdapter.read();
    if (!rectResult.ok) return rectResult;
    return worldToClient(worldX, worldY, rectResult.rect, this.cameraProvider(), this.viewport);
  }
}
