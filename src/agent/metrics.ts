import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { metrics } from '@livekit/agents';
import { _ } from '../i18n.js';

const DEFAULT_DIR = join('var', 'metrics');

/** `SPRECHSTUNDE_METRICS_DIR` points this at a writable volume; the container image has one. */
function metricsDir(): string {
  return process.env.SPRECHSTUNDE_METRICS_DIR || DEFAULT_DIR;
}

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

export interface CallConfig {
  jobId?: string;
  /** Id of the profile this call ran with. */
  profile?: string;
  /** Settings preset the voice came from, or none when the environment decided. */
  ttsPreset?: string;
  ttsProvider?: string;
  llmModel?: string;
  llmFallbackModel?: string;
}

/**
 * One line at the start of a call naming the voice and the model it runs with, so the latency
 * lines that follow can be attributed to them (`npm run metrics`, the admin UI). Ids and names
 * of our own configuration only — same rule as every other line here: no text, no caller.
 */
export function callConfigLine(config: CallConfig, now = Date.now()): Record<string, unknown> {
  return {
    type: 'call_config',
    ts: now,
    jobId: config.jobId,
    profile: config.profile,
    ttsPreset: config.ttsPreset,
    ttsProvider: config.ttsProvider,
    llmModel: config.llmModel,
    llmFallbackModel: config.llmFallbackModel,
  };
}

let warned = false;

export function recordCallConfig(config: CallConfig): void {
  write(callConfigLine(config));
}

export function recordMetrics(m: metrics.AgentMetrics): void {
  const line = metricsLine(m);
  if (!line) return;
  write(line);
}

function write(line: Record<string, unknown>): void {
  const dir = metricsDir();
  try {
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(line)}\n`);
  } catch (error) {
    // The session emits metrics from an event listener: a throw here ends the call over a
    // latency number. A read-only working directory is the usual reason (a container image
    // whose `var/` the agent user cannot write). Warn once, then stay quiet.
    if (warned) return;
    warned = true;
    console.warn(_('cannot write metrics to %s').replace('%s', dir), (error as NodeJS.ErrnoException).code ?? '');
  }
}
