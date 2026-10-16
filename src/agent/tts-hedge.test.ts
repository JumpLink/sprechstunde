import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIConnectionError, APIError, type APIConnectOptions, initializeLogger, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { HedgedTTS } from './tts-hedge.js';

initializeLogger({ pretty: false, level: 'fatal' });

const SAMPLE_RATE = 16000;
const FRAMES_PER_CALL = 3;

type Step = { delayMs: number; fail?: boolean };

/** Resolves early on abort, so a cancelled attempt does not keep the test waiting. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A non-streaming TTS whose n-th call behaves like the n-th entry of `plan` (last one repeats). */
class FakeTTS extends tts.TTS {
  label = 'fake';
  calls: FakeChunkedStream[] = [];

  constructor(private readonly plan: Step[]) {
    super(SAMPLE_RATE, 1, { streaming: false });
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    const step = this.plan[Math.min(this.calls.length, this.plan.length - 1)]!;
    const stream = new FakeChunkedStream(this, step, text, connOptions, abortSignal);
    this.calls.push(stream);
    return stream;
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported');
  }
}

class FakeChunkedStream extends tts.ChunkedStream {
  label = 'fake.ChunkedStream';
  /** Set when the attempt was cancelled before it produced anything. */
  interrupted = false;
  frames = 0;

  constructor(
    owner: FakeTTS,
    private readonly step: Step,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, owner, connOptions, abortSignal);
  }

  protected async run(): Promise<void> {
    await sleep(this.step.delayMs, this.abortSignal);
    if (this.abortSignal.aborted) {
      this.interrupted = true;
      return;
    }
    if (this.step.fail) {
      throw new APIConnectionError({ message: 'fake provider failure', options: { retryable: true } });
    }
    for (let i = 0; i < FRAMES_PER_CALL; i++) {
      if (this.abortSignal.aborted) return;
      this.frames++;
      this.queue.put({
        requestId: 'fake',
        segmentId: 'fake',
        frame: new AudioFrame(new Int16Array(160), SAMPLE_RATE, 1, 160),
        final: i === FRAMES_PER_CALL - 1,
      });
    }
  }
}

async function collect(stream: tts.ChunkedStream): Promise<number> {
  let frames = 0;
  for await (const audio of stream) {
    assert.equal(audio.frame.sampleRate, SAMPLE_RATE);
    frames++;
  }
  return frames;
}

test('a fast inner TTS is never hedged', async () => {
  const inner = new FakeTTS([{ delayMs: 0 }]);
  const frames = await collect(new HedgedTTS(inner, 500).synthesize('Guten Tag'));
  assert.equal(frames, FRAMES_PER_CALL);
  assert.equal(inner.calls.length, 1);
});

test('a stalling first request is overtaken by the hedge', async () => {
  const inner = new FakeTTS([{ delayMs: 2000 }, { delayMs: 0 }]);
  const started = Date.now();
  const frames = await collect(new HedgedTTS(inner, 100).synthesize('Guten Tag'));
  const elapsed = Date.now() - started;
  assert.equal(frames, FRAMES_PER_CALL);
  assert.equal(inner.calls.length, 2);
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  assert.equal(inner.calls[0]!.interrupted, true);
  assert.equal(inner.calls[0]!.frames, 0);
});

test('a failing request hedges immediately and the second one delivers', async () => {
  const inner = new FakeTTS([{ delayMs: 0, fail: true }, { delayMs: 0 }]);
  // The hedge timer is far away: only the failure can start the second attempt.
  const frames = await collect(new HedgedTTS(inner, 10_000).synthesize('Guten Tag'));
  assert.equal(frames, FRAMES_PER_CALL);
  assert.equal(inner.calls.length, 2);
});

test('both attempts failing fails the stream', async () => {
  const inner = new FakeTTS([{ delayMs: 0, fail: true }]);
  const stream = new HedgedTTS(inner, 50).synthesize('Guten Tag', {
    maxRetry: 0,
    retryIntervalMs: 0,
    timeoutMs: 5000,
  });
  assert.equal(await collect(stream), 0);
  assert.ok(stream.error instanceof APIError, `error was ${stream.error}`);
  assert.equal(inner.calls.length, 2);
});

test('aborting the outer stream cancels both attempts', async () => {
  const inner = new FakeTTS([{ delayMs: 2000 }]);
  const controller = new AbortController();
  const stream = new HedgedTTS(inner, 50).synthesize('Guten Tag', undefined, controller.signal);
  setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  await collect(stream);
  assert.ok(Date.now() - started < 1000, 'abort did not end the stream');
  assert.equal(inner.calls.length, 2);
  assert.ok(inner.calls.every((call) => call.interrupted));
});
