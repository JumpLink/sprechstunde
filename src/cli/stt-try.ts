import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { Mistral } from '@mistralai/mistralai';
import { type RealtimeConnection, RealtimeTranscription } from '@mistralai/mistralai/extra/realtime';
import { _ } from '../i18n.js';
import { mistralClient } from '../mistral.js';

const SAMPLE_RATE = 16000;
const CHUNK_MS = 20;
const DEFAULT_MODEL = 'voxtral-mini-transcribe-realtime-2602';

/** Decode any audio file to 16 kHz mono s16le, the format the agent streams to Mistral. */
function decode(path: string): Buffer {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The TypeScript SDK's `updateSession` only sends the audio format, although the protocol (and
 * the Python SDK) also take `target_streaming_delay_ms`. Send the message ourselves.
 */
export async function setTargetDelay(connection: RealtimeConnection, ms: number): Promise<void> {
  const send = (connection as unknown as { sendJson(payload: unknown): Promise<void> }).sendJson.bind(connection);
  await send({ type: 'session.update', session: { target_streaming_delay_ms: ms } });
}

interface Run {
  /** From the last audio chunk to `transcription.done`: what the caller waits for after speaking. */
  finalMs: number;
  defaultDelayMs: number | null | undefined;
  text: string;
}

async function transcribe(client: Mistral, model: string, pcm: Buffer, delayMs?: number): Promise<Run> {
  const rt = new RealtimeTranscription((client as unknown as { _options: object })._options);
  const connection = await rt.connect(model, { timeoutMs: 10_000 });
  const defaultDelayMs = connection.session.targetStreamingDelayMs;
  if (delayMs !== undefined) await setTargetDelay(connection, delayMs);

  let audioEnd = 0;
  const done = (async () => {
    for await (const event of connection.events()) {
      const type = (event as { type?: string }).type;
      if (type === 'transcription.done') return (event as { text?: string }).text ?? '';
      if (type === 'error') throw new Error(JSON.stringify(event).slice(0, 300));
    }
    throw new Error(_('connection closed before the transcript was done'));
  })();
  // An error event may arrive while audio is still being sent; it is rethrown at `await done`.
  done.catch(() => {});

  // Paced like a live caller: one chunk per CHUNK_MS, so the measurement includes Mistral's lag.
  const chunkBytes = (SAMPLE_RATE * CHUNK_MS * 2) / 1000;
  const started = performance.now();
  for (let offset = 0, index = 0; offset < pcm.length; offset += chunkBytes, index++) {
    // The server closes the socket after an error event; report that event, not the closed socket.
    await connection.sendAudio(pcm.subarray(offset, offset + chunkBytes)).catch(async (error: unknown) => {
      await done;
      throw error;
    });
    const due = started + (index + 1) * CHUNK_MS - performance.now();
    if (due > 0) await sleep(due);
  }
  audioEnd = performance.now();
  await connection.flushAudio();
  await connection.endAudio();
  try {
    const text = await done;
    return { finalMs: performance.now() - audioEnd, defaultDelayMs, text };
  } finally {
    await connection.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      delay: { type: 'string', multiple: true },
      repeat: { type: 'string' },
      model: { type: 'string' },
    },
  });
  const file = positionals[0];
  if (!file) throw new Error(_('usage: stt-try <audio file> [--delay ms]... [--repeat n]'));
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error(_('%s must be set').replace('%s', 'MISTRAL_API_KEY'));

  const client = mistralClient(apiKey);
  const model = values.model ?? DEFAULT_MODEL;
  const pcm = decode(file);
  const repeat = Math.max(1, Number.parseInt(values.repeat ?? '3', 10) || 3);
  const delays: (number | undefined)[] = [undefined, ...(values.delay ?? []).map((d) => Number.parseInt(d, 10))];

  console.log(
    `${_('target delay').padEnd(14)} ${_('final ms (median)').padStart(18)} ${_('max ms').padStart(8)}  ${_('text')}`,
  );
  for (const delay of delays) {
    const runs: Run[] = [];
    for (let i = 0; i < repeat; i++) {
      try {
        runs.push(await transcribe(client, model, pcm, delay));
      } catch (error) {
        console.log(`${String(delay ?? 'default').padEnd(14)} ${_('failed:')} ${(error as Error).message}`);
      }
    }
    if (runs.length === 0) continue;
    const label = delay === undefined ? `default (${runs[0]!.defaultDelayMs ?? '?'})` : String(delay);
    const finals = runs.map((run) => run.finalMs);
    console.log(
      `${label.padEnd(14)} ${median(finals).toFixed(0).padStart(18)} ${Math.max(...finals)
        .toFixed(0)
        .padStart(8)}  ${runs[0]!.text.trim().slice(0, 70)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
