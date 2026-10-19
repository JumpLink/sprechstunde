import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mistralServer } from './mistral.js';

test('mistralServer: empty means the global endpoint', () => {
  assert.deepEqual(mistralServer({ SPRECHSTUNDE_MISTRAL_SERVER: '' }), {});
  assert.deepEqual(mistralServer({}), {});
});

test('mistralServer: a region name or a URL', () => {
  assert.deepEqual(mistralServer({ SPRECHSTUNDE_MISTRAL_SERVER: 'eu' }), { server: 'eu' });
  assert.deepEqual(mistralServer({ SPRECHSTUNDE_MISTRAL_SERVER: 'https://example.test' }), {
    serverURL: 'https://example.test',
  });
});

test('mistralServer: a typo fails instead of silently using the global endpoint', () => {
  assert.throws(() => mistralServer({ SPRECHSTUNDE_MISTRAL_SERVER: 'europe' }));
});
