import { type APIConnectOptions, tts } from '@livekit/agents';

/** A pause between two audio chunks longer than this is audible as a break. */
export const GAP_MS = 150;

/** What one streaming synthesis did, in numbers only: never the text. */
export interface StreamStats {
  /** Text sent → first audio chunk; -1 when no audio came. */
  ttfbMs: number;
  /** Text sent → last audio chunk. */
  durationMs: number;
  chars: number;
  chunks: number;
  audioMs: number;
  /** Pauses between chunks above {@link GAP_MS}. */
  gaps: number;
  maxGapMs: number;
  /** Of those pauses, the ones in which new text arrived: the vendor was waiting for us, not stalling. */
  gapsAwaitingText: number;
  cancelled: boolean;
}

/** Times the chunks of one stream against the text that was fed to it. */
export class StreamMeter {
  #startedAt: number | undefined;
  #lastTextAt = 0;
  #firstChunkAt: number | undefined;
  #lastChunkAt = 0;
  #chars = 0;
  #chunks = 0;
  #audioMs = 0;
  #gaps = 0;
  #maxGapMs = 0;
  #gapsAwaitingText = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get started(): boolean {
    return this.#startedAt !== undefined;
  }

  /** Text goes to the vendor; the first call starts the clock, like `markStarted` in the SDK. */
  text(chars: number): void {
    const at = this.now();
    this.#startedAt ??= at;
    this.#lastTextAt = at;
    this.#chars += chars;
  }

  chunk(audioMs: number): void {
    const at = this.now();
    if (this.#firstChunkAt === undefined) {
      this.#firstChunkAt = at;
    } else {
      const gap = at - this.#lastChunkAt;
      if (gap > GAP_MS) {
        this.#gaps++;
        this.#maxGapMs = Math.max(this.#maxGapMs, gap);
        if (this.#lastTextAt > this.#lastChunkAt) this.#gapsAwaitingText++;
      }
    }
    this.#lastChunkAt = at;
    this.#chunks++;
    this.#audioMs += audioMs;
  }

  stats(cancelled: boolean): StreamStats {
    const start = this.#startedAt ?? 0;
    return {
      ttfbMs: this.#firstChunkAt === undefined ? -1 : Math.round(this.#firstChunkAt - start),
      durationMs: this.#chunks === 0 ? 0 : Math.round(this.#lastChunkAt - start),
      chars: this.#chars,
      chunks: this.#chunks,
      audioMs: Math.round(this.#audioMs),
      gaps: this.#gaps,
      maxGapMs: Math.round(this.#maxGapMs),
      gapsAwaitingText: this.#gapsAwaitingText,
      cancelled,
    };
  }
}

/**
 * Measures a streaming TTS that reports nothing itself. KugelAudio's stream never tells the SDK
 * when text went out (`markStarted`), so the SDK emits no `tts_metrics` for it. This wrapper does
 * that, which gives the usual `tts_metrics` line, and hands the chunk timing to `onStats` as well.
 */
export class MeasuredTTS extends tts.TTS {
  label: string;

  #forwardError = (error: unknown): void => {
    this.emit('error', error as never);
  };

  constructor(
    private readonly inner: tts.TTS,
    private readonly onStats: (stats: StreamStats) => void,
    private readonly now?: () => number,
  ) {
    super(inner.sampleRate, inner.numChannels, inner.capabilities);
    this.label = `Measured(${inner.label})`;
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
    return this.inner.synthesize(text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new MeasuredStream(
      this,
      this.inner.stream(options),
      this.onStats,
      new StreamMeter(this.now),
      options?.connOptions,
    );
  }

  async close(): Promise<void> {
    this.inner.off('error', this.#forwardError);
    await this.inner.close();
  }

  async releaseIdleConnections(): Promise<void> {
    await this.inner.releaseIdleConnections();
  }
}

class MeasuredStream extends tts.SynthesizeStream {
  label: string;

  constructor(
    owner: MeasuredTTS,
    private readonly inner: tts.SynthesizeStream,
    private readonly onStats: (stats: StreamStats) => void,
    private readonly meter: StreamMeter,
    connOptions?: APIConnectOptions,
  ) {
    super(owner, connOptions);
    this.label = `MeasuredStream<${inner.label}>`;
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
          this.inner.flush();
          continue;
        }
        // The SDK anchors `tts_metrics` on this call; the meter keeps the same anchor.
        this.markStarted();
        this.meter.text(input.length);
        this.inner.pushText(input);
      }
      this.inner.endInput();
    };

    const forwardAudio = async (): Promise<void> => {
      for await (const audio of this.inner) {
        if (this.abortController.signal.aborted) break;
        if (audio !== tts.SynthesizeStream.END_OF_STREAM) {
          this.meter.chunk((audio.frame.samplesPerChannel / audio.frame.sampleRate) * 1000);
        }
        this.queue.put(audio);
      }
    };

    try {
      await Promise.all([forwardInput(), forwardAudio()]);
    } finally {
      this.abortController.signal.removeEventListener('abort', onAbort);
      this.inner.close();
      if (this.meter.started) this.onStats(this.meter.stats(this.abortController.signal.aborted));
    }
  }
}
