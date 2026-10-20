import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSnapshot } from '../core/knowledge-snapshot.js';
import { FetchRefused, type SafeFetcher } from './fetch-safe.js';
import { createKnowledgeApi } from './knowledge-api.js';
import { openDb } from './knowledge-db.js';
import { createKnowledgeRepo } from './knowledge-repo.js';
import { createKnowledgeService, KEEP_REVISIONS, KnowledgeError, MAX_SOURCES_PER_VENUE } from './knowledge-service.js';

const html = (body: string, title = 'Page') =>
  `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

function rig(pages: Record<string, string | Error>) {
  let hook: (() => Promise<void>) | undefined;
  const failing = { publish: false };
  const logged: string[] = [];
  const bodies = { ...pages };
  const fetched: string[] = [];
  const fetcher = {
    async fetch(address: string) {
      fetched.push(address);
      await hook?.();
      const body = bodies[address];
      if (body === undefined) throw new FetchRefused('status', 'the page answered with an error');
      if (body instanceof Error) throw body;
      const isXml = body.startsWith('<?xml') || body.startsWith('<urlset') || body.startsWith('<sitemapindex');
      return { url: address, contentType: isXml ? 'application/xml' : 'text/html', text: body };
    },
  } as SafeFetcher;
  const published: Array<{ tenant: string; venue: string; text: string }> = [];
  let clock = Date.parse('2026-03-01T08:00:00Z');
  const repo = createKnowledgeRepo(openDb(':memory:'));
  const service = createKnowledgeService({
    repo,
    fetcher,
    render: renderSnapshot,
    publish: (tenant, venue, text) => {
      if (failing.publish) throw new Error('disk full');
      published.push({ tenant, venue, text });
    },
    log: (message) => logged.push(message),
    now: () => new Date(clock),
  });
  return {
    service,
    repo,
    onFetch: (fn: () => Promise<void>) => (hook = fn),
    published,
    failing,
    logged,
    fetched,
    bodies,
    tick: (hours: number) => (clock += hours * 3_600_000),
  };
}

const URL1 = 'https://venue.example/menu';
const T = 'tenant-a';

async function webSource(r: ReturnType<typeof rig>, extra: Record<string, unknown> = {}) {
  return r.service.addSource(T, { venue: 'v.json', kind: 'web', title: 'Menu page', url: URL1, ...extra });
}

test('a manual source is live at once and published', async () => {
  const r = rig({});
  const source = await r.service.addSource(T, {
    venue: 'v.json',
    kind: 'manual',
    title: 'Notes',
    markdown: 'Closed on Mondays',
  });
  assert.equal(source.kind, 'manual');
  assert.equal(r.published.length, 1);
  assert.match(r.published[0]!.text, /Closed on Mondays/);
  assert.match(r.published[0]!.text, /edited 2026-03-01/);
  await assert.rejects(r.service.refresh(T, source.id), (e) => e instanceof KnowledgeError && e.status === 400);
});

test('addSource refuses bad kinds, addresses and selectors', async () => {
  const r = rig({});
  const bad = (status: number) => (e: unknown) => e instanceof KnowledgeError && e.status === status;
  await assert.rejects(r.service.addSource(T, { venue: 'v', kind: 'pdf' as never, title: 'x' }), bad(400));
  await assert.rejects(
    r.service.addSource(T, { venue: 'v', kind: 'web', title: 'x', url: 'ftp://x.example/' }),
    bad(400),
  );
  await assert.rejects(r.service.addSource(T, { venue: 'v', kind: 'web', title: 'x' }), bad(400));
  await assert.rejects(
    r.service.addSource(T, { venue: 'v', kind: 'web', title: 'x', url: URL1, excludeSelectors: ['p['] }),
    bad(400),
  );
  await assert.rejects(
    r.service.addSource(T, { venue: 'v', kind: 'web', title: 'x', url: URL1, refreshHours: 0 }),
    bad(400),
  );
});

test('sitemap patterns are capped in number and length', async () => {
  const r = rig({});
  const bad = (e: unknown) => e instanceof KnowledgeError && e.status === 400;
  const base = { venue: 'v', kind: 'sitemap', title: 'x', url: 'https://venue.example/sitemap.xml' } as const;
  await assert.rejects(r.service.addSource(T, { ...base, includeGlobs: ['*a'.repeat(200)] }), bad);
  await assert.rejects(r.service.addSource(T, { ...base, includeGlobs: Array(21).fill('/a') }), bad);
  const made = await r.service.addSource(T, base);
  assert.throws(() => r.service.updateSource(T, made.id, { includeGlobs: ['*a'.repeat(200)] }), bad);
});

test('a fetched page is pending, not live, until approved', async () => {
  const r = rig({ [URL1]: html('<p>Soup 5</p>') });
  const source = await webSource(r);
  assert.equal(source.refreshHours, 24);
  const summary = await r.service.refresh(T, source.id);
  assert.deepEqual([summary.pending, summary.approved, summary.failed], [1, 0, 0]);
  assert.equal(r.published.length, 0);
  const overview = r.service.overview(T, 'v.json');
  assert.equal(overview[0]!.pendingCount, 1);
  const detail = r.service.detail(T, source.id);
  const pending = detail.sections[0]!.pending!;
  r.service.approve(T, pending.id);
  assert.equal(r.published.length, 1);
  assert.match(r.published[0]!.text, /Soup 5/);
  assert.match(r.published[0]!.text, /Source: Menu page — https:\/\/venue\.example\/menu — fetched 2026-03-01/);
  assert.equal(r.service.overview(T, 'v.json')[0]!.pendingCount, 0);
  await assert.rejects(
    () => Promise.resolve().then(() => r.service.approve(T, pending.id)),
    (e) => e instanceof KnowledgeError && e.status === 409,
  );
});

test('an unchanged fetch makes no revision; a changed one is a diff against the live text', async () => {
  const r = rig({ [URL1]: html('<p>Soup 5</p>') });
  const source = await webSource(r);
  await r.service.refresh(T, source.id);
  r.service.approve(T, r.service.detail(T, source.id).sections[0]!.pending!.id);
  const again = await r.service.refresh(T, source.id);
  assert.equal(again.unchanged, 1);
  r.bodies[URL1] = html('<p>Soup 6</p>');
  const changed = await r.service.refresh(T, source.id);
  assert.equal(changed.pending, 1);
  const section = r.service.detail(T, source.id).sections[0]!;
  assert.ok(section.diff!.some((line) => line.kind === 'add' && line.text === 'Soup 6'));
  assert.ok(section.diff!.some((line) => line.kind === 'del' && line.text === 'Soup 5'));
  assert.equal(section.overwritesEdit, false);
  assert.match(r.service.published(T, 'v.json'), /Soup 5/);
  r.service.reject(T, section.pending!.id);
  assert.equal(r.service.detail(T, source.id).sections[0]!.pending, null);
  assert.match(r.service.published(T, 'v.json'), /Soup 5/);
  assert.equal(r.service.history(T, section.id).length, 2);
});

test('a newer change supersedes an open one', async () => {
  const r = rig({ [URL1]: html('<p>A</p>') });
  const source = await webSource(r);
  await r.service.refresh(T, source.id);
  r.bodies[URL1] = html('<p>B</p>');
  await r.service.refresh(T, source.id);
  const section = r.service.detail(T, source.id).sections[0]!;
  assert.equal(r.service.overview(T, 'v.json')[0]!.pendingCount, 1);
  assert.match(section.pending!.markdown, /B/);
});

test('a hand edit goes live as "edited"; a later fetch warns that it would overwrite it', async () => {
  const r = rig({ [URL1]: html('<p>Soup 5</p>') });
  const source = await webSource(r);
  await r.service.refresh(T, source.id);
  const first = r.service.detail(T, source.id).sections[0]!;
  r.service.approve(T, first.pending!.id);
  const live = r.service.detail(T, source.id).sections[0]!;
  r.service.edit(T, live.id, { markdown: 'Soup 4 (corrected)', baseRevisionId: live.liveRevisionId, author: 'admin' });
  assert.match(r.service.published(T, 'v.json'), /Soup 4 \(corrected\)/);
  assert.match(r.service.published(T, 'v.json'), /edited 2026-03-01/);
  r.bodies[URL1] = html('<p>Soup 7</p>');
  await r.service.refresh(T, source.id);
  const next = r.service.detail(T, source.id).sections[0]!;
  assert.equal(next.overwritesEdit, true);
  assert.match(r.service.published(T, 'v.json'), /Soup 4/);
});

test('edit: a stale base revision is a 409', async () => {
  const r = rig({});
  const source = await r.service.addSource(T, { venue: 'v', kind: 'manual', title: 'N', markdown: 'one' });
  const section = r.service.detail(T, source.id).sections[0]!;
  r.service.edit(T, section.id, { markdown: 'two', baseRevisionId: section.liveRevisionId });
  await assert.rejects(
    () =>
      Promise.resolve().then(() =>
        r.service.edit(T, section.id, { markdown: 'three', baseRevisionId: section.liveRevisionId }),
      ),
    (e) => e instanceof KnowledgeError && e.status === 409,
  );
  assert.match(r.service.published(T, 'v'), /two/);
});

test('auto-approve publishes a changed page, except over a hand edit', async () => {
  const r = rig({ [URL1]: html('<p>A</p>') });
  const source = await webSource(r, { autoApprove: true });
  const first = await r.service.refresh(T, source.id);
  assert.equal(first.approved, 1);
  assert.match(r.service.published(T, 'v.json'), /\bA\b/);
  const section = r.service.detail(T, source.id).sections[0]!;
  r.service.edit(T, section.id, { markdown: 'mine', baseRevisionId: section.liveRevisionId });
  r.bodies[URL1] = html('<p>B</p>');
  const second = await r.service.refresh(T, source.id);
  assert.deepEqual([second.approved, second.pending], [0, 1]);
  assert.match(r.service.published(T, 'v.json'), /mine/);
});

test('a failing fetch is recorded on the source and keeps the live text', async () => {
  const r = rig({ [URL1]: html('<p>A</p>') });
  const source = await webSource(r);
  await r.service.refresh(T, source.id);
  r.service.approve(T, r.service.detail(T, source.id).sections[0]!.pending!.id);
  r.bodies[URL1] = new FetchRefused('robots', 'the site asks robots not to fetch this page');
  const summary = await r.service.refresh(T, source.id);
  assert.equal(summary.failed, 1);
  const after = r.service.overview(T, 'v.json')[0]!;
  assert.match(after.lastError ?? '', /robots/);
  assert.match(r.service.published(T, 'v.json'), /\bA\b/);
});

const SITEMAP = 'https://venue.example/sitemap.xml';
const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`;

test('a sitemap source takes the matching same-host pages, and marks vanished ones as gone', async () => {
  const r = rig({
    [SITEMAP]: urlset(
      'https://venue.example/menu/a',
      'https://venue.example/about',
      'https://elsewhere.example/menu/x',
      'https://venue.example/menu/b',
    ),
    'https://venue.example/menu/a': html('<p>A</p>', 'Dish A'),
    'https://venue.example/menu/b': html('<p>B</p>', 'Dish B'),
    'https://venue.example/about': html('<p>nope</p>'),
  });
  const source = await r.service.addSource(T, {
    venue: 'v.json',
    kind: 'sitemap',
    title: 'Site',
    url: SITEMAP,
    includeGlobs: ['/menu/**'],
  });
  const summary = await r.service.refresh(T, source.id);
  assert.equal(summary.pending, 2);
  assert.ok(!r.fetched.includes('https://venue.example/about'));
  assert.ok(!r.fetched.includes('https://elsewhere.example/menu/x'));
  const detail = r.service.detail(T, source.id);
  assert.deepEqual(detail.sections.map((section) => section.title).sort(), ['Dish A', 'Dish B']);
  for (const section of detail.sections) r.service.approve(T, section.pending!.id);
  r.bodies[SITEMAP] = urlset('https://venue.example/menu/a');
  const next = await r.service.refresh(T, source.id);
  assert.equal(next.gone, 1);
  const gone = r.service.detail(T, source.id).sections.filter((section) => section.gone);
  assert.equal(gone.length, 1);
  assert.equal(gone[0]!.title, 'Dish B');
  assert.match(r.service.published(T, 'v.json'), /Dish B/);
});

test('due: only sources whose interval has passed since the last check', async () => {
  const r = rig({ [URL1]: html('<p>A</p>') });
  const source = await webSource(r);
  assert.equal(r.service.due(T).length, 1);
  await r.service.refresh(T, source.id);
  assert.equal(r.service.due(T).length, 0);
  r.tick(23);
  assert.equal(r.service.due(T).length, 0);
  r.tick(2);
  assert.equal(r.service.due(T).length, 1);
  r.service.updateSource(T, source.id, { refreshHours: null });
  assert.equal(r.service.due(T).length, 0);
});

test("tenant isolation through the service: B cannot see, approve, edit or fetch A's source", async () => {
  const r = rig({ [URL1]: html('<p>A</p>') });
  const source = await webSource(r);
  await r.service.refresh(T, source.id);
  const section = r.service.detail(T, source.id).sections[0]!;
  const notFound = (e: unknown) => e instanceof KnowledgeError && e.status === 404;
  assert.deepEqual(r.service.overview('tenant-b', 'v.json'), []);
  assert.throws(() => r.service.detail('tenant-b', source.id), notFound);
  assert.throws(() => r.service.approve('tenant-b', section.pending!.id), notFound);
  assert.throws(() => r.service.edit('tenant-b', section.id, { markdown: 'x', baseRevisionId: null }), notFound);
  assert.throws(() => r.service.history('tenant-b', section.id), notFound);
  assert.throws(() => r.service.removeSource('tenant-b', source.id), notFound);
  await assert.rejects(r.service.refresh('tenant-b', source.id), notFound);
  assert.equal(r.service.overview(T, 'v.json').length, 1);
});

test('removing a source republishes without it', async () => {
  const r = rig({});
  const source = await r.service.addSource(T, { venue: 'v', kind: 'manual', title: 'N', markdown: 'text' });
  r.service.removeSource(T, source.id);
  assert.equal(r.published.at(-1)!.text, '');
});

test('a publish that fails after the commit is not an error: it is marked stale and retried', async () => {
  const r = rig({});
  r.failing.publish = true;
  const source = await r.service.addSource(T, {
    venue: 'v.json',
    kind: 'manual',
    title: 'Notes',
    markdown: 'Closed Mondays',
  });
  assert.equal(r.service.isStale(T, 'v.json'), true);
  assert.equal(r.service.hasStale(), true);
  assert.match(r.logged[0]!, /disk full/);
  assert.equal(r.service.overview(T, 'v.json').length, 1, 'the change itself is saved');
  assert.equal(r.service.retryStale(), 1, 'still failing');
  r.failing.publish = false;
  assert.equal(r.service.retryStale(), 0);
  assert.equal(r.service.isStale(T, 'v.json'), false);
  assert.match(r.published.at(-1)!.text, /Closed Mondays/);
  assert.ok(source.id);
});

test('the API still answers 200 and says the publish is pending', async () => {
  const r = rig({});
  const api = createKnowledgeApi({ service: r.service, tenantId: T, venueExists: () => true });
  r.failing.publish = true;
  const made = await api({
    method: 'POST',
    path: '/api/knowledge/sources',
    query: new URLSearchParams(),
    body: async () => ({ venue: 'v.json', kind: 'manual', title: 'Notes', markdown: 'Hi' }),
  });
  assert.equal(made?.status, 201);
  assert.equal((made!.payload as { publishFailed?: boolean }).publishFailed, true);
  const published = await api({
    method: 'GET',
    path: '/api/knowledge/published',
    query: new URLSearchParams('venue=v.json'),
    body: async () => ({}),
  });
  assert.equal((published!.payload as { stale: boolean }).stale, true);
});

test('a venue cannot hold more than the capped number of sources', async () => {
  const r = rig({});
  for (let i = 0; i < MAX_SOURCES_PER_VENUE; i++) {
    await r.service.addSource(T, { venue: 'v.json', kind: 'manual', title: `n${i}`, markdown: 'x' });
  }
  await assert.rejects(
    r.service.addSource(T, { venue: 'v.json', kind: 'manual', title: 'one more', markdown: 'x' }),
    (e: unknown) => e instanceof KnowledgeError && e.status === 400,
  );
  await r.service.addSource(T, { venue: 'other.json', kind: 'manual', title: 'fine', markdown: 'x' });
});

test('revisions are pruned, but never the live, the pending or the newest fetched one', async () => {
  const r = rig({ [URL1]: html('<p>0</p>') });
  const source = await webSource(r);
  for (let i = 0; i < KEEP_REVISIONS + 15; i++) {
    r.bodies[URL1] = html(`<p>v${i}</p>`);
    await r.service.refresh(T, source.id);
    const { sections } = r.service.detail(T, source.id);
    if (i % 2 === 0 && sections[0]!.pending) r.service.approve(T, sections[0]!.pending.id);
  }
  const section = r.service.detail(T, source.id).sections[0]!;
  const history = r.service.history(T, section.id);
  assert.ok(history.length <= KEEP_REVISIONS + 2, `kept ${history.length}`);
  assert.ok(history.some((rev) => rev.id === section.liveRevisionId));
  assert.ok(section.pending === null || history.some((rev) => rev.id === section.pending!.id));
  assert.match(history[0]!.markdown, /v34/);
});

test('refreshes share a small number of fetch slots', async () => {
  const pages = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`https://venue.example/p${n}`, html(`<p>${n}</p>`)]));
  const r = rig(pages);
  let running = 0;
  let peak = 0;
  const inner = r.service;
  const sources = [];
  for (const address of Object.keys(pages)) {
    sources.push(await r.service.addSource(T, { venue: 'v.json', kind: 'web', title: address, url: address }));
  }
  r.onFetch(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
  });
  await Promise.all(sources.map((source) => inner.refresh(T, source.id)));
  assert.ok(peak >= 1 && peak <= 2, `peak ${peak}`);
});
