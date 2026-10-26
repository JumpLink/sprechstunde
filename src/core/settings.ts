/**
 * Voice and model settings that change between test calls, without an env change or a restart:
 * the characters (who speaks) and which of them is the default, plus the LLM models. The agent
 * reads the file at the start of every call, the admin UI (`src/admin/`) writes it.
 *
 * A file from before characters existed (named presets and an active pair, no `schemaVersion`)
 * still loads: `parseSettings` turns it into the current shape in memory, and the next write
 * saves it that way.
 *
 * The file is optional. Without it the environment decides, which stays the documented default,
 * so a deployment that never opens the UI behaves exactly as before.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { LINE_ID } from './lines.js';

export const TTS_PROVIDERS = ['mistral', 'cartesia', 'openrouter', 'pocket', 'kugel'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

/** The vendor-side half of a character: which engine and voice speak. */
export interface VoiceSpec {
  provider: TtsProvider;
  /** The vendor's model; its default when empty (OpenRouter has none). */
  model?: string;
  /** The vendor's voice id. Required for Cartesia, OpenRouter and Kugel (a number there). */
  voice?: string;
  /** Audio file to clone, Mistral only; mutually exclusive with `voice`. */
  refAudio?: string;
}

export const GENDERS = ['female', 'male', 'neutral'] as const;
export type Gender = (typeof GENDERS)[number];

/** The only tenant until the platform has more (docs/adr/0001-multi-tenant-platform.md). */
export const DEFAULT_TENANT = 'default';

/** Who speaks on the phone. A venue picks one by id. */
export interface Character {
  /** Stable key a venue's `character` and the metrics line use; letters, digits, `.`, `_` and `-`. */
  id: string;
  tenantId: string;
  /** What the assistant calls itself; replaces the venue's own assistant name in a call. */
  name: string;
  gender: Gender;
  /** Set on characters migrated from a preset, whose gender nobody has stated yet: the UI asks once. */
  genderUnknown?: true;
  voice: VoiceSpec;
  /** Takes over when `voice` has no room for a call or fails. */
  fallbackVoice?: VoiceSpec;
  /** How it speaks, one to three sentences; goes into the system prompt. */
  tone?: string;
  /** Avatar colour as `#rrggbb`. */
  color?: string;
}

export interface LlmSettings {
  model?: string;
  /** A second model, asked when the first times out or errors; none when empty. */
  fallbackModel?: string;
  /** Seconds one attempt may take before the fallback model is asked. */
  attemptTimeoutS?: number;
}

export const SCHEMA_VERSION = 2;

export interface Settings {
  schemaVersion: typeof SCHEMA_VERSION;
  characters: Character[];
  /** The character a venue without its own uses; the environment decides while none is set. */
  defaultCharacter?: string;
  llm: LlmSettings;
  /** File name inside the profiles directory the next calls use; the start profile when unset. */
  profile?: string;
  /** Profile file per line id (`SIP_LINES`); a line without an entry uses `profile`. */
  lines?: Record<string, string>;
}

export const DEFAULT_SETTINGS_FILE = join('var', 'settings', 'voice.json');

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPRECHSTUNDE_SETTINGS_FILE || DEFAULT_SETTINGS_FILE;
}

export function emptySettings(): Settings {
  return { schemaVersion: SCHEMA_VERSION, characters: [], llm: {} };
}

export const CHARACTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** `PUT /api/characters/default` is a route, so no character may be called that. */
export const RESERVED_CHARACTER_ID = 'default';
export const MAX_NAME_CHARS = 60;
export const MAX_TONE_CHARS = 300;
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** A Kugel voice id as it appears in the vendor's library: digits, nothing else. */
export const KUGEL_VOICE_ID = /^\d{1,9}$/;
const MAX_ATTEMPT_TIMEOUT_S = 120;

export const DEFAULT_VOICES_DIR = join('var', 'voices');

export function voicesDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SPRECHSTUNDE_VOICES_DIR || DEFAULT_VOICES_DIR);
}

/** The file a voice's `refAudio` names, or null when it is absolute or leaves the voices directory. */
export function voiceRefAudioPath(refAudio: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(refAudio)) return null;
  const base = voicesDir(env);
  const file = resolve(base, refAudio);
  return file.startsWith(base + sep) ? file : null;
}

/** A profile is picked by file name only, never by path. */
export const PROFILE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export const DEFAULT_PROFILES_DIR = join('var', 'profiles');

export function profilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SPRECHSTUNDE_PROFILES_DIR || DEFAULT_PROFILES_DIR);
}

/** The file a settings `profile` names, or null when it is not a plain `*.json` name inside the profiles directory. */
export function profileFilePath(file: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!PROFILE_FILE.test(file)) return null;
  const base = profilesDir(env);
  const path = resolve(base, file);
  return path.startsWith(base + sep) ? path : null;
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid settings ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An optional field: absent, or a string with something in it. */
function optionalStr(source: Record<string, unknown>, key: string, where: string, path: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim() === '') fail(path, `${where}"${key}" must be a non-empty string`);
  return value;
}

function parseVoice(raw: unknown, where: string, path: string): VoiceSpec {
  if (!isRecord(raw)) fail(path, `${where} must be an object`);
  const prefix = `${where} `;

  const provider = raw.provider;
  if (typeof provider !== 'string' || !(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    fail(path, `${prefix}"provider" must be one of: ${TTS_PROVIDERS.join(', ')}`);
  }

  const voice = optionalStr(raw, 'voice', prefix, path);
  const refAudio = optionalStr(raw, 'refAudio', prefix, path);
  if (refAudio && voiceRefAudioPath(refAudio) === null) {
    fail(path, `${prefix}"refAudio" must be a file inside the voices directory (SPRECHSTUNDE_VOICES_DIR)`);
  }
  if (voice && refAudio) fail(path, `${prefix}"voice" and "refAudio" are mutually exclusive`);
  // Only Mistral takes a reference clip; silently ignoring it on another vendor would look like
  // the clone worked.
  if (refAudio && provider !== 'mistral') fail(path, `${prefix}"refAudio" works with the mistral provider only`);
  if (!voice && (provider === 'cartesia' || provider === 'openrouter' || provider === 'kugel')) {
    fail(path, `${prefix}"voice" is required for provider ${provider}`);
  }
  // Kugel addresses a voice by its numeric library id. A name would reach the vendor as "no id"
  // and be answered in its default voice, which only shows up when someone listens to a call.
  if (provider === 'kugel' && voice && !KUGEL_VOICE_ID.test(voice)) {
    fail(path, `${prefix}"voice" must be a numeric voice id for provider kugel: ${voice}`);
  }

  const spec: VoiceSpec = { provider: provider as TtsProvider };
  const model = optionalStr(raw, 'model', prefix, path);
  if (model !== undefined) spec.model = model;
  if (voice !== undefined) spec.voice = voice;
  if (refAudio !== undefined) spec.refAudio = refAudio;
  return spec;
}

/** A short single-line text: no control characters, so nothing in it can break a prompt line or a log. */
function plainText(value: string, max: number): boolean {
  if (value.length > max) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function parseCharacter(raw: unknown, index: number, path: string): Character {
  const where = `characters[${index}] `;
  if (!isRecord(raw)) fail(path, `characters[${index}] must be an object`);

  const id = optionalStr(raw, 'id', where, path);
  if (!id) fail(path, `${where}"id" must be a non-empty string`);
  if (!CHARACTER_ID.test(id)) fail(path, `${where}"id" may only contain letters, digits, ".", "_" and "-": ${id}`);
  if (id === RESERVED_CHARACTER_ID) fail(path, `${where}"id" may not be "${RESERVED_CHARACTER_ID}"`);

  const name = optionalStr(raw, 'name', where, path);
  if (!name) fail(path, `${where}"name" must be a non-empty string`);
  if (!plainText(name, MAX_NAME_CHARS)) {
    fail(path, `${where}"name" must be plain text of at most ${MAX_NAME_CHARS} characters`);
  }

  const gender = raw.gender;
  if (typeof gender !== 'string' || !(GENDERS as readonly string[]).includes(gender)) {
    fail(path, `${where}"gender" must be one of: ${GENDERS.join(', ')}`);
  }

  const tenantId = raw.tenantId === undefined ? DEFAULT_TENANT : optionalStr(raw, 'tenantId', where, path);
  if (tenantId === undefined || !CHARACTER_ID.test(tenantId)) fail(path, `${where}"tenantId" is not a tenant id`);

  const character: Character = {
    id,
    tenantId,
    name,
    gender: gender as Gender,
    voice: parseVoice(raw.voice, `${where}"voice"`, path),
  };
  if (raw.genderUnknown === true) character.genderUnknown = true;
  if (raw.fallbackVoice !== undefined && raw.fallbackVoice !== null) {
    character.fallbackVoice = parseVoice(raw.fallbackVoice, `${where}"fallbackVoice"`, path);
  }
  const tone = optionalStr(raw, 'tone', where, path);
  if (tone !== undefined) {
    if (!plainText(tone.trim(), MAX_TONE_CHARS)) {
      fail(path, `${where}"tone" must be plain text of at most ${MAX_TONE_CHARS} characters`);
    }
    character.tone = tone.trim();
  }
  const color = optionalStr(raw, 'color', where, path);
  if (color !== undefined) {
    if (!COLOR.test(color)) fail(path, `${where}"color" must look like #1a2b3c`);
    character.color = color.toLowerCase();
  }
  return character;
}

function parseLlm(raw: unknown, path: string): LlmSettings {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) fail(path, '"llm" must be an object');
  const llm: LlmSettings = {};
  const model = optionalStr(raw, 'model', 'llm ', path);
  const fallbackModel = optionalStr(raw, 'fallbackModel', 'llm ', path);
  if (model !== undefined) llm.model = model;
  if (fallbackModel !== undefined) llm.fallbackModel = fallbackModel;

  const timeout = raw.attemptTimeoutS;
  if (timeout !== undefined && timeout !== null && timeout !== '') {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_ATTEMPT_TIMEOUT_S) {
      fail(path, `llm "attemptTimeoutS" must be a number of seconds between 0 and ${MAX_ATTEMPT_TIMEOUT_S}`);
    }
    llm.attemptTimeoutS = timeout;
  }
  return llm;
}

/**
 * A settings file from before characters: named presets and an active primary/fallback pair.
 * Every preset becomes a character (named after its assistant name, else its label; its gender is
 * unknown), and the active pair becomes the default character's voice and fallback voice.
 */
function migrateV1(raw: Record<string, unknown>, path: string): Record<string, unknown> {
  const rawPresets = raw.presets ?? [];
  if (!Array.isArray(rawPresets)) fail(path, '"presets" must be an array');
  const byId = new Map<string, Record<string, unknown>>();
  for (const [index, preset] of rawPresets.entries()) {
    if (!isRecord(preset)) fail(path, `presets[${index}] must be an object`);
    const id = optionalStr(preset, 'id', `presets[${index}] `, path);
    if (!id) fail(path, `presets[${index}] "id" must be a non-empty string`);
    if (byId.has(id)) fail(path, `duplicate preset id: ${id}`);
    byId.set(id, preset);
  }

  const rawActive = raw.active ?? {};
  if (!isRecord(rawActive)) fail(path, '"active" must be an object');
  const primary = optionalStr(rawActive, 'primary', 'active ', path);
  const fallback = optionalStr(rawActive, 'fallback', 'active ', path);
  for (const [slot, id] of [
    ['primary', primary],
    ['fallback', fallback],
  ] as const) {
    if (id !== undefined && !byId.has(id)) fail(path, `active "${slot}" names no preset: ${id}`);
  }
  if (primary && primary === fallback) fail(path, 'active "primary" and "fallback" must be different presets');
  if (fallback && !primary) fail(path, 'active "fallback" needs an active "primary"');

  const voiceOf = (preset: Record<string, unknown>) => ({
    provider: preset.provider,
    model: preset.model,
    voice: preset.voice,
    refAudio: preset.refAudio,
  });
  const idOf = (id: string) => (id === RESERVED_CHARACTER_ID ? `${id}-voice` : id);

  const characters = [...byId.entries()].map(([id, preset]) => {
    const name =
      optionalStr(preset, 'name', `presets[${id}] `, path) ?? optionalStr(preset, 'label', `presets[${id}] `, path);
    return {
      id: idOf(id),
      name,
      gender: 'neutral',
      genderUnknown: true,
      voice: voiceOf(preset),
      ...(id === primary && fallback && { fallbackVoice: voiceOf(byId.get(fallback)!) }),
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    characters,
    ...(primary && { defaultCharacter: idOf(primary) }),
    llm: raw.llm,
    profile: raw.profile,
    lines: raw.lines,
  };
}

/** Validate an already parsed JSON value, migrating the shape from before characters. `path` only shows up in error messages. */
export function parseSettings(raw: unknown, path = '<settings>'): Settings {
  if (!isRecord(raw)) fail(path, 'top level must be an object');
  const current = raw.schemaVersion === undefined ? migrateV1(raw, path) : raw;
  if (current.schemaVersion !== SCHEMA_VERSION)
    fail(path, `"schemaVersion" ${String(current.schemaVersion)} is not supported`);

  const rawCharacters = current.characters ?? [];
  if (!Array.isArray(rawCharacters)) fail(path, '"characters" must be an array');
  const characters = rawCharacters.map((entry, index) => parseCharacter(entry, index, path));
  const keys = new Set<string>();
  for (const character of characters) {
    const key = `${character.tenantId}/${character.id}`;
    if (keys.has(key)) fail(path, `duplicate character id: ${character.id}`);
    keys.add(key);
  }

  const settings: Settings = {
    schemaVersion: SCHEMA_VERSION,
    characters,
    llm: parseLlm(current.llm, path),
  };
  const defaultId = optionalStr(current, 'defaultCharacter', '', path);
  if (defaultId !== undefined) {
    if (!findCharacter({ characters }, DEFAULT_TENANT, defaultId)) {
      fail(path, `"defaultCharacter" names no character: ${defaultId}`);
    }
    settings.defaultCharacter = defaultId;
  }
  const profile = optionalStr(current, 'profile', '', path);
  if (profile !== undefined) {
    if (profileFilePath(profile) === null) {
      fail(path, `"profile" must be the name of a .json file in the profiles directory (SPRECHSTUNDE_PROFILES_DIR)`);
    }
    settings.profile = profile;
  }
  const rawLines = current.lines;
  if (rawLines !== undefined && rawLines !== null) {
    if (!isRecord(rawLines)) fail(path, '"lines" must be an object');
    const lines: Record<string, string> = {};
    for (const [lineId, file] of Object.entries(rawLines)) {
      if (!LINE_ID.test(lineId)) fail(path, `"lines" key is not a line id: ${lineId}`);
      if (typeof file !== 'string' || profileFilePath(file) === null) {
        fail(path, `"lines" ${lineId} must be the name of a .json file in the profiles directory`);
      }
      lines[lineId] = file;
    }
    if (Object.keys(lines).length > 0) settings.lines = lines;
  }
  return settings;
}

/** Every lookup names the tenant, so a second tenant cannot reach the first one's characters by id. */
export function findCharacter(
  settings: Pick<Settings, 'characters'> | undefined,
  tenantId: string,
  id: string | undefined,
): Character | undefined {
  if (!id) return undefined;
  return settings?.characters.find((character) => character.tenantId === tenantId && character.id === id);
}

export function defaultCharacter(settings: Settings | undefined, tenantId = DEFAULT_TENANT): Character | undefined {
  return findCharacter(settings, tenantId, settings?.defaultCharacter);
}

/**
 * The character a call with this venue speaks as: the one the venue names, the default character
 * when it names none or an unknown one (`unknown` carries that id so the caller can report it),
 * and none when no default is set either — then the environment decides.
 */
export function characterFor(
  settings: Settings | undefined,
  venueCharacter: string | undefined,
  tenantId = DEFAULT_TENANT,
): { character?: Character; unknown?: string } {
  const named = findCharacter(settings, tenantId, venueCharacter);
  if (named) return { character: named };
  const fallback = defaultCharacter(settings, tenantId);
  return {
    ...(fallback && { character: fallback }),
    ...(venueCharacter && { unknown: venueCharacter }),
  };
}

/**
 * Read and validate the file. `undefined` when it does not exist — that is the normal state of a
 * fresh install, not an error. Invalid content throws, so the admin UI can report it.
 */
export function readSettings(path: string): Settings | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read settings ${path}: ${(error as Error).message}`);
  }
  if (text.trim() === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Settings ${path} are not valid JSON: ${(error as Error).message}`);
  }
  return parseSettings(json, path);
}

/**
 * Replace the file in one step: a reader (the agent, at the start of a call) sees either the old
 * or the new content, never half a write.
 */
export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // nothing to clean up
    }
    throw error;
  }
}
