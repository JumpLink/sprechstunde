/** At most `max` jobs at once; the rest wait their turn in order. A failing job frees its slot. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    active--;
    waiting.shift()?.();
  };
  return {
    async run<T>(job: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await job();
      } finally {
        release();
      }
    },
    get active(): number {
      return active;
    },
    get waiting(): number {
      return waiting.length;
    },
  };
}
