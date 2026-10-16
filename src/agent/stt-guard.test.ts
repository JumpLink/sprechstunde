import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AudioBuffer, asLanguageCode, initializeLogger, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { StallGuardSTT } from './stt-guard.js';

initializeLogger({ pretty: false, level: 'fatal' });

/** A streaming STT that reports speech and then, like an overloaded queue, never answers. */
class FakeSTT extends stt.STT {
  label: string;

  constructor(private readonly answer: string | null) {
    super({ streaming: true, interimResults: false });
    this.label = `fake(${answer ?? 'silent'})`;
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('not used');
  }

  stream(): stt.SpeechStream {
    return new FakeStream(this, this.answer);
  }
}

class FakeStream extends stt.SpeechStream {
  label = 'FakeStream';

  constructor(
    owner: FakeSTT,
    private readonly answer: string | null,
  ) {
    super(owner);
  }

  protected async run(): Promise<void> {
    this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
    this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    if (this.answer !== null) {
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [{ text: this.answer, language: asLanguageCode('de'), startTime: 0, endTime: 0, confidence: 1 }],
      });
    }
    for await (const _ of this.input) {
      // keep consuming until the stream is closed
    }
  }
}

/** A batch STT; `text` null makes it fail. */
class FakeBatchSTT extends stt.STT {
  label = 'fake-batch';
  frames = 0;

  constructor(private readonly text: string | null) {
    super({ streaming: false, interimResults: false });
  }

  protected async _recognize(buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    this.frames += Array.isArray(buffer) ? buffer.length : 1;
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
  stream.pushFrame(new AudioFrame(new Int16Array(160), 16000, 1, 160));
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
