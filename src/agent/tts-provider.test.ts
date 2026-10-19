import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ttsChoice, ttsFallbackChoice } from './tts-provider.js';

test('ttsChoice: Mistral by default, voice from the profile', () => {
  assert.deepEqual(ttsChoice({}), {
    provider: 'mistral',
    model: 'voxtral-mini-tts-latest',
    voice: undefined,
    name: undefined,
    prefix: 'SPRECHSTUNDE_TTS_',
  });
});

test('ttsChoice: another vendor needs its own voice', () => {
  assert.throws(() => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'cartesia' }), /SPRECHSTUNDE_TTS_VOICE/);
  assert.deepEqual(ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'cartesia', SPRECHSTUNDE_TTS_VOICE: 'v' }), {
    provider: 'cartesia',
    model: 'sonic-3.6',
    voice: 'v',
    name: undefined,
    prefix: 'SPRECHSTUNDE_TTS_',
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

test('ttsChoice: Pocket needs no voice, its server has a default', () => {
  assert.equal(ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'pocket' }).voice, undefined);
});

test('ttsFallbackChoice: none unless configured, read from its own keys', () => {
  assert.equal(ttsFallbackChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'pocket' }), undefined);
  assert.deepEqual(
    ttsFallbackChoice({
      SPRECHSTUNDE_TTS_PROVIDER: 'pocket',
      SPRECHSTUNDE_TTS_NAME: 'Jürgen',
      SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'mistral',
      SPRECHSTUNDE_TTS_FALLBACK_VOICE: 'm',
      SPRECHSTUNDE_TTS_FALLBACK_NAME: 'Pascal',
    }),
    {
      provider: 'mistral',
      model: 'voxtral-mini-tts-latest',
      voice: 'm',
      name: 'Pascal',
      prefix: 'SPRECHSTUNDE_TTS_FALLBACK_',
    },
  );
  assert.throws(
    () => ttsFallbackChoice({ SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'cartesia' }),
    /SPRECHSTUNDE_TTS_FALLBACK_VOICE/,
  );
});
