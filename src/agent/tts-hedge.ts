import {
  APIConnectionError,
  APIError,
  type APIConnectOptions,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from '@livekit/agents';

/** What one attempt reported back to {@link HedgedChunkedStream.run}. */
type AttemptOutcome = { won: boolean; error?: Error };

/**
 * Sends a second, identical request when the first one goes quiet.
 *
 * Mistral's non-streaming TTS occasionally needs 7–9 s for a chunk that normally takes 0.5 s —
 * a single slow request, not an error, so neither LiveKit's retry nor a `tts.FallbackAdapter`
 * reacts and the caller hears a gap mid-answer. After `hedgeMs` without a single audio frame a
 * second request goes out; whichever delivers the first frame wins, the other is aborted. One
 * hedge per chunk, so a bad provider day costs at most twice the traffic. An attempt that fails
 * lets the other one continue and starts the hedge early; only both failing fails the stream,
 * where retry and fallback take over again.
 */
export class HedgedTTS extends tts.TTS {
  label: string;

  constructor(
    private readonly inner: tts.TTS,
    private readonly hedgeMs: number,
  ) {
    super(inner.sampleRate, inner.numChannels, inner.capabilities);
    this.label = `Hedged(${inner.label})`;
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
    return new HedgedChunkedStream(this, this.inner, this.hedgeMs, text, connOptions, abortSignal);
  }

  /** Hedging only makes sense per request; a `tts.StreamAdapter` wraps this, not the other way. */
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return this.inner.stream(options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  async releaseIdleConnections(): Promise<void> {
    await this.inner.releaseIdleConnections();
  }
}

class HedgedChunkedStream extends tts.ChunkedStream {
  label: string;

  #inner: tts.TTS;
  #hedgeMs: number;
  #attemptOptions: APIConnectOptions;
  #attempts: tts.ChunkedStream[] = [];
  #winner?: tts.ChunkedStream;

  constructor(
    owner: HedgedTTS,
    inner: tts.TTS,
    hedgeMs: number,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, owner, connOptions, abortSignal);
    this.#inner = inner;
    this.#hedgeMs = hedgeMs;
    // Retries belong to this stream (see `run`), so an attempt fails fast and the hedge decides.
    this.#attemptOptions = { ...(connOptions ?? DEFAULT_API_CONNECT_OPTIONS), maxRetry: 0 };
    this.label = `HedgedChunkedStream<${inner.label}>`;
  }

  protected async run(): Promise<void> {
    const outcomes: Promise<AttemptOutcome>[] = [this.#attempt()];
    let hedged = false;
    let timer: NodeJS.Timeout | undefined;
    const hedge = () => {
      if (hedged || this.#winner || this.abortSignal.aborted) return;
      hedged = true;
      clearTimeout(timer);
      timer = undefined;
      outcomes.push(this.#attempt());
    };
    timer = setTimeout(hedge, this.#hedgeMs);

    let firstError: Error | undefined;
    try {
      // `outcomes` grows when the hedge starts, so the length is re-read every round.
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = await outcomes[i]!;
        if (outcome.won) return;
        if (outcome.error) {
          firstError ??= outcome.error;
          // A failed attempt is as good a reason to hedge as silence is, and a faster one.
          hedge();
        }
      }
    } finally {
      clearTimeout(timer);
      for (const attempt of this.#attempts) attempt.close();
    }

    if (firstError && !this.abortSignal.aborted) {
      // Rethrow so the retry loop above us and a `tts.FallbackAdapter` see a real APIError.
      throw firstError instanceof APIError
        ? firstError
        : new APIConnectionError({
            message: `${this.#inner.label}: ${firstError.message}`,
            options: { retryable: true },
          });
    }
  }

  /**
   * One provider request. The first frame of any attempt claims the stream; a loser stops
   * reading and is aborted, so it never reaches the output queue.
   */
  async #attempt(): Promise<AttemptOutcome> {
    const stream = this.#inner.synthesize(this.inputText, this.#attemptOptions, this.abortSignal);
    this.#attempts.push(stream);
    try {
      for await (const audio of stream) {
        if (this.abortSignal.aborted) break;
        if (!this.#winner) this.#claim(stream);
        if (this.#winner !== stream) break;
        if (!this.queue.closed) this.queue.put(audio);
      }
    } catch (error) {
      return { won: false, error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      stream.close();
    }

    if (this.#winner === stream) return { won: true };
    if (this.#winner || this.abortSignal.aborted) return { won: false };
    // Iterating a failed ChunkedStream just ends; `error` is where it says why.
    return {
      won: false,
      error:
        stream.error ??
        new APIConnectionError({ message: `${this.#inner.label} returned no audio`, options: { retryable: true } }),
    };
  }

  #claim(winner: tts.ChunkedStream): void {
    this.#winner = winner;
    for (const attempt of this.#attempts) {
      if (attempt !== winner) attempt.close();
    }
  }
}
