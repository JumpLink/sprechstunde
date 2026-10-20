/**
 * The settings UI as a small HTTP server: characters and which of them is the default, the LLM
 * models, a preview that plays a voice, and what the metrics say about the voices used so far.
 *
 * It binds to the loopback interface and has no login: whoever can reach it may change the voice
 * of every call. Two things follow, and both are checked here rather than assumed:
 * a `Host` that is not loopback means someone pointed a name at 127.0.0.1 (DNS rebinding), and a
 * state-changing request from another origin means a page the operator did not open.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  CHARACTER_ID,
  characterFor,
  DEFAULT_TENANT,
  emptySettings,
  findCharacter,
  parseSettings,
  readSettings,
  RESERVED_CHARACTER_ID,
  type Settings,
  TTS_PROVIDERS,
  writeSettings,
  profileFilePath,
  profilesDir,
} from '../core/settings.js';
import { describeKnowledge } from '../core/knowledge.js';
import {
  DEFAULT_PROFILE_PATH,
  listProfiles,
  loadProfile,
  type Profile,
  tryParseJson,
  withAssistantName,
} from '../core/profile.js';
import { buildInstructions, type Persona, personaOf } from '../core/prompt.js';
import { transferOverride } from '../core/tools.js';
import { profileForCall } from '../agent/settings.js';
import { choiceFromVoice, kugelApiKey, type TtsChoice, ttsChoice, ttsFallbackChoice } from '../agent/tts-provider.js';
import { _ } from '../i18n.js';
import { CATALOG_TARGETS, type CatalogService, type CatalogTarget, createCatalog } from './catalog.js';
import { byCharacter, callsFrom, METRIC_NAMES, readMetrics, summarizeCall } from './latency.js';
import { HttpError } from './http-error.js';
import { applyDraft, createProfileStore, draftView, parseDraft, revisionOf } from './profile-store.js';
import { findWebDir, serveStatic } from './static.js';
import { previewWav, type Synthesizer } from './preview.js';

export const DEFAULT_PORT = 8091;
export const HOST = '127.0.0.1';

/** A body larger than this is not a settings change; the UI sends a few hundred bytes. */
const MAX_BODY_BYTES = 256 * 1024;
/** Calls shown in the latency table. More would be a log, not an overview. */
const RECENT_CALLS = 25;
const CATALOG_PREFIX = '/api/catalog/';
const CHARACTER_PREFIX = '/api/characters/';
const PROFILE_PREFIX = '/api/profiles/';

/** A preview is a sentence or two; more is credit spent on a vendor for nothing. */
const MAX_PREVIEW_CHARS = 1000;
const MAX_VOICE_FIELD_CHARS = 100;
/** A vendor sample is a few seconds of audio; anything bigger is not one. */
const MAX_SAMPLE_BYTES = 5 * 1024 * 1024;
const SAMPLE_TIMEOUT_MS = 10_000;

export interface AdminOptions {
  settingsPath: string;
  metricsDir: string;
  synthesize: Synthesizer;
  /** Preview text the page starts with; the profile's greeting is what a caller really hears. */
  sampleText: string;
  /** The profile the worker starts with: what a call uses while no other one is picked. */
  startProfile?: { id: string; name?: string; locale?: string };
  /** Loads the start profile in full, for the knowledge view; the default profile when absent. */
  loadStartProfile?: () => Profile;
  /** The start profile's file, which "duplicate" copies; `SPRECHSTUNDE_PROFILE` or the example when absent. */
  startProfileFile?: string;
  /** Vendor models and voices; the real vendors unless a test hands in a fake. */
  catalog?: CatalogService;
  env?: NodeJS.ProcessEnv;
  /** Fetches vendor samples; the global `fetch` unless a test hands in a fake. */
  fetch?: typeof fetch;
  /** The built settings app; found next to this build when absent, `null` for none (tests). */
  webDir?: string | null;
}

function loopbackHost(header: string | undefined): boolean {
  if (!header) return false;
  const host = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** The same origin the page was served from, or nothing at all (a request outside a browser). */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, _('the request body is too large'));
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function body(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new HttpError(400, _('the request body must be a JSON object'));
  return raw;
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  payload: string | Uint8Array,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': type,
    'content-length': typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength,
    // Nothing here is for another page to read, and the answers change with every call.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(payload);
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

/** A short plain string: no control characters, so nothing in it can break a header, a log or a URL. */
function plainField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_VOICE_FIELD_CHARS) {
    throw new HttpError(400, _('"%s" must be a short plain string').replace('%s', name));
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      throw new HttpError(400, _('"%s" must be a short plain string').replace('%s', name));
    }
  }
  return value;
}

/** Whether the configured KugelAudio key routes to the EU endpoint; false when there is no key. */
function kugelInEu(env: NodeJS.ProcessEnv): boolean {
  try {
    return kugelApiKey(env).startsWith('eu-');
  } catch {
    return false;
  }
}

function slot(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A number from a form field: empty means "not set", anything else is left for the validation. */
function maybeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'number' ? value : Number(value);
}

/** The sample as bytes with the vendor's audio type; refuses anything else or anything too big. */
async function fetchSample(fetcher: typeof fetch, address: string): Promise<{ type: string; body: Uint8Array }> {
  const bad = () => new HttpError(502, _('the vendor sample could not be fetched'));
  if (!address.startsWith('https://')) throw bad();
  let upstream: Response;
  try {
    upstream = await fetcher(address, {
      signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch {
    throw bad();
  }
  const type = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  // A redirect could lead anywhere, loopback included; a catalog sample address does not redirect.
  if (upstream.status >= 300 || !upstream.ok || !type.startsWith('audio/') || !upstream.body) throw bad();
  const declared = Number(upstream.headers.get('content-length'));
  if (declared > MAX_SAMPLE_BYTES) throw bad();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of upstream.body) {
      size += chunk.byteLength;
      if (size > MAX_SAMPLE_BYTES) throw bad();
      chunks.push(chunk);
    }
  } catch {
    throw bad();
  }
  return { type, body: Buffer.concat(chunks) };
}

export function createAdminServer(options: AdminOptions): Server {
  const env = options.env ?? process.env;

  const catalog = options.catalog ?? createCatalog({ env });

  const store = createProfileStore(env);

  /** The page's view of a profile file it may edit: the raw values (no voice renaming) and the revision. */
  const editing = (file: string | null | undefined) => {
    if (!file) return { editable: false as const };
    const path = profileFilePath(file, env);
    if (!path) return { editable: false as const };
    try {
      const { revision } = store.readRaw(file);
      return {
        editable: true as const,
        revision,
        draft: draftView(loadProfile(path)),
      };
    } catch {
      return { editable: false as const };
    }
  };

  /** A call speaks as the venue's character: its name replaces the venue's, and its tone and gender shape the prompt. */
  const speaker = (settings: Settings, profile: Profile): { name?: string; persona?: Persona } => {
    const { character } = characterFor(settings, profile.character);
    if (!character) return {}; // no character: the profile's own name stands
    return { name: character.name, persona: personaOf(character) };
  };

  const startRaw = (): { raw: Record<string, unknown>; dir: string } => {
    const path = resolve(options.startProfileFile ?? (env.SPRECHSTUNDE_PROFILE || DEFAULT_PROFILE_PATH));
    try {
      const raw = tryParseJson(readFileSync(path, 'utf8'));
      if (raw === undefined) throw new Error(_('%s is not valid JSON').replace('%s', basename(path)));
      if (!isRecord(raw)) throw new Error(_('top level must be an object'));
      return { raw, dir: dirname(path) };
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  };

  const read = (): Settings => readSettings(options.settingsPath) ?? emptySettings();

  /** The settings a request works on. A file that does not parse is the operator's problem, not ours. */
  const current = (): Settings => {
    try {
      return read();
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  };

  /** Read, change, validate, write. Invalid changes are rejected before the file is touched. */
  const update = (change: (settings: Settings) => unknown): Settings => {
    let next: Settings;
    try {
      next = parseSettings(change(current()), options.settingsPath);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, (error as Error).message);
    }
    writeSettings(options.settingsPath, next);
    return next;
  };

  /** The voice the environment configures, shown while no preset is active. */
  const envVoice = (): {
    primary?: TtsChoice;
    fallback?: TtsChoice;
    error?: string;
  } => {
    try {
      return {
        primary: ttsChoice(env),
        ...(ttsFallbackChoice(env) && { fallback: ttsFallbackChoice(env) }),
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };

  const state = () => {
    let settings: Settings | undefined;
    let error: string | undefined;
    try {
      settings = read();
    } catch (failure) {
      // A hand-edited file that no longer parses: the UI has to say so, because the agent is
      // ignoring the file for the same reason and the operator sees a voice they did not pick.
      error = (failure as Error).message;
    }
    return {
      settings: settings ?? emptySettings(),
      settingsError: error,
      settingsPath: options.settingsPath,
      envVoice: envVoice(),
      providers: TTS_PROVIDERS,
      metricNames: METRIC_NAMES,
      sampleText: options.sampleText,
      // Whether a vendor can be previewed at all — never the key itself.
      keys: {
        mistral: Boolean(env.MISTRAL_API_KEY),
        cartesia: Boolean(env.CARTESIA_API_KEY),
        openrouter: Boolean(env.OPENROUTER_API_KEY),
        kugel: Boolean(env.KUGELAUDIO_API_KEY),
      },
      // Known facts for the casting badges: where KugelAudio speaks from, with the key as configured.
      kugelEu: kugelInEu(env),
    };
  };

  /** A voice that is not saved as a character (a catalog entry being tried): same validation as a character's. */
  const choiceFromInline = (inline: Record<string, unknown>): TtsChoice => {
    if (!(TTS_PROVIDERS as readonly unknown[]).includes(inline.provider)) {
      throw new HttpError(400, _('"provider" must be one of: %s').replace('%s', TTS_PROVIDERS.join(', ')));
    }
    const model = plainField(inline.model, 'model');
    const voice = plainField(inline.voice, 'voice');
    try {
      const { characters } = parseSettings(
        {
          schemaVersion: 2,
          characters: [
            {
              id: 'preview',
              name: 'preview',
              gender: 'neutral',
              voice: { provider: inline.provider, model, voice },
            },
          ],
        },
        options.settingsPath,
      );
      return choiceFromVoice(characters[0]!.voice, { id: 'preview' });
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  };

  const choiceFor = (settings: Settings, characterId: string | undefined): TtsChoice => {
    if (!characterId) {
      const voice = envVoice();
      if (!voice.primary) throw new HttpError(400, voice.error ?? _('no voice is configured'));
      return voice.primary;
    }
    const found = findCharacter(settings, DEFAULT_TENANT, characterId);
    if (!found) throw new HttpError(404, _('no character with id %s').replace('%s', characterId));
    try {
      return choiceFromVoice(found.voice, { id: found.id, name: found.name });
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  };

  const revisionOfCharacters = (settings: Settings): string =>
    revisionOf(JSON.stringify([settings.characters, settings.defaultCharacter ?? null]));

  /** Every venue that can speak: each profile file, and the one the worker starts with. */
  const venues = (): Array<{
    file: string | null;
    id: string;
    name?: string;
    character?: string;
  }> => {
    const list: Array<{
      file: string | null;
      id: string;
      name?: string;
      character?: string;
    }> = [];
    try {
      for (const entry of listProfiles(profilesDir(env))) {
        if (entry.error) continue;
        list.push({
          file: entry.file,
          id: entry.id,
          name: entry.name,
          character: entry.character,
        });
      }
    } catch {
      // an unreadable profiles directory is reported by /api/profiles
    }
    try {
      const start = (options.loadStartProfile ?? (() => loadProfile()))();
      list.push({
        file: null,
        id: start.id,
        name: start.assistantName,
        character: start.character,
      });
    } catch {
      // no start profile to name
    }
    return list;
  };

  const charactersView = () => {
    const settings = current();
    const all = venues();
    return {
      tenantId: DEFAULT_TENANT,
      revision: revisionOfCharacters(settings),
      default: settings.defaultCharacter ?? null,
      characters: settings.characters
        .filter((character) => character.tenantId === DEFAULT_TENANT)
        .map((character) => ({
          ...character,
          usedBy: all
            .filter((venue) => characterFor(settings, venue.character).character?.id === character.id)
            .map((venue) => ({
              file: venue.file,
              id: venue.id,
              name: venue.name,
              explicit: venue.character === character.id,
            })),
        })),
    };
  };

  const MAX_CHARACTERS = 200;
  const PALETTE = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f'];

  const slug = (name: string): string => {
    const base = name
      .normalize('NFD')
      .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
      .toLowerCase()
      .replace(new RegExp('[^a-z0-9]+', 'g'), '-')
      .replace(new RegExp('^-+|-+$', 'g'), '');
    return base || 'character';
  };

  /** The fields a client may set; tenant and any other key are ours to decide. */
  const characterFields = (wanted: Record<string, unknown>) => ({
    ...(wanted.name !== undefined && { name: wanted.name }),
    gender: wanted.gender,
    ...(wanted.genderUnknown === true ? { genderUnknown: true } : {}),
    voice: wanted.voice,
    ...(wanted.fallbackVoice ? { fallbackVoice: wanted.fallbackVoice } : {}),
    ...(wanted.tone ? { tone: wanted.tone } : {}),
    ...(wanted.color ? { color: wanted.color } : {}),
  });

  const requireRevision = (settings: Settings, revision: unknown): void => {
    if (typeof revision !== 'string' || revision === '') {
      throw new HttpError(400, _('"revision" must be the revision the page loaded'));
    }
    if (revision !== revisionOfCharacters(settings)) {
      throw new HttpError(409, _('the characters changed since you loaded them: reload and make the change again'));
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET';
    if (!loopbackHost(request.headers.host)) throw new HttpError(403, _('this server answers on 127.0.0.1 only'));
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request)) {
      throw new HttpError(403, _('a change must come from the page this server serves'));
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const path = url.pathname;
    const rawCharacterId =
      path.startsWith(CHARACTER_PREFIX) && path.length > CHARACTER_PREFIX.length
        ? path.slice(CHARACTER_PREFIX.length)
        : undefined;
    let characterId: string | undefined;
    if (rawCharacterId !== undefined) {
      try {
        characterId = decodeURIComponent(rawCharacterId);
      } catch {
        characterId = undefined;
      }
      if (characterId === undefined || !CHARACTER_ID.test(characterId)) {
        throw new HttpError(400, _('invalid character id'));
      }
    }

    if (method === 'GET' && path === '/api/state') return json(response, 200, state());

    if (method === 'GET' && path === '/api/latency') {
      const { lines, skipped } = readMetrics(options.metricsDir);
      const calls = callsFrom(lines);
      return json(response, 200, {
        skipped,
        characters: byCharacter(calls),
        calls: calls.slice(0, RECENT_CALLS).map((call) => ({
          start: new Date(call.start).toISOString(),
          seconds: call.seconds,
          lines: call.lines,
          character: call.character,
          provider: call.provider,
          llmModel: call.llmModel,
          summary: summarizeCall(call),
        })),
      });
    }

    // A string prefix, not a regex: xgettext on the CI runner loses track after `[^/]` in a regex
    // literal and drops the strings that follow from the catalogue.
    const catalogTarget = path.startsWith(CATALOG_PREFIX) ? path.slice(CATALOG_PREFIX.length) : undefined;
    if (method === 'GET' && catalogTarget !== undefined) {
      if (!(CATALOG_TARGETS as readonly string[]).includes(catalogTarget)) {
        throw new HttpError(404, _('unknown catalog'));
      }
      const language = url.searchParams.get('language') || undefined;
      if (language !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
        throw new HttpError(400, _('"language" must be a BCP-47 tag'));
      }
      const refresh = url.searchParams.get('refresh');
      return json(
        response,
        200,
        await catalog.get(catalogTarget as CatalogTarget, {
          refresh: refresh === '1' || refresh === 'true',
          ...(language && { language }),
        }),
      );
    }

    if (method === 'GET' && path === '/api/sample') {
      const provider = url.searchParams.get('provider') ?? '';
      if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) throw new HttpError(400, _('unknown provider'));
      const id = url.searchParams.get('voice') ?? '';
      const model = url.searchParams.get('model') || undefined;
      // The address comes from the catalog the vendor answered with, never from the request.
      const voice = (await catalog.get(provider as CatalogTarget)).voices.find(
        (entry) => entry.id === id && (!model || entry.model === model),
      );
      if (!voice?.sampleUrl) throw new HttpError(404, _('no sample for this voice'));
      const sample = await fetchSample(options.fetch ?? fetch, voice.sampleUrl);
      return send(response, 200, sample.type, sample.body);
    }

    if (method === 'GET' && path === '/api/profiles') {
      let profiles: ReturnType<typeof listProfiles> = [];
      let error: string | undefined;
      try {
        profiles = listProfiles(profilesDir(env));
      } catch (failure) {
        error = (failure as Error).message;
      }
      let active: string | null = null;
      try {
        active = read().profile ?? null;
      } catch {
        // an unreadable settings file is reported by /api/state
      }
      return json(response, 200, {
        profiles,
        active,
        default: options.startProfile ?? null,
        ...(error && { error }),
      });
    }

    if (method === 'GET' && path === '/api/knowledge') {
      const settings = current();
      const file = url.searchParams.get('file') || undefined;
      const start = options.loadStartProfile ?? (() => loadProfile());
      let profile: Profile;
      let source: 'selected' | 'active' | 'start';
      try {
        if (file) {
          const target = profileFilePath(file, env);
          if (!target) throw new Error(_('"file" must be the name of a .json file in the profiles directory'));
          profile = loadProfile(target);
          source = 'selected';
        } else {
          // The profile the next call gets, falling back exactly as the agent does.
          profile = profileForCall(start(), settings, env);
          source = settings.profile ? 'active' : 'start';
        }
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      const shown = file ?? (source === 'active' ? settings.profile : null) ?? null;
      return json(response, 200, {
        ...describeKnowledge(
          withAssistantName(profile, speaker(settings, profile).name),
          new Date(),
          transferOverride(env),
          speaker(settings, profile).persona,
        ),
        file: shown,
        source,
        ...editing(shown),
      });
    }

    if (method === 'POST' && path === '/api/knowledge/preview') {
      const wanted = body(await readBody(request));
      if (typeof wanted.file !== 'string') throw new HttpError(400, _('"file" must be a file name'));
      const { raw } = store.readRaw(wanted.file);
      const { profile } = applyDraft(raw, parseDraft(wanted.draft), wanted.file);
      const settings = current();
      const { name, persona } = speaker(settings, profile);
      return json(response, 200, {
        systemPrompt: buildInstructions(withAssistantName(profile, name), new Date(), persona),
      });
    }

    if (method === 'POST' && path === '/api/profiles') {
      const wanted = body(await readBody(request));
      if (typeof wanted.file !== 'string') throw new HttpError(400, _('"file" must be a file name'));
      if (wanted.from !== null && typeof wanted.from !== 'string') {
        throw new HttpError(400, _('"from" must be a file name or null'));
      }
      const source = wanted.from === null ? startRaw() : { raw: store.readRaw(wanted.from).raw, dir: profilesDir(env) };
      store.create(wanted.file, source.raw, source.dir);
      return json(response, 201, { file: wanted.file });
    }

    if (path.startsWith(PROFILE_PREFIX) && path.length > PROFILE_PREFIX.length) {
      let parts: string[];
      try {
        parts = path.slice(PROFILE_PREFIX.length).split('/').map(decodeURIComponent);
      } catch {
        throw new HttpError(400, _('"file" must be the name of a .json file in the profiles directory'));
      }
      const [file = '', action, ...extra] = parts;
      if (extra.length === 0 && action === undefined && method === 'PUT') {
        const wanted = body(await readBody(request));
        const picked = isRecord(wanted.draft) ? wanted.draft.character : undefined;
        if (typeof picked === 'string' && picked !== '' && !findCharacter(current(), DEFAULT_TENANT, picked)) {
          throw new HttpError(400, _('no character with id %s').replace('%s', picked));
        }
        return json(response, 200, store.save(file, wanted.revision, wanted.draft));
      }
      if (extra.length === 0 && action === 'history' && method === 'GET') {
        return json(response, 200, { versions: store.history(file) });
      }
      if (extra.length === 0 && action === 'restore' && method === 'POST') {
        const wanted = body(await readBody(request));
        return json(response, 200, store.restore(file, wanted.version, wanted.revision));
      }
    }

    if (method === 'PUT' && path === '/api/profile') {
      const wanted = body(await readBody(request));
      const file = wanted.file;
      if (file !== null && typeof file !== 'string') {
        throw new HttpError(400, _('"file" must be a file name or null'));
      }
      if (file !== null) {
        const target = profileFilePath(file, env);
        if (!target) throw new HttpError(400, _('"file" must be the name of a .json file in the profiles directory'));
        try {
          loadProfile(target);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
      }
      return json(
        response,
        200,
        update((settings) => {
          const { profile: _previous, ...rest } = settings;
          return file === null ? rest : { ...rest, profile: file };
        }),
      );
    }

    if (method === 'GET' && path === '/api/characters') return json(response, 200, charactersView());

    if (method === 'POST' && path === '/api/characters') {
      const wanted = body(await readBody(request));
      const settings = current();
      if (settings.characters.length >= MAX_CHARACTERS) {
        throw new HttpError(400, _('there are too many characters'));
      }
      const taken = (id: string) => Boolean(findCharacter(settings, DEFAULT_TENANT, id));
      let id: string;
      if (wanted.id !== undefined && wanted.id !== '') {
        if (typeof wanted.id !== 'string') throw new HttpError(400, _('invalid character id'));
        id = wanted.id;
        if (taken(id)) throw new HttpError(409, _('a character with this id already exists'));
      } else {
        const base = slug(typeof wanted.name === 'string' ? wanted.name : '');
        const free = (n: number) => (n === 1 ? base : `${base}-${n}`);
        let n = 1;
        while (taken(free(n)) || free(n) === RESERVED_CHARACTER_ID) n++;
        id = free(n);
      }
      const character = {
        ...characterFields(wanted),
        id,
        tenantId: DEFAULT_TENANT,
        color:
          typeof wanted.color === 'string' && wanted.color
            ? wanted.color
            : PALETTE[settings.characters.length % PALETTE.length],
      };
      const next = update((before) => ({
        ...before,
        characters: [...before.characters, character],
        // The first character is the one every venue speaks as until another is picked.
        ...(!before.defaultCharacter && { defaultCharacter: id }),
      }));
      return json(response, 201, {
        ...charactersView(),
        created: findCharacter(next, DEFAULT_TENANT, id),
      });
    }

    if (method === 'PUT' && path === '/api/characters/default') {
      const wanted = body(await readBody(request));
      requireRevision(current(), wanted.revision);
      const id = slot(wanted.id) ?? '';
      if (!findCharacter(current(), DEFAULT_TENANT, id)) {
        throw new HttpError(404, _('no character with id %s').replace('%s', id));
      }
      update((settings) => ({ ...settings, defaultCharacter: id }));
      return json(response, 200, charactersView());
    }

    if (method === 'PUT' && characterId) {
      const wanted = body(await readBody(request));
      requireRevision(current(), wanted.revision);
      const existing = findCharacter(current(), DEFAULT_TENANT, characterId);
      if (!existing) throw new HttpError(404, _('no character with id %s').replace('%s', characterId));
      if (wanted.id !== undefined && wanted.id !== characterId) {
        throw new HttpError(400, _('a character keeps its id'));
      }
      update((settings) => ({
        ...settings,
        characters: settings.characters.map((entry) =>
          entry.tenantId === existing.tenantId && entry.id === existing.id
            ? {
                ...characterFields({ color: entry.color, ...wanted }),
                id: entry.id,
                tenantId: entry.tenantId,
              }
            : entry,
        ),
      }));
      return json(response, 200, charactersView());
    }

    if (method === 'DELETE' && characterId) {
      const wanted = body(await readBody(request));
      const settings = current();
      requireRevision(settings, wanted.revision);
      if (!findCharacter(settings, DEFAULT_TENANT, characterId)) {
        throw new HttpError(404, _('no character with id %s').replace('%s', characterId));
      }
      if (settings.defaultCharacter === characterId) {
        throw new HttpError(409, _('the default character cannot be deleted: make another one the default first'));
      }
      if (venues().some((venue) => venue.character === characterId)) {
        throw new HttpError(409, _('a venue still uses this character: pick another one for it first'));
      }
      update((before) => ({
        ...before,
        characters: before.characters.filter(
          (entry) => !(entry.tenantId === DEFAULT_TENANT && entry.id === characterId),
        ),
      }));
      return json(response, 200, charactersView());
    }

    if (method === 'PUT' && path === '/api/llm') {
      const wanted = body(await readBody(request));
      return json(
        response,
        200,
        update((settings) => ({
          ...settings,
          llm: {
            ...(slot(wanted.model) && { model: slot(wanted.model) }),
            ...(slot(wanted.fallbackModel) && {
              fallbackModel: slot(wanted.fallbackModel),
            }),
            ...(maybeNumber(wanted.attemptTimeoutS) !== undefined && {
              attemptTimeoutS: maybeNumber(wanted.attemptTimeoutS),
            }),
          },
        })),
      );
    }

    if (method === 'POST' && path === '/api/preview') {
      const wanted = body(await readBody(request));
      const text = slot(wanted.text) ?? options.sampleText;
      if (text.length > MAX_PREVIEW_CHARS) {
        throw new HttpError(400, _('the text may have at most %s characters').replace('%s', String(MAX_PREVIEW_CHARS)));
      }
      const choice = isRecord(wanted.voice)
        ? choiceFromInline(wanted.voice)
        : choiceFor(current(), slot(wanted.character));
      const audio = await options.synthesize(choice, text);
      const { wav, sampleRate } = previewWav(audio, Boolean(wanted.phone));
      response.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': wav.byteLength,
        'cache-control': 'no-store',
        // The number the A/B comparison is about: how long a caller waits for the first sound.
        'x-ttfa-ms': String(Math.round(audio.ttfaMs)),
        'x-sample-rate': String(sampleRate),
      });
      response.end(wav);
      return;
    }

    // Anything else that is not the API is the settings app: its files, or index.html for a page path.
    if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/')) {
      const served = serveStatic(options.webDir === undefined ? findWebDir() : (options.webDir ?? undefined), path);
      if (served === 'not-built') {
        return send(
          response,
          503,
          'text/plain; charset=utf-8',
          _('the settings app is not built: run `npm run web:build`'),
        );
      }
      if (served !== 'not-found') {
        return send(response, served.status, served.type, served.body, served.headers);
      }
    }

    throw new HttpError(404, _('unknown route'));
  };

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error((error as Error).message);
      if (response.headersSent) return response.end();
      json(response, status, { error: (error as Error).message });
    });
  });
}
