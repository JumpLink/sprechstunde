import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startWatchdog } from './watchdog.js';

function run(results: (boolean | Error)[], failures: number) {
  let calls = 0;
  let dead = 0;
  const stop = startWatchdog({
    probe: async () => {
      const result = results[Math.min(calls++, results.length - 1)]!;
      if (result instanceof Error) throw result;
      return result;
    },
    onDead: () => dead++,
    intervalMs: 2,
    failures,
  });
  return { stop, dead: () => dead, calls: () => calls };
}

test('a dead worker is reported once after enough failures in a row', async () => {
  const w = run([false], 3);
  await sleep(40);
  w.stop();
  assert.equal(w.dead(), 1);
});

test('a probe that throws counts as a failure', async () => {
  const w = run([new Error('ECONNREFUSED')], 2);
  await sleep(30);
  w.stop();
  assert.equal(w.dead(), 1);
});

test('a healthy probe resets the count', async () => {
  // Startup reports unhealthy until the worker has registered; that must not kill it.
  const w = run([false, false, true, false, false, true], 3);
  await sleep(40);
  w.stop();
  assert.equal(w.dead(), 0);
});
