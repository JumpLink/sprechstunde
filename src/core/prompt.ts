import { type AudioTag, audioTagLines } from './audio-tags.js';
import type { Profile } from './profile.js';
import type { Gender } from './settings.js';
import { DETAILS_MARKER, LOOKUP_TOOL_NAME } from './knowledge-lookup.js';
import { referenceBlock } from './knowledge-snapshot.js';
import { TRANSFER_TOOL } from './tools.js';

/** What a character adds to the prompt: how it speaks, and which grammatical gender it uses for itself. */
export interface Persona {
  tone?: string;
  gender?: Gender;
  /** The cues the call's voice reads instead of speaking; none for a voice that would read them out. */
  audioTags?: readonly AudioTag[];
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

/** The speaking-style lines; none for a persona without tone, stated gender or audio tags. */
function styleLines(persona: Persona | undefined, locale: string, selfDescription?: string): string[] {
  const lines: string[] = [];
  if (persona?.tone) lines.push(`Speaking style: ${persona.tone}`);
  if (persona?.gender) lines.push(GENDER_LINE[persona.gender]);
  if (selfDescription) {
    lines.push(`If you say what you are, say "${selfDescription}".`);
  } else if (persona?.gender && locale.toLowerCase().startsWith('de')) {
    lines.push(`If you say what you are, say "${GERMAN_SELF[persona.gender]}".`);
  }
  lines.push(...audioTagLines(persona?.audioTags ?? []));
  return lines;
}

/** Build the system prompt. Pure: same profile, time, persona and reference text, same text. */
export function buildInstructions(
  profile: Profile,
  now: Date,
  persona?: Persona,
  reference?: string,
  about?: string,
): string {
  // Without this the model answers "are you open tonight?" from a guessed date.
  // No year: a caller never needs it, and a model spelling out "2026" for speech gets it wrong.
  const localNow = new Intl.DateTimeFormat(profile.locale, {
    timeZone: profile.timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  const facts = profile.facts.map((fact) => `- ${fact.topic}: ${fact.answer}`).join('\n');
  const transfer = profile.transfer
    ? `If you cannot answer or the caller asks for a person, offer to transfer the call and use the ${TRANSFER_TOOL.name} tool once the caller agrees.`
    : 'No transfer to a person is possible. If you cannot answer, say so and suggest calling again later.';

  // A cut-down section hides its dishes and prices, so "no listed fact fits" is not yet a reason
  // to say "I do not know" (measured 2026-11-10: the model skipped the tool in 4 of 7 questions
  // while a rule here said to answer without one).
  const answerRule = reference?.includes(DETAILS_MARKER)
    ? `- Answer directly from the facts below, without calling a tool. If no fact fits and the question could be about a section marked "${DETAILS_MARKER}" (dishes, prices, drinks, ingredients), call ${LOOKUP_TOOL_NAME} for that section before anything else. Only if the looked-up text does not cover it either, say you do not know.`
    : '- Answer directly from the facts below, without calling a tool. Only if no listed fact fits, say you do not know.';

  return [
    `You are ${profile.assistantName}, a voice assistant answering a phone call.`,
    `Speak the language of locale ${profile.locale}.`,
    `The call starts at ${localNow} (venue time, ${profile.timeZone}).`,
    profile.instructions,
    ...styleLines(persona, profile.locale, profile.selfDescription),
    '',
    'Rules:',
    answerRule,
    '- State nothing about the venue that the facts or reference data do not say: no reservations, prices, dishes or opening times, and no house policies such as pets, payment, parking, accessibility, seating or events. Never answer yes or no to such a question by guessing; if it is not covered, say you do not know.',
    '- On allergens, ingredients and diets, only repeat what the facts or reference data state about that dish. Never say a dish is guaranteed free of anything, or safe for an allergy, and never infer it. If the data does not state it, say you do not know and offer a person as described in the last rule.',
    // Phone test 2026-11-11: the facts said nothing about reservations by phone and the model
    // answered that the venue takes none; the venue does, through a person.
    '- You cannot take, change or cancel reservations yourself. Never say that the venue takes no reservations by phone or that reserving is impossible. If the facts or reference data name a way to reserve, say that; otherwise say you cannot book yourself and offer a transfer to a person, if one is possible.',
    '- Never offer anything you cannot do yourself, such as taking a message or arranging a call back.',
    '- Speak in short, plain sentences, as on the phone. No markdown, no lists, no emojis.',
    // Every voice reads the text as given. ElevenLabs recommends words over digits, and its own
    // normalisation only adds latency.
    '- Your text is read aloud by a speech synthesizer, so write it as it is spoken: times, dates, numbers, prices and abbreviations in words, never as digits or symbols (in German "von siebzehn bis einundzwanzig Uhr", "neun Uhr dreißig", "zwölf Euro fünfzig"). Mark pauses with commas and full stops, not with dashes or line breaks.',
    `- ${transfer}`,
    '',
    'Facts:',
    facts,
    ...(reference ? ['', referenceBlock(reference)] : []),
    ...(about ? ['', about] : []),
  ].join('\n');
}
