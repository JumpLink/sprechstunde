import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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
    fetch?: typeof fetch;
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
  const startProfileFile = join(dir, 'start-profile.json');
  writeFileSync(startProfileFile, venue('start', { voice: { refAudio: 'clip.wav' } }));
  // Outside the web directory: what a traversal would have to reach.
  writeFileSync(join(dir, 'secret.txt'), KEY);

  const asked: Harness['asked'] = [];
  const server = createAdminServer({
    settingsPath,
    metricsDir,
    sampleText: 'Guten Tag.',
    webDir,
    ...(options.catalog && { catalog: options.catalog }),
    ...(options.fetch && { fetch: options.fetch }),
    startProfile: { id: 'start', name: 'Test', locale: 'de-DE' },
    startProfileFile,
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
  return {
    url: `http://127.0.0.1:${port}`,
    settingsPath,
    profilesDir,
    metricsDir,
    asked,
  };
}

/** A request as the page makes it: same origin, JSON body. */
function call(harness: Harness, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const origin = harness.url;
  return fetch(`${harness.url}${path}`, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
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

const CHARACTER = {
  id: 'jane',
  name: 'Jane',
  gender: 'female',
  voice: { provider: 'mistral', voice: 'gb_jane_neutral' },
};
const PAUL = {
  id: 'paul',
  name: 'Paul',
  gender: 'male',
  voice: { provider: 'pocket' },
};

/** A settings file as the current version writes it. */
const stored = (characters: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  characters,
  ...extra,
});

interface CharactersView {
  tenantId: string;
  revision: string;
  default: string | null;
  characters: Array<{
    id: string;
    tenantId: string;
    name: string;
    color?: string;
    voice: { provider: string };
    usedBy: Array<{ file: string | null; id: string; explicit: boolean }>;
  }>;
  created?: { id: string };
}

const viewOf = async (harness: Harness): Promise<CharactersView> =>
  (await (await fetch(`${harness.url}/api/characters`)).json()) as CharactersView;

async function settingsOf(harness: Harness, response: Response): Promise<Settings> {
  const payload = (await response.json()) as Settings;
  // What the route answers and what the next call will read must be the same thing.
  assert.deepEqual(readSettings(harness.settingsPath), payload);
  return payload;
}

/** What a characters route answers must list what the next call will read. */
async function viewAfter(harness: Harness, response: Response): Promise<CharactersView> {
  const payload = (await response.json()) as CharactersView;
  assert.deepEqual(
    payload.characters.map((entry) => entry.id),
    readSettings(harness.settingsPath)?.characters.map((entry) => entry.id),
  );
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
  assert.match(policy, /media-src 'self' blob:(;|$)/);
  assert.doesNotMatch(policy, /https:/);
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
  const noOrigin = await fetch(`${harness.url}/api/characters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CHARACTER),
  });
  assert.equal(noOrigin.status, 403);

  const foreign = await call(harness, 'POST', '/api/characters', CHARACTER, {
    origin: 'http://evil.example',
  });
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

test('characters: create, change and delete', async () => {
  const harness = await start();
  const created = await call(harness, 'POST', '/api/characters', CHARACTER);
  assert.equal(created.status, 201);
  const first = await viewAfter(harness, created);
  assert.equal(first.created?.id, 'jane');
  assert.equal(first.tenantId, 'default');
  // The first character is the default one until another is picked.
  assert.equal(first.default, 'jane');
  assert.equal(first.characters[0]!.tenantId, 'default');
  assert.match(first.characters[0]!.color ?? '', /^#[0-9a-f]{6}$/);

  const changed = await call(harness, 'PUT', '/api/characters/jane', {
    ...CHARACTER,
    name: 'Jane (warm)',
    tone: 'Warm.',
    revision: first.revision,
  });
  assert.equal(changed.status, 200);
  const after = await viewAfter(harness, changed);
  assert.equal(after.characters[0]!.name, 'Jane (warm)');
  // The colour is kept when an edit does not send one.
  assert.equal(after.characters[0]!.color, first.characters[0]!.color);
  assert.equal(readSettings(harness.settingsPath)?.characters[0]!.tone, 'Warm.');

  const second = await call(harness, 'POST', '/api/characters', PAUL);
  const both = await viewAfter(harness, second);
  const deleted = await call(harness, 'DELETE', '/api/characters/paul', {
    revision: both.revision,
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    (await viewAfter(harness, deleted)).characters.map((entry) => entry.id),
    ['jane'],
  );
});

test('characters: the id comes from the name when none is given, and stays unique', async () => {
  const harness = await start();
  const { id: _id, ...noId } = CHARACTER;
  for (const expected of ['jane', 'jane-2']) {
    const view = (await (await call(harness, 'POST', '/api/characters', noId)).json()) as CharactersView;
    assert.equal(view.created?.id, expected);
  }
  const accented = (await (
    await call(harness, 'POST', '/api/characters', {
      ...noId,
      name: 'Zoë Müller',
    })
  ).json()) as CharactersView;
  assert.equal(accented.created?.id, 'zoe-muller');
  const reserved = (await (
    await call(harness, 'POST', '/api/characters', { ...noId, name: 'Default' })
  ).json()) as CharactersView;
  assert.equal(reserved.created?.id, 'default-2');
});

test('characters: an invalid one is refused and the file stays as it was', async () => {
  const harness = await start({
    settings: stored([CHARACTER], { defaultCharacter: 'jane' }),
  });
  const before = readFileSync(harness.settingsPath, 'utf8');
  const view = await viewOf(harness);

  const duplicate = await call(harness, 'POST', '/api/characters', CHARACTER);
  assert.equal(duplicate.status, 409);

  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no voice', { ...PAUL, id: 'c', voice: { provider: 'cartesia' } }, /"voice" is required/],
    ['provider', { ...PAUL, id: 'c', voice: { provider: 'elevenlabs' } }, /"provider"/],
    ['gender', { ...PAUL, id: 'c', gender: 'x' }, /"gender"/],
    ['name', { ...PAUL, id: 'c', name: 'a\nb' }, /"name"/],
    ['long name', { ...PAUL, id: 'c', name: 'n'.repeat(61) }, /"name"/],
    ['tone', { ...PAUL, id: 'c', tone: 'a\u0000b' }, /"tone"/],
    ['long tone', { ...PAUL, id: 'c', tone: 't'.repeat(301) }, /"tone"/],
    ['reserved id', { ...PAUL, id: 'default' }, /"id"/],
    ['id', { ...PAUL, id: 'a b' }, /id/],
  ];
  for (const [label, body, error] of bad) {
    const response = await call(harness, 'POST', '/api/characters', body);
    assert.equal(response.status, 400, label);
    assert.match(((await response.json()) as { error: string }).error, error, label);
  }

  const missing = await call(harness, 'PUT', '/api/characters/nope', {
    ...CHARACTER,
    revision: view.revision,
  });
  assert.equal(missing.status, 404);
  const renamed = await call(harness, 'PUT', '/api/characters/jane', {
    ...CHARACTER,
    id: 'other',
    revision: view.revision,
  });
  assert.equal(renamed.status, 400);
  assert.equal(readFileSync(harness.settingsPath, 'utf8'), before);
});

test('characters: a tenant id from the client is ignored', async () => {
  const harness = await start();
  const response = await call(harness, 'POST', '/api/characters', {
    ...CHARACTER,
    tenantId: 'other',
  });
  assert.equal(response.status, 201);
  assert.equal(readSettings(harness.settingsPath)?.characters[0]!.tenantId, 'default');
});

test('characters: a change from a stale page is a 409', async () => {
  const harness = await start({
    settings: stored([CHARACTER, PAUL], { defaultCharacter: 'jane' }),
  });
  const stale = (await viewOf(harness)).revision;
  const first = await call(harness, 'PUT', '/api/characters/paul', {
    ...PAUL,
    name: 'Paulus',
    revision: stale,
  });
  assert.equal(first.status, 200);
  const before = readFileSync(harness.settingsPath, 'utf8');

  for (const [method, path, body] of [
    ['PUT', '/api/characters/paul', { ...PAUL, name: 'Again', revision: stale }],
    ['DELETE', '/api/characters/paul', { revision: stale }],
    ['PUT', '/api/characters/default', { id: 'paul', revision: stale }],
  ] as const) {
    assert.equal((await call(harness, method, path, body)).status, 409, `${method} ${path}`);
  }
  for (const [method, path, body] of [
    ['PUT', '/api/characters/paul', PAUL],
    ['DELETE', '/api/characters/paul', {}],
  ] as const) {
    assert.equal((await call(harness, method, path, body)).status, 400, `${method} ${path} without revision`);
  }
  assert.equal(readFileSync(harness.settingsPath, 'utf8'), before);
});

test('characters: PUT /api/characters/default picks the default, an unknown one is a 404', async () => {
  const harness = await start({
    settings: stored([CHARACTER, PAUL], { defaultCharacter: 'jane' }),
  });
  const { revision } = await viewOf(harness);
  const missing = await call(harness, 'PUT', '/api/characters/default', {
    id: 'nope',
    revision,
  });
  assert.equal(missing.status, 404);
  const picked = await call(harness, 'PUT', '/api/characters/default', {
    id: 'paul',
    revision,
  });
  assert.equal(picked.status, 200);
  assert.equal((await viewAfter(harness, picked)).default, 'paul');
  assert.equal(readSettings(harness.settingsPath)?.defaultCharacter, 'paul');
});

test('characters: the default character cannot be deleted', async () => {
  const harness = await start({
    settings: stored([CHARACTER, PAUL], { defaultCharacter: 'jane' }),
  });
  const { revision } = await viewOf(harness);
  const response = await call(harness, 'DELETE', '/api/characters/jane', {
    revision,
  });
  assert.equal(response.status, 409);
  assert.equal((await viewOf(harness)).characters.length, 2);
});

test('characters: one a venue uses cannot be deleted, the venue is listed under it', async () => {
  const harness = await start({
    profiles: {
      'b.json': venue('beta', { character: 'paul' }),
      'c.json': venue('gamma'),
    },
    settings: stored([CHARACTER, PAUL], { defaultCharacter: 'jane' }),
  });
  const view = await viewOf(harness);
  const byId = Object.fromEntries(view.characters.map((entry) => [entry.id, entry.usedBy]));
  assert.deepEqual(
    byId.paul!.map((entry) => [entry.id, entry.explicit]),
    [['beta', true]],
  );
  // A venue without a pick speaks as the default character.
  assert.ok(byId.jane!.some((entry) => entry.id === 'gamma' && !entry.explicit));

  const refused = await call(harness, 'DELETE', '/api/characters/paul', {
    revision: view.revision,
  });
  assert.equal(refused.status, 409);
  assert.equal((await viewOf(harness)).characters.length, 2);

  // Free again once the venue picks another character.
  writeFileSync(join(harness.profilesDir, 'b.json'), venue('beta'));
  const again = await call(harness, 'DELETE', '/api/characters/paul', {
    revision: view.revision,
  });
  assert.equal(again.status, 200);
});

test('characters: a character id in the URL is decoded and must match the id pattern', async () => {
  const harness = await start({
    settings: stored([CHARACTER, PAUL], { defaultCharacter: 'paul' }),
  });
  const { revision } = await viewOf(harness);
  for (const bad of ['..%2Fx', '%E0%A4%A', 'a%20b', '.hidden']) {
    const response = await call(harness, 'DELETE', `/api/characters/${bad}`, {
      revision,
    });
    assert.equal(response.status, 400, bad);
  }
  const ok = await call(harness, 'DELETE', '/api/characters/%6Aane', {
    revision,
  });
  assert.equal(ok.status, 200);
});

test('characters: a file from before characters is served migrated and written back in the new shape', async () => {
  const harness = await start({
    settings: {
      presets: [
        { id: 'house', label: 'House', provider: 'pocket', name: 'Alex' },
        { id: 'cloud', label: 'Cloud', provider: 'mistral', voice: 'm' },
      ],
      active: { primary: 'house', fallback: 'cloud' },
      llm: { model: 'small' },
    },
  });
  const view = await viewOf(harness);
  assert.equal(view.default, 'house');
  assert.deepEqual(
    view.characters.map((entry) => [entry.id, entry.tenantId]),
    [
      ['house', 'default'],
      ['cloud', 'default'],
    ],
  );
  const llm = await call(harness, 'PUT', '/api/llm', { model: 'medium' });
  const written = await settingsOf(harness, llm);
  assert.equal(written.schemaVersion, 2);
  assert.equal(written.characters.length, 2);
  assert.equal(written.llm.model, 'medium');
});

test('llm is written and validated', async () => {
  const harness = await start({ settings: stored([CHARACTER, PAUL]) });

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

  const bad = await call(harness, 'PUT', '/api/llm', {
    attemptTimeoutS: 'soon',
  });
  assert.equal(bad.status, 400);
});

test('preview: a WAV, the time to first audio in a header, the character in the choice', async () => {
  const harness = await start({ settings: stored([CHARACTER]) });
  const response = await call(harness, 'POST', '/api/preview', {
    character: 'jane',
    text: 'Guten Abend.',
  });
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
    name: 'Jane',
    character: 'jane',
  });
  assert.equal(harness.asked.at(-1)!.text, 'Guten Abend.');
});

test('preview: "phone" is 8 kHz, and no character means the environment voice', async () => {
  const harness = await start();
  const response = await call(harness, 'POST', '/api/preview', { phone: true });
  assert.equal(response.headers.get('x-sample-rate'), '8000');
  assert.equal((await response.arrayBuffer()).byteLength, 44 + 160);
  assert.equal(harness.asked.at(-1)!.choice.character, undefined);
  assert.equal(harness.asked.at(-1)!.choice.voice, 'gb_jane_neutral');
  // No text means the sample text the page starts with.
  assert.equal(harness.asked.at(-1)!.text, 'Guten Tag.');
});

test('preview: an unknown character is a 404, not a silent environment voice', async () => {
  const harness = await start();
  const response = await call(harness, 'POST', '/api/preview', {
    character: 'nope',
  });
  assert.equal(response.status, 404);
  assert.equal(harness.asked.length, 0);
});

test('the latency route groups the metrics by character', async () => {
  const ts = Date.parse('2026-10-19T10:00:00Z');
  const harness = await start({
    metrics: [
      JSON.stringify({
        type: 'call_config',
        ts,
        character: 'jane',
        ttsProvider: 'mistral',
      }),
      JSON.stringify({ type: 'tts_metrics', ts: ts + 500, ttfbMs: 600 }),
      JSON.stringify({ type: 'llm_metrics', ts: ts + 600, ttftMs: 400 }),
    ].join('\n'),
  });
  const payload = (await (await fetch(`${harness.url}/api/latency`)).json()) as {
    characters: Array<{
      character: string;
      calls: number;
      summary: Record<string, { p50: number }>;
    }>;
    calls: Array<{ character: string; lines: number }>;
  };
  assert.equal(payload.characters.length, 1);
  assert.equal(payload.characters[0]!.character, 'jane');
  assert.equal(payload.characters[0]!.summary['tts.ttfbMs']!.p50, 600);
  assert.equal(payload.calls[0]!.lines, 2);
});

test('a broken settings file is reported, not hidden', async () => {
  const harness = await start({
    settings: '{ "schemaVersion": 2, "characters": [ {} ] }',
  });
  const state = (await (await fetch(`${harness.url}/api/state`)).json()) as {
    settingsError?: string;
  };
  assert.match(state.settingsError ?? '', /"id" must be a non-empty string/);

  const change = await call(harness, 'PUT', '/api/llm', { model: 'x' });
  assert.equal(change.status, 400);
});

test('no response ever carries an API key', async () => {
  const harness = await start({
    settings: stored([CHARACTER], { defaultCharacter: 'jane' }),
  });
  const bodies = await Promise.all(
    ['/', '/app.js', '/api/state', '/api/latency'].map(async (path) => (await fetch(`${harness.url}${path}`)).text()),
  );
  for (const text of bodies) assert.ok(!text.includes(KEY), `a response leaked the API key: ${text.slice(0, 200)}`);

  const state = (await (await fetch(`${harness.url}/api/state`)).json()) as {
    keys: Record<string, boolean>;
  };
  // Whether a vendor can be previewed is useful; the key itself never is.
  // `kugel` has no key in this environment: the UI marks such a vendor instead of hiding it.
  assert.deepEqual(state.keys, {
    mistral: true,
    cartesia: true,
    openrouter: true,
    kugel: false,
  });
});

test('unknown routes are a 404', async () => {
  const harness = await start();
  assert.equal((await fetch(`${harness.url}/api/nope`)).status, 404);
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
    profiles: {
      'b.json': venue('beta'),
      'a.json': '{ nope',
      'notes.txt': 'x',
      '../x.json': 'y',
    },
  });
  const data = (await (await fetch(`${harness.url}/api/profiles`)).json()) as {
    profiles: Array<{
      file: string;
      id: string;
      name?: string;
      locale?: string;
      error?: string;
    }>;
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
  const harness = await start({
    profiles: { 'b.json': venue('beta') },
    settings: stored([CHARACTER]),
  });
  const picked = await call(harness, 'PUT', '/api/profile', { file: 'b.json' });
  assert.equal(picked.status, 200);
  const settings = readSettings(harness.settingsPath);
  assert.equal(settings?.profile, 'b.json');
  // The rest of the settings survives the change.
  assert.equal(settings?.characters.length, 1);
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
  const data = (await (await fetch(`${harness.url}/api/profiles`)).json()) as {
    profiles: unknown[];
  };
  assert.deepEqual(data.profiles, []);
});

test('GET /api/catalog/<target> answers from the catalog; bad input is refused', async () => {
  const asked: unknown[] = [];
  const harness = await start({
    catalog: {
      get: async (target, request) => {
        asked.push([target, request]);
        return {
          provider: target,
          available: true,
          models: [],
          voices: [],
          fetchedAt: '2026-01-01T00:00:00.000Z',
        };
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
  tools: Array<{
    name: string;
    description: string;
    parameters: { type: string };
    availableWhen: string;
  }>;
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
    env: {
      ...ENV,
      TRANSFER_TARGET_NUMBER: '+4915112345678',
      TRANSFER_SIP_HOST: 'pbx.example:5060',
    },
  });
  const overriddenText = await (await fetch(`${overridden.url}/api/knowledge?file=b.json`)).text();
  assert.equal((JSON.parse(overriddenText) as KnowledgeAnswer).transfer?.targetMasked, 'sip:+•••••••••••78');
  assert.doesNotMatch(overriddenText, /15112345678|pbx\.example/);
});

test('GET /api/knowledge without a file follows the active profile, as a call does', async () => {
  const harness = await start({
    profiles: { 'b.json': venue('beta'), 'bad.json': '{}' },
    settings: { profile: 'b.json' },
  });
  const active = (await (await fetch(`${harness.url}/api/knowledge`)).json()) as KnowledgeAnswer;
  assert.equal(active.profile.id, 'beta');
  assert.equal(active.source, 'active');
  assert.equal(active.file, 'b.json');

  // An active profile that no longer loads: the call falls back to the start profile, so does the view.
  await call(harness, 'PUT', '/api/profile', { file: null });
  writeFileSync(harness.settingsPath, JSON.stringify({ profile: 'bad.json' }));
  const fallback = (await (await fetch(`${harness.url}/api/knowledge`)).json()) as KnowledgeAnswer;
  assert.equal(fallback.profile.id, 'start');
});

test('GET /api/knowledge speaks as the default character: its name, tone and gender', async () => {
  const harness = await start({
    settings: stored([{ ...CHARACTER, name: 'Lena', tone: 'Calm and warm.' }], {
      defaultCharacter: 'jane',
    }),
  });
  const data = (await (await fetch(`${harness.url}/api/knowledge`)).json()) as KnowledgeAnswer;
  assert.equal(data.profile.assistantName, 'Lena');
  assert.match(data.systemPrompt, /You are Lena,/);
  assert.match(data.systemPrompt, /Speaking style: Calm and warm\./);
  assert.match(data.systemPrompt, /eine KI-Assistentin/);
});

test('GET /api/knowledge follows the character the venue picked', async () => {
  const harness = await start({
    profiles: { 'b.json': venue('beta', { character: 'paul' }) },
    settings: stored(
      [
        { ...CHARACTER, name: 'Lena' },
        { ...PAUL, name: 'Pablo' },
      ],
      { defaultCharacter: 'jane' },
    ),
  });
  const data = (await (await fetch(`${harness.url}/api/knowledge?file=b.json`)).json()) as KnowledgeAnswer;
  assert.equal(data.profile.assistantName, 'Pablo');
  assert.match(data.systemPrompt, /"ein KI-Assistent"/);
  const unknown = await start({
    profiles: { 'b.json': venue('beta', { character: 'gone' }) },
    settings: stored([{ ...CHARACTER, name: 'Lena' }], {
      defaultCharacter: 'jane',
    }),
  });
  const fallback = (await (await fetch(`${unknown.url}/api/knowledge?file=b.json`)).json()) as KnowledgeAnswer;
  assert.equal(fallback.profile.assistantName, 'Lena');
});

test('GET /api/knowledge without a character keeps the profile as it is, prompt included', async () => {
  const harness = await start({ settings: stored([]) });
  const data = (await (await fetch(`${harness.url}/api/knowledge`)).json()) as KnowledgeAnswer;
  assert.equal(data.profile.assistantName, 'Test');
  assert.doesNotMatch(data.systemPrompt, /Speaking style|KI-Assistent/);
});

test('GET /api/knowledge refuses paths, missing and broken files', async () => {
  const harness = await start({ profiles: { 'bad.json': '{}' } });
  for (const file of ['../etc.json', 'sub/x.json', 'bad.json', 'missing.json', 'x.txt']) {
    const response = await fetch(`${harness.url}/api/knowledge?file=${encodeURIComponent(file)}`);
    assert.equal(response.status, 400, file);
  }
});

test('preview: a voice that is not a character is validated like one and synthesized as given', async () => {
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

test('preview: a text over 1000 characters is refused before any vendor is asked', async () => {
  const harness = await start();
  const response = await call(harness, 'POST', '/api/preview', {
    text: 'x'.repeat(1001),
  });
  assert.equal(response.status, 400);
  assert.equal(harness.asked.length, 0);
  assert.equal((await call(harness, 'POST', '/api/preview', { text: 'x'.repeat(1000) })).status, 200);
});

test('preview: an inline voice needs a known provider and short plain model and voice strings', async () => {
  const harness = await start();
  const bad = [
    { provider: 'evil' },
    { provider: 'mistral', model: 'm'.repeat(101) },
    { provider: 'mistral', voice: 'v\nx' },
    { provider: 'mistral', voice: 'v\u0000' },
    { provider: 'mistral', model: 5 },
    { provider: 'mistral', voice: { a: 1 } },
  ];
  for (const voice of bad) {
    assert.equal((await call(harness, 'POST', '/api/preview', { voice })).status, 400, JSON.stringify(voice));
  }
  assert.equal(harness.asked.length, 0);
  const ok = await call(harness, 'POST', '/api/preview', {
    voice: { provider: 'mistral', model: 'm'.repeat(100), voice: 'v' },
  });
  assert.equal(ok.status, 200);
});

const SAMPLE_CATALOG: CatalogService = {
  get: async (target) => ({
    provider: target,
    available: true,
    models: [],
    voices: [
      {
        id: 'a',
        name: 'A',
        languages: ['de'],
        sampleUrl: 'https://vendor.invalid/a.mp3',
      },
      { id: 'b', name: 'B', languages: ['de'] },
      {
        id: 'c',
        name: 'C',
        languages: ['de'],
        sampleUrl: 'http://vendor.invalid/c.mp3',
      },
      {
        id: 'd',
        name: 'D',
        languages: ['de'],
        sampleUrl: 'https://vendor.invalid/d.html',
      },
    ],
    fetchedAt: '2026-01-01T00:00:00.000Z',
  }),
};

test('GET /api/sample proxies the catalog sample, never a client-supplied URL', async () => {
  const fetched: string[] = [];
  const fakeFetch = (async (address: string) => {
    fetched.push(address);
    const audio = !address.endsWith('.html');
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': audio ? 'audio/mpeg' : 'text/html' },
    });
  }) as unknown as typeof fetch;
  const harness = await start({ catalog: SAMPLE_CATALOG, fetch: fakeFetch });

  const ok = await fetch(`${harness.url}/api/sample?provider=kugel&voice=a`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(fetched, ['https://vendor.invalid/a.mp3']);

  const missing = [
    'provider=kugel&voice=nobody',
    'provider=kugel&voice=b',
    'provider=kugel&voice=a&model=other',
    'provider=kugel&voice=https://evil.invalid/x.mp3',
  ];
  for (const query of missing) {
    assert.equal((await fetch(`${harness.url}/api/sample?${query}`)).status, 404, query);
  }
  assert.equal((await fetch(`${harness.url}/api/sample?provider=llm&voice=a`)).status, 400);
  assert.equal((await fetch(`${harness.url}/api/sample?provider=nope&voice=a`)).status, 400);
  // Plain http and a non-audio answer are refused.
  assert.equal((await fetch(`${harness.url}/api/sample?provider=kugel&voice=c`)).status, 502);
  assert.equal((await fetch(`${harness.url}/api/sample?provider=kugel&voice=d`)).status, 502);
  assert.deepEqual(fetched, ['https://vendor.invalid/a.mp3', 'https://vendor.invalid/d.html']);
});

test('GET /api/sample refuses a sample that is too big or a vendor that fails', async () => {
  const big = (async () =>
    new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'audio/mpeg' },
    })) as unknown as typeof fetch;
  const harness = await start({ catalog: SAMPLE_CATALOG, fetch: big });
  assert.equal((await fetch(`${harness.url}/api/sample?provider=kugel&voice=a`)).status, 502);

  const down = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const other = await start({ catalog: SAMPLE_CATALOG, fetch: down });
  assert.equal((await fetch(`${other.url}/api/sample?provider=kugel&voice=a`)).status, 502);
});

test('a symlink inside the web directory cannot serve a file from outside it', async () => {
  const harness = await start({ web: WEB });
  const dir = join(harness.profilesDir, '..');
  symlinkSync(join(dir, 'secret.txt'), join(dir, 'web', 'assets', 'leak.txt'));
  const response = await fetch(`${harness.url}/assets/leak.txt`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), new RegExp(KEY));
});

const TARGET = 'tel:+4930123456';
const EDITABLE = venue('beta', {
  voice: { ttsVoice: 'jane' },
  futureKey: { keep: ['me'] },
  transfer: { target: TARGET, announce: 'One moment.', futureTransferKey: 1 },
  fallback: 'Call later.',
  facts: [{ topic: 'Hours', answer: 'Nine to five.' }],
});

interface Edit {
  editable: boolean;
  revision?: string;
  file: string | null;
  draft?: {
    greeting: string;
    character: string | null;
    transfer: { announce: string; targetMasked: string } | null;
  };
}

const edit = async (harness: Harness, file: string): Promise<Edit> =>
  (await (await fetch(`${harness.url}/api/knowledge?file=${file}`)).json()) as Edit;

const draftOf = (extra: Record<string, unknown> = {}) => ({
  assistantName: 'Test',
  greeting: 'Hallo, ich bin eine KI.',
  instructions: 'Be brief.',
  facts: [{ topic: 'Hours', answer: 'Nine to five.' }],
  transfer: { announce: 'One moment.' },
  fallback: 'Call later.',
  ...extra,
});

const save = (harness: Harness, file: string, revision: string | undefined, draft: unknown) =>
  call(harness, 'PUT', `/api/profiles/${file}`, { revision, draft });

const profileJson = (harness: Harness, file: string) =>
  JSON.parse(readFileSync(join(harness.profilesDir, file), 'utf8')) as Record<string, unknown>;

const versions = async (harness: Harness, file: string) =>
  (
    (await (await fetch(`${harness.url}/api/profiles/${file}/history`)).json()) as {
      versions: Array<{ version: string; at: string; size: number }>;
    }
  ).versions;

test('knowledge: a profiles-directory file is editable, never with the full target; the start profile is not', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const response = await fetch(`${harness.url}/api/knowledge?file=b.json`);
  const raw = await response.text();
  assert.doesNotMatch(raw, /4930123456|30123456/);
  const data = JSON.parse(raw) as Edit;
  assert.equal(data.editable, true);
  assert.match(data.revision ?? '', /^[0-9a-f]{16}$/);
  assert.equal(data.draft?.transfer?.targetMasked, 'tel:+••••••••56');
  const startView = await (await fetch(`${harness.url}/api/knowledge`)).json();
  assert.equal((startView as Edit).editable, false);
  assert.equal('draft' in (startView as object), false);
});

test('profile save: edits land, everything else stays, the target is kept, the old file goes to history', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const path = join(harness.profilesDir, 'b.json');
  chmodSync(path, 0o640);
  const before = readFileSync(path, 'utf8');
  const { revision } = await edit(harness, 'b.json');

  const response = await save(
    harness,
    'b.json',
    revision,
    draftOf({
      greeting: 'Guten Tag, hier spricht eine KI.',
      facts: [
        { topic: 'Parking', answer: 'Behind the house.' },
        { topic: 'Hours', answer: 'Nine to five.' },
      ],
      transfer: { announce: 'Please hold.' },
      fallback: null,
    }),
  );
  assert.equal(response.status, 200);
  const saved = profileJson(harness, 'b.json');
  assert.equal(saved.greeting, 'Guten Tag, hier spricht eine KI.');
  assert.deepEqual(
    (saved.facts as Array<{ topic: string }>).map((fact) => fact.topic),
    ['Parking', 'Hours'],
  );
  assert.deepEqual(saved.transfer, {
    target: TARGET,
    announce: 'Please hold.',
    futureTransferKey: 1,
  });
  assert.equal('fallback' in saved, false);
  // Untouched fields, including one this code has never heard of.
  assert.deepEqual(saved.voice, { ttsVoice: 'jane' });
  assert.deepEqual(saved.futureKey, { keep: ['me'] });
  assert.equal(saved.id, 'beta');
  assert.equal(saved.timeZone, 'Europe/Berlin');
  assert.equal(saved.locale, 'de-DE');
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.deepEqual(
    readdirSync(harness.profilesDir).filter((name) => name.endsWith('.tmp')),
    [],
  );

  const list = await versions(harness, 'b.json');
  assert.equal(list.length, 1);
  assert.equal(readFileSync(join(harness.profilesDir, '.history', `b.json.${list[0]!.version}.json`), 'utf8'), before);
  assert.equal(list[0]!.size, Buffer.byteLength(before));
  assert.equal(Number.isNaN(Date.parse(list[0]!.at)), false);
  // The answer's revision is the one the next load reports.
  const next = await edit(harness, 'b.json');
  assert.equal(((await response.json()) as { revision: string }).revision, next.revision);
  assert.notEqual(next.revision, revision);
});

test('profile save: a new target is validated, normalised and replaces the old one', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  let revision = (await edit(harness, 'b.json')).revision;
  const ok = await save(harness, 'b.json', revision, draftOf({ transferTarget: '+49 30 99-88' }));
  assert.equal(ok.status, 200);
  assert.equal((profileJson(harness, 'b.json').transfer as { target: string }).target, 'tel:+49309988');
  assert.doesNotMatch(await (await fetch(`${harness.url}/api/knowledge?file=b.json`)).text(), /49309988/);

  revision = (await edit(harness, 'b.json')).revision;
  const sip = await save(harness, 'b.json', revision, draftOf({ transferTarget: 'sip:desk@pbx.example' }));
  assert.equal(sip.status, 200);
  assert.equal((profileJson(harness, 'b.json').transfer as { target: string }).target, 'sip:desk@pbx.example');

  revision = (await edit(harness, 'b.json')).revision;
  for (const transferTarget of ['http://evil.example', 'tel:abc', 'sip:a b', 'x'.repeat(300), 'sip:', 42]) {
    assert.equal(
      (await save(harness, 'b.json', revision, draftOf({ transferTarget }))).status,
      400,
      String(transferTarget),
    );
  }
});

test('profile save: a stale revision is a 409 and changes nothing', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const { revision } = await edit(harness, 'b.json');
  writeFileSync(join(harness.profilesDir, 'b.json'), EDITABLE.replace('Test', 'Changed elsewhere'));
  const changed = readFileSync(join(harness.profilesDir, 'b.json'), 'utf8');
  const response = await save(harness, 'b.json', revision, draftOf({ greeting: 'Mine.' }));
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /\S+/);
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), changed);
  assert.deepEqual(await versions(harness, 'b.json'), []);
  assert.equal((await save(harness, 'b.json', undefined, draftOf())).status, 400);
});

test('profile save: what the loader would refuse is a 400 with the parser message, nothing is written', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const before = readFileSync(join(harness.profilesDir, 'b.json'), 'utf8');
  const { revision } = await edit(harness, 'b.json');
  const empty = await save(harness, 'b.json', revision, draftOf({ greeting: '   ' }));
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as { error: string }).error, /"greeting" must be a non-empty string/);
  const bad = [
    draftOf({ assistantName: '' }),
    draftOf({ facts: [{ topic: 'x', answer: '' }] }),
    draftOf({ facts: 'no' }),
    draftOf({ facts: [1] }),
    draftOf({ greeting: 5 }),
    draftOf({ transfer: 'yes' }),
    draftOf({ instructions: 'x'.repeat(20_001) }),
    'nope',
    null,
  ];
  for (const draft of bad) {
    assert.equal((await save(harness, 'b.json', revision, draft)).status, 400, JSON.stringify(draft)?.slice(0, 40));
  }
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), before);
  assert.deepEqual(await versions(harness, 'b.json'), []);

  // No target anywhere: a transfer cannot be switched on by an announcement alone.
  const plain = await start({ profiles: { 'c.json': venue('c') } });
  const rev = (await edit(plain, 'c.json')).revision;
  assert.equal((await save(plain, 'c.json', rev, draftOf({ fallback: null }))).status, 400);
  assert.equal((await save(plain, 'c.json', rev, draftOf({ fallback: null, transfer: null }))).status, 200);
});

test('profile save: removing the transfer drops the block, and the file is read again by the loader', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const { revision } = await edit(harness, 'b.json');
  assert.equal((await save(harness, 'b.json', revision, draftOf({ transfer: null }))).status, 200);
  assert.equal('transfer' in profileJson(harness, 'b.json'), false);
  assert.equal((await edit(harness, 'b.json')).draft?.transfer, null);
});

test('profile files and versions: names cannot leave the profiles directory', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  writeFileSync(join(harness.profilesDir, '..', 'outside.json'), EDITABLE);
  const { revision } = await edit(harness, 'b.json');
  const files = ['..%2Foutside.json', '%2e%2e%2foutside.json', 'sub%2Fb.json', 'b.txt', '..', '.history', '%00.json'];
  for (const file of files) {
    assert.ok([400, 404].includes((await save(harness, file, revision, draftOf())).status), file);
    assert.ok([400, 404].includes((await fetch(`${harness.url}/api/profiles/${file}/history`)).status), file);
    assert.ok(
      [400, 404].includes(
        (
          await call(harness, 'POST', `/api/profiles/${file}/restore`, {
            version: 'x',
          })
        ).status,
      ),
      file,
    );
  }
  assert.equal(readFileSync(join(harness.profilesDir, '..', 'outside.json'), 'utf8'), EDITABLE);
  assert.equal((await save(harness, 'missing.json', revision, draftOf())).status, 404);

  await save(harness, 'b.json', revision, draftOf({ greeting: 'Changed.' }));
  const [entry] = await versions(harness, 'b.json');
  const versionsToTry = [
    '../b.json',
    '..%2Foutside',
    `${entry!.version}/../../outside`,
    'b.json.' + entry!.version,
    '2026-10-20',
    '',
    7,
    null,
  ];
  for (const version of versionsToTry) {
    const response = await call(harness, 'POST', '/api/profiles/b.json/restore', { version });
    assert.equal(response.status, 400, String(version));
  }
  assert.equal(
    (
      await call(harness, 'POST', '/api/profiles/b.json/restore', {
        version: '2020-01-01T00-00-00.000Z',
      })
    ).status,
    404,
  );
  // Another profile's history is not reachable by this file's name.
  writeFileSync(join(harness.profilesDir, 'b.json.x'), 'noise');
  assert.equal((await versions(harness, 'b.json')).length, 1);
});

test('profile history: the newest 20 versions are kept', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  for (let index = 0; index < 23; index += 1) {
    const { revision } = await edit(harness, 'b.json');
    const response = await save(harness, 'b.json', revision, draftOf({ greeting: `Hallo ${index}, KI.` }));
    assert.equal(response.status, 200);
  }
  const list = await versions(harness, 'b.json');
  assert.equal(list.length, 20);
  // Newest first, and the oldest three (the original and two edits) are gone.
  assert.deepEqual(
    [...list]
      .map((entry) => entry.version)
      .sort()
      .reverse(),
    list.map((entry) => entry.version),
  );
  const oldest = readFileSync(join(harness.profilesDir, '.history', `b.json.${list.at(-1)!.version}.json`), 'utf8');
  assert.match(oldest, /Hallo 2, KI\./);
  assert.equal(readdirSync(join(harness.profilesDir, '.history')).length, 20);
});

test('profile restore: brings a version back and versions what it replaces; .history is not a profile', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const original = readFileSync(join(harness.profilesDir, 'b.json'), 'utf8');
  const { revision } = await edit(harness, 'b.json');
  await save(harness, 'b.json', revision, draftOf({ greeting: 'Second, KI.' }));
  const edited = readFileSync(join(harness.profilesDir, 'b.json'), 'utf8');
  const [entry] = await versions(harness, 'b.json');

  const response = await call(harness, 'POST', '/api/profiles/b.json/restore', {
    version: entry!.version,
  });
  assert.equal(response.status, 200);
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), original);
  assert.equal(((await response.json()) as { revision: string }).revision, (await edit(harness, 'b.json')).revision);
  const after = await versions(harness, 'b.json');
  assert.equal(after.length, 2);
  const newest = readFileSync(join(harness.profilesDir, '.history', `b.json.${after[0]!.version}.json`), 'utf8');
  assert.equal(newest, edited);

  const listed = (await (await fetch(`${harness.url}/api/profiles`)).json()) as { profiles: Array<{ file: string }> };
  assert.deepEqual(
    listed.profiles.map((profile) => profile.file),
    ['b.json'],
  );

  // A version that is no longer a profile is refused, not written over a good file.
  writeFileSync(join(harness.profilesDir, '.history', `b.json.${after[0]!.version}.json`), '{}');
  assert.equal(
    (
      await call(harness, 'POST', '/api/profiles/b.json/restore', {
        version: after[0]!.version,
      })
    ).status,
    400,
  );
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), original);
});

test('duplicate: a copy of a profile or of the read-only start profile, never over an existing name', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const fromFile = await call(harness, 'POST', '/api/profiles', {
    from: 'b.json',
    file: 'copy.json',
  });
  assert.equal(fromFile.status, 201);
  assert.deepEqual(profileJson(harness, 'copy.json'), profileJson(harness, 'b.json'));

  const fromStart = await call(harness, 'POST', '/api/profiles', {
    from: null,
    file: 'mine.json',
  });
  assert.equal(fromStart.status, 201);
  const mine = profileJson(harness, 'mine.json');
  assert.equal(mine.id, 'start');
  // The clip was relative to the start profile's file; the copy points at it absolutely.
  assert.match((mine.voice as { refAudio: string }).refAudio, /clip\.wav$/);
  assert.equal(isAbsolute((mine.voice as { refAudio: string }).refAudio), true);
  assert.equal((await edit(harness, 'mine.json')).editable, true);

  const before = readFileSync(join(harness.profilesDir, 'b.json'), 'utf8');
  assert.equal(
    (
      await call(harness, 'POST', '/api/profiles', {
        from: null,
        file: 'b.json',
      })
    ).status,
    409,
  );
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), before);

  for (const body of [
    { from: null, file: '../x.json' },
    { from: null, file: 'sub/x.json' },
    { from: null, file: 'x.txt' },
    { from: null, file: '.history' },
    { from: null },
    { from: 5, file: 'y.json' },
    { from: '../b.json', file: 'y.json' },
    { from: 'missing.json', file: 'y.json' },
  ]) {
    assert.ok([400, 404].includes((await call(harness, 'POST', '/api/profiles', body)).status), JSON.stringify(body));
  }
  assert.equal(existsSync(join(harness.profilesDir, '..', 'x.json')), false);
  // The start profile itself cannot be saved over: it is not in the profiles directory.
  assert.equal((await save(harness, 'start-profile.json', 'abc', draftOf())).status, 404);
});

test('knowledge preview: the prompt of an edited draft, nothing written', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const before = readFileSync(join(harness.profilesDir, 'b.json'), 'utf8');
  const response = await call(harness, 'POST', '/api/knowledge/preview', {
    file: 'b.json',
    draft: draftOf({ facts: [{ topic: 'Dogs', answer: 'On the terrace.' }] }),
  });
  assert.equal(response.status, 200);
  const { systemPrompt } = (await response.json()) as { systemPrompt: string };
  assert.match(systemPrompt, /- Dogs: On the terrace\./);
  assert.doesNotMatch(systemPrompt, /Nine to five/);
  assert.doesNotMatch(systemPrompt, /4930123456/);
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), before);
  assert.deepEqual(await versions(harness, 'b.json'), []);
  assert.equal(
    (
      await call(harness, 'POST', '/api/knowledge/preview', {
        file: 'b.json',
        draft: draftOf({ greeting: '' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(harness, 'POST', '/api/knowledge/preview', {
        file: '../b.json',
        draft: draftOf(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(harness, 'POST', '/api/knowledge/preview', {
        draft: draftOf(),
      })
    ).status,
    400,
  );
});

test('every profile write needs the page as its origin', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const before = readFileSync(join(harness.profilesDir, 'b.json'), 'utf8');
  const { revision } = await edit(harness, 'b.json');
  const writes: Array<[string, string, unknown]> = [
    ['PUT', '/api/profiles/b.json', { revision, draft: draftOf({ greeting: 'Hijacked, KI.' }) }],
    ['POST', '/api/profiles', { from: null, file: 'z.json' }],
    ['POST', '/api/profiles/b.json/restore', { version: '2020-01-01T00-00-00.000Z' }],
    ['POST', '/api/knowledge/preview', { file: 'b.json', draft: draftOf() }],
  ];
  for (const [method, path, payload] of writes) {
    for (const origin of [undefined, 'http://evil.example']) {
      const response = await fetch(`${harness.url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(origin && { origin }),
        },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 403, `${method} ${path} ${origin}`);
    }
  }
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), before);
  assert.equal(existsSync(join(harness.profilesDir, 'z.json')), false);
  assert.deepEqual(await versions(harness, 'b.json'), []);
});

test('a broken profile file never puts its content into a response', async () => {
  const broken = '{"transfer": {"target": "tel:+4930123456"} oops';
  const harness = await start({
    profiles: { 'b.json': EDITABLE, 'bad.json': broken },
  });
  mkdirSync(join(harness.profilesDir, '.history'), { recursive: true });
  const stamp = '2026-01-01T00-00-00.000Z';
  writeFileSync(join(harness.profilesDir, '.history', `b.json.${stamp}.json`), broken);
  const { revision } = await edit(harness, 'b.json');
  const bodies = [
    await (await fetch(`${harness.url}/api/knowledge?file=bad.json`)).text(),
    await (await fetch(`${harness.url}/api/profiles`)).text(),
    await (await save(harness, 'bad.json', 'x', draftOf())).text(),
    await (
      await call(harness, 'POST', '/api/profiles/b.json/restore', {
        version: stamp,
      })
    ).text(),
    await (
      await call(harness, 'POST', '/api/profiles', {
        from: 'bad.json',
        file: 'n.json',
      })
    ).text(),
    await (
      await call(harness, 'POST', '/api/knowledge/preview', {
        file: 'bad.json',
        draft: draftOf(),
      })
    ).text(),
    await (
      await call(harness, 'POST', '/api/profiles/bad.json/restore', {
        version: stamp,
      })
    ).text(),
  ];
  for (const text of bodies) assert.doesNotMatch(text, /4930123456|30123456|oops/);
  assert.match(bodies[0]!, /not valid JSON/);
  assert.equal(readFileSync(join(harness.profilesDir, 'b.json'), 'utf8'), EDITABLE);
  assert.ok(revision);
});

test('profile save: keys of a fact the page does not edit survive a reorder', async () => {
  const withKeys = venue('beta', {
    facts: [
      { topic: 'A', answer: 'a', note: 'keep-a' },
      { topic: 'B', answer: 'b', note: 'keep-b' },
    ],
  });
  const harness = await start({ profiles: { 'b.json': withKeys } });
  const view = await (await fetch(`${harness.url}/api/knowledge?file=b.json`)).json();
  const { revision, draft } = view as {
    revision: string;
    draft: { facts: Array<Record<string, unknown>> };
  };
  const [first, second] = draft.facts;
  const response = await save(harness, 'b.json', revision, {
    ...draftOf(),
    transfer: null,
    fallback: null,
    facts: [second, { ...first, answer: 'changed' }, { topic: 'New', answer: 'n' }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(profileJson(harness, 'b.json').facts, [
    { topic: 'B', answer: 'b', note: 'keep-b' },
    { topic: 'A', answer: 'changed', note: 'keep-a' },
    { topic: 'New', answer: 'n' },
  ]);
});

test('profile save: the character is picked, kept when absent, taken off with null, unknown ids refused', async () => {
  const harness = await start({
    profiles: { 'b.json': venue('beta', { futureKey: 'keep' }) },
    settings: stored([CHARACTER, PAUL], { defaultCharacter: 'jane' }),
  });
  const plain = (extra: Record<string, unknown>) => draftOf({ transfer: null, fallback: null, ...extra });
  const revisionNow = async () => (await edit(harness, 'b.json')).revision;

  const picked = await save(harness, 'b.json', await revisionNow(), plain({ character: 'paul' }));
  assert.equal(picked.status, 200);
  assert.equal(profileJson(harness, 'b.json').character, 'paul');
  assert.equal(profileJson(harness, 'b.json').futureKey, 'keep');

  // A save that does not mention it leaves the pick alone.
  await save(harness, 'b.json', await revisionNow(), plain({ greeting: 'Neu, ich bin eine KI.' }));
  assert.equal(profileJson(harness, 'b.json').character, 'paul');
  assert.equal((await edit(harness, 'b.json')).draft?.character, 'paul');

  const unknown = await save(harness, 'b.json', await revisionNow(), plain({ character: 'gone' }));
  assert.equal(unknown.status, 400);
  assert.equal(profileJson(harness, 'b.json').character, 'paul');

  const off = await save(harness, 'b.json', await revisionNow(), plain({ character: null }));
  assert.equal(off.status, 200);
  assert.equal('character' in profileJson(harness, 'b.json'), false);
  assert.equal(profileJson(harness, 'b.json').futureKey, 'keep');
});

test('profile restore: a stale revision is a 409', async () => {
  const harness = await start({ profiles: { 'b.json': EDITABLE } });
  const { revision } = await edit(harness, 'b.json');
  await save(harness, 'b.json', revision, draftOf({ greeting: 'Second, KI.' }));
  const [entry] = await versions(harness, 'b.json');
  const stale = await call(harness, 'POST', '/api/profiles/b.json/restore', {
    version: entry!.version,
    revision,
  });
  assert.equal(stale.status, 409);
  const fresh = (await edit(harness, 'b.json')).revision;
  const ok = await call(harness, 'POST', '/api/profiles/b.json/restore', {
    version: entry!.version,
    revision: fresh,
  });
  assert.equal(ok.status, 200);
});

test('GET /api/sample refuses a redirect and enforces the size cap while streaming', async () => {
  const redirect = (async () =>
    new Response(null, {
      status: 302,
      headers: {
        location: 'http://127.0.0.1:1/x',
        'content-type': 'audio/mpeg',
      },
    })) as unknown as typeof fetch;
  const seen: unknown[] = [];
  const spy = (async (address: string, init?: RequestInit) => {
    seen.push(init?.redirect);
    return redirect(address, init as never);
  }) as unknown as typeof fetch;
  const one = await start({ catalog: SAMPLE_CATALOG, fetch: spy });
  assert.equal((await fetch(`${one.url}/api/sample?provider=kugel&voice=a`)).status, 502);
  assert.deepEqual(seen, ['manual']);

  const lying = (async () =>
    new Response(new Uint8Array(5 * 1024 * 1024 + 10), {
      headers: { 'content-type': 'audio/mpeg', 'content-length': '10' },
    })) as unknown as typeof fetch;
  const two = await start({ catalog: SAMPLE_CATALOG, fetch: lying });
  assert.equal((await fetch(`${two.url}/api/sample?provider=kugel&voice=a`)).status, 502);
});
