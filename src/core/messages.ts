import type { LlmTool } from './tools.js';

/**
 * Taking a message for the venue, channel-independent: the tool the LLM sees, the check of what it
 * filled in, and the delivery to the venue's endpoint. The endpoint (`profile.messages.endpoint`)
 * receives a JSON POST; how the venue stores or mails it is its own business.
 */
export const MESSAGE_TOOL: LlmTool = {
  name: 'take_message',
  description:
    'Pass a message from the caller on to the venue team, who call back. Only call this after the caller told you their name and their message and confirmed the callback number.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The caller's name as they gave it." },
      message: {
        type: 'string',
        description: 'What the team should know, in a few sentences, in the language of the call.',
      },
      callbackNumber: {
        type: 'string',
        description:
          'The number to call back, digits only. Leave empty when the caller agreed to be called back on the number they are calling from.',
      },
    },
    required: ['name', 'message'],
  },
};

/** What the venue receives. `phone` is the number to call back, never shown to the LLM again. */
export interface PhoneMessage {
  source: 'sprechstunde';
  venue: string;
  name: string;
  phone: string;
  message: string;
  receivedAt: string;
}

export type MessageCheck = { ok: true; message: PhoneMessage } | { ok: false; reply: string };

const MAX_TEXT = 2000;

/** Digits with an optional leading +, as a caller dictates them ("0 47 21 …" → "047721…"). */
function phoneOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\s()/.-]/g, '');
  return /^\+?[0-9]{5,20}$/.test(cleaned) ? cleaned : undefined;
}

/**
 * Turns the LLM's arguments into a message, or into the reply that tells it what is missing.
 * `callerNumber` is the number the call came from; it is used when the LLM left the number empty.
 */
export function checkMessage(
  args: { name?: unknown; message?: unknown; callbackNumber?: unknown },
  context: { venue: string; callerNumber?: string; now: Date },
): MessageCheck {
  const name = typeof args.name === 'string' ? args.name.trim().slice(0, 200) : '';
  const text = typeof args.message === 'string' ? args.message.trim().slice(0, MAX_TEXT) : '';
  if (!name) return { ok: false, reply: 'The name is missing. Ask the caller for their name.' };
  if (!text) return { ok: false, reply: 'The message is missing. Ask the caller what the team should know.' };
  const given = typeof args.callbackNumber === 'string' && args.callbackNumber.trim() !== '';
  const phone = given ? phoneOf(args.callbackNumber) : phoneOf(context.callerNumber);
  if (!phone) {
    return {
      ok: false,
      reply: given
        ? 'That callback number is not valid. Ask the caller to repeat it digit by digit.'
        : 'The caller is calling from a hidden number. Ask for a number to call back.',
    };
  }
  return {
    ok: true,
    message: {
      source: 'sprechstunde',
      venue: context.venue,
      name,
      phone,
      message: text,
      receivedAt: context.now.toISOString(),
    },
  };
}

/**
 * POSTs the message with a bearer token. Resolves to whether the venue took it: the caller is told
 * the truth, so a failure must never look like a success.
 */
export async function deliverMessage(
  endpoint: string,
  token: string | undefined,
  message: PhoneMessage,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Said to the LLM about messages, for a venue that takes them. */
export function messageRule(transfer: boolean): string {
  const when = transfer
    ? 'when nobody answers a transfer, when the transfer fails, when the venue is closed, or when the caller would rather leave a message'
    : 'when you cannot help or the caller would rather leave a message';
  return `You can take a message for the team, who call back: offer it ${when}. Ask for the caller's name and what it is about, and ask whether the team may call back on the number they are calling from (if not, or if it is hidden, ask for a number and read it back digit by digit). Sum up the message in one sentence, then use the ${MESSAGE_TOOL.name} tool. Only promise a callback after the tool says the message was passed on.`;
}

/**
 * Added to the instructions when the caller comes back from a transfer nobody answered. The
 * caller already heard the greeting and the AI disclosure in the first leg of the call.
 */
export const RETURNED_FROM_TRANSFER =
  'This caller was just transferred to the team, but nobody answered, and the call came back to you. Do not offer another transfer unless the caller insists.';

export function returnedGreetingInstruction(messages: boolean): string {
  return messages
    ? 'Say in one or two short sentences that nobody from the team could answer just now, and offer to take a message so the team calls back.'
    : 'Say in one or two short sentences that nobody from the team could answer just now, and suggest calling again later.';
}
