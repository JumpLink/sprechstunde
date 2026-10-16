import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioFrame } from '@livekit/rtc-node';
import { concatFrames } from './stt-merge.js';

test('concatFrames keeps samples in order', () => {
  const merged = concatFrames([
    new AudioFrame(Int16Array.from([1, 2]), 16000, 1, 2),
    new AudioFrame(Int16Array.from([3]), 16000, 1, 1),
  ]);
  assert.deepEqual([...merged.data], [1, 2, 3]);
  assert.equal(merged.samplesPerChannel, 3);
});

test('concatFrames joins 30 s of 10 ms frames without blocking', () => {
  const frames = Array.from({ length: 3000 }, () => new AudioFrame(new Int16Array(480), 48000, 1, 480));
  const started = performance.now();
  const merged = concatFrames(frames);
  assert.equal(merged.samplesPerChannel, 3000 * 480);
  assert.ok(performance.now() - started < 200, 'merge took longer than 200 ms');
});

test('concatFrames rejects mixed sample rates', () => {
  assert.throws(() =>
    concatFrames([new AudioFrame(new Int16Array(1), 16000, 1, 1), new AudioFrame(new Int16Array(1), 48000, 1, 1)]),
  );
});
