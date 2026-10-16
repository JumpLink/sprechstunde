import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Fact {
  topic: string;
  answer: string;
}

export interface Profile {
  id: string;
  /** BCP-47 tag, e.g. "de-DE". */
  locale: string;
  /** IANA time zone of the venue, e.g. "Europe/Berlin": "today" and "tonight" are local to it. */
  timeZone: string;
  assistantName: string;
  /** Spoken first. Must disclose that the caller talks to an AI (EU AI Act, Art. 50). */
  greeting: string;
  /** Free-text persona and rules, added to the system prompt. */
  instructions: string;
  facts: Fact[];
  transfer?: { target: string; announce: string };
  /**
   * `ttsVoice` is a Mistral voice id; `refAudio` is an audio file to clone, relative to the profile
   * file (absolute after `loadProfile`). At most one of them.
   */
  voice?: { ttsVoice?: string; refAudio?: string };
}

export const DEFAULT_PROFILE_PATH = 'profiles/example/profile.de.json';

const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function fail(path: string, message: string): never {
  throw new Error(`Invalid profile ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, `"${key}" must be a non-empty string`);
  }
  return value;
}

/** Validate an already parsed JSON value. `path` is only used in error messages. */
export function parseProfile(raw: unknown, path = '<profile>'): Profile {
  if (!isRecord(raw)) fail(path, 'top level must be an object');

  const locale = str(raw, 'locale', path);
  if (!BCP47.test(locale)) fail(path, `"locale" is not a BCP-47 tag: ${locale}`);

  const timeZone = str(raw, 'timeZone', path);
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    fail(path, `"timeZone" is not an IANA time zone: ${timeZone}`);
  }

  if (!Array.isArray(raw.facts)) fail(path, '"facts" must be an array');
  const facts = raw.facts.map((entry, index): Fact => {
    if (!isRecord(entry)) fail(path, `facts[${index}] must be an object`);
    return {
      topic: str(entry, 'topic', `${path} facts[${index}]`),
      answer: str(entry, 'answer', `${path} facts[${index}]`),
    };
  });

  const profile: Profile = {
    id: str(raw, 'id', path),
    locale,
    timeZone,
    assistantName: str(raw, 'assistantName', path),
    greeting: str(raw, 'greeting', path),
    instructions: str(raw, 'instructions', path),
    facts,
  };

  if (raw.transfer !== undefined) {
    if (!isRecord(raw.transfer)) fail(path, '"transfer" must be an object');
    const target = str(raw.transfer, 'target', `${path} transfer`);
    if (!/^(tel:|sip:)/.test(target)) fail(path, '"transfer.target" must start with tel: or sip:');
    profile.transfer = { target, announce: str(raw.transfer, 'announce', `${path} transfer`) };
  }

  if (raw.voice !== undefined) {
    if (!isRecord(raw.voice)) fail(path, '"voice" must be an object');
    const { ttsVoice, refAudio } = raw.voice;
    if (ttsVoice !== undefined && typeof ttsVoice !== 'string') {
      fail(path, '"voice.ttsVoice" must be a string');
    }
    if (refAudio !== undefined && (typeof refAudio !== 'string' || refAudio.trim() === '')) {
      fail(path, '"voice.refAudio" must be a non-empty path');
    }
    if (ttsVoice !== undefined && refAudio !== undefined) {
      fail(path, '"voice.ttsVoice" and "voice.refAudio" are mutually exclusive');
    }
    profile.voice = {};
    if (ttsVoice !== undefined) profile.voice.ttsVoice = ttsVoice;
    if (refAudio !== undefined) profile.voice.refAudio = refAudio;
  }

  return profile;
}

export function loadProfile(path?: string): Profile {
  const file = path ?? process.env.SPRECHSTUNDE_PROFILE ?? DEFAULT_PROFILE_PATH;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read profile ${file}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Profile ${file} is not valid JSON: ${(error as Error).message}`);
  }
  const profile = parseProfile(json, file);
  if (profile.voice?.refAudio) profile.voice.refAudio = resolve(dirname(file), profile.voice.refAudio);
  return profile;
}
