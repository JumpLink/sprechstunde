/** Pure audio helpers: PCM conversion, resampling and a minimal WAV writer. No I/O. */

/** Convert little-endian float32 samples to little-endian signed 16-bit, clipping like the LiveKit Mistral plugin. */
export function f32leToS16le(data: Uint8Array): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = Math.floor(data.byteLength / 4);
  const out = new DataView(new ArrayBuffer(count * 2));
  for (let index = 0; index < count; index++) {
    const sample = view.getFloat32(index * 4, true);
    out.setInt16(index * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
  }
  return new Uint8Array(out.buffer);
}

/**
 * Reduce the sample rate by an integer factor, averaging each group of samples. Crude, but
 * enough to hear what a phone line (8 kHz) does to a voice.
 */
export function downsampleS16le(data: Uint8Array, factor: number): Uint8Array {
  if (!Number.isInteger(factor) || factor < 1) throw new Error(`factor must be a positive integer: ${factor}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = Math.floor(data.byteLength / 2 / factor);
  const out = new DataView(new ArrayBuffer(count * 2));
  for (let index = 0; index < count; index++) {
    let sum = 0;
    for (let step = 0; step < factor; step++) sum += view.getInt16((index * factor + step) * 2, true);
    out.setInt16(index * 2, Math.round(sum / factor), true);
  }
  return new Uint8Array(out.buffer);
}

/** The 44-byte RIFF header of a mono 16-bit PCM WAV file holding `dataBytes` bytes of samples. */
export function wavHeader(sampleRate: number, dataBytes: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const tag = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) header.setUint8(offset + index, text.charCodeAt(index));
  };
  tag(0, 'RIFF');
  header.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // byte rate
  header.setUint16(32, 2, true); // block align
  header.setUint16(34, 16, true); // bits per sample
  tag(36, 'data');
  header.setUint32(40, dataBytes, true);
  return new Uint8Array(header.buffer);
}

export function silenceS16le(sampleRate: number, ms: number): Uint8Array {
  return new Uint8Array(Math.round((sampleRate * ms) / 1000) * 2);
}

export function encodeWav(sampleRate: number, s16le: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + s16le.byteLength);
  out.set(wavHeader(sampleRate, s16le.byteLength), 0);
  out.set(s16le, 44);
  return out;
}
