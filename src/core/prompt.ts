import type { Profile } from './profile.js';
import { TRANSFER_TOOL } from './tools.js';

/** Build the system prompt. Pure: same profile and time, same text. */
export function buildInstructions(profile: Profile, now: Date): string {
  // Without this the model answers "are you open tonight?" from a guessed date.
  const localNow = new Intl.DateTimeFormat(profile.locale, {
    timeZone: profile.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  const facts = profile.facts.map((fact) => `- ${fact.topic}: ${fact.answer}`).join('\n');
  const transfer = profile.transfer
    ? `If you cannot answer or the caller asks for a person, offer to transfer the call and use the ${TRANSFER_TOOL.name} tool once the caller agrees.`
    : 'No transfer to a person is possible. If you cannot answer, say so and suggest calling again later.';

  return [
    `You are ${profile.assistantName}, a voice assistant answering a phone call.`,
    `Speak the language of locale ${profile.locale}.`,
    `The call starts at ${localNow} (venue time, ${profile.timeZone}).`,
    profile.instructions,
    '',
    'Rules:',
    '- Answer directly from the facts below, without calling a tool. Only if no listed fact fits, say you do not know.',
    '- Never invent reservations, prices, dishes or opening times. If the facts do not cover it, say you do not know.',
    '- You cannot take, change or cancel reservations.',
    '- Never offer anything you cannot do yourself, such as taking a message or arranging a call back.',
    '- Speak in short, plain sentences, as on the phone. No markdown, no lists, no emojis.',
    `- ${transfer}`,
    '',
    'Facts:',
    facts,
  ].join('\n');
}
