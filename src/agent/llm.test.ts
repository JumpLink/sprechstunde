import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeLogger, llm } from '@livekit/agents';
import type { Mistral } from '@mistralai/mistralai';
import { parseSettings } from '../core/settings.js';
import { buildLlm, llmModel } from './llm.js';

initializeLogger({ pretty: false, level: 'fatal' });

// The plugin only needs a client object to exist; nothing here talks to Mistral.
const client = {} as Mistral;

test('llmModel: settings first, then the environment, then the default', () => {
  assert.equal(llmModel(undefined, {}), 'mistral-small-latest');
  assert.equal(llmModel(undefined, { SPRECHSTUNDE_LLM_MODEL: 'from-env' }), 'from-env');
  assert.equal(
    llmModel(parseSettings({ llm: { model: 'from-settings' } }), { SPRECHSTUNDE_LLM_MODEL: 'from-env' }),
    'from-settings',
  );
});

test('buildLlm: a single LLM while no fallback model is configured', () => {
  const built = buildLlm(client, undefined, {});
  assert.ok(!(built instanceof llm.FallbackAdapter));
  assert.equal(built.model, 'mistral-small-latest');
});

test('buildLlm: a fallback model puts both behind the adapter', () => {
  const built = buildLlm(client, undefined, {
    SPRECHSTUNDE_LLM_MODEL: 'first',
    SPRECHSTUNDE_LLM_FALLBACK_MODEL: 'second',
  });
  assert.ok(built instanceof llm.FallbackAdapter);
  assert.deepEqual(
    built.llms.map((instance) => instance.model),
    ['first', 'second'],
  );
  assert.equal(built.attemptTimeout, 3);
});

test('buildLlm: the same model twice is not a fallback', () => {
  const built = buildLlm(client, undefined, { SPRECHSTUNDE_LLM_MODEL: 'one', SPRECHSTUNDE_LLM_FALLBACK_MODEL: 'one' });
  assert.ok(!(built instanceof llm.FallbackAdapter));
});

test('buildLlm: the attempt timeout comes from the settings, in seconds', () => {
  const settings = parseSettings({ llm: { model: 'a', fallbackModel: 'b', attemptTimeoutS: 1.5 } });
  const built = buildLlm(client, settings, { SPRECHSTUNDE_LLM_ATTEMPT_TIMEOUT: '9' });
  assert.ok(built instanceof llm.FallbackAdapter);
  assert.equal(built.attemptTimeout, 1.5);
  assert.equal(
    (
      buildLlm(client, undefined, {
        SPRECHSTUNDE_LLM_MODEL: 'a',
        SPRECHSTUNDE_LLM_FALLBACK_MODEL: 'b',
        SPRECHSTUNDE_LLM_ATTEMPT_TIMEOUT: '9',
      }) as llm.FallbackAdapter
    ).attemptTimeout,
    9,
  );
});
