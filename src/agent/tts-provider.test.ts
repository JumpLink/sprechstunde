import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ttsChoice } from './tts-provider.js';

test('ttsChoice: Mistral by default, voice from the profile', () => {
  assert.deepEqual(ttsChoice({}), { provider: 'mistral', model: 'voxtral-mini-tts-latest', voice: undefined });
});

test('ttsChoice: another vendor needs its own voice', () => {
  assert.throws(() => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'cartesia' }), /SPRECHSTUNDE_TTS_VOICE/);
  assert.deepEqual(ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'cartesia', SPRECHSTUNDE_TTS_VOICE: 'v' }), {
    provider: 'cartesia',
    model: 'sonic-3.6',
    voice: 'v',
  });
});

test('ttsChoice: OpenRouter has no default model', () => {
  assert.throws(
    () => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'openrouter', SPRECHSTUNDE_TTS_VOICE: 'v' }),
    /SPRECHSTUNDE_TTS_MODEL/,
  );
});

test('ttsChoice: an unknown vendor fails instead of falling back', () => {
  assert.throws(() => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'elevenlabs' }), /SPRECHSTUNDE_TTS_PROVIDER/);
});
