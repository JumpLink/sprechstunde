import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeLogger, type tts } from '@livekit/agents';
import { collect, previewWav, type Synthesized } from './preview.js';

initializeLogger({ pretty: false, level: 'fatal' });

/** A TTS that hands out prepared frames. `collect` only touches these four members. */
function fakeTts(frames: Int16Array[], sampleRate = 24000): tts.TTS {
  return {
    sampleRate,
    capabilities: { streaming: false },
    synthesize: () =>
      (async function* () {
        for (const data of frames) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield { frame: { data, sampleRate } };
        }
      })(),
  } as unknown as tts.TTS;
}

function sampleRateOf(wav: Uint8Array): number {
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true);
}

test('collect: joins the frames and times the first audio', async () => {
  const audio = await collect(fakeTts([Int16Array.from([1, 2]), Int16Array.from([3])]), 'hello');
  assert.equal(audio.sampleRate, 24000);
  assert.equal(audio.pcm.byteLength, 6);
  assert.deepEqual([...new Int16Array(audio.pcm.buffer, audio.pcm.byteOffset, 3)], [1, 2, 3]);
  assert.ok(audio.ttfaMs > 0, `expected a measured time, got ${audio.ttfaMs}`);
});

test('collect: no audio is a failure, not an empty file', async () => {
  // The message is translated, so only the fact that it rejects is asserted here.
  await assert.rejects(collect(fakeTts([]), 'hello'), Error);
});

test('previewWav: a WAV at the synthesized rate', () => {
  const audio: Synthesized = { pcm: new Uint8Array(480), sampleRate: 24000, ttfaMs: 10 };
  const { wav, sampleRate } = previewWav(audio, false);
  assert.equal(sampleRate, 24000);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(sampleRateOf(wav), 24000);
  assert.equal(wav.byteLength, 44 + 480);
});

test('previewWav: "phone" resamples to 8 kHz', () => {
  const audio: Synthesized = { pcm: new Uint8Array(480), sampleRate: 24000, ttfaMs: 10 };
  const { wav, sampleRate } = previewWav(audio, true);
  assert.equal(sampleRate, 8000);
  assert.equal(sampleRateOf(wav), 8000);
  assert.equal(wav.byteLength, 44 + 160);
});

test('previewWav: a vendor that already delivers 8 kHz is left alone', () => {
  const { wav, sampleRate } = previewWav({ pcm: new Uint8Array(160), sampleRate: 8000, ttfaMs: 1 }, true);
  assert.equal(sampleRate, 8000);
  assert.equal(wav.byteLength, 44 + 160);
});
