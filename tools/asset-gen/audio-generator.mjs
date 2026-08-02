import { encodeCanonicalWav, SAMPLE_RATE } from "./wav-codec.mjs";

const clamp16 = (value) => Math.max(-32768, Math.min(32767, Math.trunc(value)));

export function synthesizeFixedPoint({ channels, sampleCount, voices }) {
  if (![1, 2].includes(channels) || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || !Array.isArray(voices)) throw new TypeError("AUDIO_SOURCE_DEFINITION_INVALID");
  const samples = new Int16Array(sampleCount * channels);
  for (let frame = 0; frame < sampleCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      let mixed = 0;
      for (const voice of voices) {
        const phase = ((frame * voice.phaseStep + (voice.phaseOffset ?? 0)) & 0xffff) - 32768;
        const wave = voice.kind === "WOOD" ? (phase > 0 ? 1 : -1) * Math.max(0, voice.durationSamples - frame) : phase / 32768;
        mixed += Math.trunc(wave * voice.amplitude);
      }
      samples[frame * channels + channel] = clamp16(mixed);
    }
  }
  return samples;
}

export function generateCanonicalAudio(definition) {
  const samples = synthesizeFixedPoint(definition);
  return encodeCanonicalWav({ channels: definition.channels, samples, sampleRate: SAMPLE_RATE });
}

