/**
 * A sample of a voice, synthesized exactly the way a call would: through `buildBaseTts`, so what
 * the UI plays is what the caller hears, not a second code path that may drift from it.
 *
 * The chunking, the hedge and the fallback adapter around it stay out: they shape how a long reply
 * is cut up, and a preview is one sentence.
 */

import { tts } from '@livekit/agents';
import type { Mistral } from '@mistralai/mistralai';
import { downsampleS16le, encodeWav } from '../core/audio.js';
import type { Profile } from '../core/profile.js';
import { buildBaseTts, type TtsChoice } from '../agent/tts-provider.js';
import { _ } from '../i18n.js';

/** 24 kHz (what the vendors deliver) to the 8 kHz a phone line carries. */
const PHONE_SAMPLE_RATE = 8000;

export interface Synthesized {
  /** Signed 16-bit little-endian mono PCM. */
  pcm: Uint8Array;
  sampleRate: number;
  /** Time to the first audio sample — what a caller waits before the voice starts. */
  ttfaMs: number;
}

/** Synthesizes one preview. Injected, so the tests never reach a vendor. */
export type Synthesizer = (choice: TtsChoice, text: string) => Promise<Synthesized>;

function bytes(frame: { data: Int16Array }): Uint8Array {
  // A copy: the frame's buffer belongs to the plugin and may be reused for the next frame.
  return new Uint8Array(frame.data.buffer.slice(frame.data.byteOffset, frame.data.byteOffset + frame.data.byteLength));
}

/** Read a TTS instance to its end and time its first audio. */
export async function collect(instance: tts.TTS, text: string): Promise<Synthesized> {
  const started = performance.now();
  const chunks: Uint8Array[] = [];
  let ttfaMs = -1;
  let sampleRate = instance.sampleRate;
  const take = (audio: tts.SynthesizedAudio) => {
    if (ttfaMs < 0) ttfaMs = performance.now() - started;
    sampleRate = audio.frame.sampleRate;
    chunks.push(bytes(audio.frame));
  };

  if (instance.capabilities.streaming) {
    // A vendor that streams text in (Cartesia) must be fed over its socket: its `synthesize()`
    // plays a 400 error body back as audio (plugin 1.9.3, issue #24).
    const stream = instance.stream();
    stream.pushText(text);
    stream.flush();
    stream.endInput();
    try {
      for await (const event of stream) {
        if (event === tts.SynthesizeStream.END_OF_STREAM) break;
        take(event);
      }
    } finally {
      stream.close();
    }
  } else {
    for await (const audio of instance.synthesize(text)) take(audio);
  }

  if (chunks.length === 0) throw new Error(_('no audio received'));
  return { pcm: new Uint8Array(Buffer.concat(chunks)), sampleRate, ttfaMs };
}

/** The synthesizer the admin process uses: the agent's own TTS construction, one instance per preview. */
export function ttsSynthesizer(
  client: () => Mistral,
  profile: Profile,
  env: NodeJS.ProcessEnv = process.env,
): Synthesizer {
  return async (choice, text) => {
    const instance = buildBaseTts(client(), profile, choice, env);
    try {
      return await collect(instance, text);
    } finally {
      await instance.close().catch(() => {});
    }
  };
}

/**
 * The preview as a WAV file. `phone` resamples to 8 kHz first: a voice that sounds warm at 24 kHz
 * can lose exactly the band a phone line carries, and that is the only band a caller ever hears.
 */
export function previewWav(audio: Synthesized, phone: boolean): { wav: Uint8Array; sampleRate: number } {
  if (!phone) return { wav: encodeWav(audio.sampleRate, audio.pcm), sampleRate: audio.sampleRate };
  const factor = Math.max(1, Math.round(audio.sampleRate / PHONE_SAMPLE_RATE));
  const rate = Math.round(audio.sampleRate / factor);
  return { wav: encodeWav(rate, downsampleS16le(audio.pcm, factor)), sampleRate: rate };
}
