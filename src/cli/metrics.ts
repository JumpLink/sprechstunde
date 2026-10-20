import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { splitByGap, summarize, type Summary } from '../core/stats.js';
import { _ } from '../i18n.js';

const CALL_GAP_MS = 60_000;

/** Metric rows: `<type>.<field>` of the lines written by src/agent/metrics.ts. */
const METRICS = [
  ['eou_metrics', 'endOfUtteranceDelayMs'],
  ['eou_metrics', 'transcriptionDelayMs'],
  ['llm_metrics', 'ttftMs'],
  ['llm_metrics', 'durationMs'],
  ['tts_metrics', 'ttfbMs'],
  ['tts_stream', 'gaps'],
  ['tts_stream', 'maxGapMs'],
  ['tts_metrics', 'durationMs'],
] as const;

const names = METRICS.map(([type, field]) => `${type.split('_')[0]}.${field}`);

interface Entry {
  ts: number;
  type: string;
  values: Record<string, unknown>;
}

function usage(): string {
  return [
    _('usage: metrics [--since <ISO|date>] [--until <ISO|date>] [--day <YYYY-MM-DD>] [--calls] [--json]'),
    _('Reads <SPRECHSTUNDE_METRICS_DIR or var/metrics>/<date>.jsonl and prints n, p50, p95 and max per metric.'),
    _('  --since, --until  time window on the line timestamp; --until is exclusive; bare dates are UTC'),
    _('  --day             one UTC day, same as --since D --until D+1'),
    _('  --calls           one row per call: a gap above 60 s between lines starts a new call'),
    _('  --json            machine-readable output'),
    _(
      'Percentiles are nearest-rank (always a measured value). A TTS chunk hedged by HedgedTTS can appear twice; lines are not de-duplicated.',
    ),
  ].join('\n');
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(_('invalid date: %s').replace('%s', value));
  return ms;
}

function read(dir: string): { entries: Entry[]; skipped: number } {
  const entries: Entry[] = [];
  let skipped = 0;
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.type !== 'string' || typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) {
          throw new Error('shape');
        }
        entries.push({ ts: parsed.ts, type: parsed.type, values: parsed });
      } catch {
        skipped++;
      }
    }
  }
  return { entries, skipped };
}

function summaries(entries: readonly Entry[]): Record<string, Summary> {
  const result: Record<string, Summary> = {};
  METRICS.forEach(([type, field], index) => {
    const numbers = entries
      .filter((entry) => entry.type === type)
      .map((entry) => entry.values[field])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    result[names[index]!] = summarize(numbers);
  });
  return result;
}

const cell = (value: number | null) => (value === null ? '-' : String(Math.round(value)));

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row.map((text, column) => (column === 0 ? text.padEnd(widths[0]!) : text.padStart(widths[column]!))).join('  '),
    )
    .join('\n');
}

function summaryTable(summary: Record<string, Summary>): string {
  return table([
    [_('metric (ms)'), 'n', 'p50', 'p95', 'max'],
    ...names.map((name) => {
      const s = summary[name]!;
      return [name, String(s.n), cell(s.p50), cell(s.p95), cell(s.max)];
    }),
  ]);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      day: { type: 'string' },
      calls: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }

  let since = values.since ? parseTime(values.since) : -Infinity;
  let until = values.until ? parseTime(values.until) : Infinity;
  if (values.day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.day)) throw new Error(_('invalid date: %s').replace('%s', values.day));
    since = parseTime(values.day);
    until = since + 86_400_000;
  }

  const dir = process.env.SPRECHSTUNDE_METRICS_DIR || join('var', 'metrics');
  let read_: ReturnType<typeof read>;
  try {
    read_ = read(dir);
  } catch (error) {
    throw new Error(_('cannot read metrics from %s').replace('%s', dir), { cause: error });
  }
  const entries = read_.entries.filter((entry) => entry.ts >= since && entry.ts < until);
  const calls = values.calls
    ? splitByGap(entries, CALL_GAP_MS).map((run) => ({
        start: new Date(run[0]!.ts).toISOString(),
        seconds: Math.round((run[run.length - 1]!.ts - run[0]!.ts) / 1000),
        lines: run.length,
        summary: summaries(run),
      }))
    : undefined;
  const summary = summaries(entries);

  if (values.json) {
    console.log(JSON.stringify({ skipped: read_.skipped, lines: entries.length, calls, summary }, null, 2));
    return;
  }
  if (calls) {
    const focus = ['eou.endOfUtteranceDelayMs', 'llm.ttftMs', 'tts.ttfbMs'];
    console.log(
      table([
        [_('call start (UTC)'), _('seconds'), _('lines'), ...focus.map((name) => `${name} p50`)],
        ...calls.map((call) => [
          call.start,
          String(call.seconds),
          String(call.lines),
          ...focus.map((name) => cell(call.summary[name]!.p50)),
        ]),
      ]),
    );
    console.log();
  }
  console.log(summaryTable(summary));
  if (read_.skipped) console.log(_('skipped malformed lines: %s').replace('%s', String(read_.skipped)));
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
