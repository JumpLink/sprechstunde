import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { SafeFetcher } from './fetch-safe.js';
import { createKnowledgeRuntime, runDue } from './knowledge-runtime.js';
import type { Ocr } from './ocr.js';
import { createAdminServer } from './server.js';

const servers: Array<{ close: () => void }> = [];
after(() => {
  for (const server of servers) server.close();
});

const PAGE = 'https://venue.example/menu';

async function start(ocr?: Ocr) {
  const dir = mkdtempSync(join(tmpdir(), 'sprechstunde-knowledge-'));
  const profiles = join(dir, 'profiles');
  mkdirSync(profiles);
  writeFileSync(join(profiles, 'venue.json'), '{}');
  const env = { SPRECHSTUNDE_PROFILES_DIR: profiles, SPRECHSTUNDE_DB: ':memory:' };
  let body = '<html><head><title>Menu</title></head><body><main><p>Soup 5</p></main></body></html>';
  const fetcher = {
    async fetch(address: string) {
      return { url: address, contentType: 'text/html', text: body };
    },
  } as SafeFetcher;
  const runtime = createKnowledgeRuntime(env, fetcher, ocr);
  const server = createAdminServer({
    settingsPath: join(dir, 'voice.json'),
    metricsDir: join(dir, 'metrics'),
    sampleText: 'x',
    webDir: null,
    env,
    knowledge: runtime.api,
    synthesize: async () => ({ pcm: new Uint8Array(2), sampleRate: 24000, ttfaMs: 1 }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, payload?: unknown, origin: string | null = url) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        ...(origin ? { origin } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const upload = (path: string, bytes: Uint8Array | string, name = 'card.pdf') =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
      body: bytes,
    });
  return { call, upload, profiles, runtime, setBody: (next: string) => (body = next) };
}

test('knowledge API: add, fetch, review, edit, publish - and the file the agent reads', async () => {
  const r = await start();
  const added = await r.call('POST', '/api/knowledge/sources', {
    venue: 'venue.json',
    kind: 'web',
    title: 'Menu',
    url: PAGE,
  });
  assert.equal(added.status, 201);
  const source = (await added.json()) as { id: string };

  const refreshed = await r.call('POST', `/api/knowledge/sources/${source.id}/refresh`, {});
  assert.equal(((await refreshed.json()) as { pending: number }).pending, 1);
  assert.equal(existsSync(join(r.profiles, 'venue.knowledge.md')), false);

  const detail = (await (await r.call('GET', `/api/knowledge/sources/${source.id}`)).json()) as {
    sections: Array<{ id: string; liveRevisionId: number | null; pending: { id: number }; diff: unknown[] }>;
  };
  const section = detail.sections[0]!;
  assert.ok(section.diff.length > 0);
  const approve = await r.call('POST', `/api/knowledge/revisions/${section.pending.id}/approve`, {});
  assert.equal(approve.status, 200);
  const file = readFileSync(join(r.profiles, 'venue.knowledge.md'), 'utf8');
  assert.match(file, /Soup 5/);
  assert.match(file, /<reference-data>/);
  const again = await r.call('POST', `/api/knowledge/revisions/${section.pending.id}/approve`, {});
  assert.equal(again.status, 409);

  const live = (await (await r.call('GET', `/api/knowledge/sources/${source.id}`)).json()) as {
    sections: Array<{ liveRevisionId: number }>;
  };
  const base = live.sections[0]!.liveRevisionId;
  const edit = await r.call('PUT', `/api/knowledge/sections/${section.id}`, {
    markdown: 'Soup 4',
    baseRevisionId: base,
  });
  assert.equal(edit.status, 200);
  const stale = await r.call('PUT', `/api/knowledge/sections/${section.id}`, {
    markdown: 'Soup 3',
    baseRevisionId: base,
  });
  assert.equal(stale.status, 409);
  assert.match(readFileSync(join(r.profiles, 'venue.knowledge.md'), 'utf8'), /Soup 4/);

  const published = (await (await r.call('GET', '/api/knowledge/published?venue=venue.json')).json()) as {
    text: string;
  };
  assert.match(published.text, /Soup 4/);
  const history = (await (await r.call('GET', `/api/knowledge/sections/${section.id}/history`)).json()) as unknown[];
  assert.equal(history.length, 2);

  assert.equal((await r.call('DELETE', `/api/knowledge/sources/${source.id}`)).status, 200);
  assert.equal(existsSync(join(r.profiles, 'venue.knowledge.md')), false);
});

test('knowledge API: writes need the same origin, bad input is a 400, an unknown venue a 404', async () => {
  const r = await start();
  const body = { venue: 'venue.json', kind: 'manual', title: 'N', markdown: 'x' };
  assert.equal((await r.call('POST', '/api/knowledge/sources', body, null)).status, 403);
  assert.equal((await r.call('POST', '/api/knowledge/sources', body, 'http://evil.example')).status, 403);
  assert.equal((await r.call('POST', '/api/knowledge/sources', { ...body, venue: '../x.json' })).status, 400);
  assert.equal((await r.call('POST', '/api/knowledge/sources', { ...body, venue: 'other.json' })).status, 404);
  assert.equal(
    (await r.call('POST', '/api/knowledge/sources', { ...body, kind: 'web', url: 'file:///etc/passwd' })).status,
    400,
  );
  assert.equal((await r.call('GET', '/api/knowledge/sources/nothere')).status, 404);
  assert.equal((await r.call('GET', '/api/knowledge/sources')).status, 400);
  assert.equal((await r.call('POST', '/api/knowledge/revisions/abc/approve', {})).status, 400);
  assert.equal((await r.call('GET', '/api/knowledge/unknown')).status, 404);
});

test('runDue: refreshes what is due and survives a failure', async () => {
  const r = await start();
  await r.call('POST', '/api/knowledge/sources', { venue: 'venue.json', kind: 'web', title: 'A', url: PAGE });
  await r.call('POST', '/api/knowledge/sources', { venue: 'venue.json', kind: 'web', title: 'B', url: PAGE });
  const logged: string[] = [];
  assert.equal(await runDue(r.runtime.service, 'default', (message) => logged.push(message)), 2);
  assert.equal(await runDue(r.runtime.service, 'default', (message) => logged.push(message)), 0);
  assert.deepEqual(logged, []);
});

test('a second refresh of the same source within the cooldown is a 429 with Retry-After', async () => {
  const r = await start();
  const added = await r.call('POST', '/api/knowledge/sources', {
    venue: 'venue.json',
    kind: 'web',
    title: 'Menu',
    url: PAGE,
  });
  const source = (await added.json()) as { id: string };
  const path = `/api/knowledge/sources/${source.id}/refresh`;
  assert.equal((await r.call('POST', path, {})).status, 200);
  const again = await r.call('POST', path, {});
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) > 0);
});

test('knowledge API: a PDF is uploaded, read, reviewed and handed back with safe headers', async () => {
  const reads: number[] = [];
  const r = await start(async (document) => {
    reads.push(document.bytes.length);
    return ['# Starters\nSoup 4'];
  });
  const made = await r.call('POST', '/api/knowledge/sources', { venue: 'venue.json', kind: 'pdf', title: 'Card' });
  assert.equal(made.status, 201);
  const { id } = (await made.json()) as { id: string };

  const pdf = Buffer.from('%PDF-1.4\nfake');
  assert.equal((await r.upload(`/api/knowledge/sources/${id}/files`, 'plain text, not a PDF')).status, 400);
  const sent = await r.upload(`/api/knowledge/sources/${id}/files`, pdf, 'Mittags karte ä.pdf');
  assert.equal(sent.status, 201);
  assert.equal(((await sent.json()) as { name: string }).name, 'Mittags karte ä.pdf');
  assert.equal((await r.upload(`/api/knowledge/sources/${id}/files`, pdf, 'x.pdf')).status, 201);

  const refreshed = await r.call('POST', `/api/knowledge/sources/${id}/refresh`, {});
  assert.equal(((await refreshed.json()) as { pending: number }).pending, 1);
  assert.deepEqual(reads, [pdf.length]);

  const detail = (await (await r.call('GET', `/api/knowledge/sources/${id}`)).json()) as {
    files: Array<{ position: number; name: string }>;
    sections: Array<{ pending: { markdown: string } }>;
  };
  assert.equal(detail.files.length, 1);
  assert.equal(detail.sections[0]!.pending.markdown, '# Starters\nSoup 4');

  const original = await r.call('GET', `/api/knowledge/sources/${id}/files/1`);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-type'), 'application/pdf');
  assert.match(
    original.headers.get('content-disposition') ?? '',
    /^attachment; filename="x\.pdf"; filename\*=UTF-8''x\.pdf$/,
  );
  assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
  assert.match(original.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), pdf);
  assert.equal((await r.call('GET', `/api/knowledge/sources/${id}/files/9`)).status, 404);
  assert.equal((await r.call('GET', `/api/knowledge/sources/${id}/files/x`)).status, 400);

  const big = await r.upload(`/api/knowledge/sources/${id}/files`, Buffer.alloc(21 * 1024 * 1024));
  assert.equal(big.status, 413);

  const stranger = await fetch(`${new URL(sent.url).origin}/api/knowledge/sources/${id}/files`, {
    method: 'POST',
    body: pdf,
  });
  assert.ok(stranger.status >= 400 && stranger.status < 500, 'a write without the page origin is refused');
});
