import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATIONS, migrate, openDb } from './knowledge-db.js';
import { createKnowledgeRepo, type TenantRepo } from './knowledge-repo.js';

const AT = '2026-01-01T10:00:00.000Z';

function fresh() {
  const repo = createKnowledgeRepo(openDb(':memory:'));
  return { repo, a: repo.forTenant('tenant-a'), b: repo.forTenant('tenant-b') };
}

function seed(t: TenantRepo, venue = 'venue-1') {
  const source = t.createSource({ venue, kind: 'web', title: 'Menu', url: 'https://venue.example/', createdAt: AT });
  const section = t.addSection(source.id, { url: 'https://venue.example/', title: 'Menu', createdAt: AT });
  const revision = t.addRevision({
    sectionId: section.id,
    origin: 'fetched',
    status: 'pending',
    title: 'Menu',
    url: section.url,
    markdown: '# Menu',
    sha256: 'abc',
    fetchedAt: AT,
    createdAt: AT,
  });
  return { source, section, revision };
}

test('migrate: applies every step once and refuses a newer database', () => {
  const db = openDb(':memory:');
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
  migrate(db);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  assert.throws(() => migrate(db), /newer version/);
});

test('repo: a source round-trips with its lists and flags', () => {
  const { a } = fresh();
  const made = a.createSource({
    venue: 'v',
    kind: 'sitemap',
    title: 'Site',
    url: 'https://venue.example/sitemap.xml',
    includeGlobs: ['/menu/**'],
    excludeSelectors: ['.cookie'],
    refreshHours: 24,
    autoApprove: true,
    createdAt: AT,
  });
  assert.deepEqual(a.source(made.id), made);
  assert.deepEqual(made.includeGlobs, ['/menu/**']);
  assert.equal(made.autoApprove, true);
  const patched = a.updateSource(made.id, { refreshHours: null, autoApprove: false });
  assert.equal(patched?.refreshHours, null);
  assert.equal(patched?.autoApprove, false);
  assert.equal(a.updateSource('nope', { title: 'x' }), undefined);
});

test('repo: tenant B cannot read, change or delete tenant A rows', () => {
  const { a, b } = fresh();
  const { source, section, revision } = seed(a);
  assert.equal(b.source(source.id), undefined);
  assert.deepEqual(b.sources('venue-1'), []);
  assert.equal(b.section(section.id), undefined);
  assert.deepEqual(b.sections(source.id), []);
  assert.equal(b.revision(revision.id), undefined);
  assert.deepEqual(b.revisions(section.id), []);
  assert.equal(b.pending(section.id), undefined);
  assert.equal(b.pendingCount(source.id), 0);
  assert.deepEqual(b.live('venue-1'), []);

  assert.equal(b.updateSource(source.id, { title: 'hacked' }), undefined);
  b.decide(revision.id, 'approved', AT);
  b.setLive(section.id, revision.id);
  b.renameSection(section.id, 'hacked');
  b.setGone(section.id, true);
  b.markChecked(source.id, AT, 'boom', true);
  assert.equal(b.deleteSection(section.id), false);
  assert.equal(b.deleteSource(source.id), false);

  assert.equal(a.source(source.id)?.title, 'Menu');
  assert.equal(a.source(source.id)?.lastError, null);
  assert.equal(a.revision(revision.id)?.status, 'pending');
  assert.equal(a.section(section.id)?.liveRevisionId, null);
  assert.equal(a.section(section.id)?.title, 'Menu');
  assert.equal(a.section(section.id)?.gone, false);
});

test("repo: B cannot attach a revision to A's section", () => {
  const { a, b } = fresh();
  const { section } = seed(a);
  assert.throws(() =>
    b.addRevision({
      sectionId: section.id,
      origin: 'edited',
      status: 'approved',
      title: 'x',
      url: null,
      markdown: 'x',
      sha256: 'x',
      fetchedAt: null,
      createdAt: AT,
    }),
  );
  assert.equal(a.revisions(section.id).length, 1);
});

test('repo: the same ids may exist in two tenants without touching each other', () => {
  const { a, b, repo } = fresh();
  seed(a);
  seed(b);
  assert.equal(a.sources('venue-1').length, 1);
  assert.equal(b.sources('venue-1').length, 1);
  assert.deepEqual(repo.venues(), [
    { tenantId: 'tenant-a', venue: 'venue-1' },
    { tenantId: 'tenant-b', venue: 'venue-1' },
  ]);
});

test('repo: pending, supersede, decide, live and the pending count', () => {
  const { a } = fresh();
  const { source, section, revision } = seed(a);
  assert.equal(a.pendingCount(source.id), 1);
  assert.equal(a.pending(section.id)?.id, revision.id);
  a.supersedePending(section.id, AT);
  assert.equal(a.pending(section.id), undefined);
  assert.equal(a.revision(revision.id)?.status, 'rejected');

  const next = a.addRevision({
    sectionId: section.id,
    origin: 'fetched',
    status: 'pending',
    title: 'Menu',
    url: section.url,
    markdown: '# Menu 2',
    sha256: 'def',
    fetchedAt: AT,
    createdAt: AT,
  });
  a.decide(next.id, 'approved', AT);
  a.setLive(section.id, next.id);
  assert.equal(a.latestFetched(section.id)?.id, next.id);
  const live = a.live('venue-1');
  assert.equal(live.length, 1);
  assert.equal(live[0]!.revision.markdown, '# Menu 2');
  assert.equal(live[0]!.source.title, 'Menu');
  assert.deepEqual(a.live('other-venue'), []);
});

test('repo: deleting a source removes its sections and revisions', () => {
  const { a } = fresh();
  const { source, section, revision } = seed(a);
  assert.equal(a.deleteSource(source.id), true);
  assert.equal(a.section(section.id), undefined);
  assert.equal(a.revision(revision.id), undefined);
});

test('repo: transaction rolls back on a throw', () => {
  const { a, repo } = fresh();
  assert.throws(() =>
    repo.transaction(() => {
      a.createSource({ venue: 'v', kind: 'manual', title: 'x', createdAt: AT });
      throw new Error('stop');
    }),
  );
  assert.deepEqual(a.sources('v'), []);
});
