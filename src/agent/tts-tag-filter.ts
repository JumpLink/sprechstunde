import { type APIConnectOptions, tts } from '@livekit/agents';
import { AudioTagStripper, stripAudioTags } from '../core/audio-tags.js';

/**
 * A voice that cannot read audio tags, standing in for one that can. When the primary voice of a
 * call reads `[chuckles]` as a cue, the model writes tags; the fallback voice would speak them out,
 * so this wrapper removes them from the text before it gets there. The inner voice measures
 * itself, so its metrics and errors are passed on as they are.
 */
export class TagFreeTTS extends tts.TTS {
  label: string;

  #forwardMetrics = (metrics: unknown): void => {
    this.emit('metrics_collected', metrics as never);
  };

  #forwardError = (error: unknown): void => {
    this.emit('error', error as never);
  };

  constructor(private readonly inner: tts.TTS) {
    super(inner.sampleRate, inner.numChannels, inner.capabilities);
    this.label = `TagFree(${inner.label})`;
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
    return this.inner.synthesize(stripAudioTags(text), connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new TagFreeStream(this, this.inner.stream(options), options?.connOptions);
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

class TagFreeStream extends tts.SynthesizeStream {
  label: string;
  // The inner stream reports the metrics; reporting them here too would count every reply twice.
  protected emitMetrics = false;
  readonly #stripper = new AudioTagStripper();

  constructor(
    owner: TagFreeTTS,
    private readonly inner: tts.SynthesizeStream,
    connOptions?: APIConnectOptions,
  ) {
    super(owner, connOptions);
    this.label = `TagFreeStream<${inner.label}>`;
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
          const rest = this.#stripper.flush();
          if (rest) this.inner.pushText(rest);
          this.inner.flush();
          continue;
        }
        const text = this.#stripper.push(input);
        if (text) this.inner.pushText(text);
      }
      const rest = this.#stripper.flush();
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
