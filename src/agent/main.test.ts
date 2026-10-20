import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverOptions } from './main.js';

test('the worker health endpoint binds to loopback, not to every interface', () => {
  assert.equal(serverOptions({}).host, '127.0.0.1');
  assert.equal(serverOptions({ SPRECHSTUNDE_AGENT_NAME: 'x' }).agentName, 'x');
  assert.equal(serverOptions({}).agentName, 'sprechstunde');
});
