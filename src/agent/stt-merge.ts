import { type APIConnectOptions, stt } from '@livekit/agents';
import type { AudioBuffer } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

/** Joins frames in one copy; all frames must share sample rate and channel count. */
export function concatFrames(frames: AudioFrame[]): AudioFrame {
  const first = frames[0];
  if (!first) throw new TypeError('no audio frames');
  const length = frames.reduce((sum, frame) => sum + frame.data.length, 0);
  const data = new Int16Array(length);
  let offset = 0;
  let samplesPerChannel = 0;
  for (const frame of frames) {
    if (frame.sampleRate !== first.sampleRate || frame.channels !== first.channels) {
      throw new TypeError('audio frames differ in sample rate or channel count');
    }
    data.set(frame.data, offset);
    offset += frame.data.length;
    samplesPerChannel += frame.samplesPerChannel;
  }
  return new AudioFrame(data, first.sampleRate, first.channels, samplesPerChannel);
}

/**
 * Hands a batch STT one contiguous frame. `mergeFrames` in @livekit/agents 1.9.3 copies the whole
 * buffer for every frame it appends, so a 12 s utterance blocked the event loop for 12 s
 * (2026-10-16); a single frame passes through it untouched. Remove once upstream is linear.
 */
export class ContiguousSTT extends stt.STT {
  label: string;

  constructor(private readonly inner: stt.STT) {
    super(inner.capabilities);
    this.label = inner.label;
  }

  get model(): string {
    return this.inner.model;
  }

  get provider(): string {
    return this.inner.provider;
  }

  protected _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frame = Array.isArray(buffer) ? concatFrames(buffer) : buffer;
    return this.inner.recognize(frame, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    return this.inner.stream(options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
