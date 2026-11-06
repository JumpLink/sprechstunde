import { type APIConnectOptions, tts } from '@livekit/agents';
import { type AudioTagDialect, AudioTagRewriter, rewriteAudioTags } from '../core/audio-tags.js';

/**
 * A voice that does not read the model's audio tags as written. When the model writes `[chuckles]`,
 * this wrapper rewrites the cue in the inner voice's dialect (Voxtral 3: `[chuckle]`), or removes it
 * for a voice that would speak it out. The inner voice measures itself, so its metrics and errors
 * are passed on as they are.
 */
export class AudioTagTTS extends tts.TTS {
  label: string;

  #forwardMetrics = (metrics: unknown): void => {
    this.emit('metrics_collected', metrics as never);
  };

  #forwardError = (error: unknown): void => {
    this.emit('error', error as never);
  };

  constructor(
    private readonly inner: tts.TTS,
    readonly dialect?: AudioTagDialect,
  ) {
    super(inner.sampleRate, inner.numChannels, inner.capabilities);
    this.label = `AudioTags[${dialect ?? 'none'}](${inner.label})`;
    inner.on('metrics_collected', this.#forwardMetrics);
    inner.on('error', this.#forwardError);
  }

  get model(): string {
    return this.inner.model;
  }

  get provider(): string {
    return this.inner.provider;
  }

  get _wrappedTts(): readonly tts.TTS[] {
    return [this.inner];
  }

  protected markupProviderKey(): string {
    return this.inner.markup.providerKey;
  }

  _setExpressive(enabled: boolean): void {
    super._setExpressive(enabled);
    this.inner._setExpressive(enabled);
  }

  prewarm(): void {
    this.inner.prewarm();
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return this.inner.synthesize(rewriteAudioTags(text, this.dialect), connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new AudioTagStream(this, this.inner.stream(options), options?.connOptions);
  }

  async close(): Promise<void> {
    this.inner.off('metrics_collected', this.#forwardMetrics);
    this.inner.off('error', this.#forwardError);
    await this.inner.close();
  }

  async releaseIdleConnections(): Promise<void> {
    await this.inner.releaseIdleConnections();
  }
}

class AudioTagStream extends tts.SynthesizeStream {
  label: string;
  // The inner stream reports the metrics; reporting them here too would count every reply twice.
  protected emitMetrics = false;
  readonly #rewriter: AudioTagRewriter;

  constructor(
    owner: AudioTagTTS,
    private readonly inner: tts.SynthesizeStream,
    connOptions?: APIConnectOptions,
  ) {
    super(owner, connOptions);
    this.label = `AudioTagStream<${inner.label}>`;
    this.#rewriter = new AudioTagRewriter(owner.dialect);
  }

  get error(): Error | undefined {
    return super.error ?? this.inner.error;
  }

  protected async run(): Promise<void> {
    const onAbort = (): void => this.inner.close();
    this.abortController.signal.addEventListener('abort', onAbort, { once: true });

    const forwardInput = async (): Promise<void> => {
      for await (const input of this.input) {
        if (this.abortController.signal.aborted) break;
        if (input === tts.SynthesizeStream.FLUSH_SENTINEL) {
          // A `[` still open at the end of a segment was no tag; it goes out before the flush.
          const rest = this.#rewriter.flush();
          if (rest) this.inner.pushText(rest);
          this.inner.flush();
          continue;
        }
        const text = this.#rewriter.push(input);
        if (text) this.inner.pushText(text);
      }
      const rest = this.#rewriter.flush();
      if (rest) this.inner.pushText(rest);
      this.inner.endInput();
    };

    const forwardAudio = async (): Promise<void> => {
      for await (const audio of this.inner) {
        if (this.abortController.signal.aborted) break;
        this.queue.put(audio);
      }
    };

    try {
      await Promise.all([forwardInput(), forwardAudio()]);
    } finally {
      this.abortController.signal.removeEventListener('abort', onAbort);
      this.inner.close();
    }
  }
}
