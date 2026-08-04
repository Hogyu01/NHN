export const SAMPLE_RATE = 48000;

export function encodeCanonicalWav({ channels, samples, sampleRate = SAMPLE_RATE }) {
  if (![1, 2].includes(channels) || !(samples instanceof Int16Array) || samples.length % channels !== 0) throw new TypeError("WAV_PCM16_CONTRACT_INVALID");
  const dataSize = samples.length * 2;
  const output = Buffer.alloc(44 + dataSize);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVEfmt ", 8, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * 2, 28);
  output.writeUInt16LE(channels * 2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index += 1) output.writeInt16LE(samples[index], 44 + index * 2);
  return output;
}

export function decodeCanonicalWav(bytes) {
  const input = Buffer.from(bytes);
  if (input.length < 44 || input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 16) !== "WAVEfmt ") throw new Error("WAV_HEADER_INVALID");
  const channels = input.readUInt16LE(22);
  const sampleRate = input.readUInt32LE(24);
  const dataSize = input.readUInt32LE(40);
  if (input.readUInt16LE(20) !== 1 || input.readUInt32LE(16) !== 16 || input.readUInt16LE(34) !== 16 || input.toString("ascii", 36, 40) !== "data" || input.length !== 44 + dataSize) throw new Error("WAV_CONTRACT_INVALID");
  const samples = new Int16Array(dataSize / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = input.readInt16LE(44 + index * 2);
  return { channels, sampleRate, samples };
}

export function validateCanonicalWav(bytes) {
  const decoded = decodeCanonicalWav(bytes);
  return { ok: Buffer.from(bytes).equals(encodeCanonicalWav(decoded)), channels: decoded.channels, sampleRate: decoded.sampleRate, sampleCount: decoded.samples.length / decoded.channels };
}
