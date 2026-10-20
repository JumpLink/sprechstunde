import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSettings } from '../core/settings.js';
import { choiceFromVoice, kugelApiKey, ttsChoice, ttsChoices, ttsFallbackChoice } from './tts-provider.js';

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
  assert.deepEqual(
    ttsChoice({
      SPRECHSTUNDE_TTS_PROVIDER: 'cartesia',
      SPRECHSTUNDE_TTS_VOICE: 'v',
    }),
    {
      provider: 'cartesia',
      model: 'sonic-3.6',
      voice: 'v',
      refAudio: undefined,
      name: undefined,
    },
  );
});

test('ttsChoice: OpenRouter has no default model', () => {
  assert.throws(
    () =>
      ttsChoice({
        SPRECHSTUNDE_TTS_PROVIDER: 'openrouter',
        SPRECHSTUNDE_TTS_VOICE: 'v',
      }),
    /SPRECHSTUNDE_TTS_MODEL/,
  );
});

test('ttsChoice: an unknown vendor fails instead of falling back', () => {
  assert.throws(() => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'elevenlabs' }), /SPRECHSTUNDE_TTS_PROVIDER/);
});

test('ttsChoice: a kugel voice is a number, not a name', () => {
  assert.throws(() => ttsChoice({ SPRECHSTUNDE_TTS_PROVIDER: 'kugel' }), /SPRECHSTUNDE_TTS_VOICE/);
  assert.throws(
    () =>
      ttsChoice({
        SPRECHSTUNDE_TTS_PROVIDER: 'kugel',
        SPRECHSTUNDE_TTS_VOICE: 'ernst',
      }),
    /SPRECHSTUNDE_TTS_VOICE/,
  );
  assert.throws(
    () =>
      ttsChoice({
        SPRECHSTUNDE_TTS_PROVIDER: 'kugel',
        SPRECHSTUNDE_TTS_VOICE: '1234567890',
      }),
    /SPRECHSTUNDE_TTS_VOICE/,
  );
  assert.deepEqual(
    ttsChoice({
      SPRECHSTUNDE_TTS_PROVIDER: 'kugel',
      SPRECHSTUNDE_TTS_VOICE: '7',
    }),
    {
      provider: 'kugel',
      model: 'kugel-3.5',
      voice: '7',
      refAudio: undefined,
      name: undefined,
    },
  );
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
  assert.equal(
    kugelApiKey({
      KUGELAUDIO_API_KEY: 'k',
      SPRECHSTUNDE_KUGEL_REGION: 'global',
    }),
    'global-k',
  );
  // A key that names its own region is left alone, whatever the variable says.
  for (const key of ['eu-k', 'us-k', 'global-k']) {
    assert.equal(kugelApiKey({ KUGELAUDIO_API_KEY: key }), key);
    assert.equal(
      kugelApiKey({
        KUGELAUDIO_API_KEY: key,
        SPRECHSTUNDE_KUGEL_REGION: 'global',
      }),
      key,
    );
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

test('choiceFromVoice: the vendor default fills in the model', () => {
  assert.deepEqual(choiceFromVoice({ provider: 'mistral' }, { id: 'house', name: 'Alex' }), {
    provider: 'mistral',
    model: 'voxtral-mini-tts-latest',
    voice: undefined,
    refAudio: undefined,
    name: 'Alex',
    character: 'house',
  });
  assert.equal(choiceFromVoice({ provider: 'pocket', voice: 'juergen' }, { id: 'p' }).model, 'pocket-tts');
  // The message is translated; the character and the vendor are in it whatever the locale.
  assert.throws(() => choiceFromVoice({ provider: 'openrouter', voice: 'v' }, { id: 'r' }), /openrouter/);
});

test('choiceFromVoice: a kugel voice carries the numeric voice id', () => {
  assert.deepEqual(choiceFromVoice({ provider: 'kugel', voice: '7' }, { id: 'berlin' }), {
    provider: 'kugel',
    model: 'kugel-3.5',
    voice: '7',
    refAudio: undefined,
    name: undefined,
    character: 'berlin',
  });
  // The message is translated, quotation marks and all; only the character id is in every locale.
  assert.throws(() => choiceFromVoice({ provider: 'kugel', voice: 'a-name' }, { id: 'berlin' }), /berlin/);
});

const aCharacter = (overrides: Record<string, unknown> = {}) =>
  parseSettings({
    schemaVersion: 2,
    characters: [
      {
        id: 'house',
        name: 'Alex',
        gender: 'male',
        voice: { provider: 'pocket', voice: 'juergen' },
        ...overrides,
      },
    ],
  }).characters[0]!;

test('ttsChoices: the environment decides while there is no character', () => {
  const env = {
    SPRECHSTUNDE_TTS_PROVIDER: 'pocket',
    SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'mistral',
  };
  assert.deepEqual(ttsChoices(undefined, env).primary.provider, 'pocket');
  assert.deepEqual(ttsChoices(undefined, env).fallback?.provider, 'mistral');
});

test('ttsChoices: a character wins over the environment, voice and fallback as a pair', () => {
  const character = aCharacter({
    fallbackVoice: { provider: 'mistral', voice: 'm' },
  });
  const env = {
    SPRECHSTUNDE_TTS_PROVIDER: 'cartesia',
    SPRECHSTUNDE_TTS_VOICE: 'from-env',
  };
  const choices = ttsChoices(character, env);
  assert.equal(choices.primary.character, 'house');
  assert.equal(choices.primary.voice, 'juergen');
  assert.equal(choices.primary.name, 'Alex');
  assert.equal(choices.fallback?.provider, 'mistral');
  assert.equal(choices.fallback?.character, 'house');
});

test('ttsChoices: a character without a fallback voice leaves the env fallback out', () => {
  const choices = ttsChoices(aCharacter(), {
    SPRECHSTUNDE_TTS_FALLBACK_PROVIDER: 'mistral',
  });
  assert.equal(choices.fallback, undefined);
});

test('choiceFromVoice: a clip resolves into the voices directory', () => {
  const before = process.env.SPRECHSTUNDE_VOICES_DIR;
  process.env.SPRECHSTUNDE_VOICES_DIR = '/srv/voices';
  try {
    const choice = choiceFromVoice({ provider: 'mistral', refAudio: 'clip.wav' }, { id: 'a' });
    assert.equal(choice.refAudio, '/srv/voices/clip.wav');
  } finally {
    if (before === undefined) delete process.env.SPRECHSTUNDE_VOICES_DIR;
    else process.env.SPRECHSTUNDE_VOICES_DIR = before;
  }
});
