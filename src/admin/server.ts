/**
 * The settings UI as a small HTTP server: presets, which of them is active, the LLM models, a
 * preview that plays a voice, and what the metrics say about the voices used so far.
 *
 * It binds to the loopback interface and has no login: whoever can reach it may change the voice
 * of every call. Two things follow, and both are checked here rather than assumed:
 * a `Host` that is not loopback means someone pointed a name at 127.0.0.1 (DNS rebinding), and a
 * state-changing request from another origin means a page the operator did not open.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type ActiveSlot,
  emptySettings,
  parseSettings,
  readSettings,
  type Settings,
  TTS_PROVIDERS,
  writeSettings,
  PRESET_ID,
} from '../core/settings.js';
import { choiceFromPreset, type TtsChoice, ttsChoice, ttsFallbackChoice } from '../agent/tts-provider.js';
import { _ } from '../i18n.js';
import { byPreset, callsFrom, METRIC_NAMES, readMetrics, summarizeCall } from './latency.js';
import { appJs, pageHtml, uiStrings } from './page.js';
import { previewWav, type Synthesizer } from './preview.js';

export const DEFAULT_PORT = 8091;
export const HOST = '127.0.0.1';

/** A body larger than this is not a settings change; the UI sends a few hundred bytes. */
const MAX_BODY_BYTES = 256 * 1024;
/** Calls shown in the latency table. More would be a log, not an overview. */
const RECENT_CALLS = 25;

export interface AdminOptions {
  settingsPath: string;
  metricsDir: string;
  synthesize: Synthesizer;
  /** Preview text the page starts with; the profile's greeting is what a caller really hears. */
  sampleText: string;
  env?: NodeJS.ProcessEnv;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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

function send(response: ServerResponse, status: number, type: string, payload: string | Uint8Array): void {
  response.writeHead(status, {
    'content-type': type,
    'content-length': typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength,
    // Nothing here is for another page to read, and the answers change with every call.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function slot(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A number from a form field: empty means "not set", anything else is left for the validation. */
function maybeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'number' ? value : Number(value);
}

export function createAdminServer(options: AdminOptions): Server {
  const env = options.env ?? process.env;

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
  const envVoice = (): { primary?: TtsChoice; fallback?: TtsChoice; error?: string } => {
    try {
      return { primary: ttsChoice(env), ...(ttsFallbackChoice(env) && { fallback: ttsFallbackChoice(env) }) };
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
      },
      strings: uiStrings(),
    };
  };

  const choiceFor = (settings: Settings, preset: string | undefined): TtsChoice => {
    if (!preset) {
      const voice = envVoice();
      if (!voice.primary) throw new HttpError(400, voice.error ?? _('no voice is configured'));
      return voice.primary;
    }
    const found = settings.presets.find((entry) => entry.id === preset);
    if (!found) throw new HttpError(404, _('no preset with id %s').replace('%s', preset));
    try {
      return choiceFromPreset(found);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
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
    const rawPresetId = /^\/api\/presets\/(.+)$/.exec(path)?.[1];
    let presetId: string | undefined;
    if (rawPresetId !== undefined) {
      try {
        presetId = decodeURIComponent(rawPresetId);
      } catch {
        presetId = undefined;
      }
      if (presetId === undefined || !PRESET_ID.test(presetId)) throw new HttpError(400, _('invalid preset id'));
    }

    if (method === 'GET' && path === '/') return send(response, 200, 'text/html; charset=utf-8', pageHtml());
    if (method === 'GET' && path === '/app.js') {
      return send(response, 200, 'text/javascript; charset=utf-8', appJs());
    }
    if (method === 'GET' && path === '/api/state') return json(response, 200, state());

    if (method === 'GET' && path === '/api/latency') {
      const { lines, skipped } = readMetrics(options.metricsDir);
      const calls = callsFrom(lines);
      return json(response, 200, {
        skipped,
        presets: byPreset(calls),
        calls: calls.slice(0, RECENT_CALLS).map((call) => ({
          start: new Date(call.start).toISOString(),
          seconds: call.seconds,
          lines: call.lines,
          preset: call.preset,
          provider: call.provider,
          llmModel: call.llmModel,
          summary: summarizeCall(call),
        })),
      });
    }

    if (method === 'POST' && path === '/api/presets') {
      const preset = body(await readBody(request));
      return json(
        response,
        201,
        update((settings) => ({ ...settings, presets: [...settings.presets, preset] })),
      );
    }

    if (method === 'PUT' && presetId) {
      const preset = body(await readBody(request));
      return json(
        response,
        200,
        update((settings) => {
          if (!settings.presets.some((entry) => entry.id === presetId)) {
            throw new HttpError(404, _('no preset with id %s').replace('%s', presetId));
          }
          const renamed = slot(preset.id);
          const active = { ...settings.active };
          // A renamed preset keeps its place: `active` points at ids, and dropping the voice
          // mid-edit would silently move the next call to another one.
          for (const key of ['primary', 'fallback'] as ActiveSlot[]) {
            if (active[key] === presetId && renamed) active[key] = renamed;
          }
          return {
            ...settings,
            active,
            presets: settings.presets.map((entry) => (entry.id === presetId ? preset : entry)),
          };
        }),
      );
    }

    if (method === 'DELETE' && presetId) {
      return json(
        response,
        200,
        update((settings) => {
          const presets = settings.presets.filter((entry) => entry.id !== presetId);
          const active: Settings['active'] = {};
          for (const key of ['primary', 'fallback'] as ActiveSlot[]) {
            const id = settings.active[key];
            if (id && id !== presetId && presets.some((entry) => entry.id === id)) active[key] = id;
          }
          // A fallback without a primary is not a configuration the agent can read (see
          // `parseSettings`): deleting the primary drops the pair.
          if (!active.primary) delete active.fallback;
          return { ...settings, presets, active };
        }),
      );
    }

    if (method === 'PUT' && path === '/api/active') {
      const wanted = body(await readBody(request));
      return json(
        response,
        200,
        update((settings) => ({
          ...settings,
          active: {
            ...(slot(wanted.primary) && { primary: slot(wanted.primary) }),
            ...(slot(wanted.fallback) && { fallback: slot(wanted.fallback) }),
          },
        })),
      );
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
            ...(slot(wanted.fallbackModel) && { fallbackModel: slot(wanted.fallbackModel) }),
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
      const choice = choiceFor(current(), slot(wanted.preset));
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
