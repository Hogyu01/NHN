/** Task 27 — canonical JSON serialize와 SHA-256 hash. 같은 논리값은 항상 같은 byte열을 만든다. */

function canonicalize(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const result = {};
    for (const key of sortedKeys) result[key] = canonicalize(value[key]);
    return result;
  }
  throw new TypeError(`canonical JSON으로 표현할 수 없는 값입니다: ${typeof value}`);
}

/** 재귀적으로 key를 정렬해 항상 같은 문자열을 만드는 JSON.stringify. */
export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

/** Web Crypto(SubtleCrypto)를 사용한 SHA-256 hex digest. 브라우저와 Node 22.14+ 모두 지원한다. */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
