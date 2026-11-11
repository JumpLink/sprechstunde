/**
 * What a call cost: the usage the session counted, priced with a table the operator keeps.
 *
 * The table is a server setting, never part of the repository: vendors change their prices, and a
 * price in code looks like a fact long after it stopped being one. A usage line with no row in
 * the table is reported as unpriced instead of costing nothing.
 */

/** One entry of `session.usage.modelUsage`, as far as pricing reads it. */
export interface UsageItem {
  type: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  inputCachedTokens?: number;
  outputTokens?: number;
  charactersCount?: number;
  audioDurationMs?: number;
}

export type PriceUnit =
  | 'per_1m_input_tokens'
  | 'per_1m_cached_input_tokens'
  | 'per_1m_output_tokens'
  | 'per_1k_characters'
  | 'per_audio_minute';

const UNITS: readonly PriceUnit[] = [
  'per_1m_input_tokens',
  'per_1m_cached_input_tokens',
  'per_1m_output_tokens',
  'per_1k_characters',
  'per_audio_minute',
];

export interface PriceRow {
  /** The provider name as the usage line carries it, compared without case. */
  provider: string;
  /** A model name, or `*` for every model of the provider. */
  model: string;
  unit: PriceUnit;
  price: number;
  currency: string;
  /** Where the number comes from; a row without one is shown as unsourced. */
  source?: string;
  accessed?: string;
}

/** A recurring cost that is not tied to a call: server, phone line, a plan's base fee. */
export interface MonthlyItem {
  name: string;
  amount: number;
  currency: string;
}

export interface PriceTable {
  rows: PriceRow[];
  monthly: MonthlyItem[];
  /** Only for a total in one currency; without it totals stay per currency. */
  usdToEur?: number;
}

export interface CostLine {
  provider: string;
  model: string;
  unit: PriceUnit;
  quantity: number;
  /** `null` when the table has no row for this provider, model and unit. */
  cost: number | null;
  currency?: string;
}

export interface CallCost {
  lines: CostLine[];
  /** Per currency, over the lines that have a price. */
  totals: Record<string, number>;
  unpriced: CostLine[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`price table: ${field} must be a text`);
  return value.trim();
}

function amount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`price table: ${field} must be a number of at least 0`);
  }
  return value;
}

export function parsePriceTable(raw: unknown): PriceTable {
  if (!isRecord(raw)) throw new Error('price table: expected an object');
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((entry, index): PriceRow => {
    if (!isRecord(entry)) throw new Error(`price table: rows[${index}] must be an object`);
    const unit = entry.unit as PriceUnit;
    if (!UNITS.includes(unit)) throw new Error(`price table: rows[${index}].unit must be one of ${UNITS.join(', ')}`);
    return {
      provider: text(entry.provider, `rows[${index}].provider`),
      model: text(entry.model, `rows[${index}].model`),
      unit,
      price: amount(entry.price, `rows[${index}].price`),
      currency: text(entry.currency, `rows[${index}].currency`).toUpperCase(),
      source: typeof entry.source === 'string' && entry.source.trim() ? entry.source.trim() : undefined,
      accessed: typeof entry.accessed === 'string' && entry.accessed.trim() ? entry.accessed.trim() : undefined,
    };
  });
  const monthly = (Array.isArray(raw.monthly) ? raw.monthly : []).map((entry, index): MonthlyItem => {
    if (!isRecord(entry)) throw new Error(`price table: monthly[${index}] must be an object`);
    return {
      name: text(entry.name, `monthly[${index}].name`),
      amount: amount(entry.amount, `monthly[${index}].amount`),
      currency: text(entry.currency, `monthly[${index}].currency`).toUpperCase(),
    };
  });
  const usdToEur = raw.usdToEur === undefined ? undefined : amount(raw.usdToEur, 'usdToEur');
  return { rows, monthly, usdToEur };
}

interface Quantity {
  unit: PriceUnit;
  quantity: number;
}

/** What one usage entry consumed, per unit a vendor could bill it in. */
function quantities(item: UsageItem): Quantity[] {
  const minutes = (item.audioDurationMs ?? 0) / 60_000;
  switch (item.type) {
    case 'llm_usage': {
      const cached = item.inputCachedTokens ?? 0;
      return [
        { unit: 'per_1m_input_tokens', quantity: Math.max(0, (item.inputTokens ?? 0) - cached) / 1e6 },
        { unit: 'per_1m_cached_input_tokens', quantity: cached / 1e6 },
        { unit: 'per_1m_output_tokens', quantity: (item.outputTokens ?? 0) / 1e6 },
      ];
    }
    case 'stt_usage':
      return [{ unit: 'per_audio_minute', quantity: minutes }];
    case 'tts_usage':
      return [
        { unit: 'per_1k_characters', quantity: (item.charactersCount ?? 0) / 1000 },
        { unit: 'per_audio_minute', quantity: minutes },
      ];
    default:
      return [];
  }
}

function rowFor(table: PriceTable, item: UsageItem, unit: PriceUnit): PriceRow | undefined {
  const provider = (item.provider ?? '').toLowerCase();
  const candidates = table.rows.filter((row) => row.unit === unit && row.provider.toLowerCase() === provider);
  return candidates.find((row) => row.model === item.model) ?? candidates.find((row) => row.model === '*');
}

/**
 * Prices one call. A vendor bills a service in one unit, so a unit with no quantity is skipped
 * and a unit with no row is listed as unpriced, unless another unit of the same entry is priced
 * (a TTS row per character makes the per-minute quantity irrelevant). Cached input tokens with
 * no row of their own are priced like fresh ones: an upper bound, never a silent zero.
 */
export function priceUsage(usage: readonly UsageItem[], table: PriceTable): CallCost {
  const lines: CostLine[] = [];
  for (const item of usage) {
    const found: CostLine[] = [];
    const missing: CostLine[] = [];
    for (const { unit, quantity } of quantities(item)) {
      if (quantity <= 0) continue;
      const base = { provider: item.provider ?? '?', model: item.model ?? '?', unit, quantity };
      let row = rowFor(table, item, unit);
      if (!row && unit === 'per_1m_cached_input_tokens') row = rowFor(table, item, 'per_1m_input_tokens');
      if (row) found.push({ ...base, cost: row.price * quantity, currency: row.currency });
      else missing.push({ ...base, cost: null });
    }
    lines.push(...found);
    if (item.type !== 'tts_usage' || found.length === 0) lines.push(...missing);
  }
  const totals: Record<string, number> = {};
  for (const line of lines) {
    if (line.cost === null || !line.currency) continue;
    totals[line.currency] = (totals[line.currency] ?? 0) + line.cost;
  }
  return { lines, totals, unpriced: lines.filter((line) => line.cost === null) };
}

/** The cost in euros when every currency in `totals` can be converted, else `undefined`. */
export function totalInEur(totals: Record<string, number>, table: PriceTable): number | undefined {
  let sum = 0;
  for (const [currency, value] of Object.entries(totals)) {
    if (currency === 'EUR') sum += value;
    else if (currency === 'USD' && table.usdToEur !== undefined) sum += value * table.usdToEur;
    else return undefined;
  }
  return sum;
}

/** The monthly items in euros; `undefined` when one needs a rate the table does not have. */
export function monthlyInEur(table: PriceTable): number | undefined {
  const totals: Record<string, number> = {};
  for (const item of table.monthly) totals[item.currency] = (totals[item.currency] ?? 0) + item.amount;
  return totalInEur(totals, table);
}
