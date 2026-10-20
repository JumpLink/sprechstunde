/**
 * The only module that runs SQL on the knowledge tables. Everything goes through `forTenant(id)`:
 * the returned object has the tenant id baked into every statement, so a caller cannot forget it
 * and one tenant's id can never read or change another tenant's rows.
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type SourceKind = 'manual' | 'web' | 'sitemap';
export type RevisionStatus = 'pending' | 'approved' | 'rejected';
export type RevisionOrigin = 'fetched' | 'edited';

export interface Source {
  id: string;
  venue: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  includeGlobs: string[];
  excludeSelectors: string[];
  /** Hours between automatic fetches; null for none. */
  refreshHours: number | null;
  autoApprove: boolean;
  lastCheckedAt: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface Section {
  id: string;
  sourceId: string;
  url: string | null;
  title: string;
  liveRevisionId: number | null;
  /** A sitemap no longer lists this page. It stays live until someone removes it. */
  gone: boolean;
  createdAt: string;
}

export interface Revision {
  id: number;
  sectionId: string;
  origin: RevisionOrigin;
  status: RevisionStatus;
  title: string;
  url: string | null;
  markdown: string;
  sha256: string;
  fetchedAt: string | null;
  author: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface NewSource {
  venue: string;
  kind: SourceKind;
  title: string;
  url?: string | null;
  includeGlobs?: string[];
  excludeSelectors?: string[];
  refreshHours?: number | null;
  autoApprove?: boolean;
  createdAt: string;
}

export type SourcePatch = Partial<
  Pick<Source, 'title' | 'url' | 'includeGlobs' | 'excludeSelectors' | 'refreshHours' | 'autoApprove'>
>;

export interface NewRevision {
  sectionId: string;
  origin: RevisionOrigin;
  status: RevisionStatus;
  title: string;
  url: string | null;
  markdown: string;
  sha256: string;
  fetchedAt: string | null;
  author?: string | null;
  note?: string | null;
  createdAt: string;
}

/** What the agent's snapshot is made of: a section with its live revision. */
export interface LiveSection {
  source: Pick<Source, 'id' | 'kind' | 'title'>;
  section: Pick<Section, 'id' | 'title' | 'url' | 'gone'>;
  revision: Pick<Revision, 'id' | 'origin' | 'markdown' | 'fetchedAt' | 'createdAt' | 'author'>;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string => String(value);
const maybe = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const list = (value: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(text(value));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

const sourceOf = (row: Row): Source => ({
  id: text(row.id),
  venue: text(row.venue),
  kind: text(row.kind) as SourceKind,
  title: text(row.title),
  url: maybe(row.url),
  includeGlobs: list(row.include_globs),
  excludeSelectors: list(row.exclude_selectors),
  refreshHours: row.refresh_hours === null ? null : Number(row.refresh_hours),
  autoApprove: Number(row.auto_approve) === 1,
  lastCheckedAt: maybe(row.last_checked_at),
  lastFetchedAt: maybe(row.last_fetched_at),
  lastError: maybe(row.last_error),
  createdAt: text(row.created_at),
});

const sectionOf = (row: Row): Section => ({
  id: text(row.id),
  sourceId: text(row.source_id),
  url: maybe(row.url),
  title: text(row.title),
  liveRevisionId: row.live_revision_id === null ? null : Number(row.live_revision_id),
  gone: Number(row.gone) === 1,
  createdAt: text(row.created_at),
});

const revisionOf = (row: Row): Revision => ({
  id: Number(row.id),
  sectionId: text(row.section_id),
  origin: text(row.origin) as RevisionOrigin,
  status: text(row.status) as RevisionStatus,
  title: text(row.title),
  url: maybe(row.url),
  markdown: text(row.markdown),
  sha256: text(row.sha256),
  fetchedAt: maybe(row.fetched_at),
  author: maybe(row.author),
  note: maybe(row.note),
  createdAt: text(row.created_at),
  decidedAt: maybe(row.decided_at),
});

const newId = (): string => randomBytes(8).toString('hex');

export function createKnowledgeRepo(db: DatabaseSync) {
  const all = (sql: string, ...params: SQLInputValue[]): Row[] => db.prepare(sql).all(...params) as Row[];
  const one = (sql: string, ...params: SQLInputValue[]): Row | undefined =>
    db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

  return {
    /** Runs `change` in one transaction; a throw rolls everything back. */
    transaction<T>(change: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = change();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    /** Every (tenant, venue) that has sources: what a start-up republish walks. */
    venues(): Array<{ tenantId: string; venue: string }> {
      return all('SELECT DISTINCT tenant_id, venue FROM source ORDER BY tenant_id, venue').map((row) => ({
        tenantId: text(row.tenant_id),
        venue: text(row.venue),
      }));
    },

    forTenant(tenantId: string) {
      return {
        createSource(input: NewSource): Source {
          const id = newId();
          run(
            `INSERT INTO source (tenant_id, id, venue, kind, title, url, include_globs, exclude_selectors,
               refresh_hours, auto_approve, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            tenantId,
            id,
            input.venue,
            input.kind,
            input.title,
            input.url ?? null,
            JSON.stringify(input.includeGlobs ?? []),
            JSON.stringify(input.excludeSelectors ?? []),
            input.refreshHours ?? null,
            input.autoApprove ? 1 : 0,
            input.createdAt,
          );
          return this.source(id)!;
        },

        source(id: string): Source | undefined {
          const row = one('SELECT * FROM source WHERE tenant_id = ? AND id = ?', tenantId, id);
          return row && sourceOf(row);
        },

        sources(venue: string): Source[] {
          return all(
            'SELECT * FROM source WHERE tenant_id = ? AND venue = ? ORDER BY created_at, id',
            tenantId,
            venue,
          ).map(sourceOf);
        },

        /** Sources with an automatic refresh, for the scheduler. */
        refreshable(): Source[] {
          return all(
            `SELECT * FROM source WHERE tenant_id = ? AND kind != 'manual' AND refresh_hours IS NOT NULL ORDER BY created_at, id`,
            tenantId,
          ).map(sourceOf);
        },

        updateSource(id: string, patch: SourcePatch): Source | undefined {
          const current = this.source(id);
          if (!current) return undefined;
          const next = { ...current, ...patch };
          run(
            `UPDATE source SET title = ?, url = ?, include_globs = ?, exclude_selectors = ?, refresh_hours = ?,
               auto_approve = ? WHERE tenant_id = ? AND id = ?`,
            next.title,
            next.url,
            JSON.stringify(next.includeGlobs),
            JSON.stringify(next.excludeSelectors),
            next.refreshHours,
            next.autoApprove ? 1 : 0,
            tenantId,
            id,
          );
          return this.source(id);
        },

        /** `fetchedAt` only when the attempt got a page; `error` null on success. */
        markChecked(id: string, at: string, error: string | null, fetched: boolean): void {
          run(
            `UPDATE source SET last_checked_at = ?, last_error = ?, last_fetched_at = CASE WHEN ? THEN ? ELSE last_fetched_at END
             WHERE tenant_id = ? AND id = ?`,
            at,
            error,
            fetched ? 1 : 0,
            at,
            tenantId,
            id,
          );
        },

        deleteSource(id: string): boolean {
          return Number(run('DELETE FROM source WHERE tenant_id = ? AND id = ?', tenantId, id).changes) > 0;
        },

        addSection(sourceId: string, input: { url: string | null; title: string; createdAt: string }): Section {
          const id = newId();
          run(
            'INSERT INTO section (tenant_id, id, source_id, url, title, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            tenantId,
            id,
            sourceId,
            input.url,
            input.title,
            input.createdAt,
          );
          return this.section(id)!;
        },

        section(id: string): Section | undefined {
          const row = one('SELECT * FROM section WHERE tenant_id = ? AND id = ?', tenantId, id);
          return row && sectionOf(row);
        },

        sections(sourceId: string): Section[] {
          return all(
            'SELECT * FROM section WHERE tenant_id = ? AND source_id = ? ORDER BY created_at, id',
            tenantId,
            sourceId,
          ).map(sectionOf);
        },

        sectionByUrl(sourceId: string, url: string): Section | undefined {
          const row = one(
            'SELECT * FROM section WHERE tenant_id = ? AND source_id = ? AND url = ?',
            tenantId,
            sourceId,
            url,
          );
          return row && sectionOf(row);
        },

        renameSection(id: string, title: string): void {
          run('UPDATE section SET title = ? WHERE tenant_id = ? AND id = ?', title, tenantId, id);
        },

        setGone(id: string, gone: boolean): void {
          run('UPDATE section SET gone = ? WHERE tenant_id = ? AND id = ?', gone ? 1 : 0, tenantId, id);
        },

        setLive(sectionId: string, revisionId: number | null): void {
          run(
            'UPDATE section SET live_revision_id = ? WHERE tenant_id = ? AND id = ?',
            revisionId,
            tenantId,
            sectionId,
          );
        },

        deleteSection(id: string): boolean {
          return Number(run('DELETE FROM section WHERE tenant_id = ? AND id = ?', tenantId, id).changes) > 0;
        },

        addRevision(input: NewRevision): Revision {
          const result = run(
            `INSERT INTO revision (tenant_id, section_id, origin, status, title, url, markdown, sha256, fetched_at,
               author, note, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            tenantId,
            input.sectionId,
            input.origin,
            input.status,
            input.title,
            input.url,
            input.markdown,
            input.sha256,
            input.fetchedAt,
            input.author ?? null,
            input.note ?? null,
            input.createdAt,
            input.status === 'pending' ? null : input.createdAt,
          );
          return this.revision(Number(result.lastInsertRowid))!;
        },

        /**
         * Drops old decided revisions of a section. Kept: the newest `keep`, every pending one, the live one,
         * the newest `keepEdits` hand edits and the newest fetched one (the baseline for the next diff).
         */
        pruneRevisions(sectionId: string, keep: number, keepEdits: number): number {
          const newest = (extra: string, limit: number) =>
            `SELECT id FROM revision WHERE tenant_id = ? AND section_id = ? ${extra} ORDER BY id DESC LIMIT ${limit}`;
          return Number(
            run(
              `DELETE FROM revision WHERE tenant_id = ? AND section_id = ? AND status != 'pending'
                 AND id NOT IN (SELECT live_revision_id FROM section WHERE tenant_id = ? AND id = ? AND live_revision_id IS NOT NULL)
                 AND id NOT IN (${newest('', Math.trunc(keep))})
                 AND id NOT IN (${newest("AND origin = 'edited'", Math.trunc(keepEdits))})
                 AND id NOT IN (${newest("AND origin = 'fetched'", 1)})`,
              tenantId,
              sectionId,
              tenantId,
              sectionId,
              tenantId,
              sectionId,
              tenantId,
              sectionId,
              tenantId,
              sectionId,
            ).changes,
          );
        },

        revision(id: number): Revision | undefined {
          const row = one('SELECT * FROM revision WHERE tenant_id = ? AND id = ?', tenantId, id);
          return row && revisionOf(row);
        },

        /** Newest first. */
        revisions(sectionId: string, limit = 50): Revision[] {
          return all(
            'SELECT * FROM revision WHERE tenant_id = ? AND section_id = ? ORDER BY id DESC LIMIT ?',
            tenantId,
            sectionId,
            limit,
          ).map(revisionOf);
        },

        latestFetched(sectionId: string): Revision | undefined {
          const row = one(
            `SELECT * FROM revision WHERE tenant_id = ? AND section_id = ? AND origin = 'fetched' ORDER BY id DESC LIMIT 1`,
            tenantId,
            sectionId,
          );
          return row && revisionOf(row);
        },

        pending(sectionId: string): Revision | undefined {
          const row = one(
            `SELECT * FROM revision WHERE tenant_id = ? AND section_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
            tenantId,
            sectionId,
          );
          return row && revisionOf(row);
        },

        /** Open changes of a source's sections, for the badge on the list. */
        pendingCount(sourceId: string): number {
          const row = one(
            `SELECT COUNT(*) AS n FROM revision r JOIN section s ON s.tenant_id = r.tenant_id AND s.id = r.section_id
             WHERE r.tenant_id = ? AND s.source_id = ? AND r.status = 'pending'`,
            tenantId,
            sourceId,
          );
          return Number(row?.n ?? 0);
        },

        decide(id: string | number, status: RevisionStatus, at: string, note?: string): void {
          run(
            'UPDATE revision SET status = ?, decided_at = ?, note = COALESCE(?, note) WHERE tenant_id = ? AND id = ?',
            status,
            at,
            note ?? null,
            tenantId,
            Number(id),
          );
        },

        /** Older open changes of a section lose to a newer one. */
        supersedePending(sectionId: string, at: string): void {
          run(
            `UPDATE revision SET status = 'rejected', decided_at = ?, note = 'superseded'
             WHERE tenant_id = ? AND section_id = ? AND status = 'pending'`,
            at,
            tenantId,
            sectionId,
          );
        },

        /** What the agent is told about a venue: every section that has a live revision. */
        live(venue: string): LiveSection[] {
          return all(
            `SELECT src.id AS source_id, src.kind AS source_kind, src.title AS source_title,
                    sec.id AS section_id, sec.title AS section_title, sec.url AS section_url, sec.gone AS section_gone,
                    r.id AS rev_id, r.origin AS rev_origin, r.markdown AS rev_markdown, r.fetched_at AS rev_fetched_at,
                    r.created_at AS rev_created_at, r.author AS rev_author
             FROM source src
             JOIN section sec ON sec.tenant_id = src.tenant_id AND sec.source_id = src.id
             JOIN revision r ON r.tenant_id = sec.tenant_id AND r.id = sec.live_revision_id
             WHERE src.tenant_id = ? AND src.venue = ?
             ORDER BY src.created_at, src.id, sec.created_at, sec.id`,
            tenantId,
            venue,
          ).map((row) => ({
            source: {
              id: text(row.source_id),
              kind: text(row.source_kind) as SourceKind,
              title: text(row.source_title),
            },
            section: {
              id: text(row.section_id),
              title: text(row.section_title),
              url: maybe(row.section_url),
              gone: Number(row.section_gone) === 1,
            },
            revision: {
              id: Number(row.rev_id),
              origin: text(row.rev_origin) as RevisionOrigin,
              markdown: text(row.rev_markdown),
              fetchedAt: maybe(row.rev_fetched_at),
              createdAt: text(row.rev_created_at),
              author: maybe(row.rev_author),
            },
          }));
        },
      };
    },
  };
}

export type KnowledgeRepo = ReturnType<typeof createKnowledgeRepo>;
export type TenantRepo = ReturnType<KnowledgeRepo['forTenant']>;
