import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type APIConnectOptions, initializeLogger, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { AudioTagTTS } from './tts-tag-filter.js';

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

test('AudioTagTTS: without a dialect, tags never reach the inner voice, split or whole, and the flush order holds', async () => {
  const inner = new RecordingTTS();
  const stream = new AudioTagTTS(inner).stream();
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

test('AudioTagTTS: synthesize strips the whole text', () => {
  const inner = new RecordingTTS();
  assert.throws(() => new AudioTagTTS(inner).synthesize('[sighs] Leider voll.'), /recorded/);
  assert.deepEqual(inner.seen, ['Leider voll.']);
});

test('AudioTagTTS: Voxtral gets its own tags, split or whole', async () => {
  const inner = new RecordingTTS();
  const stream = new AudioTagTTS(inner, 'voxtral').stream();
  stream.pushText('[warm');
  stream.pushText('ly] Moin! [laughs softly] Na klar.');
  stream.endInput();
  for await (const _audio of stream);
  assert.deepEqual(
    inner.seen.filter((text) => text !== '<flush>'),
    ['[emotion=warm] Moin! [laugh] Na klar.'],
  );
  assert.throws(() => new AudioTagTTS(inner, 'voxtral').synthesize('[sighs] Leider voll.'), /recorded/);
  assert.equal(inner.seen.at(-1), '[sigh] Leider voll.');
});
