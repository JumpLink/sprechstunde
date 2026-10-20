import { type Candidate, mixOf, specKey, specOf } from './casting';

/** What a voice can be told apart by. `region` is the pair of toggles, not a list. */
export type Facet = 'vendor' | 'language' | 'gender' | 'age' | 'category' | 'quality';

export const FACETS: Facet[] = ['vendor', 'language', 'gender', 'age', 'category', 'quality'];

export type Tab = 'all' | 'own' | 'favourites';

/** The value of a voice whose gender the vendor does not state. */
export const UNKNOWN = 'unknown';

export interface Filters {
  facets: Record<Facet, Set<string>>;
  eu: boolean;
  local: boolean;
  search: string;
  tab: Tab;
}

/** What the filters need to know besides the voice itself. */
export interface Context {
  kugelEu: boolean;
  favourites: ReadonlySet<string>;
}

export const emptyFilters = (): Filters => ({
  facets: {
    vendor: new Set(),
    language: new Set(),
    gender: new Set(),
    age: new Set(),
    category: new Set(),
    quality: new Set(),
  },
  eu: false,
  local: false,
  search: '',
  tab: 'all',
});

export const baseLanguage = (tag: string): string => tag.split('-')[0]!.toLowerCase();

/** The values a voice has for a facet; empty when the vendor says nothing. */
export function factsOf(candidate: Candidate, facet: Facet): string[] {
  switch (facet) {
    case 'vendor':
      return [candidate.provider];
    case 'language':
      return [...new Set(candidate.languages.map(baseLanguage))];
    case 'gender':
      return [candidate.gender ?? UNKNOWN];
    case 'age':
      return candidate.age ? [candidate.age] : [];
    case 'category':
      return candidate.category ? [candidate.category] : [];
    case 'quality':
      return candidate.quality ? [candidate.quality] : [];
  }
}

const isEu = (candidate: Candidate, context: Context): boolean => candidate.provider === 'kugel' && context.kugelEu;
const isLocal = (candidate: Candidate): boolean => candidate.provider === 'pocket';

const key = (candidate: Candidate): string => specKey(specOf(candidate));

/** Whether a voice passes the filters, leaving out one facet so its own counts stay meaningful. */
export function matches(candidate: Candidate, filters: Filters, context: Context, skip?: Facet): boolean {
  for (const facet of FACETS) {
    const wanted = filters.facets[facet];
    if (facet === skip || wanted.size === 0) continue;
    if (!factsOf(candidate, facet).some((value) => wanted.has(value))) return false;
  }
  if (filters.eu && !isEu(candidate, context)) return false;
  if (filters.local && !isLocal(candidate)) return false;
  if (filters.tab === 'own' && !candidate.own) return false;
  if (filters.tab === 'favourites' && !context.favourites.has(key(candidate))) return false;
  const needle = filters.search.trim().toLowerCase();
  return !needle || `${candidate.name} ${candidate.description ?? ''}`.toLowerCase().includes(needle);
}

export const filtered = (candidates: Candidate[], filters: Filters, context: Context): Candidate[] =>
  candidates.filter((candidate) => matches(candidate, filters, context));

export interface Option {
  value: string;
  count: number;
}

const GENDER_ORDER = ['female', 'male', 'neutral', UNKNOWN];
const AGE_ORDER = ['young', 'middle', 'old'];

/** The values of a facet over all voices, each with how many voices the other filters leave. */
export function options(candidates: Candidate[], filters: Filters, context: Context, facet: Facet): Option[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const values = factsOf(candidate, facet);
    const pass = matches(candidate, filters, context, facet);
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + (pass ? 1 : 0));
  }
  const order = facet === 'gender' ? GENDER_ORDER : facet === 'age' ? AGE_ORDER : undefined;
  return (
    [...counts]
      .map(([value, count]) => ({ value, count }))
      // An option no voice is left for is noise, unless it is chosen and must stay undoable.
      .filter(({ value, count }) => count > 0 || filters.facets[facet].has(value))
      .toSorted((a, b) =>
        order ? order.indexOf(a.value) - order.indexOf(b.value) : b.count - a.count || a.value.localeCompare(b.value),
      )
  );
}

/**
 * Whether a filter is worth showing: some voice states the fact. Vendor and language only tell
 * anything apart when there is more than one, and an all-unknown gender is no gender.
 */
export function offered(candidates: Candidate[], facet: Facet): boolean {
  const values = new Set(candidates.flatMap((candidate) => factsOf(candidate, facet)));
  if (facet === 'vendor' || facet === 'language') return values.size > 1;
  values.delete(UNKNOWN);
  return values.size > 0;
}

export const hasEu = (candidates: Candidate[], context: Context): boolean =>
  candidates.some((candidate) => isEu(candidate, context));
export const hasLocal = (candidates: Candidate[]): boolean => candidates.some(isLocal);

/** How many filters are narrowing the list, the tab and the search excluded. */
export function activeCount(filters: Filters): number {
  return (
    FACETS.reduce((sum, facet) => sum + filters.facets[facet].size, 0) + Number(filters.eu) + Number(filters.local)
  );
}

const isHighQuality = (quality: string | undefined): boolean =>
  ['high', 'premium', 'ultra', 'studio'].includes(quality?.toLowerCase() ?? '');

/** A face and a vendor sample make a voice easy to judge, so they weigh most; then verified, then high quality. */
export const score = (candidate: Candidate): number =>
  (candidate.hasAvatar ? 3 : 0) +
  (candidate.hasSample ? 3 : 0) +
  (candidate.verified ? 2 : 0) +
  (isHighQuality(candidate.quality) ? 1 : 0);

/**
 * `count` voices to start from, mixed across vendors: each vendor offers its best-scored ones,
 * and `seen` keeps a reshuffle from repeating itself.
 */
export function recommend(candidates: Candidate[], count: number, seen: Set<string>): Candidate[] {
  const byVendor = new Map<string, Candidate[]>();
  for (const candidate of candidates.toSorted((a, b) => score(b) - score(a))) {
    const list = byVendor.get(candidate.provider) ?? [];
    if (list.length < count * 2) byVendor.set(candidate.provider, [...list, candidate]);
  }
  return mixOf([...byVendor.values()].flat(), count, seen);
}
