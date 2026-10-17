import type { Mistral } from '@mistralai/mistralai';
import type { TtsVoice } from '../agent/tts-voice.js';
import { f32leToS16le } from '../core/audio.js';
import { _ } from '../i18n.js';

/** One streamed request; 24 kHz signed 16-bit mono PCM plus how long it took. */
export async function synthesize(
  client: Mistral,
  model: string,
  text: string,
  voice: TtsVoice,
): Promise<{ pcm: Uint8Array; ttfaMs: number; totalMs: number }> {
  const started = performance.now();
  const stream = await client.audio.speech.complete({
    model,
    input: text,
    responseFormat: 'pcm',
    stream: true,
    ...(voice.refAudio ? { refAudio: voice.refAudio } : { voiceId: voice.voice }),
  });

  const chunks: Uint8Array[] = [];
  let ttfaMs = -1;
  for await (const event of stream) {
    const data = event.data;
    if (data.type !== 'speech.audio.delta') continue;
    if (ttfaMs < 0) ttfaMs = performance.now() - started;
    chunks.push(f32leToS16le(new Uint8Array(Buffer.from(data.audioData, 'base64'))));
  }
  const totalMs = performance.now() - started;
  if (chunks.length === 0) throw new Error(_('no audio received'));
  return { pcm: new Uint8Array(Buffer.concat(chunks)), ttfaMs, totalMs };
}
