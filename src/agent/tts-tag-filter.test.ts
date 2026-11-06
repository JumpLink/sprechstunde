import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type APIConnectOptions, initializeLogger, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { TagFreeTTS } from './tts-tag-filter.js';

initializeLogger({ pretty: false, level: 'fatal' });

/** Records the text it is fed and answers each piece with one frame. */
class RecordingStream extends tts.SynthesizeStream {
  label = 'recording.stream';
  constructor(
    owner: tts.TTS,
    private readonly seen: string[],
    connOptions?: APIConnectOptions,
  ) {
    super(owner, connOptions);
  }
  protected async run(): Promise<void> {
    let n = 0;
    for await (const input of this.input) {
      if (input === tts.SynthesizeStream.FLUSH_SENTINEL) {
        this.seen.push('<flush>');
        continue;
      }
      this.seen.push(input);
      const frame = new AudioFrame(new Int16Array(240), 24000, 1, 240);
      this.queue.put({ requestId: 'r', segmentId: `s${n++}`, frame, final: false });
    }
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

class RecordingTTS extends tts.TTS {
  label = 'recording';
  readonly seen: string[] = [];
  constructor() {
    super(24000, 1, { streaming: true });
  }
  synthesize(text: string): tts.ChunkedStream {
    this.seen.push(text);
    throw new Error('recorded');
  }
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new RecordingStream(this, this.seen, options?.connOptions);
  }
}

test('TagFreeTTS: tags never reach the inner voice, split or whole, and the flush order holds', async () => {
  const inner = new RecordingTTS();
  const stream = new TagFreeTTS(inner).stream();
  stream.pushText('[chuck');
  stream.pushText('les] Na klar.');
  stream.pushText(' Zimmer [3');
  stream.flush();
  stream.pushText('[warmly] Bis bald!');
  stream.endInput();
  let frames = 0;
  for await (const audio of stream) {
    if (audio !== tts.SynthesizeStream.END_OF_STREAM) frames++;
  }
  // The end of input flushes once more, as it does for every stream.
  assert.deepEqual(
    inner.seen.filter((text, index) => text !== '<flush>' || inner.seen[index - 1] !== '<flush>'),
    ['Na klar.', ' Zimmer ', '[3', '<flush>', 'Bis bald!', '<flush>'],
  );
  assert.equal(frames, 4);
});

test('TagFreeTTS: synthesize strips the whole text', () => {
  const inner = new RecordingTTS();
  assert.throws(() => new TagFreeTTS(inner).synthesize('[sighs] Leider voll.'), /recorded/);
  assert.deepEqual(inner.seen, ['Leider voll.']);
});
