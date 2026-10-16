import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { metrics } from '@livekit/agents';

const DIR = join('var', 'metrics');

/** Latencies only: numbers, ids and timestamps. Never transcript text or caller numbers. */
export function metricsLine(m: metrics.AgentMetrics): Record<string, unknown> | null {
  switch (m.type) {
    case 'eou_metrics':
      return {
        type: m.type,
        ts: m.timestamp,
        speechId: m.speechId,
        endOfUtteranceDelayMs: m.endOfUtteranceDelayMs,
        transcriptionDelayMs: m.transcriptionDelayMs,
      };
    case 'llm_metrics':
      return { type: m.type, ts: m.timestamp, speechId: m.speechId, ttftMs: m.ttftMs, durationMs: m.durationMs };
    case 'tts_metrics':
      return { type: m.type, ts: m.timestamp, speechId: m.speechId, ttfbMs: m.ttfbMs, durationMs: m.durationMs };
    default:
      return null;
  }
}

export function recordMetrics(m: metrics.AgentMetrics): void {
  const line = metricsLine(m);
  if (!line) return;
  mkdirSync(DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(DIR, `${day}.jsonl`), `${JSON.stringify(line)}\n`);
}
