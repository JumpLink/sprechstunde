import { Mistral } from '@mistralai/mistralai';
import { _ } from './i18n.js';

const SERVERS = ['global', 'eu', 'us'] as const;
type Server = (typeof SERVERS)[number];

/**
 * `SPRECHSTUNDE_MISTRAL_SERVER`: `eu` or `us` for Mistral's regional inference (10 % surcharge,
 * processing stays in that region), a base URL, or empty for the global endpoint, which makes no
 * promise where a request runs. On 2026-10-19 the EU endpoint listed every model the agent uses.
 */
export function mistralServer(env: NodeJS.ProcessEnv = process.env): { server?: Server; serverURL?: string } {
  const value = env.SPRECHSTUNDE_MISTRAL_SERVER || '';
  if (!value) return {};
  if ((SERVERS as readonly string[]).includes(value)) return { server: value as Server };
  if (new RegExp('^https?://').test(value)) return { serverURL: value };
  throw new Error(_('SPRECHSTUNDE_MISTRAL_SERVER must be global, eu, us or a URL'));
}

export function mistralClient(apiKey = process.env.MISTRAL_API_KEY): Mistral {
  if (!apiKey) throw new Error(_('%s must be set').replace('%s', 'MISTRAL_API_KEY'));
  return new Mistral({ apiKey, ...mistralServer() });
}
