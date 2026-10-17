import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { Mistral } from '@mistralai/mistralai';
import { downsampleS16le, encodeWav, silenceS16le } from '../core/audio.js';
import { refAudioFromFile, type TtsVoice } from '../agent/tts-voice.js';
import { _ } from '../i18n.js';
import { synthesize } from './speech.js';

const SAMPLE_RATE = 24000;
const PHONE_FACTOR = 3; // 24 kHz -> 8 kHz
const OUT_DIR = 'var/tts';
const DEFAULT_MODEL = 'voxtral-mini-tts-latest';
const DEFAULT_VOICES = ['fr_marie_neutral', 'en_paul_neutral', 'gb_jane_neutral', 'gb_oliver_neutral'];
const DEFAULT_TEXT =
  'Guten Tag, hier ist der digitale Assistent vom Restaurant Zur Alten Mühle. ' +
  'Ich bin eine künstliche Intelligenz. ' +
  'Wir haben heute von siebzehn Uhr dreißig bis dreiundzwanzig Uhr geöffnet, und für Sonntag sind noch zwölf Plätze frei.';
const SPLIT_PAUSE_MS = 300;

/** Sentence chunks as the agent's TTS stream adapter sends them: one request each. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim() !== '');
}

interface Target {
  label: string;
  voiceId?: string;
  refAudioPath?: string;
}

function ttsVoice(target: Target): TtsVoice {
  return target.refAudioPath ? { refAudio: refAudioFromFile(target.refAudioPath) } : { voice: target.voiceId };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function safeLabel(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * One request per sentence, joined with short pauses, the way the agent speaks a reply. With a
 * cloned voice every request is cloned anew, so this is where the voice may drift.
 */
async function synthesizeSplit(
  client: Mistral,
  model: string,
  text: string,
  voice: TtsVoice,
): Promise<{ pcm: Uint8Array; ttfaMs: number; totalMs: number }> {
  const started = performance.now();
  const parts: Uint8Array[] = [];
  let ttfaMs = -1;
  for (const sentence of splitSentences(text)) {
    const run = await synthesize(client, model, sentence, voice);
    if (ttfaMs < 0) ttfaMs = run.ttfaMs;
    if (parts.length > 0) parts.push(silenceS16le(SAMPLE_RATE, SPLIT_PAUSE_MS));
    parts.push(run.pcm);
  }
  return { pcm: new Uint8Array(Buffer.concat(parts)), ttfaMs, totalMs: performance.now() - started };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      text: { type: 'string' },
      voice: { type: 'string', multiple: true },
      ref: { type: 'string', multiple: true },
      model: { type: 'string' },
      repeat: { type: 'string' },
      split: { type: 'boolean' },
      suffix: { type: 'string' },
    },
  });

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error(_('%s must be set').replace('%s', 'MISTRAL_API_KEY'));

  const voices = values.voice ?? [];
  const refs = values.ref ?? [];
  const targets: Target[] = [
    ...voices.map((voiceId): Target => ({ label: safeLabel(voiceId), voiceId })),
    ...refs.map((path): Target => ({
      label: `ref-${safeLabel(basename(path, extname(path)))}`,
      refAudioPath: path,
    })),
  ];
  if (targets.length === 0) {
    targets.push(...DEFAULT_VOICES.map((voiceId): Target => ({ label: voiceId, voiceId })));
  }

  const client = new Mistral({ apiKey });
  const model = values.model ?? DEFAULT_MODEL;
  const text = values.text ?? DEFAULT_TEXT;
  mkdirSync(OUT_DIR, { recursive: true });

  const repeat = Math.max(1, Number.parseInt(values.repeat ?? '1', 10) || 1);
  console.log(
    `${_('voice').padEnd(28)} ${_('first audio ms').padStart(14)} ${_('max ms').padStart(8)} ${_('total ms').padStart(10)}  ${_('file')}`,
  );
  for (const target of targets) {
    try {
      // Runs are sequential on purpose: parallel requests would measure Mistral's queueing,
      // not the latency one caller sees.
      const runs = [];
      const run = values.split ? synthesizeSplit : synthesize;
      const voice = ttsVoice(target);
      for (let i = 0; i < repeat; i++) runs.push(await run(client, model, text, voice));
      const { pcm } = runs[0]!;
      const ttfa = median(runs.map((run) => run.ttfaMs));
      const ttfaMax = Math.max(...runs.map((run) => run.ttfaMs));
      const total = median(runs.map((run) => run.totalMs));
      const name = `${target.label}${values.split ? '.split' : ''}${values.suffix ? `.${safeLabel(values.suffix)}` : ''}`;
      const file = `${OUT_DIR}/${name}.wav`;
      writeFileSync(file, encodeWav(SAMPLE_RATE, pcm));
      writeFileSync(
        `${OUT_DIR}/${name}.8k.wav`,
        encodeWav(SAMPLE_RATE / PHONE_FACTOR, downsampleS16le(pcm, PHONE_FACTOR)),
      );
      console.log(
        `${target.label.padEnd(28)} ${ttfa.toFixed(0).padStart(14)} ${ttfaMax.toFixed(0).padStart(8)} ${total.toFixed(0).padStart(10)}  ${file}`,
      );
    } catch (error) {
      console.log(`${target.label.padEnd(28)} ${_('failed:')} ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
