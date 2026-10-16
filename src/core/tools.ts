import type { Profile } from './profile.js';

/** Channel-independent request; each channel decides how to carry it out. */
export interface TransferRequest {
  target: string;
  announce: string;
}

/**
 * `targetNumber` (e.g. `+4930…`) replaces the profile's target, so a deployment keeps its real
 * number out of the profile and in one place with the gateway's allow-list.
 */
export function transferRequest(profile: Profile, targetNumber?: string): TransferRequest | null {
  if (!profile.transfer) return null;
  if (!targetNumber) return { ...profile.transfer };
  if (!/^\+?[0-9]+$/.test(targetNumber)) throw new Error('transfer number must be digits with an optional leading +');
  return { ...profile.transfer, target: `tel:${targetNumber}` };
}
