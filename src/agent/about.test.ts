import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderFromEnv, technologyFor } from './about.js';

test('builderFromEnv: none without a name, otherwise only what is set', () => {
  assert.equal(builderFromEnv({ SPRECHSTUNDE_BUILDER_EMAIL: 'a@example.org' }), undefined);
  assert.deepEqual(
    builderFromEnv({ SPRECHSTUNDE_BUILDER_NAME: ' Jo ', SPRECHSTUNDE_BUILDER_URL: 'https://x.example' }),
    {
      name: 'Jo',
      url: 'https://x.example',
    },
  );
});

test('technologyFor: the models the agent reads, the voice from the environment without a character', () => {
  const tech = technologyFor(undefined, undefined, {
    SPRECHSTUNDE_LLM_MODEL: 'llm-x',
    SPRECHSTUNDE_STT_MODEL: 'stt-x',
    SPRECHSTUNDE_TTS_PROVIDER: 'mistral',
  });
  assert.equal(tech.llm.model, 'llm-x');
  assert.equal(tech.stt.model, 'stt-x');
  assert.equal(tech.tts[0]?.provider, 'mistral');
  assert.equal(tech.tts.length, 1);
});
