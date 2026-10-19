import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROFILE_FILE } from './settings.js';

/**
 * JSON.parse, but `undefined` instead of V8's SyntaxError: its message quotes a snippet of the
 * input, and a profile holds a phone number that must not travel into an error text.
 */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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
   * Played by the telephony gateway, not by the agent, when no agent answers: a recording made
   * beforehand (`npm run fallback`), so it works exactly when the agent and the models do not.
   */
  fallback?: string;
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

  if (raw.fallback !== undefined) profile.fallback = str(raw, 'fallback', path);

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
  // compose passes an unset variable as "", which means "no profile chosen", not a file named "".
  const file = path || process.env.SPRECHSTUNDE_PROFILE || DEFAULT_PROFILE_PATH;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read profile ${file}: ${(error as Error).message}`);
  }
  const json = tryParseJson(text);
  if (json === undefined) throw new Error(`Profile ${file} is not valid JSON`);
  const profile = parseProfile(json, file);
  if (profile.voice?.refAudio) profile.voice.refAudio = resolve(dirname(file), profile.voice.refAudio);
  return profile;
}

/**
 * The profile as spoken by an assistant called `name`: every whole-word mention of the profile's
 * `assistantName` in the greeting, the instructions and the transfer announcement becomes `name`.
 * Lets each voice carry its own name, so a caller is never greeted by one name in another voice.
 */
export function withAssistantName(profile: Profile, name: string | undefined): Profile {
  if (!name || name === profile.assistantName) return profile;
  const escaped = profile.assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  const rename = (text: string) => text.replace(mention, name);
  return {
    ...profile,
    assistantName: name,
    greeting: rename(profile.greeting),
    instructions: rename(profile.instructions),
    ...(profile.transfer && { transfer: { ...profile.transfer, announce: rename(profile.transfer.announce) } }),
  };
}

export interface ProfileEntry {
  file: string;
  /** The profile's id; the file name without `.json` when the file does not load. */
  id: string;
  /** What the assistant is called in this profile. */
  name?: string;
  locale?: string;
  /** Why the file does not load. */
  error?: string;
}

/** Every `*.json` file in `dir`, loaded or not: one broken file must not hide the others. */
export function listProfiles(dir: string): ProfileEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => PROFILE_FILE.test(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files.sort().map((file): ProfileEntry => {
    try {
      const profile = loadProfile(join(dir, file));
      return { file, id: profile.id, name: profile.assistantName, locale: profile.locale };
    } catch (error) {
      return { file, id: file.replace(/\.json$/, ''), error: (error as Error).message };
    }
  });
}
