export const MILLI_LOGICAL_PIXEL_SCALE = 1_000;
export const FIXED_SIMULATION_STEP_MS = 20;
export const MILLISECONDS_PER_SECOND = 1_000;
export const DIAGONAL_NORMALIZER_PPM = 707_106;

function requireSafeInteger(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field}는 safe integer여야 합니다.`);
  }
  return value;
}

function requirePositiveSafeInteger(value, field) {
  requireSafeInteger(value, field);
  if (value <= 0) throw new RangeError(`${field}는 1 이상이어야 합니다.`);
  return value;
}

function safeBigIntToNumber(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError(`${field} 결과가 safe integer 범위를 초과했습니다.`);
  }
  return number;
}

export function checkedAdd(left, right) {
  requireSafeInteger(left, "left");
  requireSafeInteger(right, "right");
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("fixed-point 덧셈이 safe integer 범위를 초과했습니다.");
  }
  return result;
}

export function checkedSubtract(left, right) {
  requireSafeInteger(left, "left");
  requireSafeInteger(right, "right");
  const result = left - right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("fixed-point 뺄셈이 safe integer 범위를 초과했습니다.");
  }
  return result;
}

/** Integer rational multiplication with truncation toward zero. */
export function multiplyDivideTrunc(value, multiplier, denominator) {
  requireSafeInteger(value, "value");
  requireSafeInteger(multiplier, "multiplier");
  requirePositiveSafeInteger(denominator, "denominator");
  const result = (BigInt(value) * BigInt(multiplier)) / BigInt(denominator);
  return safeBigIntToNumber(result, "multiplyDivideTrunc");
}

/** Integer rational multiplication with halves rounded away from zero. */
export function multiplyDivideHalfUp(value, multiplier, denominator) {
  requireSafeInteger(value, "value");
  requireSafeInteger(multiplier, "multiplier");
  requirePositiveSafeInteger(denominator, "denominator");

  const product = BigInt(value) * BigInt(multiplier);
  const sign = product < 0n ? -1n : 1n;
  const absolute = product < 0n ? -product : product;
  const divisor = BigInt(denominator);
  const rounded = (absolute * 2n + divisor) / (divisor * 2n);
  return safeBigIntToNumber(sign * rounded, "multiplyDivideHalfUp");
}

export function integerUnitsToFixed(value, scale = MILLI_LOGICAL_PIXEL_SCALE) {
  requireSafeInteger(value, "value");
  requirePositiveSafeInteger(scale, "scale");
  return safeBigIntToNumber(BigInt(value) * BigInt(scale), "integerUnitsToFixed");
}

/**
 * Converts an integer per-second rate into one fixed-step delta without floating-point state.
 * For the canonical guest speed this returns 96 * 1000 * 20 / 1000 = 1920 milli-pixels.
 */
export function fixedDeltaPerStep(
  unitsPerSecond,
  {
    stepMs = FIXED_SIMULATION_STEP_MS,
    scale = MILLI_LOGICAL_PIXEL_SCALE,
  } = {},
) {
  requireSafeInteger(unitsPerSecond, "unitsPerSecond");
  requirePositiveSafeInteger(stepMs, "stepMs");
  requirePositiveSafeInteger(scale, "scale");
  const scaledStep = safeBigIntToNumber(
    BigInt(scale) * BigInt(stepMs),
    "fixedDeltaPerStep scaledStep",
  );
  return multiplyDivideTrunc(
    unitsPerSecond,
    scaledStep,
    MILLISECONDS_PER_SECOND,
  );
}

/** Display-only projection; domain state remains an integer fixed-point value. */
export function fixedToDisplayNumber(value, scale = MILLI_LOGICAL_PIXEL_SCALE) {
  requireSafeInteger(value, "value");
  requirePositiveSafeInteger(scale, "scale");
  return value / scale;
}
