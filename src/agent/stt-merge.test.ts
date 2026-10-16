import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioFrame } from '@livekit/rtc-node';
import { type APIConnectOptions, stt } from '@livekit/agents';
import { ContiguousSTT, concatFrames } from './stt-merge.js';

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

class RecordingSTT extends stt.STT {
  label = 'recording';
  received: unknown[] = [];

  constructor() {
    super({ streaming: false, interimResults: false });
  }

  protected async _recognize(buffer: unknown): Promise<stt.SpeechEvent> {
    this.received.push(buffer);
    return { type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [] } as unknown as stt.SpeechEvent;
  }

  stream(_options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    throw new Error('not streaming');
  }
}

test('ContiguousSTT hands the inner STT exactly one frame', async () => {
  const inner = new RecordingSTT();
  const merging = new ContiguousSTT(inner);
  const single = new AudioFrame(new Int16Array(4), 16000, 1, 4);
  await merging.recognize(single);
  await merging.recognize([single, new AudioFrame(new Int16Array(2), 16000, 1, 2)]);
  assert.equal(inner.received[0], single, 'a single frame is passed through unchanged');
  const joined = inner.received[1] as AudioFrame;
  assert.ok(joined instanceof AudioFrame);
  assert.equal(joined.samplesPerChannel, 6);
});
