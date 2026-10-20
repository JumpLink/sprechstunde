export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload.error || response.statusText);
  return payload as T;
}

export interface PreviewResult {
  url: string;
  ttfaMs: number;
}

/** `choice` is a saved character id (or empty for the environment voice) or a voice that is not saved. */
export async function preview(
  choice: { character: string } | { voice: { provider: string; model?: string; voice?: string } },
  text: string,
  phone: boolean,
): Promise<PreviewResult> {
  const response = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...choice, text, phone }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || response.statusText);
  }
  const ttfaMs = Number(response.headers.get('x-ttfa-ms'));
  return { url: URL.createObjectURL(await response.blob()), ttfaMs };
}

/** The vendor sample of a catalog voice, played through the server so the page talks to no one else. */
export const sampleUrl = (provider: string, voice: string, model?: string): string =>
  `/api/sample?${new URLSearchParams({ provider, voice, ...(model && { model }) })}`;

export function revoke(url: string | undefined): void {
  if (url) URL.revokeObjectURL(url);
}

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
