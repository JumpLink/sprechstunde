import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLimiter } from './limiter.js';

test('createLimiter: never more than max at once, in order, and a failure frees the slot', async () => {
  const limiter = createLimiter(2);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const job = (n: number, fail = false) =>
    limiter.run(async () => {
      running++;
      peak = Math.max(peak, running);
      order.push(n);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (fail) throw new Error('boom');
      return n;
    });
  const results = await Promise.allSettled([job(1), job(2, true), job(3), job(4), job(5)]);
  assert.equal(peak, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled'],
  );
  assert.equal(limiter.active, 0);
  assert.equal(limiter.waiting, 0);
});
