const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function requireFieldName(field) {
  return typeof field === "string" && field.trim() !== "" ? field : "value";
}

/** Returns true only for an integer representable without precision loss. */
export function isSafeIntegerG(value) {
  return Number.isSafeInteger(value);
}

/**
 * Validates an integer G value without coercion.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @param {{minimum?: number, maximum?: number}} [bounds]
 */
export function requireSafeIntegerG(
  value,
  field = "value",
  { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = {},
) {
  const name = requireFieldName(field);
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) {
    throw new TypeError(`${name}의 safe integer 경계가 유효하지 않습니다.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name}는 safe integer G여야 합니다.`);
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(`${name}는 ${minimum}..${maximum}G 범위여야 합니다.`);
  }
  return value;
}

export function requireNonNegativeG(value, field = "value") {
  return requireSafeIntegerG(value, field, { minimum: 0 });
}

export function requirePositiveG(value, field = "value") {
  return requireSafeIntegerG(value, field, { minimum: 1 });
}

function safeBigIntToNumber(value, field) {
  if (value < MIN_SAFE_BIGINT || value > MAX_SAFE_BIGINT) {
    throw new RangeError(`${requireFieldName(field)} 결과가 safe integer 범위를 초과했습니다.`);
  }
  return Number(value);
}

/** Adds two integer G values with an explicit overflow guard. */
export function checkedAddG(left, right, field = "money addition") {
  requireSafeIntegerG(left, "left");
  requireSafeIntegerG(right, "right");
  return safeBigIntToNumber(BigInt(left) + BigInt(right), field);
}

/** Subtracts two integer G values with an explicit overflow guard. */
export function checkedSubtractG(left, right, field = "money subtraction") {
  requireSafeIntegerG(left, "left");
  requireSafeIntegerG(right, "right");
  return safeBigIntToNumber(BigInt(left) - BigInt(right), field);
}

/**
 * Applies Half-Up exactly once to an integer rational. Ties are rounded away from zero.
 * BigInt intermediates prevent `abs(numerator) * 2` from silently overflowing Number.
 */
export function divideHalfUp(numerator, denominator) {
  requireSafeIntegerG(numerator, "numerator");
  requirePositiveG(denominator, "denominator");

  const signedNumerator = BigInt(numerator);
  const sign = signedNumerator < 0n ? -1n : 1n;
  const absolute = signedNumerator < 0n ? -signedNumerator : signedNumerator;
  const divisor = BigInt(denominator);
  const roundedAbsolute = (absolute * 2n + divisor) / (divisor * 2n);
  return safeBigIntToNumber(sign * roundedAbsolute, "Half-Up");
}

/**
 * Multiplies the integer operands as an exact rational, then applies Half-Up once at final
 * recognition. No staged floating-point or intermediate rounding is performed.
 */
export function multiplyDivideHalfUp(value, multiplier, denominator) {
  requireSafeIntegerG(value, "value");
  requireSafeIntegerG(multiplier, "multiplier");
  requirePositiveG(denominator, "denominator");

  const product = BigInt(value) * BigInt(multiplier);
  const sign = product < 0n ? -1n : 1n;
  const absolute = product < 0n ? -product : product;
  const divisor = BigInt(denominator);
  const roundedAbsolute = (absolute * 2n + divisor) / (divisor * 2n);
  return safeBigIntToNumber(sign * roundedAbsolute, "Half-Up multiplication");
}

/** Sums integer G values with a safe final-result guard. */
export function sumG(values, field = "money total") {
  if (!Array.isArray(values)) throw new TypeError("values는 배열이어야 합니다.");
  let total = 0n;
  for (let index = 0; index < values.length; index += 1) {
    requireSafeIntegerG(values[index], `${field}[${index}]`);
    total += BigInt(values[index]);
  }
  return safeBigIntToNumber(total, field);
}
