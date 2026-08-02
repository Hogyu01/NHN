import { SAVE_STORAGE_KEYS } from "./storage-adapter.js";

/**
 * Task 34 / Requirement 22 AC3~6 — master/sfx/bgm buses, integer 0..100 volume, mute-preserves-
 * value, and settings stored under a versioned key separate from campaign checkpoints (never goes
 * through the save-system current/previous/temp rotation).
 */

const SCHEMA_VERSION = 1;
const BUS_IDS = Object.freeze(["master", "sfx", "bgm"]);

export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  buses: Object.freeze({
    master: Object.freeze({ volume: 100, muted: false }),
    sfx: Object.freeze({ volume: 100, muted: false }),
    bgm: Object.freeze({ volume: 100, muted: false }),
  }),
});

function isValidBusEntry(entry) {
  return entry && typeof entry === "object" &&
    Number.isInteger(entry.volume) && entry.volume >= 0 && entry.volume <= 100 &&
    typeof entry.muted === "boolean";
}

export function validateAudioSettings(settings) {
  if (!settings || typeof settings !== "object" || settings.schemaVersion !== SCHEMA_VERSION) return false;
  if (!settings.buses || typeof settings.buses !== "object") return false;
  return BUS_IDS.every((busId) => isValidBusEntry(settings.buses[busId]));
}

/** `effective gain = master × child / 10000`. muted(master 또는 child)는 항상 0을 만든다. */
export function computeEffectiveGain({ masterVolume, masterMuted, childVolume, childMuted }) {
  if (masterMuted || childMuted) return 0;
  return (masterVolume * childVolume) / 10000;
}

export function loadAudioSettings(storage) {
  if (!storage || typeof storage.getItem !== "function") {
    return { settings: DEFAULT_AUDIO_SETTINGS, code: "STORAGE_UNAVAILABLE" };
  }
  let raw = null;
  try {
    raw = storage.getItem(SAVE_STORAGE_KEYS.AUDIO_SETTINGS);
  } catch {
    return { settings: DEFAULT_AUDIO_SETTINGS, code: "STORAGE_READ_FAILED" };
  }
  if (raw === null) return { settings: DEFAULT_AUDIO_SETTINGS, code: "ABSENT" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { settings: DEFAULT_AUDIO_SETTINGS, code: "CORRUPT_JSON" };
  }
  if (!validateAudioSettings(parsed)) return { settings: DEFAULT_AUDIO_SETTINGS, code: "INVALID_SCHEMA" };
  return {
    settings: Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      buses: Object.freeze({
        master: Object.freeze({ ...parsed.buses.master }),
        sfx: Object.freeze({ ...parsed.buses.sfx }),
        bgm: Object.freeze({ ...parsed.buses.bgm }),
      }),
    }),
    code: "OK",
  };
}

export function saveAudioSettings(storage, settings) {
  if (!validateAudioSettings(settings)) return { ok: false, code: "INVALID_SCHEMA" };
  if (!storage || typeof storage.setItem !== "function") return { ok: false, code: "STORAGE_UNAVAILABLE" };
  try {
    storage.setItem(SAVE_STORAGE_KEYS.AUDIO_SETTINGS, JSON.stringify(settings));
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "STORAGE_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) };
  }
}

export { BUS_IDS };
