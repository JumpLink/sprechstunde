import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentile, splitByGap, summarize } from './stats.js';

test('percentile: nearest rank', () => {
  const table: Array<[number[], number, number | null]> = [
    [[], 50, null],
    [[7], 50, 7],
    [[7], 95, 7],
    [[4, 1, 3, 2], 50, 2],
    [[4, 1, 3, 2], 95, 4],
    [Array.from({ length: 20 }, (_, i) => i + 1), 95, 19],
    [Array.from({ length: 100 }, (_, i) => i + 1), 50, 50],
    [[5, 5, 5, 9], 50, 5],
    [[5, 5, 5, 9], 75, 5],
    [[5, 5, 5, 9], 76, 9],
    [[3, 1, 2], 0, 1],
    [[3, 1, 2], 100, 3],
  ];
  for (const [values, p, expected] of table) assert.equal(percentile(values, p), expected, `${values} p${p}`);
});

test('percentile does not mutate its input', () => {
  const values = [3, 1, 2];
  percentile(values, 50);
  assert.deepEqual(values, [3, 1, 2]);
});

test('summarize', () => {
  assert.deepEqual(summarize([]), { n: 0, p50: null, p95: null, max: null });
  assert.deepEqual(summarize([10]), { n: 1, p50: 10, p95: 10, max: 10 });
  assert.deepEqual(summarize([10, 10, 30]), { n: 3, p50: 10, p95: 30, max: 30 });
});

test('splitByGap: a gap above the limit starts a new run', () => {
  const at = (...ts: number[]) => ts.map((t) => ({ ts: t }));
  assert.deepEqual(splitByGap([], 60), []);
  assert.deepEqual(splitByGap(at(5), 60), [at(5)]);
  assert.deepEqual(splitByGap(at(200, 0, 60, 120), 60), [at(0, 60, 120), at(200)]);
  assert.deepEqual(splitByGap(at(0, 61), 60), [at(0), at(61)]);
});
