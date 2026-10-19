import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { metrics } from '@livekit/agents';
import { callConfigLine, metricsLine, recordMetrics } from './metrics.js';

const eouMetrics = {
  type: 'eou_metrics',
  timestamp: 1,
  speechId: 'speech-1',
  endOfUtteranceDelayMs: 800,
  transcriptionDelayMs: 700,
} as unknown as metrics.AgentMetrics;

function withMetricsDir<T>(dir: string, body: () => T): T {
  const previous = process.env.SPRECHSTUNDE_METRICS_DIR;
  process.env.SPRECHSTUNDE_METRICS_DIR = dir;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.SPRECHSTUNDE_METRICS_DIR;
    else process.env.SPRECHSTUNDE_METRICS_DIR = previous;
  }
}

test('recordMetrics writes one line per metric into the configured directory', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'sprechstunde-metrics-')), 'nested');
  withMetricsDir(dir, () => recordMetrics(eouMetrics));
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
});

test('an unwritable metrics directory does not end the call', () => {
  // The session emits metrics from an event listener, so a throw would tear the job down.
  const base = mkdtempSync(join(tmpdir(), 'sprechstunde-metrics-'));
  const blocked = join(base, 'not-a-directory');
  writeFileSync(blocked, '');
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    withMetricsDir(join(blocked, 'metrics'), () => {
      assert.doesNotThrow(() => recordMetrics(eouMetrics));
      assert.doesNotThrow(() => recordMetrics(eouMetrics));
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1, 'the warning repeats for every metric');
});

test('metricsLine keeps only numbers, ids and timestamps', () => {
  // Real metric objects carry more fields; a text field must never reach the file.
  const extra = { label: 'mistral', metadata: { modelName: 'x' }, text: 'never stored', requestId: 'r' };
  const cases: [Record<string, unknown>, string[]][] = [
    [{ ...eouMetrics, ...extra }, ['type', 'ts', 'speechId', 'endOfUtteranceDelayMs', 'transcriptionDelayMs']],
    [
      { ...extra, type: 'llm_metrics', timestamp: 1, speechId: 's', ttftMs: 1, durationMs: 2 },
      ['type', 'ts', 'speechId', 'ttftMs', 'durationMs'],
    ],
    [
      { ...extra, type: 'tts_metrics', timestamp: 1, speechId: 's', ttfbMs: 1, durationMs: 2 },
      ['type', 'ts', 'speechId', 'ttfbMs', 'durationMs'],
    ],
  ];
  for (const [input, keys] of cases) {
    const line = metricsLine(input as unknown as metrics.AgentMetrics);
    assert.deepEqual(Object.keys(line ?? {}), keys);
    for (const [key, value] of Object.entries(line ?? {})) {
      if (key === 'type' || key === 'speechId') continue;
      assert.equal(typeof value, 'number', key);
    }
  }
  assert.equal(metricsLine({ ...extra, type: 'stt_metrics' } as unknown as metrics.AgentMetrics), null);
});

test('callConfigLine: ids and names only, no text', () => {
  const line = callConfigLine(
    {
      jobId: 'job-1',
      profile: 'venue',
      ttsPreset: 'house',
      ttsProvider: 'pocket',
      llmModel: 'small',
      llmFallbackModel: 'big',
    },
    42,
  );
  assert.deepEqual(line, {
    type: 'call_config',
    ts: 42,
    jobId: 'job-1',
    profile: 'venue',
    ttsPreset: 'house',
    ttsProvider: 'pocket',
    llmModel: 'small',
    llmFallbackModel: 'big',
  });
});
