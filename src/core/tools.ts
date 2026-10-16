import type { Profile } from './profile.js';

/** Channel-independent request; each channel decides how to carry it out. */
export interface TransferRequest {
  target: string;
  announce: string;
}

export function transferRequest(profile: Profile): TransferRequest | null {
  return profile.transfer ? { ...profile.transfer } : null;
}
