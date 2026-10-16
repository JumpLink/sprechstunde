import { SipClient } from 'livekit-server-sdk';
import { _ } from '../i18n.js';

/** The SIP API speaks HTTP(S); the worker URL is usually ws(s). */
export function httpUrl(url: string): string {
  return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

export async function transferSipParticipant(room: string, identity: string, target: string): Promise<void> {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    throw new Error(_('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set'));
  }
  await new SipClient(httpUrl(url), key, secret).transferSipParticipant(room, identity, target);
}
