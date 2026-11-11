import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdlePrompt } from './idle-prompt.js';

test('asks on the first silence, then says it is there, then stays quiet', () => {
  const idle = new IdlePrompt();
  assert.match(idle.next('away') ?? '', /still there/);
  assert.match(idle.next('away') ?? '', /still silent/);
  assert.equal(idle.next('away'), undefined);
});

test('a caller who speaks again gets the two questions back', () => {
  const idle = new IdlePrompt();
  idle.next('away');
  idle.next('away');
  assert.equal(idle.next('speaking'), undefined);
  assert.ok(idle.next('away'));
});

test('listening and speaking states ask nothing', () => {
  const idle = new IdlePrompt();
  assert.equal(idle.next('listening'), undefined);
  assert.equal(idle.next('speaking'), undefined);
});
