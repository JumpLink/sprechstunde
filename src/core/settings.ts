/**
 * Voice and model settings that change between test calls, without an env change or a restart:
 * named presets and which of them is active, plus the LLM models. The agent reads the file at the
 * start of every call, the admin UI (`src/admin/`) writes it.
 *
 * The file is optional. Without it the environment decides, which stays the documented default,
 * so a deployment that never opens the UI behaves exactly as before.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const TTS_PROVIDERS = ['mistral', 'cartesia', 'openrouter', 'pocket', 'kugel'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export interface VoicePreset {
  /** Stable key used by `active` and by the metrics line; letters, digits, `.`, `_` and `-`. */
  id: string;
  /** What the UI shows. Free text, so a venue can call a voice what it likes. */
  label: string;
  provider: TtsProvider;
  /** The vendor's model; its default when empty (OpenRouter has none). */
  model?: string;
  /** The vendor's voice id. Required for Cartesia, OpenRouter and Kugel (a number there). */
  voice?: string;
  /** Audio file to clone, Mistral only; mutually exclusive with `voice`. */
  refAudio?: string;
  /** The name the assistant gives itself with this voice; the profile's otherwise. */
  name?: string;
}

export interface LlmSettings {
  model?: string;
  /** A second model, asked when the first times out or errors; none when empty. */
  fallbackModel?: string;
  /** Seconds one attempt may take before the fallback model is asked. */
  attemptTimeoutS?: number;
}

export type ActiveSlot = 'primary' | 'fallback';

export interface Settings {
  presets: VoicePreset[];
  active: Partial<Record<ActiveSlot, string>>;
  llm: LlmSettings;
}

export const DEFAULT_SETTINGS_FILE = join('var', 'settings', 'voice.json');

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPRECHSTUNDE_SETTINGS_FILE || DEFAULT_SETTINGS_FILE;
}

export function emptySettings(): Settings {
  return { presets: [], active: {}, llm: {} };
}

export const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A Kugel voice id as it appears in the vendor's library: digits, nothing else. */
export const KUGEL_VOICE_ID = /^\d+$/;
const MAX_ATTEMPT_TIMEOUT_S = 120;

export const DEFAULT_VOICES_DIR = join('var', 'voices');

export function voicesDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SPRECHSTUNDE_VOICES_DIR || DEFAULT_VOICES_DIR);
}

/** The file a preset's `refAudio` names, or null when it is absolute or leaves the voices directory. */
export function presetRefAudioPath(refAudio: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(refAudio)) return null;
  const base = voicesDir(env);
  const file = resolve(base, refAudio);
  return file.startsWith(base + sep) ? file : null;
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

function parsePreset(raw: unknown, index: number, path: string): VoicePreset {
  const where = `presets[${index}] `;
  if (!isRecord(raw)) fail(path, `presets[${index}] must be an object`);

  const id = optionalStr(raw, 'id', where, path);
  if (!id) fail(path, `${where}"id" must be a non-empty string`);
  if (!PRESET_ID.test(id)) fail(path, `${where}"id" may only contain letters, digits, ".", "_" and "-": ${id}`);

  const label = optionalStr(raw, 'label', where, path);
  if (!label) fail(path, `${where}"label" must be a non-empty string`);

  const provider = raw.provider;
  if (typeof provider !== 'string' || !(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    fail(path, `${where}"provider" must be one of: ${TTS_PROVIDERS.join(', ')}`);
  }

  const voice = optionalStr(raw, 'voice', where, path);
  const refAudio = optionalStr(raw, 'refAudio', where, path);
  if (refAudio && presetRefAudioPath(refAudio) === null) {
    fail(path, `${where}"refAudio" must be a file inside the voices directory (SPRECHSTUNDE_VOICES_DIR)`);
  }
  if (voice && refAudio) fail(path, `${where}"voice" and "refAudio" are mutually exclusive`);
  // Only Mistral takes a reference clip; silently ignoring it on another vendor would look like
  // the clone worked.
  if (refAudio && provider !== 'mistral') fail(path, `${where}"refAudio" works with the mistral provider only`);
  if (!voice && (provider === 'cartesia' || provider === 'openrouter' || provider === 'kugel')) {
    fail(path, `${where}"voice" is required for provider ${provider}`);
  }
  // Kugel addresses a voice by its numeric library id. A name would reach the vendor as "no id"
  // and be answered in its default voice, which only shows up when someone listens to a call.
  if (provider === 'kugel' && voice && !KUGEL_VOICE_ID.test(voice)) {
    fail(path, `${where}"voice" must be a numeric voice id for provider kugel: ${voice}`);
  }

  const preset: VoicePreset = { id, label, provider: provider as TtsProvider };
  const model = optionalStr(raw, 'model', where, path);
  const name = optionalStr(raw, 'name', where, path);
  if (model !== undefined) preset.model = model;
  if (voice !== undefined) preset.voice = voice;
  if (refAudio !== undefined) preset.refAudio = refAudio;
  if (name !== undefined) preset.name = name;
  return preset;
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

/** Validate an already parsed JSON value. `path` only shows up in error messages. */
export function parseSettings(raw: unknown, path = '<settings>'): Settings {
  if (!isRecord(raw)) fail(path, 'top level must be an object');

  const rawPresets = raw.presets ?? [];
  if (!Array.isArray(rawPresets)) fail(path, '"presets" must be an array');
  const presets = rawPresets.map((entry, index) => parsePreset(entry, index, path));
  const ids = new Set<string>();
  for (const preset of presets) {
    if (ids.has(preset.id)) fail(path, `duplicate preset id: ${preset.id}`);
    ids.add(preset.id);
  }

  const rawActive = raw.active ?? {};
  if (!isRecord(rawActive)) fail(path, '"active" must be an object');
  const active: Settings['active'] = {};
  for (const slot of ['primary', 'fallback'] as const) {
    const id = optionalStr(rawActive, slot, 'active ', path);
    if (id === undefined) continue;
    if (!ids.has(id)) fail(path, `active "${slot}" names no preset: ${id}`);
    active[slot] = id;
  }
  if (active.primary && active.primary === active.fallback) {
    fail(path, 'active "primary" and "fallback" must be different presets');
  }
  // A fallback alone would silently do nothing: the agent reads the pair, primary first.
  if (active.fallback && !active.primary) fail(path, 'active "fallback" needs an active "primary"');

  return { presets, active, llm: parseLlm(raw.llm, path) };
}

export function activePreset(settings: Settings | undefined, slot: ActiveSlot): VoicePreset | undefined {
  const id = settings?.active[slot];
  if (!id) return undefined;
  return settings?.presets.find((preset) => preset.id === id);
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
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
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
