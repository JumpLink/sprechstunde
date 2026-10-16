import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { metrics } from '@livekit/agents';
import { recordMetrics } from './metrics.js';

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
