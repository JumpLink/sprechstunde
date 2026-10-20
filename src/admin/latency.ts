/**
 * What the metrics files say about the voices: the latency lines of `src/agent/metrics.ts`, cut
 * into calls and attributed to the character each call ran with.
 *
 * The agent writes one `call_config` line at the start of a call and latency lines after it, so a
 * `call_config` starts a new call here. Lines without one in front of them (an older file, or a
 * call configured by the environment) still form calls, split by a long gap, and count as "the
 * environment".
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize, type Summary } from '../core/stats.js';

/** Gap between two lines that cannot be the same call. Same value as `npm run metrics --calls`. */
const CALL_GAP_MS = 60_000;

/** `<type>.<field>` of the lines written by src/agent/metrics.ts, in the order the UI shows them. */
const METRICS = [
  ['eou_metrics', 'endOfUtteranceDelayMs'],
  ['eou_metrics', 'transcriptionDelayMs'],
  ['llm_metrics', 'ttftMs'],
  ['tts_metrics', 'ttfbMs'],
  ['tts_stream', 'maxGapMs'],
] as const;

export const METRIC_NAMES = METRICS.map(([type, field]) => `${type.split('_')[0]}.${field}`);

export interface Line {
  ts: number;
  type: string;
  values: Record<string, unknown>;
}

export interface Call {
  /** Timestamp of the first line, which is the `call_config` line when there is one. */
  start: number;
  seconds: number;
  lines: number;
  /** Character id, or `undefined` when the environment decided the voice. */
  character?: string;
  provider?: string;
  llmModel?: string;
  /** Measured values per metric name, so several calls can be summarized together. */
  values: Record<string, number[]>;
}

export function parseLines(text: string): { lines: Line[]; skipped: number } {
  const lines: Line[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.type !== 'string' || typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) {
        throw new Error('shape');
      }
      lines.push({ ts: parsed.ts, type: parsed.type, values: parsed });
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

/**
 * The newest `days` daily files of the metrics directory. A missing directory is the normal state
 * before the first call, not an error.
 */
export function readMetrics(dir: string, days = 7): { lines: Line[]; skipped: number } {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .slice(-days);
  } catch {
    return { lines: [], skipped: 0 };
  }
  const lines: Line[] = [];
  let skipped = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseLines(text);
    lines.push(...parsed.lines);
    skipped += parsed.skipped;
  }
  return { lines, skipped };
}

function text(line: Line, key: string): string | undefined {
  const value = line.values[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function emptyCall(line: Line): Call {
  const call: Call = { start: line.ts, seconds: 0, lines: 0, values: {} };
  for (const name of METRIC_NAMES) call.values[name] = [];
  return call;
}

/** Newest call first. */
export function callsFrom(lines: readonly Line[], gapMs = CALL_GAP_MS): Call[] {
  const sorted = [...lines].sort((a, b) => a.ts - b.ts);
  const calls: Call[] = [];
  let last = -Infinity;
  for (const line of sorted) {
    let call = calls[calls.length - 1];
    if (!call || line.type === 'call_config' || line.ts - last > gapMs) {
      call = emptyCall(line);
      calls.push(call);
    }
    last = line.ts;
    call.seconds = Math.round((line.ts - call.start) / 1000);
    if (line.type === 'call_config') {
      // `ttsPreset` is what lines wrote before characters; a preset's id became its character's id.
      call.character = text(line, 'character') ?? text(line, 'ttsPreset');
      call.provider = text(line, 'ttsProvider');
      call.llmModel = text(line, 'llmModel');
      continue;
    }
    call.lines++;
    METRICS.forEach(([type, field], index) => {
      if (line.type !== type) return;
      const value = line.values[field];
      if (typeof value === 'number' && Number.isFinite(value)) call.values[METRIC_NAMES[index]!]!.push(value);
    });
  }
  // A call_config whose call never produced a latency line (the caller hung up at the greeting)
  // says nothing about the voice and would only pad the list.
  return calls.filter((call) => call.lines > 0).reverse();
}

export function summarizeCall(call: Call): Record<string, Summary> {
  const result: Record<string, Summary> = {};
  for (const name of METRIC_NAMES) result[name] = summarize(call.values[name] ?? []);
  return result;
}

export interface CharacterLatency {
  /** Character id, or `undefined` for the calls the environment configured. */
  character?: string;
  calls: number;
  provider?: string;
  summary: Record<string, Summary>;
}

/** One row per character, over all given calls. Most calls first. */
export function byCharacter(calls: readonly Call[]): CharacterLatency[] {
  const rows = new Map<string, CharacterLatency & { values: Record<string, number[]> }>();
  for (const call of calls) {
    const key = call.character ?? '';
    let row = rows.get(key);
    if (!row) {
      row = {
        ...(call.character && { character: call.character }),
        calls: 0,
        summary: {},
        values: {},
      };
      for (const name of METRIC_NAMES) row.values[name] = [];
      rows.set(key, row);
    }
    row.calls++;
    // The provider of the most recent call; a character that changed vendor is a new character in
    // practice, and the id is what the operator recognises.
    row.provider ??= call.provider;
    for (const name of METRIC_NAMES) row.values[name]!.push(...(call.values[name] ?? []));
  }
  return [...rows.values()]
    .map(({ values, ...row }) => {
      const summary: Record<string, Summary> = {};
      for (const name of METRIC_NAMES) summary[name] = summarize(values[name] ?? []);
      return { ...row, summary };
    })
    .sort((a, b) => b.calls - a.calls);
}
