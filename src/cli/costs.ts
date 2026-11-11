import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type CallCost,
  monthlyInEur,
  parsePriceTable,
  type PriceTable,
  priceUsage,
  totalInEur,
  type UsageItem,
} from '../core/costs.js';
import { _ } from '../i18n.js';

interface Call {
  ts: number;
  durationMs: number;
  usage: UsageItem[];
  cost: CallCost;
}

function usage(): string {
  return [
    _('usage: costs [--since <ISO|date>] [--until <ISO|date>] [--day <YYYY-MM-DD>] [--prices <file>] [--json]'),
    _('       costs --estimate <calls per month> <minutes per call>'),
    _('Prices the call_usage lines in <SPRECHSTUNDE_METRICS_DIR or var/metrics> with a price table.'),
    _('  --prices    the table; default SPRECHSTUNDE_PRICES or var/prices.json (a server setting, not in git)'),
    _('  --estimate  what a month would cost if every call used what the measured calls used per minute'),
  ].join('\n');
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(_('invalid date: %s').replace('%s', value));
  return ms;
}

function readCalls(dir: string, table: PriceTable, since: number, until: number): Call[] {
  const calls: Call[] = [];
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.includes('"call_usage"')) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; ts?: number; durationMs?: number; usage?: UsageItem[] };
        if (parsed.type !== 'call_usage' || typeof parsed.ts !== 'number' || !Array.isArray(parsed.usage)) continue;
        if (parsed.ts < since || parsed.ts >= until) continue;
        calls.push({
          ts: parsed.ts,
          durationMs: parsed.durationMs ?? 0,
          usage: parsed.usage,
          cost: priceUsage(parsed.usage, table),
        });
      } catch {
        // A line cut off by a crash is not worth stopping the report for.
      }
    }
  }
  return calls.sort((a, b) => a.ts - b.ts);
}

const money = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(4));

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row.map((text, column) => (column === 0 ? text.padEnd(widths[0]!) : text.padStart(widths[column]!))).join('  '),
    )
    .join('\n');
}

/** Totals per vendor model and unit over all calls. */
function perVendor(calls: readonly Call[]): Map<string, { quantity: number; cost: Record<string, number> }> {
  const map = new Map<string, { quantity: number; cost: Record<string, number> }>();
  for (const call of calls) {
    for (const line of call.cost.lines) {
      const key = `${line.provider} ${line.model} ${line.unit}`;
      const entry = map.get(key) ?? { quantity: 0, cost: {} };
      entry.quantity += line.quantity;
      if (line.cost !== null && line.currency) entry.cost[line.currency] = (entry.cost[line.currency] ?? 0) + line.cost;
      map.set(key, entry);
    }
  }
  return map;
}

function sumTotals(calls: readonly Call[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const call of calls) {
    for (const [currency, value] of Object.entries(call.cost.totals))
      totals[currency] = (totals[currency] ?? 0) + value;
  }
  return totals;
}

function describe(totals: Record<string, number>): string {
  const parts = Object.entries(totals).map(([currency, value]) => `${value.toFixed(4)} ${currency}`);
  return parts.length ? parts.join(' + ') : '-';
}

function estimate(calls: readonly Call[], prices: PriceTable, perMonth: number, minutes: number): string {
  const measured = calls.filter((call) => call.durationMs > 0 && call.usage.length > 0);
  const seconds = measured.reduce((sum, call) => sum + call.durationMs, 0) / 1000;
  if (seconds === 0) throw new Error(_('no measured call to base an estimate on'));
  // Scale each call's usage by the minutes wanted per measured minute, then price it as one call.
  const factor = (perMonth * minutes * 60) / seconds;
  const scaled = measured.flatMap((call) =>
    call.usage.map((item) => ({
      ...item,
      inputTokens: (item.inputTokens ?? 0) * factor,
      inputCachedTokens: (item.inputCachedTokens ?? 0) * factor,
      outputTokens: (item.outputTokens ?? 0) * factor,
      charactersCount: (item.charactersCount ?? 0) * factor,
      audioDurationMs: (item.audioDurationMs ?? 0) * factor,
    })),
  );
  const cost = priceUsage(scaled, prices);
  const variable = totalInEur(cost.totals, prices);
  const fixed = monthlyInEur(prices);
  const total = variable !== undefined && fixed !== undefined ? variable + fixed : undefined;
  return [
    _('measured: %s calls, %s minutes')
      .replace('%s', String(measured.length))
      .replace('%s', (seconds / 60).toFixed(1)),
    `${perMonth} × ${minutes} min / ${_('month')}`,
    `${_('variable')}: ${describe(cost.totals)}`,
    `${_('fixed')}: ${money(fixed)} EUR`,
    `${_('total')}: ${money(total)} EUR (${money(total === undefined ? undefined : total / perMonth)} EUR / ${_('call')})`,
  ].join('\n');
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      day: { type: 'string' },
      prices: { type: 'string' },
      json: { type: 'boolean', default: false },
      estimate: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  let since = values.since ? parseTime(values.since) : -Infinity;
  let until = values.until ? parseTime(values.until) : Infinity;
  if (values.day) {
    since = parseTime(values.day);
    until = since + 86_400_000;
  }

  const pricesFile = values.prices || process.env.SPRECHSTUNDE_PRICES || join('var', 'prices.json');
  let prices: PriceTable;
  try {
    prices = parsePriceTable(JSON.parse(readFileSync(pricesFile, 'utf8')));
  } catch (error) {
    throw new Error(_('cannot read the price table %s').replace('%s', pricesFile), { cause: error });
  }
  const dir = process.env.SPRECHSTUNDE_METRICS_DIR || join('var', 'metrics');
  const calls = readCalls(dir, prices, since, until);

  if (values.estimate) {
    const [perMonth, minutes] = positionals.map(Number);
    if (!perMonth || !minutes) throw new Error(usage());
    console.log(estimate(calls, prices, perMonth, minutes));
    return;
  }

  const totals = sumTotals(calls);
  const unpriced = new Set(
    calls.flatMap((call) => call.cost.unpriced.map((line) => `${line.provider} ${line.model} ${line.unit}`)),
  );
  const minutes = calls.reduce((sum, call) => sum + call.durationMs, 0) / 60_000;
  if (values.json) {
    console.log(JSON.stringify({ calls: calls.length, minutes, totals, unpriced: [...unpriced] }, null, 2));
    return;
  }
  if (calls.length === 0) {
    console.log(_('no call_usage lines in %s (recorded since the call end was instrumented)').replace('%s', dir));
    return;
  }
  console.log(
    table([
      [_('call start (UTC)'), _('minutes'), _('cost')],
      ...calls.map((call) => [
        new Date(call.ts - call.durationMs).toISOString(),
        (call.durationMs / 60_000).toFixed(1),
        describe(call.cost.totals),
      ]),
    ]),
  );
  console.log();
  console.log(
    table([
      [_('vendor model unit'), _('quantity'), _('cost')],
      ...[...perVendor(calls)].map(([key, entry]) => [key, entry.quantity.toFixed(3), describe(entry.cost)]),
    ]),
  );
  console.log();
  const eur = totalInEur(totals, prices);
  console.log(
    `${_('calls')}: ${calls.length}, ${_('minutes')}: ${minutes.toFixed(1)}, ${_('total')}: ${describe(totals)}`,
  );
  if (eur !== undefined && minutes > 0) {
    console.log(`${money(eur / calls.length)} EUR / ${_('call')}, ${money(eur / minutes)} EUR / ${_('minute')}`);
  }
  if (unpriced.size) console.log(`${_('unpriced')}: ${[...unpriced].join('; ')}`);
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
