import {
  APIConnectionError,
  APIStatusError,
  type APIConnectOptions,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

/** Kyutai Pocket TTS speaks at 24 kHz; the server says so in `X-Sample-Rate` as well. */
export const POCKET_SAMPLE_RATE = 24000;
export const DEFAULT_POCKET_URL = 'http://127.0.0.1:8090';

/**
 * Kyutai Pocket TTS on our own server (`deploy/pocket-tts/server.py`): one HTTP request per chunk,
 * streamed back as raw 16-bit PCM. The server answers 503 when every worker is busy, which
 * reaches a `tts.FallbackAdapter` as an ordinary API error. `spellOut` turns digits into words
 * first: Pocket TTS swallows them (see `core/spoken-numbers.ts`).
 */
export class PocketTTS extends tts.TTS {
  label = 'pocket.TTS';

  constructor(
    readonly url: string,
    readonly voice?: string,
    readonly spellOut?: (text: string) => string,
  ) {
    super(POCKET_SAMPLE_RATE, 1, { streaming: false });
  }

  get model(): string {
    return 'pocket-tts';
  }

  get provider(): string {
    return 'kyutai-pocket';
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new PocketChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Pocket TTS takes one request per chunk; wrap it in a tts.StreamAdapter');
  }
}

class PocketChunkedStream extends tts.ChunkedStream {
  label = 'pocket.ChunkedStream';
  #timeoutMs: number;

  constructor(
    private readonly owner: PocketTTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, owner, connOptions, abortSignal);
    this.#timeoutMs = (connOptions ?? DEFAULT_API_CONNECT_OPTIONS).timeoutMs;
  }

  protected async run(): Promise<void> {
    // The timeout covers waiting for the answer to start; a long answer may stream for longer.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('timed out')), this.#timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.owner.url}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: this.owner.spellOut ? this.owner.spellOut(this.inputText) : this.inputText,
          voice: this.owner.voice,
        }),
        signal: AbortSignal.any([this.abortSignal, timeout.signal]),
      });
    } catch (error) {
      if (this.abortSignal.aborted) return;
      throw new APIConnectionError({ message: `pocket: ${(error as Error).message}`, options: { retryable: true } });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) {
      throw new APIStatusError({
        message: `pocket: HTTP ${response.status}`,
        // 503 means "all workers busy": retrying the same server right away would only wait again.
        options: { statusCode: response.status, retryable: false },
      });
    }

    const requestId = shortuuid();
    const bytes = new AudioByteStream(POCKET_SAMPLE_RATE, 1);
    let pending: AudioFrame | undefined;
    const put = (frame: AudioFrame) => {
      if (pending) this.queue.put({ requestId, segmentId: requestId, frame: pending, final: false });
      pending = frame;
    };
    try {
      for await (const chunk of response.body) {
        for (const frame of bytes.write(chunk)) put(frame);
      }
      for (const frame of bytes.flush()) put(frame);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      throw new APIConnectionError({ message: `pocket: ${(error as Error).message}`, options: { retryable: true } });
    }
    if (pending) this.queue.put({ requestId, segmentId: requestId, frame: pending, final: true });
  }
}

/**
 * Reserve one of the server's sessions for a call. `undefined` when all are taken or the server
 * is unreachable: the call then speaks with the fallback voice from the start, so the caller
 * never hears the voice change for capacity reasons.
 */
export async function openPocketSession(url: string, timeoutMs = 500): Promise<(() => Promise<void>) | undefined> {
  try {
    const response = await fetch(`${url}/sessions`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 201) return undefined;
    const { id } = (await response.json()) as { id: string };
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      // The server expires forgotten sessions; a failed release costs capacity, not correctness.
      await fetch(`${url}/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(timeoutMs),
      }).catch(() => undefined);
    };
  } catch {
    return undefined;
  }
}
