import type { Profile } from './profile.js';
import type { Gender } from './settings.js';
import { referenceBlock } from './knowledge-snapshot.js';
import { TRANSFER_TOOL } from './tools.js';

/** What a character adds to the prompt: how it speaks, and which grammatical gender it uses for itself. */
export interface Persona {
  tone?: string;
  gender?: Gender;
}

const GENDER_LINE: Record<Gender, string> = {
  female: 'You are a woman: where the language marks gender, use the feminine form when you speak about yourself.',
  male: 'You are a man: where the language marks gender, use the masculine form when you speak about yourself.',
  neutral: 'Where the language marks gender, avoid gendered forms when you speak about yourself.',
};

/** How a German-speaking assistant names what it is, once the persona has a stated gender. */
const GERMAN_SELF: Record<Gender, string> = {
  female: 'eine KI-Assistentin',
  male: 'ein KI-Assistent',
  neutral: 'eine KI',
};

/** The persona of a character; a gender nobody has stated stays out, so the prompt is as it was. */
export function personaOf(
  character: { tone?: string; gender: Gender; genderUnknown?: true } | undefined,
): Persona | undefined {
  if (!character) return undefined;
  return {
    tone: character.tone,
    ...(!character.genderUnknown && { gender: character.gender }),
  };
}

/** The speaking-style lines; none for a persona without tone and without a stated gender. */
function styleLines(persona: Persona | undefined, locale: string, selfDescription?: string): string[] {
  const lines: string[] = [];
  if (persona?.tone) lines.push(`Speaking style: ${persona.tone}`);
  if (persona?.gender) lines.push(GENDER_LINE[persona.gender]);
  if (selfDescription) {
    lines.push(`If you say what you are, say "${selfDescription}".`);
  } else if (persona?.gender && locale.toLowerCase().startsWith('de')) {
    lines.push(`If you say what you are, say "${GERMAN_SELF[persona.gender]}".`);
  }
  return lines;
}

/** Build the system prompt. Pure: same profile, time, persona and reference text, same text. */
export function buildInstructions(profile: Profile, now: Date, persona?: Persona, reference?: string): string {
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
    ...styleLines(persona, profile.locale, profile.selfDescription),
    '',
    'Rules:',
    '- Answer directly from the facts below, without calling a tool. Only if no listed fact fits, say you do not know.',
    '- Never invent reservations, prices, dishes or opening times. If the facts do not cover it, say you do not know.',
    '- On allergens, ingredients and diets, only repeat what the facts or reference data state about that dish. Never say a dish is guaranteed free of anything, or safe for an allergy, and never infer it. If the data does not state it, say you do not know and offer a person as described in the last rule.',
    '- You cannot take, change or cancel reservations.',
    '- Never offer anything you cannot do yourself, such as taking a message or arranging a call back.',
    '- Speak in short, plain sentences, as on the phone. No markdown, no lists, no emojis.',
    `- ${transfer}`,
    '',
    'Facts:',
    facts,
    ...(reference ? ['', referenceBlock(reference)] : []),
  ].join('\n');
}
