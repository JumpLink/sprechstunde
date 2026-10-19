import { _ } from '../i18n.js';

export interface WatchdogOptions {
  /** Resolves to `true` when the worker can take a job. */
  probe: () => Promise<boolean>;
  /** Called once after `failures` probes in a row failed; the default ends the process. */
  onDead: () => void;
  intervalMs: number;
  failures: number;
}

/**
 * The worker's own health endpoint turns 503 when its inference process died, yet the process
 * keeps running and stays registered, so no restart policy fires. Seen 2026-10-18: under memory
 * pressure the child processes ended ("inference process orphaned") and every call got the
 * fallback announcement for a day. This polls the endpoint and hands a dead worker to `onDead`.
 */
export function startWatchdog(opts: WatchdogOptions): () => void {
  let failed = 0;
  let stopped = false;
  const timer = setInterval(() => {
    void opts
      .probe()
      .catch(() => false)
      .then((healthy) => {
        if (stopped) return;
        failed = healthy ? 0 : failed + 1;
        if (failed < opts.failures) return;
        stop();
        opts.onDead();
      });
  }, opts.intervalMs);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}

export function httpProbe(url: string, timeoutMs: number): () => Promise<boolean> {
  return async () => (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok;
}

export function exitUnhealthy(): void {
  console.error(_('worker is unhealthy; exiting so the container restarts'));
  process.exit(1);
}
