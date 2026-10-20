import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type APIConnectOptions, initializeLogger, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { ttsStreamLine } from './metrics.js';
import { MeasuredTTS, StreamMeter, type StreamStats } from './tts-meter.js';

initializeLogger({ pretty: false, level: 'fatal' });

function clock(): { now: () => number; at: (ms: number) => void } {
  let t = 0;
  return { now: () => t, at: (ms) => void (t = ms) };
}

test('StreamMeter: ttfb and duration run from the first text', () => {
  const c = clock();
  const meter = new StreamMeter(c.now);
  c.at(1000);
  meter.text(40);
  c.at(1300);
  meter.chunk(100);
  c.at(1400);
  meter.chunk(100);
  const stats = meter.stats(false);
  assert.equal(stats.ttfbMs, 300);
  assert.equal(stats.durationMs, 400);
  assert.equal(stats.chars, 40);
  assert.equal(stats.chunks, 2);
  assert.equal(stats.audioMs, 200);
  assert.equal(stats.gaps, 0);
});

test('StreamMeter: only pauses above 150 ms count as gaps', () => {
  const c = clock();
  const meter = new StreamMeter(c.now);
  meter.text(10);
  for (const at of [100, 250, 600, 700, 1500]) {
    c.at(at);
    meter.chunk(20);
  }
  const stats = meter.stats(false);
  assert.equal(stats.gaps, 2);
  assert.equal(stats.maxGapMs, 800);
  assert.equal(stats.gapsAwaitingText, 0);
});

test('StreamMeter: a pause in which new text arrived is told apart from a vendor stall', () => {
  const c = clock();
  const meter = new StreamMeter(c.now);
  meter.text(10);
  c.at(100);
  meter.chunk(20);
  c.at(300);
  meter.text(10);
  c.at(600);
  meter.chunk(20);
  const stats = meter.stats(false);
  assert.equal(stats.gaps, 1);
  assert.equal(stats.gapsAwaitingText, 1);
});

test('StreamMeter: no audio is ttfb -1', () => {
  const meter = new StreamMeter(clock().now);
  meter.text(5);
  assert.equal(meter.stats(true).ttfbMs, -1);
  assert.equal(meter.stats(true).cancelled, true);
});

test('ttsStreamLine: numbers and flags only', () => {
  const stats: StreamStats = {
    ttfbMs: 1,
    durationMs: 2,
    chars: 3,
    chunks: 4,
    audioMs: 5,
    gaps: 6,
    maxGapMs: 7,
    gapsAwaitingText: 0,
    cancelled: false,
  };
  assert.deepEqual(ttsStreamLine(stats, 'kugel', 9), { type: 'tts_stream', ts: 9, provider: 'kugel', ...stats });
});

class FakeStream extends tts.SynthesizeStream {
  label = 'fake.stream';
  protected async run(): Promise<void> {
    let n = 0;
    for await (const input of this.input) {
      if (input === tts.SynthesizeStream.FLUSH_SENTINEL) continue;
      const frame = new AudioFrame(new Int16Array(240), 24000, 1, 240);
      this.queue.put({ requestId: 'r', segmentId: `s${n++}`, frame, final: false });
    }
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

class FakeTTS extends tts.TTS {
  label = 'fake';
  constructor() {
    super(24000, 1, { streaming: true });
  }
  synthesize(): tts.ChunkedStream {
    throw new Error('not used');
  }
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new FakeStream(this, options?.connOptions);
  }
}

test('MeasuredTTS: audio passes through and the stats arrive once the stream ends', async () => {
  const seen: StreamStats[] = [];
  const stream = new MeasuredTTS(new FakeTTS(), (s) => seen.push(s)).stream();
  stream.pushText('Guten Tag.');
  stream.pushText('Wie geht es?');
  stream.endInput();
  let frames = 0;
  for await (const audio of stream) {
    if (audio !== tts.SynthesizeStream.END_OF_STREAM) frames++;
  }
  assert.equal(frames, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.chars, 'Guten Tag.'.length + 'Wie geht es?'.length);
  assert.equal(seen[0]!.chunks, 2);
  assert.ok(seen[0]!.ttfbMs >= 0);
  assert.equal(seen[0]!.cancelled, false);
});
