export interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/**
 * Nearest-rank percentile: the smallest value with at least p % of the samples at or below it,
 * i.e. the sorted value at rank ceil(p / 100 * n). Always returns a sample, never interpolates.
 * `null` for empty input.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export function summarize(values: readonly number[]): Summary {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
  };
}

/** Splits timestamped items (any order) into runs; a gap larger than `gapMs` starts a new run. */
export function splitByGap<T extends { ts: number }>(items: readonly T[], gapMs: number): T[][] {
  const sorted = [...items].sort((a, b) => a.ts - b.ts);
  const runs: T[][] = [];
  for (const item of sorted) {
    const run = runs[runs.length - 1];
    if (run && item.ts - run[run.length - 1]!.ts <= gapMs) run.push(item);
    else runs.push([item]);
  }
  return runs;
}
