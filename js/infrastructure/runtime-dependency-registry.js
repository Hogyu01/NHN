export const PIXI_RUNTIME_CONTRACT = Object.freeze({
  package: "pixi.js",
  version: "8.19.0",
  localEntry: "js/libs/pixijs/pixi.min.js",
  localSha256: "28fefb52eeb15bb3e087533456bafc53e91af70932af4dd046ff2938ec3edd0e",
  licenseId: "MIT",
});

export function validateRuntimeDependencies(input) {
  const pixi = input?.dependencies?.find((entry) => entry.dependencyId === "runtime.pixi-js");
  const diagnostics = [];
  if (input?.schemaVersion !== 1 || !pixi) diagnostics.push("PIXI_DEPENDENCY_MISSING");
  else {
    for (const [field, expected] of Object.entries(PIXI_RUNTIME_CONTRACT)) if (pixi[field] !== expected) diagnostics.push(`PIXI_${field.toUpperCase()}_MISMATCH`);
    if (!pixi.officialDistributionUrl?.startsWith("https://registry.npmjs.org/pixi.js/-/pixi.js-8.19.0")) diagnostics.push("PIXI_OFFICIAL_SOURCE_INVALID");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pixi.verifiedAt ?? "")) diagnostics.push("PIXI_VERIFICATION_MISSING");
    if (pixi.lockfile !== "package-lock.json" || pixi.manifestVersion !== PIXI_RUNTIME_CONTRACT.version || pixi.buildMetadataVersion !== PIXI_RUNTIME_CONTRACT.version) diagnostics.push("PIXI_VERSION_PARITY_INVALID");
    if (!pixi.noticePath || /^https?:/.test(pixi.localEntry)) diagnostics.push("PIXI_LOCAL_LICENSE_INVALID");
  }
  return diagnostics.length > 0 ? { ok: false, code: "RUNTIME_DEPENDENCY_INVALID", diagnostics } : { ok: true, code: "RUNTIME_DEPENDENCY_VALID", pixi: Object.freeze(pixi) };
}

export async function loadRuntimeDependencies(baseUrl, fetchImpl = (...args) => window.fetch.call(window, ...args)) {
  const response = await fetchImpl(new URL("data/runtime-dependencies.json", baseUrl));
  if (!response.ok) throw new Error(`RUNTIME_DEPENDENCY_FETCH_FAILED:${response.status}`);
  const result = validateRuntimeDependencies(await response.json());
  if (!result.ok) throw new Error(`${result.code}:${result.diagnostics.join("|")}`);
  return result;
}
