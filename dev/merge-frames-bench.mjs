// Reproduces the event-loop block observed on 2026-10-16 (12.3 s, cpuTime 12.2 s).
//
// `mergeFrames` in @livekit/agents (src/utils.ts:133) grows its buffer with
// `data = new Int16Array([...data, ...frame.data])`, which is quadratic in the number of frames
// and goes through a boxed JS array on every step. Every batch (non-streaming) STT call runs it:
// `stt.StreamAdapter` per VAD segment, and our StallGuard rescue over its whole pending buffer.
//
// Usage: node dev/merge-frames-bench.mjs
import { AudioFrame } from '@livekit/rtc-node';

/** Verbatim copy of @livekit/agents `mergeFrames`, array branch only. */
const mergeFrames = (frames) => {
  let samplesPerChannel = 0;
  let data = new Int16Array();
  for (const frame of frames) {
    data = new Int16Array([...data, ...frame.data]);
    samplesPerChannel += frame.samplesPerChannel;
  }
  return new AudioFrame(data, frames[0].sampleRate, frames[0].channels, samplesPerChannel);
};

const cases = [
  { label: 'one VAD segment via stt.StreamAdapter', sampleRate: 48000, frameMs: 10, seconds: 4.8 },
  { label: 'StallGuard rescue, no final transcript yet', sampleRate: 48000, frameMs: 10, seconds: 12.4 },
  { label: 'same, 20 ms frames', sampleRate: 48000, frameMs: 20, seconds: 12.4 },
];
// RESCUE_BUFFER_SECONDS = 30 is left out on purpose: quadratic in the frame count, so it runs
// for minutes and would make this script useless as a quick check.

for (const { label, sampleRate, frameMs, seconds } of cases) {
  const samplesPerFrame = (sampleRate * frameMs) / 1000;
  const count = Math.round((seconds * 1000) / frameMs);
  const frames = Array.from(
    { length: count },
    () => new AudioFrame(new Int16Array(samplesPerFrame), sampleRate, 1, samplesPerFrame),
  );
  const started = process.hrtime.bigint();
  const merged = mergeFrames(frames);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    `${seconds}s @ ${frameMs}ms = ${count} frames (${merged.samplesPerChannel} samples): ` +
      `${ms.toFixed(0)} ms blocked  — ${label}`,
  );
}
