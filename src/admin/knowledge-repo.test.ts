import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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

test('migrate: widening the source kinds keeps every row and its children', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIGRATIONS[0]!);
  db.exec('PRAGMA user_version = 1');
  db.exec(`INSERT INTO source (tenant_id, id, venue, kind, title, url, created_at)
    VALUES ('t', 's1', 'v', 'web', 'Menu', 'https://venue.example/', '${AT}')`);
  db.exec(`INSERT INTO section (tenant_id, id, source_id, url, title, created_at)
    VALUES ('t', 'sec1', 's1', 'https://venue.example/', 'Menu', '${AT}')`);
  db.exec(`INSERT INTO revision (tenant_id, section_id, origin, status, title, markdown, sha256, created_at)
    VALUES ('t', 'sec1', 'fetched', 'pending', 'Menu', '# Menu', 'abc', '${AT}')`);

  migrate(db);

  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  const repo = createKnowledgeRepo(db);
  const t = repo.forTenant('t');
  assert.equal(t.source('s1')?.title, 'Menu');
  assert.equal(t.sections('s1').length, 1);
  assert.equal(t.pending('sec1')?.markdown, '# Menu');
  assert.equal(t.source('s1')?.ocrSha, null);
  const pdf = t.createSource({ venue: 'v', kind: 'pdf', title: 'Card', createdAt: AT });
  assert.equal(pdf.kind, 'pdf');
  // the children still cascade from the rebuilt table
  assert.equal(t.deleteSource('s1'), true);
  assert.equal(t.sections('s1').length, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM revision').get() as { n: number }).n, 0);
});

test('repo: files keep their order, are per tenant and go with their source', () => {
  const { a, b } = fresh();
  const source = a.createSource({ venue: 'v', kind: 'image', title: 'Photos', createdAt: AT });
  const file = (sha: string, name: string) => ({ sha256: sha, name, mime: 'image/png', bytes: 3 });
  assert.equal(a.addFile(source.id, file('a'.repeat(64), 'one.png')).position, 1);
  assert.equal(a.addFile(source.id, file('b'.repeat(64), 'two.png')).position, 2);
  assert.deepEqual(
    a.files(source.id).map((entry) => entry.name),
    ['one.png', 'two.png'],
  );
  assert.equal(a.fileUsers('a'.repeat(64)), 1);
  assert.equal(b.fileUsers('a'.repeat(64)), 0, 'another tenant does not count');
  assert.deepEqual(b.files(source.id), []);
  a.setOcr(source.id, 'set', 2);
  assert.equal(a.source(source.id)?.ocrPages, 2);
  a.clearFiles(source.id);
  assert.deepEqual(a.files(source.id), []);
  a.addFile(source.id, file('c'.repeat(64), 'three.png'));
  assert.equal(a.deleteSource(source.id), true);
  assert.equal(a.fileUsers('c'.repeat(64)), 0);
});

test('repo: only sources with an address are refreshed on a timer', () => {
  const { a } = fresh();
  a.createSource({ venue: 'v', kind: 'pdf', title: 'Upload', refreshHours: 24, createdAt: AT });
  const web = a.createSource({
    venue: 'v',
    kind: 'pdf',
    title: 'Link',
    url: 'https://venue.example/card.pdf',
    refreshHours: 24,
    createdAt: AT,
  });
  assert.deepEqual(
    a.refreshable().map((entry) => entry.id),
    [web.id],
  );
});
