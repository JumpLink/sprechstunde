import { APIConnectionError, type APIConnectOptions, stt } from '@livekit/agents';
import type { AudioBuffer } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

const RESCUE_BUFFER_SECONDS = 15;
const RESCUE_TIMEOUT_MS = 5000;

/**
 * Turns a silent streaming STT into a failing one. Mistral's realtime queue sometimes accepts
 * audio and answers nothing for many seconds without an error; LiveKit's retry and fallback only
 * react to errors, so the caller hears silence. After the end of speech the stream must deliver
 * a transcript within `stallMs`, otherwise this stream fails: LiveKit reconnects, and a
 * `stt.FallbackAdapter` around it moves on to the next STT. The stalled utterance itself is
 * transcribed by the batch `rescue` STT first, so the caller does not have to repeat it.
 */
export class StallGuardSTT extends stt.STT {
  label: string;

  constructor(
    private readonly inner: stt.STT,
    private readonly stallMs: number,
    private readonly rescue: stt.STT,
  ) {
    super(inner.capabilities);
    this.label = `StallGuard(${inner.label})`;
    // The guard stream rethrows the inner failure itself; an `error` event without a listener
    // would make the EventEmitter throw "Unhandled error" on top of it.
    inner.on('error', () => {});
  }

  get model(): string {
    return this.inner.model;
  }

  get provider(): string {
    return this.inner.provider;
  }

  protected _recognize(frame: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    return this.inner.recognize(frame, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    return new StallGuardStream(this, this.inner, this.stallMs, this.rescue, options?.connOptions);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

class StallGuardStream extends stt.SpeechStream {
  label = 'StallGuardStream';

  constructor(
    guard: StallGuardSTT,
    private readonly inner: stt.STT,
    private readonly stallMs: number,
    private readonly rescue: stt.STT,
    connOptions?: APIConnectOptions,
  ) {
    super(guard, undefined, connOptions);
  }

  /** Audio since the last final transcript, i.e. what a stalled utterance consists of. */
  private pending: AudioFrame[] = [];
  private pendingSeconds = 0;

  private remember(frame: AudioFrame): void {
    this.pending.push(frame);
    this.pendingSeconds += frame.samplesPerChannel / frame.sampleRate;
    while (this.pendingSeconds > RESCUE_BUFFER_SECONDS && this.pending.length > 1) {
      const dropped = this.pending.shift()!;
      this.pendingSeconds -= dropped.samplesPerChannel / dropped.sampleRate;
    }
  }

  protected async run(): Promise<void> {
    // Retries belong to this stream (see `mainTask`), so the inner one fails fast.
    const child = this.inner.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 } });
    let finished = false;
    void (async () => {
      for await (const item of this.input) {
        // A retry starts a new run that reads the same input; the old forwarder gives way.
        if (finished) break;
        if (item === StallGuardStream.FLUSH_SENTINEL) {
          child.flush();
        } else {
          this.remember(item);
          child.pushFrame(item);
        }
      }
      if (!finished) child.endInput();
    })().catch(() => {});

    let timer: NodeJS.Timeout | undefined;
    let stalled = false;
    let rescuing: Promise<void> | undefined;
    const disarm = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    try {
      for await (const event of child) {
        if (event.type === stt.SpeechEventType.END_OF_SPEECH) {
          disarm();
          timer = setTimeout(() => {
            stalled = true;
            // The child stays open until the rescue is done, so the loop below cannot end early.
            rescuing = this.rescueUtterance().finally(() => child.close());
          }, this.stallMs);
        } else if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
          disarm();
          this.pending = [];
          this.pendingSeconds = 0;
        }
        this.queue.put(event);
      }
    } finally {
      disarm();
      finished = true;
      await rescuing;
      child.close();
    }
    if (stalled) throw new APIConnectionError({ message: `no transcript ${this.stallMs} ms after end of speech` });
    if (child._failed) {
      throw new APIConnectionError({ message: child.terminalError?.message ?? 'inner STT stream failed' });
    }
  }

  /** The fallback only starts with the next utterance, so the stalled one is transcribed here. */
  private async rescueUtterance(): Promise<void> {
    if (this.pending.length === 0) return;
    try {
      const event = await this.rescue.recognize(this.pending.slice(), AbortSignal.timeout(RESCUE_TIMEOUT_MS));
      const text = event.alternatives?.[0]?.text.trim();
      if (text) this.queue.put({ ...event, type: stt.SpeechEventType.FINAL_TRANSCRIPT });
    } catch {
      // Same outcome as without a rescue: the stall error below moves the fallback on.
    }
  }
}
