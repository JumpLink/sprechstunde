import { _ } from '../i18n.js';
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

/** What the LLM is told about a tool; `parameters` is a JSON schema, as the LLM receives it. */
export interface LlmTool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

/** A tool plus when a call can really use it, for the admin UI. */
export interface ToolDescriptor extends LlmTool {
  availableWhen: string;
}

/**
 * The tools a call offers, defined once: the agent registers exactly these and the admin UI lists
 * exactly these, so the page can never show a tool the agent lacks. Facts are not a tool on
 * purpose: they sit in the instructions, and a tool call costs a second LLM round.
 */
export const TRANSFER_TOOL: LlmTool = {
  name: 'transfer_to_human',
  description: 'Transfer the call to a person. Only call this after the caller agreed.',
  parameters: { type: 'object', properties: {}, required: [] },
};

export function toolDescriptors(): ToolDescriptor[] {
  return [{ ...TRANSFER_TOOL, availableWhen: _('Phone calls only, and only when the profile has a transfer target.') }];
}

/** The deployment's own transfer target, kept out of the profile (see `transferRequest`). */
export function transferOverride(env: NodeJS.ProcessEnv = process.env): { number?: string; sipHost: string } {
  return {
    number: env.TRANSFER_TARGET_NUMBER || undefined,
    sipHost: env.TRANSFER_SIP_HOST || '127.0.0.1:5070',
  };
}

/** `tel:+49•••••••42`: a phone number shown only so far as to recognise it, never in full. */
export function maskTransferTarget(target: string): string {
  const match = /^(tel|sip):([^@]*)/.exec(target);
  if (!match) return '•••';
  const user = match[2]!;
  let digits = user.replace(/\D/g, '').length;
  const masked = user.replace(/\d/g, (digit) => (--digits >= 2 ? '•' : digit));
  return `${match[1]}:${masked}`;
}
