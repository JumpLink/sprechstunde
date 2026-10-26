const PREFIX = 'lk.pii.';

/**
 * Drops every `lk.pii.*` key from one log line. @livekit/agents puts what callers say (and what the
 * assistant answers) under those keys, at every level, and only its OTEL exporter treats them as
 * redactable; the stdout stream gets them as they are. Anything that is not a JSON object passes
 * through unchanged.
 */
export function redactLine(line: string): string {
  if (!line.includes(PREFIX)) return line;
  const end = line.endsWith('\n') ? '\n' : '';
  try {
    const record: unknown = JSON.parse(line);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return line;
    const entries = Object.entries(record).filter(([key]) => !key.startsWith(PREFIX));
    return JSON.stringify(Object.fromEntries(entries)) + end;
  } catch {
    return line;
  }
}

type Write = (chunk: unknown, ...rest: unknown[]) => boolean;

/**
 * Filters `lk.pii.*` out of everything the process writes to `stream`. The library builds its
 * logger inside the job and inference processes and offers no redact option, but its JSON logger
 * writes to `process.stdout` on each call, so wrapping `write` once covers it. Idempotent.
 *
 * Not covered: `dev` mode's pretty printer, which writes to fd 1 itself. `start`, what runs on a
 * server, logs JSON.
 */
export function redactPiiLogs(stream: { write: unknown } = process.stdout): void {
  const marked = stream as { write: Write & { redactsPii?: true } };
  if (marked.write.redactsPii) return;
  const original = marked.write.bind(stream);
  const write: Write & { redactsPii?: true } = (chunk, ...rest) => {
    const text =
      typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : undefined;
    return original(
      text === undefined ? chunk : text.includes(PREFIX) ? text.split('\n').map(redactLine).join('\n') : chunk,
      ...rest,
    );
  };
  write.redactsPii = true;
  marked.write = write;
}
