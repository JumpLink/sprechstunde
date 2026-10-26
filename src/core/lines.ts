/**
 * Lines: the provider numbers one installation answers. Each has an id from `SIP_LINES`; Asterisk
 * (deploy/asterisk) registers them and tags every call with its line id, so the agent and the admin
 * UI talk about ids, never about phone numbers.
 */

import { maskTransferTarget } from './tools.js';

/** The line every installation has: `SIP_LINES` unset means this one, from `SIP_PROVIDER_*`. */
export const DEFAULT_LINE = 'main';
export const LINE_ID = /^[a-z0-9-]{1,20}$/;
/** Added by Asterisk (extensions.conf) to the call it hands to LiveKit. */
export const LINE_HEADER = 'X-Sprechstunde-Line';
/** The participant attribute the inbound trunk maps that header to (`headersToAttributes`). */
export const LINE_ATTRIBUTE = 'sprechstunde.line';

/** The configured line ids in order; invalid or repeated entries are dropped (Asterisk refuses to start on them). */
export function lineIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env.SIP_LINES ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => LINE_ID.test(id));
  const ids = [...new Set(listed)];
  return ids.length > 0 ? ids : [DEFAULT_LINE];
}

/** `SIP_LINE_<ID>_<field>`, else `SIP_PROVIDER_<field>`: the same fallback entrypoint.sh applies. */
export function lineSetting(id: string, field: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = `SIP_LINE_${id.toUpperCase().replaceAll('-', '_')}_${field}`;
  return env[key] || env[`SIP_PROVIDER_${field}`] || undefined;
}

/** The line's number for display only, e.g. `tel:+••••••••00`; undefined when none is configured. */
export function maskedLineNumber(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const number = lineSetting(id, 'NUMBER', env);
  return number ? maskTransferTarget(`tel:${number}`) : undefined;
}
