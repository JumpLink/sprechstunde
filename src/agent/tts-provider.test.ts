import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettings } from '../core/settings.js';
import { choiceFromPreset, kugelApiKey, ttsChoice, ttsChoices, ttsFallbackChoice } from './tts-provider.js';

test('ttsChoice: Mistral by default, voice from the profile', () => {
  assert.deepEqual(ttsChoice({}), {
    provider: 'mistral',
    model: 'voxtral-mini-tts-latest',
    voice: undefined,
    refAudio: undefined,
    name: undefined,
  });
});

test('ttsChoice: another vendor needs its own voice', () => {
  assert.throws(() => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'cartesia' }), /SPRECHSTUNDE_TTS_VOICE/);
  assert.deepEqual(ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'cartesia', SPRECHSTUNDE_TTS_VOICE: 'v' }), {
    provider: 'cartesia',
    model: 'sonic-3.6',
    voice: 'v',
    refAudio: undefined,
    name: undefined,
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

test('ttsChoice: a kugel voice is a number, not a name', () => {
  assert.throws(() => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'kugel' }), /SPRECHSTUNDE_TTS_VOICE/);
  assert.throws(
    () => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'kugel', SPRECHSTUNDE_TTS_VOICE: 'ernst' }),
    /SPRECHSTUNDE_TTS_VOICE/,
  );
  assert.throws(
    () => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'kugel', SPRECHSTUNDE_TTS_VOICE: '1234567890' }),
    /numeric KugelAudio voice id/,
  );
  assert.deepEqual(ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'kugel', SPRECHSTUNDE_TTS_VOICE: '7' }), {
    provider: 'kugel',
    model: 'kugel-3.5',
    voice: '7',
    refAudio: undefined,
    name: undefined,
  });
  // The fallback slot reads its own key and says so.
  assert.throws(
    () =>
      ttsFallbackChoice({
        SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'kugel',
        SPRECHSTUNDE_TTS_FALLBACK_VOICE: 'ernst',
      }),
    /SPRECHSTUNDE_TTS_FALLBACK_VOICE/,
  );
});

test('kugelApiKey: the EU endpoint unless asked otherwise', () => {
  assert.equal(kugelApiKey({ KUGELAUDIO_API_KEY: 'k' }), 'eu-k');
  assert.equal(kugelApiKey({ KUGELAUDIO_API_KEY: 'k', SPRECHSTUNDE_KUGEL_REGION: 'eu' }), 'eu-k');
  assert.equal(kugelApiKey({ KUGELAUDIO_API_KEY: 'k', SPRECHSTUNDE_KUGEL_REGION: 'global' }), 'global-k');
  // A key that names its own region is left alone, whatever the variable says.
  for (const key of ['eu-k', 'us-k', 'global-k']) {
    assert.equal(kugelApiKey({ KUGELAUDIO_API_KEY: key }), key);
    assert.equal(kugelApiKey({ KUGELAUDIO_API_KEY: key, SPRECHSTUNDE_KUGEL_REGION: 'global' }), key);
  }
  assert.throws(() => kugelApiKey({}), /KUGELAUDIO_API_KEY/);
  assert.throws(() => kugelApiKey({ KUGELAUDIO_API_KEY: 'k', SPRECHSTUNDE_KUGEL_REGION: 'us' }), /KUGEL_REGION/);
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
      refAudio: undefined,
      name: 'Pascal',
    },
  );
  assert.throws(
    () => ttsFallbackChoice({ SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'cartesia' }),
    /SPRECHSTUNDE_TTS_FALLBACK_VOICE/,
  );
});

test('ttsChoice: the reference clip is part of the choice', () => {
  assert.equal(ttsChoice({ SPRECHSTUNDE_TTS_REF_AUDIO: 'clip.wav' }).refAudio, 'clip.wav');
  assert.equal(
    ttsFallbackChoice({
      SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'mistral',
      SPRECHSTUNDE_TTS_FALLBACK_REF_AUDIO: 'other.wav',
    })?.refAudio,
    'other.wav',
  );
});

test('choiceFromPreset: the vendor default fills in the model', () => {
  assert.deepEqual(choiceFromPreset({ id: 'house', label: 'House', provider: 'mistral', name: 'Alex' }), {
    provider: 'mistral',
    model: 'voxtral-mini-tts-latest',
    voice: undefined,
    refAudio: undefined,
    name: 'Alex',
    preset: 'house',
  });
  assert.equal(choiceFromPreset({ id: 'p', label: 'P', provider: 'pocket', voice: 'juergen' }).model, 'pocket-tts');
  // The message is translated; the preset and the vendor are in it whatever the locale.
  assert.throws(() => choiceFromPreset({ id: 'r', label: 'R', provider: 'openrouter', voice: 'v' }), /openrouter/);
});

test('choiceFromPreset: a kugel preset carries the numeric voice id', () => {
  assert.deepEqual(choiceFromPreset({ id: 'berlin', label: 'Berlin', provider: 'kugel', voice: '7' }), {
    provider: 'kugel',
    model: 'kugel-3.5',
    voice: '7',
    refAudio: undefined,
    name: undefined,
    preset: 'berlin',
  });
  // The message is translated, quotation marks and all; only the preset id is in every locale.
  assert.throws(
    () => choiceFromPreset({ id: 'berlin', label: 'Berlin', provider: 'kugel', voice: 'a-name' }),
    /berlin/,
  );
});

test('ttsChoices: the environment decides while no preset is active', () => {
  const env = { SPRECHSTUNDE_TTS_PROVIDER: 'pocket', SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'mistral' };
  assert.deepEqual(ttsChoices(undefined, env).primary.provider, 'pocket');
  assert.deepEqual(ttsChoices(parseSettings({}), env).fallback?.provider, 'mistral');
  // Presets that exist but are not active change nothing.
  const idle = parseSettings({ presets: [{ id: 'c', label: 'C', provider: 'cartesia', voice: 'v' }] });
  assert.equal(ttsChoices(idle, env).primary.provider, 'pocket');
});

test('ttsChoices: an active preset wins over the environment, as a pair', () => {
  const settings = parseSettings({
    presets: [
      { id: 'house', label: 'House', provider: 'pocket', voice: 'juergen', name: 'Alex' },
      { id: 'cloud', label: 'Cloud', provider: 'mistral', voice: 'm' },
    ],
    active: { primary: 'house', fallback: 'cloud' },
  });
  const env = { SPRECHSTUNDE_TTS_PROVIDER: 'cartesia', SPRECHSTUNDE_TTS_VOICE: 'from-env' };
  const choices = ttsChoices(settings, env);
  assert.equal(choices.primary.preset, 'house');
  assert.equal(choices.primary.voice, 'juergen');
  assert.equal(choices.primary.name, 'Alex');
  assert.equal(choices.fallback?.preset, 'cloud');
});

test('ttsChoices: an active primary without a fallback leaves the env fallback out', () => {
  const settings = parseSettings({
    presets: [{ id: 'house', label: 'House', provider: 'pocket' }],
    active: { primary: 'house' },
  });
  const choices = ttsChoices(settings, { SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'mistral' });
  assert.equal(choices.fallback, undefined);
});

test('choiceFromPreset: a preset clip resolves into the voices directory', () => {
  const before = process.env.SPRECHSTUNDE_VOICES_DIR;
  process.env.SPRECHSTUNDE_VOICES_DIR = '/srv/voices';
  try {
    const choice = choiceFromPreset({ id: 'a', label: 'A', provider: 'mistral', refAudio: 'clip.wav' });
    assert.equal(choice.refAudio, '/srv/voices/clip.wav');
  } finally {
    if (before === undefined) delete process.env.SPRECHSTUNDE_VOICES_DIR;
    else process.env.SPRECHSTUNDE_VOICES_DIR = before;
  }
});
