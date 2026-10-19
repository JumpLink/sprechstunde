import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { parseProfile } from '../core/profile.js';
import { readSettings, type Settings } from '../core/settings.js';
import type { TtsChoice } from '../agent/tts-provider.js';
import type { CatalogService } from './catalog.js';
import { createAdminServer } from './server.js';
import type { Synthesized } from './preview.js';

const KEY = 'sk-test-must-never-be-served';

const ENV: NodeJS.ProcessEnv = {
  MISTRAL_API_KEY: KEY,
  CARTESIA_API_KEY: KEY,
  OPENROUTER_API_KEY: KEY,
  SPRECHSTUNDE_TTS_PROVIDER: 'mistral',
  SPRECHSTUNDE_TTS_VOICE: 'gb_jane_neutral',
};

interface Harness {
  url: string;
  settingsPath: string;
  profilesDir: string;
  metricsDir: string;
  /** Every choice the server asked the fake vendor to synthesize. */
  asked: Array<{ choice: TtsChoice; text: string }>;
}

const servers: Array<{ close: () => void }> = [];

after(() => {
  for (const server of servers) server.close();
});

async function start(
  options: {
    env?: NodeJS.ProcessEnv;
    settings?: unknown;
    metrics?: string;
    profiles?: Record<string, string>;
    catalog?: CatalogService;
    /** Files of the built settings app by path; none means the app is not built. */
    web?: Record<string, string>;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'sprechstunde-admin-'));
  const settingsPath = join(dir, 'voice.json');
  const metricsDir = join(dir, 'metrics');
  const profilesDir = join(dir, 'profiles');
  mkdirSync(profilesDir);
  for (const [name, content] of Object.entries(options.profiles ?? {})) writeFileSync(join(profilesDir, name), content);
  if (options.settings !== undefined) {
    writeFileSync(
      settingsPath,
      typeof options.settings === 'string' ? options.settings : JSON.stringify(options.settings),
    );
  }
  if (options.metrics !== undefined) {
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(join(metricsDir, '2026-10-19.jsonl'), options.metrics);
  }

  let webDir: string | null = null;
  if (options.web) {
    webDir = join(dir, 'web');
    for (const [name, content] of Object.entries(options.web)) {
      mkdirSync(dirname(join(webDir, name)), { recursive: true });
      writeFileSync(join(webDir, name), content);
    }
  }
  // Outside the web directory: what a traversal would have to reach.
  writeFileSync(join(dir, 'secret.txt'), KEY);

  const asked: Harness['asked'] = [];
  const server = createAdminServer({
    settingsPath,
    metricsDir,
    sampleText: 'Guten Tag.',
    webDir,
    ...(options.catalog && { catalog: options.catalog }),
    startProfile: { id: 'start', name: 'Test', locale: 'de-DE' },
    loadStartProfile: () => parseProfile(JSON.parse(venue('start'))),
    env: { ...(options.env ?? ENV), SPRECHSTUNDE_PROFILES_DIR: profilesDir },
    // 240 samples of silence at 24 kHz; no vendor is involved.
    synthesize: async (choice, text): Promise<Synthesized> => {
      asked.push({ choice, text });
      return { pcm: new Uint8Array(480), sampleRate: 24000, ttfaMs: 123.4 };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, settingsPath, profilesDir, metricsDir, asked };
}

/** A request as the page makes it: same origin, JSON body. */
function call(harness: Harness, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const origin = harness.url;
  return fetch(`${harness.url}${path}`, {
    method,
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A GET with a Host header of our choosing — the one header `fetch` refuses to hand over. */
function statusWithHost(harness: Harness, host: string): Promise<number> {
  const { port } = new URL(harness.url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/api/state', headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
}

const PRESET = { id: 'jane', label: 'Jane', provider: 'mistral', voice: 'gb_jane_neutral' };

async function settingsOf(harness: Harness, response: Response): Promise<Settings> {
  const payload = (await response.json()) as Settings;
  // What the route answers and what the next call will read must be the same thing.
  assert.deepEqual(readSettings(harness.settingsPath), payload);
  return payload;
}

const WEB = {
  'index.html': '<!doctype html><title>app</title><script type="module" src="/assets/app.js"></script>',
  'assets/app.js': 'console.log("app");',
  'assets/app.css': 'body{}',
  'locale/de.json': '{"Save":"Speichern"}',
};

/** A GET with the path exactly as written: `fetch` would resolve the dot segments first. */
function rawGet(harness: Harness, path: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(harness.url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('the settings app is served with its own types and a strict policy', async () => {
  const harness = await start({ web: WEB });
  const page = await fetch(harness.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const policy = page.headers.get('content-security-policy') ?? '';
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(await page.text(), /assets\/app\.js/);

  const script = await fetch(`${harness.url}/assets/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /text\/javascript/);
  assert.match(script.headers.get('cache-control') ?? '', /immutable/);
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');

  const css = await fetch(`${harness.url}/assets/app.css`);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);

  const locale = await fetch(`${harness.url}/locale/de.json`);
  assert.match(locale.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await locale.json(), { Save: 'Speichern' });
});

test('a page path falls back to index.html, a missing file does not', async () => {
  const harness = await start({ web: WEB });
  for (const path of ['/voices', '/knowledge', '/calls/', '/some/deep/page']) {
    const response = await fetch(`${harness.url}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<title>app<\/title>/, path);
  }
  const asset = await fetch(`${harness.url}/assets/gone.js`);
  assert.equal(asset.status, 404);
  assert.match(asset.headers.get('content-type') ?? '', /application\/json/);
  // The API never falls back to the app.
  const api = await fetch(`${harness.url}/api/nothing`);
  assert.equal(api.status, 404);
  assert.equal(typeof ((await api.json()) as { error: unknown }).error, 'string');
  // Only reads are served.
  const post = await call(harness, 'POST', '/voices', {});
  assert.equal(post.status, 404);
});

test('a path cannot leave the web directory', async () => {
  const harness = await start({ web: WEB });
  for (const path of [
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/assets%5c..%5c..%5csecret.txt',
    '/%00.js',
  ]) {
    const reply = await rawGet(harness, path);
    assert.ok(!reply.body.includes(KEY), path);
    assert.notEqual(reply.status, 500, path);
  }
  const reply = await rawGet(harness, '/../secret.txt');
  assert.equal(reply.status, 404);
});

test('without a build the app answers 503, the API still works', async () => {
  const harness = await start();
  const page = await fetch(harness.url);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /web:build/);
  assert.equal((await fetch(`${harness.url}/api/state`)).status, 200);
});

test('the state no longer carries UI strings', async () => {
  const harness = await start();
  const state = (await (await fetch(`${harness.url}/api/state`)).json()) as Record<string, unknown>;
  assert.equal('strings' in state, false);
});

test('a state-changing request must come from this page', async () => {
  const harness = await start();
  const noOrigin = await fetch(`${harness.url}/api/presets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PRESET),
  });
  assert.equal(noOrigin.status, 403);

  const foreign = await call(harness, 'POST', '/api/presets', PRESET, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);

  // Neither attempt may have created the file.
  assert.equal(readSettings(harness.settingsPath), undefined);
});

test('a Host that is not loopback is refused (DNS rebinding)', async () => {
  const harness = await start();
  // `fetch` sets the Host header itself, so this one goes out over a plain request.
  assert.equal(await statusWithHost(harness, 'admin.evil.example'), 403);
  assert.equal(await statusWithHost(harness, 'localhost'), 200);
});

test('presets: create, change, rename and delete', async () => {
  const harness = await start();
  const created = await call(harness, 'POST', '/api/presets', PRESET);
  assert.equal(created.status, 201);
  assert.deepEqual((await settingsOf(harness, created)).presets, [PRESET]);

  const changed = await call(harness, 'PUT', '/api/presets/jane', { ...PRESET, label: 'Jane (warm)' });
  assert.equal(changed.status, 200);
  assert.equal((await settingsOf(harness, changed)).presets[0]!.label, 'Jane (warm)');

  await call(harness, 'PUT', '/api/active', { primary: 'jane' });
  const renamed = await call(harness, 'PUT', '/api/presets/jane', { ...PRESET, id: 'jane-2' });
  const afterRename = await settingsOf(harness, renamed);
  // The active voice follows the rename instead of silently falling back to another preset.
  assert.equal(afterRename.active.primary, 'jane-2');

  const deleted = await call(harness, 'DELETE', '/api/presets/jane-2');
  assert.equal(deleted.status, 200);
  const empty = await settingsOf(harness, deleted);
  assert.deepEqual(empty.presets, []);
  assert.deepEqual(empty.active, {});
});

test('presets: an invalid one is refused and the file stays as it was', async () => {
  const harness = await start({ settings: { presets: [PRESET], active: { primary: 'jane' } } });
  const before = readFileSync(harness.settingsPath, 'utf8');

  const duplicate = await call(harness, 'POST', '/api/presets', PRESET);
  assert.equal(duplicate.status, 400);
  assert.match(((await duplicate.json()) as { error: string }).error, /duplicate preset id/);

  const noVoice = await call(harness, 'POST', '/api/presets', { id: 'c', label: 'C', provider: 'cartesia' });
  assert.equal(noVoice.status, 400);
  assert.match(((await noVoice.json()) as { error: string }).error, /"voice" is required/);

  const missing = await call(harness, 'PUT', '/api/presets/nope', PRESET);
  assert.equal(missing.status, 404);
  assert.equal(readFileSync(harness.settingsPath, 'utf8'), before);
});

test('deleting the active primary drops the fallback with it', async () => {
  const harness = await start({
    settings: {
      presets: [PRESET, { id: 'paul', label: 'Paul', provider: 'pocket' }],
      active: { primary: 'jane', fallback: 'paul' },
    },
  });
  const response = await call(harness, 'DELETE', '/api/presets/jane');
  assert.deepEqual((await settingsOf(harness, response)).active, {});
});

test('active and llm are written, the pair is validated', async () => {
  const harness = await start({ settings: { presets: [PRESET, { id: 'paul', label: 'Paul', provider: 'pocket' }] } });

  const active = await call(harness, 'PUT', '/api/active', { primary: 'jane', fallback: 'paul' });
  assert.deepEqual((await settingsOf(harness, active)).active, { primary: 'jane', fallback: 'paul' });

  const same = await call(harness, 'PUT', '/api/active', { primary: 'jane', fallback: 'jane' });
  assert.equal(same.status, 400);

  const orphan = await call(harness, 'PUT', '/api/active', { fallback: 'paul' });
  assert.equal(orphan.status, 400);

  // The form sends strings; the seconds must arrive as a number.
  const llm = await call(harness, 'PUT', '/api/llm', {
    model: 'mistral-small-latest',
    fallbackModel: 'mistral-medium-latest',
    attemptTimeoutS: '2.5',
  });
  assert.deepEqual((await settingsOf(harness, llm)).llm, {
    model: 'mistral-small-latest',
    fallbackModel: 'mistral-medium-latest',
    attemptTimeoutS: 2.5,
  });

  const bad = await call(harness, 'PUT', '/api/llm', { attemptTimeoutS: 'soon' });
  assert.equal(bad.status, 400);
});

test('preview: a WAV, the time to first audio in a header, the preset in the choice', async () => {
  const harness = await start({ settings: { presets: [PRESET] } });
  const response = await call(harness, 'POST', '/api/preview', { preset: 'jane', text: 'Guten Abend.' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('x-ttfa-ms'), '123');
  assert.equal(response.headers.get('x-sample-rate'), '24000');

  const wav = new Uint8Array(await response.arrayBuffer());
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(wav.byteLength, 44 + 480);
  assert.deepEqual(harness.asked.at(-1)!.choice, {
    provider: 'mistral',
    model: 'voxtral-mini-tts-latest',
    voice: 'gb_jane_neutral',
    refAudio: undefined,
    name: undefined,
    preset: 'jane',
  });
  assert.equal(harness.asked.at(-1)!.text, 'Guten Abend.');
});

test('preview: "phone" is 8 kHz, and no preset means the environment voice', async () => {
  const harness = await start();
  const response = await call(harness, 'POST', '/api/preview', { phone: true });
  assert.equal(response.headers.get('x-sample-rate'), '8000');
  assert.equal((await response.arrayBuffer()).byteLength, 44 + 160);
  assert.equal(harness.asked.at(-1)!.choice.preset, undefined);
  assert.equal(harness.asked.at(-1)!.choice.voice, 'gb_jane_neutral');
  // No text means the sample text the page starts with.
  assert.equal(harness.asked.at(-1)!.text, 'Guten Tag.');
});

test('preview: an unknown preset is a 404, not a silent environment voice', async () => {
  const harness = await start();
  const response = await call(harness, 'POST', '/api/preview', { preset: 'nope' });
  assert.equal(response.status, 404);
  assert.equal(harness.asked.length, 0);
});

test('the latency route groups the metrics by preset', async () => {
  const ts = Date.parse('2026-10-19T10:00:00Z');
  const harness = await start({
    metrics: [
      JSON.stringify({ type: 'call_config', ts, ttsPreset: 'jane', ttsProvider: 'mistral' }),
      JSON.stringify({ type: 'tts_metrics', ts: ts + 500, ttfbMs: 600 }),
      JSON.stringify({ type: 'llm_metrics', ts: ts + 600, ttftMs: 400 }),
    ].join('\n'),
  });
  const payload = (await (await fetch(`${harness.url}/api/latency`)).json()) as {
    presets: Array<{ preset: string; calls: number; summary: Record<string, { p50: number }> }>;
    calls: Array<{ preset: string; lines: number }>;
  };
  assert.equal(payload.presets.length, 1);
  assert.equal(payload.presets[0]!.preset, 'jane');
  assert.equal(payload.presets[0]!.summary['tts.ttfbMs']!.p50, 600);
  assert.equal(payload.calls[0]!.lines, 2);
});

test('a broken settings file is reported, not hidden', async () => {
  const harness = await start({ settings: '{ "presets": [ {} ] }' });
  const state = (await (await fetch(`${harness.url}/api/state`)).json()) as { settingsError?: string };
  assert.match(state.settingsError ?? '', /"id" must be a non-empty string/);

  const change = await call(harness, 'PUT', '/api/active', { primary: 'jane' });
  assert.equal(change.status, 400);
});

test('no response ever carries an API key', async () => {
  const harness = await start({ settings: { presets: [PRESET], active: { primary: 'jane' } } });
  const bodies = await Promise.all(
    ['/', '/app.js', '/api/state', '/api/latency'].map(async (path) => (await fetch(`${harness.url}${path}`)).text()),
  );
  for (const text of bodies) assert.ok(!text.includes(KEY), `a response leaked the API key: ${text.slice(0, 200)}`);

  const state = (await (await fetch(`${harness.url}/api/state`)).json()) as { keys: Record<string, boolean> };
  // Whether a vendor can be previewed is useful; the key itself never is.
  // `kugel` has no key in this environment: the UI marks such a vendor instead of hiding it.
  assert.deepEqual(state.keys, { mistral: true, cartesia: true, openrouter: true, kugel: false });
});

test('unknown routes are a 404', async () => {
  const harness = await start();
  assert.equal((await fetch(`${harness.url}/api/nope`)).status, 404);
});

test('a preset id in the URL is decoded and must match the id pattern', async () => {
  const harness = await start({ settings: { presets: [PRESET] } });
  for (const bad of ['..%2Fx', '%E0%A4%A', 'a%20b', '.hidden']) {
    const response = await call(harness, 'DELETE', `/api/presets/${bad}`);
    assert.equal(response.status, 400, bad);
  }
  const ok = await call(harness, 'DELETE', '/api/presets/%6Aane');
  assert.equal(ok.status, 200);
});

const venue = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    locale: 'de-DE',
    timeZone: 'Europe/Berlin',
    assistantName: 'Test',
    greeting: 'Hallo, ich bin eine KI.',
    instructions: 'Be brief.',
    facts: [],
    ...extra,
  });

test('GET /api/profiles lists every json file, broken ones with an error', async () => {
  const harness = await start({
    profiles: { 'b.json': venue('beta'), 'a.json': '{ nope', 'notes.txt': 'x', '../x.json': 'y' },
  });
  const data = (await (await fetch(`${harness.url}/api/profiles`)).json()) as {
    profiles: Array<{ file: string; id: string; name?: string; locale?: string; error?: string }>;
    active: string | null;
    default: { id: string };
  };
  assert.deepEqual(
    data.profiles.map((entry) => [entry.file, entry.id, Boolean(entry.error)]),
    [
      ['a.json', 'a', true],
      ['b.json', 'beta', false],
    ],
  );
  assert.equal(data.profiles[1]!.locale, 'de-DE');
  assert.equal(data.profiles[1]!.name, 'Test');
  assert.equal(data.active, null);
  assert.equal(data.default.id, 'start');
});

test('PUT /api/profile picks a file and null goes back to the default', async () => {
  const harness = await start({ profiles: { 'b.json': venue('beta') }, settings: { presets: [PRESET] } });
  const picked = await call(harness, 'PUT', '/api/profile', { file: 'b.json' });
  assert.equal(picked.status, 200);
  const settings = readSettings(harness.settingsPath);
  assert.equal(settings?.profile, 'b.json');
  // The rest of the settings survives the change.
  assert.equal(settings?.presets.length, 1);
  const listed = (await (await fetch(`${harness.url}/api/profiles`)).json()) as { active: string | null };
  assert.equal(listed.active, 'b.json');

  const reset = await call(harness, 'PUT', '/api/profile', { file: null });
  assert.equal(reset.status, 200);
  assert.equal(readSettings(harness.settingsPath)?.profile, undefined);
});

test('PUT /api/profile refuses paths, missing and broken files', async () => {
  const harness = await start({ profiles: { 'bad.json': '{}' } });
  for (const file of ['../etc.json', 'sub/x.json', 'bad.json', 'missing.json', 'x.txt', 5, undefined]) {
    const response = await call(harness, 'PUT', '/api/profile', { file });
    assert.equal(response.status, 400, String(file));
  }
  assert.equal(readSettings(harness.settingsPath), undefined);
});

test('GET /api/profiles without a directory is an empty list', async () => {
  const harness = await start();
  rmSync(harness.profilesDir, { recursive: true });
  const data = (await (await fetch(`${harness.url}/api/profiles`)).json()) as { profiles: unknown[] };
  assert.deepEqual(data.profiles, []);
});

test('GET /api/catalog/<target> answers from the catalog; bad input is refused', async () => {
  const asked: unknown[] = [];
  const harness = await start({
    catalog: {
      get: async (target, request) => {
        asked.push([target, request]);
        return { provider: target, available: true, models: [], voices: [], fetchedAt: '2026-01-01T00:00:00.000Z' };
      },
    },
  });
  const ok = await fetch(`${harness.url}/api/catalog/kugel?refresh=1&language=de-DE`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { provider: string }).provider, 'kugel');
  await fetch(`${harness.url}/api/catalog/llm`);
  assert.deepEqual(asked, [
    ['kugel', { refresh: true, language: 'de-DE' }],
    ['llm', { refresh: false }],
  ]);

  assert.equal((await fetch(`${harness.url}/api/catalog/nobody`)).status, 404);
  assert.equal((await fetch(`${harness.url}/api/catalog/kugel?language=../x`)).status, 400);
});

test('GET /api/catalog never throws out of the endpoint and never serves a key', async () => {
  const harness = await start();
  // The default catalog with no key for Cartesia in this environment: unavailable, status 200.
  const response = await fetch(`${harness.url}/api/catalog/kugel`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal((JSON.parse(text) as { available: boolean }).available, false);
  assert.equal(text.includes(KEY), false);
});

interface KnowledgeAnswer {
  profile: { id: string; assistantName: string };
  source: string;
  file: string | null;
  greeting: string;
  facts: Array<{ topic: string; answer: string }>;
  transfer: { announce: string; targetMasked: string } | null;
  systemPrompt: string;
  tools: Array<{ name: string; description: string; parameters: { type: string }; availableWhen: string }>;
}

const WITH_TRANSFER = {
  facts: [{ topic: 'Hours', answer: 'Open daily.' }],
  transfer: { target: 'tel:+4930123456', announce: 'One moment.' },
};

test('GET /api/knowledge answers for the start profile: prompt, facts and the real tool list', async () => {
  const harness = await start();
  const response = await fetch(`${harness.url}/api/knowledge`);
  assert.equal(response.status, 200);
  const data = (await response.json()) as KnowledgeAnswer;
  assert.equal(data.profile.id, 'start');
  assert.equal(data.source, 'start');
  assert.equal(data.file, null);
  assert.equal(data.transfer, null);
  assert.match(data.systemPrompt, /You are Test, a voice assistant/);
  assert.deepEqual(
    data.tools.map((tool) => tool.name),
    ['transfer_to_human'],
  );
  assert.equal(data.tools[0]!.parameters.type, 'object');
  assert.ok(data.tools[0]!.availableWhen);
});

test('GET /api/knowledge masks the transfer target, also when the deployment overrides it', async () => {
  const profiles = { 'b.json': venue('beta', WITH_TRANSFER) };
  const harness = await start({ profiles });
  const picked = await fetch(`${harness.url}/api/knowledge?file=b.json`);
  const text = await picked.text();
  const data = JSON.parse(text) as KnowledgeAnswer;
  assert.equal(data.source, 'selected');
  assert.equal(data.file, 'b.json');
  assert.equal(data.facts[0]!.topic, 'Hours');
  assert.equal(data.transfer?.announce, 'One moment.');
  assert.equal(data.transfer?.targetMasked, 'tel:+••••••••56');
  assert.doesNotMatch(text, /4930123456|30123456/);

  const overridden = await start({
    profiles,
    env: { ...ENV, TRANSFER_TARGET_NUMBER: '+4915112345678', TRANSFER_SIP_HOST: 'pbx.example:5060' },
  });
  const overriddenText = await (await fetch(`${overridden.url}/api/knowledge?file=b.json`)).text();
  assert.equal((JSON.parse(overriddenText) as KnowledgeAnswer).transfer?.targetMasked, 'sip:+•••••••••••78');
  assert.doesNotMatch(overriddenText, /15112345678|pbx\.example/);
});

test('GET /api/knowledge without a file follows the active profile, as a call does', async () => {
  const harness = await start({
    profiles: { 'b.json': venue('beta'), 'bad.json': '{}' },
    settings: { presets: [], active: {}, profile: 'b.json' },
  });
  const active = (await (await fetch(`${harness.url}/api/knowledge`)).json()) as KnowledgeAnswer;
  assert.equal(active.profile.id, 'beta');
  assert.equal(active.source, 'active');
  assert.equal(active.file, 'b.json');

  // An active profile that no longer loads: the call falls back to the start profile, so does the view.
  await call(harness, 'PUT', '/api/profile', { file: null });
  writeFileSync(harness.settingsPath, JSON.stringify({ presets: [], active: {}, profile: 'bad.json' }));
  const fallback = (await (await fetch(`${harness.url}/api/knowledge`)).json()) as KnowledgeAnswer;
  assert.equal(fallback.profile.id, 'start');
});

test('GET /api/knowledge speaks with the name of the active voice', async () => {
  const harness = await start({
    settings: { presets: [{ ...PRESET, name: 'Lena' }], active: { primary: 'jane' } },
  });
  const data = (await (await fetch(`${harness.url}/api/knowledge`)).json()) as KnowledgeAnswer;
  assert.equal(data.profile.assistantName, 'Lena');
  assert.match(data.systemPrompt, /You are Lena,/);
});

test('GET /api/knowledge refuses paths, missing and broken files', async () => {
  const harness = await start({ profiles: { 'bad.json': '{}' } });
  for (const file of ['../etc.json', 'sub/x.json', 'bad.json', 'missing.json', 'x.txt']) {
    const response = await fetch(`${harness.url}/api/knowledge?file=${encodeURIComponent(file)}`);
    assert.equal(response.status, 400, file);
  }
});

test('preview: a voice that is not a preset is validated like one and synthesized as given', async () => {
  const harness = await start();
  const response = await call(harness, 'POST', '/api/preview', {
    text: 'Hello.',
    voice: { provider: 'mistral', model: 'm1', voice: 'v1' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ttfa-ms'), '123');
  assert.equal(harness.asked[0]!.choice.provider, 'mistral');
  assert.equal(harness.asked[0]!.choice.model, 'm1');
  assert.equal(harness.asked[0]!.choice.voice, 'v1');

  for (const voice of [{ provider: 'nope' }, { provider: 'kugel', voice: 'not-a-number' }, { provider: 'cartesia' }]) {
    assert.equal((await call(harness, 'POST', '/api/preview', { voice })).status, 400, JSON.stringify(voice));
  }
  assert.equal(harness.asked.length, 1);
});
