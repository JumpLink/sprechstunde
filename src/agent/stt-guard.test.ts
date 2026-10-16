import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AudioBuffer, asLanguageCode, initializeLogger, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { StallGuardSTT } from './stt-guard.js';

initializeLogger({ pretty: false, level: 'fatal' });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function frame(): AudioFrame {
  return new AudioFrame(new Int16Array(160), 16000, 1, 160);
}

interface FakeOptions {
  /** Delay between the end of speech and the final transcript; the guard may stall first. */
  finalAfterMs?: number;
  /** Mimics a provider stream whose cleanup throws. */
  closeThrows?: boolean;
}

/** A streaming STT that reports speech and then, like an overloaded queue, never answers. */
class FakeSTT extends stt.STT {
  label: string;
  streams: FakeStream[] = [];

  constructor(
    private readonly answer: string | null,
    private readonly options: FakeOptions = {},
  ) {
    super({ streaming: true, interimResults: false });
    this.label = `fake(${answer ?? 'silent'})`;
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('not used');
  }

  stream(): stt.SpeechStream {
    const stream = new FakeStream(this, this.answer, this.options);
    this.streams.push(stream);
    return stream;
  }
}

class FakeStream extends stt.SpeechStream {
  label = 'FakeStream';
  /** Frames this stream received, i.e. what the guard forwarded to it. */
  frames = 0;

  constructor(
    owner: FakeSTT,
    private readonly answer: string | null,
    private readonly options: FakeOptions,
  ) {
    super(owner);
  }

  protected async run(): Promise<void> {
    this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    const transcribe = async () => {
      if (this.answer === null) return;
      await sleep(this.options.finalAfterMs ?? 0);
      if (this.queue.closed) return;
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [{ text: this.answer, language: asLanguageCode('de'), startTime: 0, endTime: 0, confidence: 1 }],
      });
    };
    void transcribe();
    for await (const item of this.input) {
      if (item !== stt.SpeechStream.FLUSH_SENTINEL) this.frames++;
    }
  }

  close(): void {
    super.close();
    if (this.options.closeThrows) throw new Error('close failed');
  }
}

/** A batch STT; `text` null makes it fail. */
class FakeBatchSTT extends stt.STT {
  label = 'fake-batch';
  frames = 0;

  constructor(
    private readonly text: string | null,
    private readonly takesMs = 0,
  ) {
    super({ streaming: false, interimResults: false });
  }

  protected async _recognize(buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    this.frames += Array.isArray(buffer) ? buffer.length : 1;
    await sleep(this.takesMs);
    if (this.text === null) throw new Error('rescue failed');
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: this.text, language: asLanguageCode('de'), startTime: 0, endTime: 0, confidence: 1 }],
    };
  }

  stream(): stt.SpeechStream {
    throw new Error('not used');
  }
}

async function firstTranscript(sttInstance: stt.STT, timeoutMs: number): Promise<string> {
  const stream = sttInstance.stream();
  stream.pushFrame(frame());
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs));
  const read = (async () => {
    for await (const event of stream) {
      if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) return event.alternatives![0]!.text;
    }
    throw new Error('stream ended without a transcript');
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    stream.close();
  }
}

/** Every final transcript until the stream ends — a stalled stream fails once the rescue is in. */
async function allTranscripts(sttInstance: stt.STT, timeoutMs: number): Promise<string[]> {
  sttInstance.on('error', () => {});
  const stream = sttInstance.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs } });
  stream.pushFrame(frame());
  const found: string[] = [];
  for await (const event of stream) {
    if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) found.push(event.alternatives![0]!.text);
  }
  return found;
}

test('a silent STT behind the stall guard hands over to the fallback', async () => {
  const adapter = new stt.FallbackAdapter({
    sttInstances: [new StallGuardSTT(new FakeSTT(null), 150, new FakeBatchSTT(null)), new FakeSTT('Hallo')],
    retryIntervalMs: 0,
  });
  assert.equal(await firstTranscript(adapter, 3000), 'Hallo');
});

test('the stall guard passes a timely transcript through', async () => {
  const guard = new StallGuardSTT(new FakeSTT('Guten Tag'), 150, new FakeBatchSTT(''));
  assert.equal(await firstTranscript(guard, 1000), 'Guten Tag');
});

test('the stall guard rescues the stalled utterance with the batch STT', async () => {
  const rescue = new FakeBatchSTT('Gerettet');
  assert.equal(await firstTranscript(new StallGuardSTT(new FakeSTT(null), 150, rescue), 3000), 'Gerettet');
  assert.ok(rescue.frames >= 1);
});

test('a late transcript after the rescue is not sent twice', async () => {
  // The inner stream answers 200 ms after the guard gave up on it, while the rescue still runs.
  const guard = new StallGuardSTT(new FakeSTT('Spät', { finalAfterMs: 200 }), 150, new FakeBatchSTT('Gerettet', 300));
  assert.deepEqual(await allTranscripts(guard, 3000), ['Gerettet']);
});

test('a throwing close does not hide the stall error', async () => {
  // Only the stall error makes LiveKit reconnect and the fallback move on.
  const guard = new StallGuardSTT(new FakeSTT(null, { closeThrows: true }), 150, new FakeBatchSTT(null));
  guard.on('error', () => {});
  const stream = guard.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 5000 } });
  stream.pushFrame(frame());
  const seen: stt.SpeechEvent[] = [];
  for await (const event of stream) seen.push(event);
  assert.match(stream.terminalError?.message ?? '', /no transcript/);
});

test('a hang-up mid-utterance ends the stream without an error', async () => {
  // The caller is gone before the transcript arrives: writing it would hit a closed queue.
  const guard = new StallGuardSTT(new FakeSTT('Hallo', { finalAfterMs: 100 }), 5000, new FakeBatchSTT(''));
  const errors: unknown[] = [];
  guard.on('error', (event) => errors.push(event));
  const stream = guard.stream();
  stream.pushFrame(frame());
  await sleep(20);
  stream.close();
  await sleep(250);
  assert.deepEqual(errors, []);
  assert.equal(stream.terminalError, undefined);
});
