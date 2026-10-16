import type { Profile } from './profile.js';

/** Channel-independent request; each channel decides how to carry it out. */
export interface TransferRequest {
  target: string;
  announce: string;
}

/**
 * `override.number` (e.g. `+4930…`) replaces the profile's target, so a deployment keeps its real
 * number out of the profile and in one place with the gateway's allow-list. With `sipHost` it
 * becomes `sip:<number>@<sipHost>`: Asterisk answers a REFER to a `tel:` URI with 400.
 */
export function transferRequest(
  profile: Profile,
  override?: { number?: string; sipHost?: string },
): TransferRequest | null {
  if (!profile.transfer) return null;
  const number = override?.number;
  if (!number) return { ...profile.transfer };
  if (!/^\+?[0-9]+$/.test(number)) throw new Error('transfer number must be digits with an optional leading +');
  const target = override.sipHost ? `sip:${number}@${override.sipHost}` : `tel:${number}`;
  return { ...profile.transfer, target };
}
