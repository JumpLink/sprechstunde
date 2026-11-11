import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monthlyInEur, parsePriceTable, priceUsage, totalInEur } from './costs.js';

const table = parsePriceTable({
  usdToEur: 0.5,
  rows: [
    { provider: 'Vendor-A', model: 'big', unit: 'per_1m_input_tokens', price: 2, currency: 'eur' },
    { provider: 'vendor-a', model: 'big', unit: 'per_1m_output_tokens', price: 6, currency: 'EUR' },
    { provider: 'vendor-a', model: 'big', unit: 'per_1m_cached_input_tokens', price: 0.5, currency: 'EUR' },
    { provider: 'vendor-b', model: '*', unit: 'per_audio_minute', price: 0.01, currency: 'EUR' },
    { provider: 'vendor-c', model: 'voice', unit: 'per_1k_characters', price: 0.2, currency: 'USD' },
  ],
  monthly: [
    { name: 'server', amount: 10, currency: 'EUR' },
    { name: 'line', amount: 4, currency: 'USD' },
  ],
});

test('priceUsage: tokens are priced per million, cached ones at their own rate', () => {
  const cost = priceUsage(
    [
      {
        type: 'llm_usage',
        provider: 'vendor-a',
        model: 'big',
        inputTokens: 1_500_000,
        inputCachedTokens: 500_000,
        outputTokens: 100_000,
      },
    ],
    table,
  );
  // 1 M fresh * 2 + 0.5 M cached * 0.5 + 0.1 M out * 6
  assert.ok(Math.abs(cost.totals.EUR! - 2.85) < 1e-9);
  assert.equal(cost.unpriced.length, 0);
});

test('priceUsage: audio minutes and characters, with a wildcard model', () => {
  const cost = priceUsage(
    [
      { type: 'stt_usage', provider: 'vendor-b', model: 'anything', audioDurationMs: 120_000 },
      { type: 'tts_usage', provider: 'vendor-c', model: 'voice', charactersCount: 5000, audioDurationMs: 300_000 },
    ],
    table,
  );
  assert.ok(Math.abs(cost.totals.EUR! - 0.02) < 1e-9);
  assert.ok(Math.abs(cost.totals.USD! - 1) < 1e-9);
  // The per-minute quantity of the character-priced voice is not a missing price.
  assert.equal(cost.unpriced.length, 0);
});

test('priceUsage: no row means unpriced, never free', () => {
  const cost = priceUsage([{ type: 'stt_usage', provider: 'unknown', model: 'x', audioDurationMs: 60_000 }], table);
  assert.deepEqual(cost.totals, {});
  assert.equal(cost.unpriced.length, 1);
  assert.equal(cost.unpriced[0]!.cost, null);
});

test('priceUsage: cached tokens without a row of their own are priced like fresh ones', () => {
  const noCache = parsePriceTable({
    rows: [{ provider: 'p', model: 'm', unit: 'per_1m_input_tokens', price: 1, currency: 'EUR' }],
  });
  const cost = priceUsage(
    [{ type: 'llm_usage', provider: 'p', model: 'm', inputTokens: 2_000_000, inputCachedTokens: 1_000_000 }],
    noCache,
  );
  assert.equal(cost.totals.EUR, 2);
});

test('totalInEur and monthlyInEur convert dollars only with a rate', () => {
  assert.equal(totalInEur({ EUR: 1, USD: 2 }, table), 2);
  assert.equal(totalInEur({ USD: 2 }, parsePriceTable({ rows: [] })), undefined);
  assert.equal(monthlyInEur(table), 12);
});

test('parsePriceTable: names the field that is wrong', () => {
  assert.throws(
    () => parsePriceTable({ rows: [{ provider: 'p', model: 'm', unit: 'per_year', price: 1, currency: 'EUR' }] }),
    /rows\[0\]\.unit/,
  );
  assert.throws(
    () =>
      parsePriceTable({ rows: [{ provider: 'p', model: 'm', unit: 'per_audio_minute', price: -1, currency: 'EUR' }] }),
    /rows\[0\]\.price/,
  );
  assert.throws(() => parsePriceTable([]), /expected an object/);
});
