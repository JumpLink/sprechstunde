import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aboutBlock, type Technology } from './about.js';

const tech: Technology = {
  llm: { model: 'model-a', fallback: 'model-b' },
  stt: { model: 'stt-a', fallback: 'stt-b' },
  tts: [
    { provider: 'elevenlabs', model: 'voice-a' },
    { provider: 'kugel', model: 'voice-b' },
  ],
};

test('aboutBlock: names the models of the call, the fallbacks and the vendors', () => {
  const text = aboutBlock(tech);
  assert.match(text, /Language model: model-a, with model-b as the fallback, hosted by Mistral AI/);
  assert.match(text, /Speech recognition: stt-a, with stt-b as the fallback/);
  assert.match(text, /Voice: ElevenLabs, model voice-a, with KugelAudio, model voice-b as the fallback/);
  assert.match(text, /only when the caller asks/);
});

test('aboutBlock: no builder line without a builder, no fallback when it equals the model', () => {
  const text = aboutBlock({ ...tech, llm: { model: 'm', fallback: 'm' }, tts: [{ provider: 'x', model: 'y' }] });
  assert.ok(!text.includes('built by'));
  assert.match(text, /Language model: m, hosted/);
  assert.match(text, /Voice: x, model y\./);
});

test('aboutBlock: the builder with place and the contact details that are set', () => {
  const full = aboutBlock(tech, {
    name: 'Jo Doe',
    place: 'Springfield',
    email: 'jo@example.org',
    url: 'https://example.org',
  });
  assert.match(full, /built by Jo Doe, a freelance software developer from Springfield/);
  assert.match(full, /e-mail jo@example\.org and website https:\/\/example\.org/);
  const bare = aboutBlock(tech, { name: 'Jo Doe' });
  assert.ok(!bare.includes('give '));
});
