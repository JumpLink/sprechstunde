import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activeCount,
  type Context,
  emptyFilters,
  filtered,
  groupByVendor,
  offered,
  options,
  recommend,
  score,
  UNKNOWN,
} from './browse';
import type { Candidate } from './casting';

const voice = (name: string, rest: Partial<Candidate> = {}): Candidate => ({
  provider: 'alpha',
  voice: name.toLowerCase(),
  name,
  languages: ['de-DE'],
  ...rest,
});

const context: Context = { kugelEu: false, favourites: new Set() };

const pool: Candidate[] = [
  voice('Anna', {
    gender: 'female',
    age: 'young',
    category: 'premade',
    quality: 'high',
    hasAvatar: true,
    hasSample: true,
  }),
  voice('Berta', { gender: 'female', description: 'warm and calm' }),
  voice('Carl', { gender: 'male', own: true }),
  voice('Dora', { provider: 'beta', languages: ['en-US'] }),
];

describe('browse', () => {
  it('treats a voice without gender as unknown, not as hidden', () => {
    const filters = emptyFilters();
    filters.facets.gender = new Set([UNKNOWN]);
    assert.deepEqual(
      filtered(pool, filters, context).map((entry) => entry.name),
      ['Dora'],
    );
  });

  it('combines facets with and, values of one facet with or', () => {
    const filters = emptyFilters();
    filters.facets.gender = new Set(['female', 'male']);
    filters.facets.vendor = new Set(['alpha']);
    assert.equal(filtered(pool, filters, context).length, 3);
    filters.facets.age = new Set(['young']);
    assert.deepEqual(
      filtered(pool, filters, context).map((entry) => entry.name),
      ['Anna'],
    );
  });

  it('searches name and description', () => {
    const filters = emptyFilters();
    filters.search = ' CALM ';
    assert.deepEqual(
      filtered(pool, filters, context).map((entry) => entry.name),
      ['Berta'],
    );
  });

  it('filters tabs and the region toggles', () => {
    const filters = emptyFilters();
    filters.tab = 'own';
    assert.deepEqual(
      filtered(pool, filters, context).map((entry) => entry.name),
      ['Carl'],
    );
    filters.tab = 'favourites';
    assert.equal(filtered(pool, filters, { ...context, favourites: new Set(['alpha||berta']) }).length, 1);
    const eu = emptyFilters();
    eu.eu = true;
    assert.equal(filtered([voice('K', { provider: 'kugel' }), ...pool], eu, { ...context, kugelEu: true }).length, 1);
    assert.equal(filtered([voice('K', { provider: 'kugel' }), ...pool], eu, context).length, 0);
  });

  it('counts each option against the other filters only, and drops empty ones', () => {
    const filters = emptyFilters();
    filters.facets.vendor = new Set(['alpha']);
    const vendors = options(pool, filters, context, 'vendor');
    assert.deepEqual(vendors, [
      { value: 'alpha', count: 3 },
      { value: 'beta', count: 1 },
    ]);
    filters.facets.gender = new Set(['male']);
    // beta's only voice is unknown-gender, so with "male" chosen it counts 0 and disappears ...
    assert.deepEqual(
      options(pool, filters, context, 'vendor').map((entry) => entry.value),
      ['alpha'],
    );
    // ... but a chosen option stays, so it can be undone.
    filters.facets.vendor = new Set(['alpha', 'beta']);
    assert.ok(options(pool, filters, context, 'vendor').some((entry) => entry.value === 'beta'));
  });

  it('shows a facet only when some voice states it', () => {
    assert.equal(offered(pool, 'age'), true);
    assert.equal(offered(pool, 'quality'), true);
    assert.equal(offered([voice('X'), voice('Y')], 'age'), false);
    assert.equal(offered([voice('X'), voice('Y')], 'vendor'), false);
    assert.equal(offered([voice('X')], 'gender'), false);
  });

  it('counts narrowing filters but not tab or search', () => {
    const filters = emptyFilters();
    filters.search = 'a';
    filters.tab = 'own';
    assert.equal(activeCount(filters), 0);
    filters.facets.gender = new Set(['female', 'male']);
    filters.local = true;
    assert.equal(activeCount(filters), 3);
  });

  it('recommends voices with a photo and a sample first', () => {
    assert.ok(score(pool[0]!) > score(pool[1]!));
    const many = [...pool, ...[1, 2, 3, 4].map((n) => voice(`Z${n}`))];
    assert.equal(recommend(many, 3, new Set()).length, 3);
  });

  it('groups voices under their vendor, the larger vendor first, keeping the order inside', () => {
    const groups = groupByVendor(pool);
    assert.deepEqual(
      groups.map((group) => [group.provider, group.voices.map((entry) => entry.name)]),
      [
        ['alpha', ['Anna', 'Berta', 'Carl']],
        ['beta', ['Dora']],
      ],
    );
    assert.deepEqual(groupByVendor([]), []);
  });
});
