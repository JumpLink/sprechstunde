import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { byCharacter, callsFrom, type Line, parseLines, readMetrics, summarizeCall } from './latency.js';

const T0 = 1_760_000_000_000;

function lines(...entries: Array<Record<string, unknown>>): Line[] {
  return entries.map((entry) => ({
    ts: entry.ts as number,
    type: entry.type as string,
    values: entry,
  }));
}

function config(ts: number, preset: string | undefined, provider: string): Record<string, unknown> {
  return {
    type: 'call_config',
    ts,
    character: preset,
    ttsProvider: provider,
    llmModel: 'mistral-small-latest',
  };
}

const tts = (ts: number, ttfbMs: number) => ({
  type: 'tts_metrics',
  ts,
  ttfbMs,
  durationMs: 900,
});
const eou = (ts: number, delay: number) => ({
  type: 'eou_metrics',
  ts,
  endOfUtteranceDelayMs: delay,
});

test('parseLines: keeps well-formed lines and counts the rest', () => {
  const parsed = parseLines(
    ['{"type":"tts_metrics","ts":1,"ttfbMs":5}', 'not json', '{"type":"x"}', '', '  '].join('\n'),
  );
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.skipped, 2);
});

test('callsFrom: a call_config line starts a call and names its character', () => {
  const calls = callsFrom(
    lines(
      config(T0, 'pocket-juergen', 'pocket'),
      tts(T0 + 500, 120),
      config(T0 + 1000, 'mistral-jane', 'mistral'),
      tts(T0 + 1500, 700),
    ),
  );
  assert.equal(calls.length, 2);
  // Newest first.
  assert.equal(calls[0]!.character, 'mistral-jane');
  assert.equal(calls[1]!.character, 'pocket-juergen');
  assert.equal(calls[1]!.provider, 'pocket');
  assert.equal(calls[1]!.llmModel, 'mistral-small-latest');
  assert.deepEqual(calls[1]!.values['tts.ttfbMs'], [120]);
});

test('callsFrom: a line from before characters names its preset as the character', () => {
  const calls = callsFrom(lines({ type: 'call_config', ts: T0, ttsPreset: 'old-one' }, tts(T0 + 1, 100)));
  assert.equal(calls[0]!.character, 'old-one');
});

test('callsFrom: lines without a call_config still form calls, split by the gap', () => {
  const calls = callsFrom(lines(tts(T0, 100), tts(T0 + 1000, 200), tts(T0 + 120_000, 300)));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.character, undefined);
  assert.deepEqual(calls[1]!.values['tts.ttfbMs'], [100, 200]);
});

test('callsFrom: a call without latency lines is not a measurement', () => {
  assert.deepEqual(callsFrom(lines(config(T0, 'a', 'pocket'))), []);
});

test('summarizeCall: percentiles per metric, nothing measured stays null', () => {
  const [call] = callsFrom(lines(config(T0, 'a', 'pocket'), tts(T0 + 1, 100), tts(T0 + 2, 300), eou(T0 + 3, 800)));
  const summary = summarizeCall(call!);
  assert.equal(summary['tts.ttfbMs']!.n, 2);
  assert.equal(summary['tts.ttfbMs']!.p50, 100);
  assert.equal(summary['tts.ttfbMs']!.max, 300);
  assert.equal(summary['eou.endOfUtteranceDelayMs']!.p50, 800);
  assert.equal(summary['llm.ttftMs']!.n, 0);
  assert.equal(summary['llm.ttftMs']!.p50, null);
});

test('byCharacter: one row per preset over all its calls, most calls first', () => {
  const calls = callsFrom(
    lines(
      config(T0, 'a', 'pocket'),
      tts(T0 + 1, 100),
      config(T0 + 10_000, 'b', 'mistral'),
      tts(T0 + 10_001, 500),
      config(T0 + 20_000, 'a', 'pocket'),
      tts(T0 + 20_001, 300),
    ),
  );
  const rows = byCharacter(calls);
  assert.deepEqual(
    rows.map((row) => [row.character, row.calls]),
    [
      ['a', 2],
      ['b', 1],
    ],
  );
  assert.equal(rows[0]!.provider, 'pocket');
  assert.equal(rows[0]!.summary['tts.ttfbMs']!.n, 2);
  assert.equal(rows[0]!.summary['tts.ttfbMs']!.p50, 100);
});

test('readMetrics: reads the newest daily files, a missing directory is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprechstunde-metrics-'));
  writeFileSync(join(dir, '2026-10-17.jsonl'), `${JSON.stringify(tts(T0, 100))}\n`);
  writeFileSync(join(dir, '2026-10-18.jsonl'), `${JSON.stringify(tts(T0 + 200_000, 200))}\nbroken\n`);
  writeFileSync(join(dir, 'notes.txt'), 'ignored');

  const all = readMetrics(dir);
  assert.equal(all.lines.length, 2);
  assert.equal(all.skipped, 1);
  assert.equal(readMetrics(dir, 1).lines.length, 1);
  assert.deepEqual(readMetrics(join(dir, 'nope')), { lines: [], skipped: 0 });
});
