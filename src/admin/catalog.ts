/**
 * What each vendor offers: models and voices, normalized to one shape so the admin UI can list and
 * filter them without knowing five APIs. Admin only — the agent never asks a catalog during a call;
 * a preset names a voice id, and that is all a call needs.
 *
 * Every fetcher is injectable (`fetch`, the vendor SDK clients), so the tests run without network
 * or keys. A vendor that cannot be asked — no key, no network, an error answer — is reported as
 * `available: false` with a short reason, never thrown out of the endpoint. Keys are never logged
 * and are scrubbed from every reason.
 */

import { KugelAudio } from 'kugelaudio';
import { Mistral } from '@mistralai/mistralai';
import { defaultTtsModel, kugelApiKey, pocketUrl } from '../agent/tts-provider.js';
import { TTS_PROVIDERS } from '../core/settings.js';
import { _ } from '../i18n.js';
import { mistralServer } from '../mistral.js';

export const CATALOG_TARGETS = [...TTS_PROVIDERS, 'llm'] as const;
export type CatalogTarget = (typeof CATALOG_TARGETS)[number];

/** Every field but `id` and `label` is optional and only set when the vendor said it. */
export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
  /** The model this id follows or resolves to (set on every id of a group but the canonical one). */
  aliasOf?: string;
  /** The other ids that name the same model; set on the canonical entry. */
  aliases?: string[];
  /** A moving alias: it follows the newest version of a model. */
  latest?: boolean;
  deprecated?: boolean;
  deprecatedAt?: string;
  replacement?: string;
  /** Tokens the model reads, as the vendor reports. */
  contextLength?: number;
  maxOutput?: number;
  /** Characters of text per request (Kugel). */
  maxInput?: number;
  capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean; audioIn?: boolean; audioOut?: boolean };
  /** USD per token, as OpenRouter lists it. */
  pricing?: { prompt?: number; completion?: number };
  /** ISO timestamp. */
  created?: string;
}

export interface CatalogVoice {
  /** What a preset's `voice` takes. */
  id: string;
  name: string;
  /** Set when the voice belongs to one model (OpenRouter). */
  model?: string;
  languages: string[];
  gender?: string;
  description?: string;
  sampleUrl?: string;
}

export interface Catalog {
  /** The vendor; `llm` answers with the chat models of Mistral, the one LLM vendor the agent uses. */
  provider: CatalogTarget;
  available: boolean;
  reason?: string;
  models: CatalogModel[];
  voices: CatalogVoice[];
  fetchedAt: string;
}

/** The part of the KugelAudio client a catalog uses. */
export interface KugelLike {
  voices: {
    list(options: { language?: string; includePublic?: boolean; limit?: number; offset?: number }): Promise<{
      voices: Array<{
        id: number;
        name: string;
        description?: string;
        sex?: string;
        supportedLanguages: string[];
        sampleUrl?: string;
      }>;
      total: number;
    }>;
  };
  models: { list(): Promise<Array<{ id: string; name: string; description?: string; maxInputLength?: number }>> };
}

interface MistralModelCard {
  id: string;
  name?: string | null;
  internal?: boolean;
  description?: string | null;
  maxContextLength?: number;
  aliases?: string[];
  deprecation?: Date | string | null;
  deprecationReplacementModel?: string | null;
  created?: number;
  capabilities?: {
    completionChat?: boolean;
    functionCalling?: boolean;
    reasoning?: boolean;
    vision?: boolean;
    audio?: boolean;
    audioSpeech?: boolean;
  };
}

/** The part of the Mistral client a catalog uses. */
export interface MistralLike {
  audio: {
    voices: {
      list(request: { limit: number; offset: number }): Promise<{
        items: Array<{
          id: string;
          name: string;
          languages?: string[];
          gender?: string | null;
          description?: string | null;
        }>;
        total: number;
      }>;
    };
  };
  models: { list(): Promise<{ data?: MistralModelCard[] | undefined }> };
}

export interface CatalogDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  kugel?: (apiKey: string) => KugelLike;
  mistral?: (apiKey: string, env: NodeJS.ProcessEnv) => MistralLike;
  now?: () => number;
}

export interface CatalogRequest {
  /** Bypass the cache. */
  refresh?: boolean;
  /** BCP-47 language or language-region tag, for the vendors that filter by it. */
  language?: string;
}

export interface CatalogService {
  get(target: CatalogTarget, request?: CatalogRequest): Promise<Catalog>;
}

const CACHE_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
/** A runaway pagination loop is a bug on the vendor's side; the catalog stops at this many pages. */
const MAX_PAGES = 20;
const MAX_REASON_CHARS = 160;

/** A vendor answered, but not with a success status. */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class MissingKeyError extends Error {}

type Fetched = { models: CatalogModel[]; voices: CatalogVoice[] };
type Context = {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  kugel: (apiKey: string) => KugelLike;
  mistral: (apiKey: string, env: NodeJS.ProcessEnv) => MistralLike;
  language?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

async function getJson(context: Context, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await context.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new HttpStatusError(response.status);
  return response.json();
}

function requireKey(context: Context, name: string): string {
  const key = context.env[name];
  if (!key) throw new MissingKeyError(_('no API key for this vendor in the environment'));
  return key;
}

function voice(entry: CatalogVoice): CatalogVoice {
  // Drop empty optionals so a response never carries `"gender": null`-style noise.
  const result: CatalogVoice = { id: entry.id, name: entry.name, languages: entry.languages };
  for (const key of ['model', 'gender', 'description', 'sampleUrl'] as const) {
    if (entry[key]) result[key] = entry[key];
  }
  return result;
}

async function fetchKugel(context: Context): Promise<Fetched> {
  requireKey(context, 'KUGELAUDIO_API_KEY');
  // The same key and region rule a call uses.
  const client = context.kugel(kugelApiKey(context.env));
  const models = (await client.models.list()).map((model): CatalogModel => {
    const entry: CatalogModel = { id: model.id, label: model.name || model.id };
    if (model.description) entry.description = model.description;
    if (model.maxInputLength) entry.maxInput = model.maxInputLength;
    return entry;
  });
  const voices: CatalogVoice[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.voices.list({
      ...(context.language && { language: context.language.split('-')[0] }),
      includePublic: true,
      limit: PAGE_SIZE,
      offset: voices.length,
    });
    for (const entry of result.voices) {
      voices.push(
        voice({
          id: String(entry.id),
          name: entry.name,
          languages: entry.supportedLanguages ?? [],
          gender: entry.sex,
          description: entry.description,
          sampleUrl: entry.sampleUrl,
        }),
      );
    }
    if (result.voices.length === 0 || voices.length >= result.total) break;
  }
  return { models, voices };
}

async function mistralCards(context: Context): Promise<{ client: MistralLike; cards: MistralModelCard[] }> {
  const client = context.mistral(requireKey(context, 'MISTRAL_API_KEY'), context.env);
  const cards = ((await client.models.list()).data ?? []).filter((card) => !card.internal);
  return { client, cards };
}

/** Words whose plain capitalisation would be wrong. */
const WORD_OVERRIDES: Record<string, string> = {
  glm: 'GLM',
  zai: 'Z.ai',
  tts: 'TTS',
  cli: 'CLI',
  fim: 'FIM',
  ocr: 'OCR',
  vibe: 'Vibe',
};

/** `2603` → `2026-03`; undefined when the digits are no year-month. */
function yearMonth(token: string): string | undefined {
  const match = /^(2[3-9])(0[1-9]|1[0-2])$/.exec(token);
  return match ? `20${match[1]}-${match[2]}` : undefined;
}

/**
 * A readable name from a model id: `mistral-small-2603` → `Mistral Small (2026-03)`,
 * `glm-5-2` → `GLM 5.2`, `ministral-14b-latest` → `Ministral 14B`. `-latest` is dropped; the
 * moving alias is marked by `latest`, not by its name.
 */
export function labelFromId(id: string): string {
  const tokens = id.split('-').filter((token) => token !== 'latest');
  const words: string[] = [];
  let release = '';
  for (const token of tokens) {
    const date = yearMonth(token);
    if (date) release = ` (${date})`;
    else if (/^\d+$/.test(token) && /^\d+(\.\d+)*$/.test(words.at(-1) ?? '')) words[words.length - 1] += `.${token}`;
    else if (/^\d+b$/.test(token)) words.push(token.toUpperCase());
    else words.push(WORD_OVERRIDES[token] ?? token.charAt(0).toUpperCase() + token.slice(1));
  }
  return (words.join(' ') || id) + release;
}

function isoOf(value: Date | string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * One entry per id, grouped by the aliases Mistral lists. A card's `name` is the model it resolves
 * to, so an alias carries its target's name: the id, not the name, is what tells entries apart.
 * The canonical id of a group is the one whose `name` is its own id, else the newest dated one.
 */
function mistralModels(cards: MistralModelCard[]): CatalogModel[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const groupOf = new Map<string, Set<string>>();
  for (const card of cards) {
    const group = new Set([card.id, ...(card.aliases ?? []).filter((alias) => byId.has(alias))]);
    for (const id of [...group]) for (const other of groupOf.get(id) ?? []) group.add(other);
    for (const id of group) groupOf.set(id, group);
  }
  const canonicalOf = new Map<Set<string>, string>();
  for (const group of new Set(groupOf.values())) {
    const ids = [...group];
    canonicalOf.set(
      group,
      ids.find((id) => byId.get(id)?.name === id) ??
        ids.find((id) => /-\d{4}$/.test(id)) ??
        ids.find((id) => !id.endsWith('-latest')) ??
        ids[0]!,
    );
  }
  return cards.map((card) => {
    const group = groupOf.get(card.id)!;
    const canonical = canonicalOf.get(group)!;
    const model: CatalogModel = { id: card.id, label: labelFromId(card.id) };
    if (card.description) model.description = card.description;
    if (card.id === canonical) {
      const aliases = [...group].filter((id) => id !== card.id);
      if (aliases.length > 0) model.aliases = aliases;
    } else {
      model.aliasOf = canonical;
    }
    if (card.id.endsWith('-latest')) model.latest = true;
    const deprecatedAt = isoOf(card.deprecation);
    if (deprecatedAt) {
      model.deprecated = true;
      model.deprecatedAt = deprecatedAt;
    }
    if (card.deprecationReplacementModel) model.replacement = card.deprecationReplacementModel;
    if (card.maxContextLength) model.contextLength = card.maxContextLength;
    const created = isoOf(card.created);
    if (created) model.created = created;
    const caps = card.capabilities;
    if (caps) {
      model.capabilities = {
        tools: !!caps.functionCalling,
        vision: !!caps.vision,
        reasoning: !!caps.reasoning,
        audioIn: !!caps.audio,
        audioOut: !!caps.audioSpeech,
      };
    }
    return model;
  });
}

async function fetchMistral(context: Context): Promise<Fetched> {
  const { client, cards } = await mistralCards(context);
  const models = mistralModels(cards.filter((card) => card.capabilities?.audioSpeech));
  const voices: CatalogVoice[] = [];
  // Presets and the account's own cloned voices, both addressed by id.
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.audio.voices.list({ limit: PAGE_SIZE, offset: voices.length });
    for (const entry of result.items) {
      voices.push(
        voice({
          id: entry.id,
          name: entry.name,
          languages: entry.languages ?? [],
          gender: entry.gender ?? undefined,
          description: entry.description ?? undefined,
        }),
      );
    }
    if (result.items.length === 0 || voices.length >= result.total) break;
  }
  return { models, voices };
}

async function fetchLlm(context: Context): Promise<Fetched> {
  const { cards } = await mistralCards(context);
  // The agent's one tool (the transfer) needs function calling.
  const models = cards.filter((card) => card.capabilities?.completionChat && card.capabilities.functionCalling);
  return { models: mistralModels(models), voices: [] };
}

function num(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function openRouterModel(entry: Record<string, unknown>, id: string): CatalogModel {
  const model: CatalogModel = { id, label: str(entry.name) ?? id };
  const description = str(entry.description);
  if (description) model.description = description;
  // Speech models list 0 where a text model has a window.
  const context = num(entry.context_length);
  if (context) model.contextLength = context;
  const top = isRecord(entry.top_provider) ? entry.top_provider : {};
  const maxOutput = num(top.max_completion_tokens);
  if (maxOutput) model.maxOutput = maxOutput;
  if (isRecord(entry.pricing)) {
    const prompt = num(entry.pricing.prompt);
    const completion = num(entry.pricing.completion);
    if (prompt !== undefined || completion !== undefined) {
      model.pricing = { ...(prompt !== undefined && { prompt }), ...(completion !== undefined && { completion }) };
    }
  }
  const created = isoOf(num(entry.created));
  if (created) model.created = created;
  return model;
}

async function fetchOpenRouter(context: Context): Promise<Fetched> {
  const body = await getJson(context, 'https://openrouter.ai/api/v1/models?output_modalities=speech');
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const models: CatalogModel[] = [];
  const voices: CatalogVoice[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    if (!id) continue;
    models.push(openRouterModel(entry, id));
    // Voices belong to a model here: the same name on two models is two entries.
    for (const name of strings(entry.supported_voices))
      voices.push(voice({ id: name, name, model: id, languages: [] }));
  }
  return { models, voices };
}

// Neither vendor lists its models over the API, so the one the provider defaults to is all that is
// known; the name and sentence come from the vendors' own pages.
const STATIC_MODELS: Record<string, Pick<CatalogModel, 'label' | 'description'>> = {
  // https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
  'sonic-3.6': {
    label: 'Sonic 3.6',
    description: "Cartesia's fastest, most natural text-to-speech model, with native support for 44 languages.",
  },
  // https://github.com/kyutai-labs/pocket-tts
  'pocket-tts': {
    label: 'Kyutai Pocket TTS',
    description: 'A lightweight text-to-speech model that runs efficiently on CPUs.',
  },
};

function staticModels(provider: 'cartesia' | 'pocket'): CatalogModel[] {
  const id = defaultTtsModel(provider);
  return id ? [{ id, label: id, ...STATIC_MODELS[id] }] : [];
}

// What the vendor documents for GET /voices; cursor pagination.
const CARTESIA_VERSION = '2025-04-16';

async function fetchCartesia(context: Context): Promise<Fetched> {
  const key = requireKey(context, 'CARTESIA_API_KEY');
  const voices: CatalogVoice[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (context.language) query.set('language', context.language.split('-')[0]!);
    if (after) query.set('starting_after', after);
    const body = await getJson(context, `https://api.cartesia.ai/voices?${query}`, {
      'X-API-Key': key,
      'Cartesia-Version': CARTESIA_VERSION,
    });
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const id = str(entry.id);
      if (!id) continue;
      const locales = Array.isArray(entry.accents)
        ? entry.accents.map((accent) => (isRecord(accent) ? str(accent.locale) : undefined)).filter((l) => l)
        : [];
      voices.push(
        voice({
          id,
          name: str(entry.name) ?? id,
          languages: locales.length > 0 ? (locales as string[]) : ([str(entry.language)].filter((l) => l) as string[]),
          gender: str(entry.gender),
          description: str(entry.description) ?? str(entry.tagline),
        }),
      );
    }
    after = isRecord(body) && body.has_more === true ? str(body.next_page) : undefined;
    if (!after) break;
  }
  return { models: staticModels('cartesia'), voices };
}

// What the image shipped with before `GET /voices` existed.
const POCKET_FALLBACK_VOICES = ['alba', 'juergen'];

async function fetchPocket(context: Context): Promise<Fetched> {
  let names = POCKET_FALLBACK_VOICES;
  let language: string | undefined;
  try {
    const body = await getJson(context, `${pocketUrl(context.env)}/voices`);
    if (isRecord(body)) {
      const listed = strings(body.voices);
      if (listed.length > 0) names = listed;
      language = str(body.language);
    }
  } catch (error) {
    // A server from before the endpoint answers 404; anything else means it is not there.
    if (!(error instanceof HttpStatusError && error.status === 404)) throw error;
  }
  return {
    models: staticModels('pocket'),
    voices: names.map((name) => voice({ id: name, name, languages: language ? [language] : [] })),
  };
}

const FETCHERS: Record<CatalogTarget, (context: Context) => Promise<Fetched>> = {
  mistral: fetchMistral,
  cartesia: fetchCartesia,
  openrouter: fetchOpenRouter,
  pocket: fetchPocket,
  kugel: fetchKugel,
  llm: fetchLlm,
};

/** Env values that must never appear in a reason, whatever a vendor echoes back. */
function secretsOf(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => /KEY|SECRET|TOKEN|PASSWORD/.test(name) && value && value.length >= 8)
    .map(([, value]) => value!);
}

function reasonOf(error: unknown, env: NodeJS.ProcessEnv): string {
  if (error instanceof MissingKeyError) return error.message;
  if (error instanceof HttpStatusError) return _('the vendor answered with %s').replace('%s', `HTTP ${error.status}`);
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secretsOf(env)) message = message.split(secret).join('***');
  // Prefixed keys (Kugel's region) reach the SDK in another shape; the bare key was scrubbed above.
  message = message.replace(/\s+/g, ' ').slice(0, MAX_REASON_CHARS);
  return _('the request failed: %s').replace('%s', message);
}

export function createCatalog(deps: CatalogDeps = {}): CatalogService {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const context = (language?: string): Context => ({
    env,
    fetch: deps.fetch ?? fetch,
    kugel: deps.kugel ?? ((apiKey) => new KugelAudio({ apiKey })),
    mistral:
      deps.mistral ??
      ((apiKey, environment) => new Mistral({ apiKey, ...mistralServer(environment) }) as unknown as MistralLike),
    ...(language && { language }),
  });
  const cache = new Map<string, { at: number; catalog: Catalog }>();

  return {
    async get(target, request = {}) {
      const key = `${target}|${request.language ?? ''}`;
      const cached = cache.get(key);
      if (!request.refresh && cached && now() - cached.at < CACHE_MS) return cached.catalog;

      const fetchedAt = new Date(now()).toISOString();
      try {
        const { models, voices } = await FETCHERS[target](context(request.language));
        const catalog: Catalog = { provider: target, available: true, models, voices, fetchedAt };
        cache.set(key, { at: now(), catalog });
        return catalog;
      } catch (error) {
        // Not cached: a key added a minute later, or a vendor back up, should show on the next look.
        return {
          provider: target,
          available: false,
          reason: reasonOf(error, env),
          models: [],
          voices: [],
          fetchedAt,
        };
      }
    },
  };
}
