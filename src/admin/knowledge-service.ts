/**
 * What happens to a venue's knowledge sources: fetching, review, hand edits and publishing. The
 * rules, in one place:
 *
 * - a fetch never changes what the assistant knows by itself; it leaves a pending revision to
 *   approve or reject, unless the source opted into auto-approve and its live text is not a hand edit;
 * - a hand edit is a new approved revision (`edited`); a later fetch that differs is shown as a
 *   diff against that live text, marked as overwriting it;
 * - every change to what is live republishes the venue's snapshot (`publish`).
 */

import { createHash } from 'node:crypto';
import { _ } from '../i18n.js';
import { type SnapshotSection } from '../core/knowledge-snapshot.js';
import { FetchRefused, SITEMAP_TYPES, type SafeFetcher } from './fetch-safe.js';
import { checkSelectors, htmlToMarkdown } from './html-markdown.js';
import {
  type KnowledgeRepo,
  type Revision,
  type Section,
  type Source,
  type SourceKind,
  type TenantRepo,
} from './knowledge-repo.js';
import { changed, lineDiff, type DiffLine } from './line-diff.js';
import { matchesGlobs, parseSitemap, sameHost } from './sitemap.js';
import { MAX_PATTERN_CHARS } from './wildcard.js';

export const MAX_PAGES = 30;
export const MAX_SITEMAPS = 3;
export const MAX_MANUAL_CHARS = 100_000;
export const MAX_TITLE_CHARS = 120;
export const DEFAULT_REFRESH_HOURS = 24;

/** The service reports user mistakes with a status the HTTP layer maps one to one. */
export class KnowledgeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export interface ServiceOptions {
  repo: KnowledgeRepo;
  fetcher: SafeFetcher;
  /** Writes (or, for an empty text, removes) the snapshot of one venue. */
  publish: (tenantId: string, venue: string, text: string) => void;
  render: (sections: SnapshotSection[]) => string;
  now?: () => Date;
  /** Where a failed publish is reported (details stay in the log, never in an answer). */
  log?: (message: string) => void;
}

export interface NewSourceInput {
  venue: string;
  kind: SourceKind;
  title: string;
  url?: string;
  markdown?: string;
  includeGlobs?: string[];
  excludeSelectors?: string[];
  refreshHours?: number | null;
  autoApprove?: boolean;
  author?: string;
}

export interface RefreshSummary {
  pages: number;
  unchanged: number;
  pending: number;
  approved: number;
  gone: number;
  failed: number;
  error: string | null;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const MAX_GLOBS = 20;

function cleanGlobs(globs: string[]): string[] {
  const kept = globs.filter((glob) => typeof glob === 'string' && glob.trim() !== '').map((glob) => glob.trim());
  if (kept.length > MAX_GLOBS)
    throw new KnowledgeError(400, _('at most %s patterns are allowed').replace('%s', String(MAX_GLOBS)));
  if (kept.some((glob) => glob.length > MAX_PATTERN_CHARS)) {
    throw new KnowledgeError(
      400,
      _('a pattern may have at most %s characters').replace('%s', String(MAX_PATTERN_CHARS)),
    );
  }
  return kept;
}

function cleanTitle(value: unknown, fallback: string): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (title || fallback).slice(0, MAX_TITLE_CHARS);
}

function checkAddress(value: unknown): string {
  if (typeof value !== 'string') throw new KnowledgeError(400, _('"url" must be a web address'));
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new KnowledgeError(400, _('this is not a valid web address'));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new KnowledgeError(400, _('only http and https addresses can be fetched'));
  }
  return url.href;
}

export function createKnowledgeService(options: ServiceOptions) {
  const { repo, fetcher } = options;
  const now = options.now ?? (() => new Date());
  const stamp = (): string => now().toISOString();

  const snapshotOf = (tenantId: string, venue: string): string =>
    options.render(
      repo
        .forTenant(tenantId)
        .live(venue)
        .map((entry) => ({
          sourceTitle: entry.source.title,
          title: entry.section.title,
          url: entry.section.url,
          at: entry.revision.origin === 'edited' ? entry.revision.createdAt : entry.revision.fetchedAt,
          edited: entry.revision.origin === 'edited',
          markdown: entry.revision.markdown,
        })),
    );

  // The database commit is what counts. A snapshot that could not be written stays marked stale and
  // is retried (next scheduler tick, next start), so a full disk never turns a saved change into an error.
  const stale = new Map<string, { tenantId: string; venue: string }>();
  const log = options.log ?? ((message: string) => console.error(message));

  const republish = (tenantId: string, venue: string): void => {
    const key = `${tenantId}\u0000${venue}`;
    try {
      options.publish(tenantId, venue, snapshotOf(tenantId, venue));
      stale.delete(key);
    } catch (error) {
      stale.set(key, { tenantId, venue });
      log(`knowledge publish failed, will retry: ${(error as Error).message}`);
    }
  };

  const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new KnowledgeError(404, _('not found'));
    return value;
  };

  const goLive = (t: TenantRepo, section: Section, revision: Revision): void => {
    t.decide(revision.id, 'approved', stamp());
    t.setLive(section.id, revision.id);
    t.renameSection(section.id, revision.title || section.title);
  };

  /** Stores one fetched page of a source; returns what became of it. */
  const takePage = (
    t: TenantRepo,
    source: Source,
    page: { url: string; title: string; markdown: string },
  ): 'unchanged' | 'pending' | 'approved' => {
    const at = stamp();
    const sectionUrl = source.kind === 'web' ? (source.url ?? page.url) : page.url;
    const section =
      t.sectionByUrl(source.id, sectionUrl) ??
      t.addSection(source.id, { url: sectionUrl, title: cleanTitle(page.title, source.title), createdAt: at });
    if (section.gone) t.setGone(section.id, false);
    const hash = sha(page.markdown);
    if (t.latestFetched(section.id)?.sha256 === hash) return 'unchanged';
    const live = section.liveRevisionId === null ? undefined : t.revision(section.liveRevisionId);
    if (live && live.sha256 === hash && live.origin === 'fetched') return 'unchanged';
    t.supersedePending(section.id, at);
    const revision = t.addRevision({
      sectionId: section.id,
      origin: 'fetched',
      status: 'pending',
      title: cleanTitle(page.title, section.title),
      url: page.url,
      markdown: page.markdown,
      sha256: hash,
      fetchedAt: at,
      createdAt: at,
    });
    if (source.autoApprove && live?.origin !== 'edited') {
      goLive(t, section, revision);
      return 'approved';
    }
    return 'pending';
  };

  const fetchPage = async (source: Source, address: string) => {
    const result = await fetcher.fetch(address);
    const exclude = checkSelectors(source.excludeSelectors);
    const converted =
      result.contentType === 'text/html' || result.contentType === 'application/xhtml+xml'
        ? htmlToMarkdown(result.text, { exclude, baseUrl: result.url })
        : { title: '', markdown: result.text.trim() };
    return { url: result.url, title: converted.title, markdown: converted.markdown };
  };

  const sitemapPages = async (source: Source): Promise<string[]> => {
    const start = source.url!;
    const pages: string[] = [];
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length > 0 && seen.size < MAX_SITEMAPS + 1) {
      const address = queue.shift()!;
      if (seen.has(address)) continue;
      seen.add(address);
      const xml = await fetcher.fetch(address, { types: SITEMAP_TYPES });
      const parsed = parseSitemap(xml.text);
      for (const nested of parsed.sitemaps) if (sameHost(nested, start)) queue.push(nested);
      for (const page of parsed.pages) {
        if (sameHost(page, start) && matchesGlobs(page, source.includeGlobs)) pages.push(page);
      }
    }
    return [...new Set(pages)];
  };

  return {
    republish,

    /** True when the venue's published text is behind the database. */
    isStale: (tenantId: string, venue: string): boolean => stale.has(`${tenantId}\u0000${venue}`),
    hasStale: (): boolean => stale.size > 0,
    /** Tries every stale snapshot again; returns how many are still behind. */
    retryStale(): number {
      for (const { tenantId, venue } of stale.values()) republish(tenantId, venue);
      return stale.size;
    },

    async addSource(tenantId: string, input: NewSourceInput): Promise<Source> {
      const t = repo.forTenant(tenantId);
      if (!['manual', 'web', 'sitemap'].includes(input.kind)) {
        throw new KnowledgeError(400, _('"kind" must be one of: %s').replace('%s', 'manual, web, sitemap'));
      }
      const at = stamp();
      const title = cleanTitle(input.title, input.kind === 'manual' ? _('Notes') : _('Web page'));
      if (input.kind === 'manual') {
        const markdown = typeof input.markdown === 'string' ? input.markdown : '';
        if (markdown.length > MAX_MANUAL_CHARS) throw new KnowledgeError(400, _('the text is too long'));
        const source = repo.transaction(() => {
          const made = t.createSource({ venue: input.venue, kind: 'manual', title, createdAt: at });
          const section = t.addSection(made.id, { url: null, title, createdAt: at });
          const revision = t.addRevision({
            sectionId: section.id,
            origin: 'edited',
            status: 'approved',
            title,
            url: null,
            markdown,
            sha256: sha(markdown),
            fetchedAt: null,
            author: input.author ?? null,
            createdAt: at,
          });
          t.setLive(section.id, revision.id);
          return made;
        });
        republish(tenantId, input.venue);
        return source;
      }
      const url = checkAddress(input.url);
      let excludeSelectors: string[];
      try {
        excludeSelectors = checkSelectors(input.excludeSelectors ?? []);
      } catch (error) {
        throw new KnowledgeError(400, (error as Error).message);
      }
      const refreshHours = input.refreshHours === undefined ? DEFAULT_REFRESH_HOURS : input.refreshHours;
      if (refreshHours !== null && (!Number.isInteger(refreshHours) || refreshHours < 1 || refreshHours > 24 * 90)) {
        throw new KnowledgeError(400, _('"refreshHours" must be a whole number of hours, or null'));
      }
      return t.createSource({
        venue: input.venue,
        kind: input.kind,
        title,
        url,
        includeGlobs: cleanGlobs(input.includeGlobs ?? []),
        excludeSelectors,
        refreshHours,
        autoApprove: input.autoApprove === true,
        createdAt: at,
      });
    },

    /** Fetches a source now. One failing page does not stop the others. */
    async refresh(tenantId: string, sourceId: string): Promise<RefreshSummary> {
      const t = repo.forTenant(tenantId);
      const source = need(t.source(sourceId));
      if (source.kind === 'manual') throw new KnowledgeError(400, _('a text source has nothing to fetch'));
      const summary: RefreshSummary = {
        pages: 0,
        unchanged: 0,
        pending: 0,
        approved: 0,
        gone: 0,
        failed: 0,
        error: null,
      };
      let addresses: string[];
      try {
        addresses = source.kind === 'web' ? [source.url!] : await sitemapPages(source);
      } catch (error) {
        const message = error instanceof FetchRefused ? error.message : (error as Error).message;
        t.markChecked(source.id, stamp(), message, false);
        summary.error = message;
        summary.failed = 1;
        return summary;
      }
      const errors: string[] = [];
      let reached = 0;
      const limited = addresses.slice(0, MAX_PAGES);
      for (const address of limited) {
        try {
          const page = await fetchPage(source, address);
          reached++;
          const result = repo.transaction(() => takePage(t, source, page));
          summary.pages++;
          summary[result]++;
        } catch (error) {
          summary.failed++;
          errors.push(error instanceof FetchRefused || error instanceof Error ? error.message : String(error));
        }
      }
      if (source.kind === 'sitemap' && summary.failed === 0 && addresses.length <= MAX_PAGES) {
        const listed = new Set(addresses);
        for (const section of t.sections(source.id)) {
          if (section.url && !listed.has(section.url) && !section.gone) {
            t.setGone(section.id, true);
            summary.gone++;
          }
        }
      }
      summary.error = errors[0] ?? null;
      t.markChecked(source.id, stamp(), summary.error, reached > 0);
      if (summary.approved > 0) republish(tenantId, source.venue);
      return summary;
    },

    /** Sources whose automatic refresh is due. */
    due(tenantId: string): Source[] {
      const t = repo.forTenant(tenantId);
      const at = now().getTime();
      return t.refreshable().filter((source) => {
        if (source.refreshHours === null) return false;
        const last = source.lastCheckedAt ? Date.parse(source.lastCheckedAt) : 0;
        return last + source.refreshHours * 3_600_000 <= at;
      });
    },

    approve(tenantId: string, revisionId: number): void {
      const t = repo.forTenant(tenantId);
      const revision = need(t.revision(revisionId));
      if (revision.status !== 'pending')
        throw new KnowledgeError(409, _('this change was already decided: reload the page'));
      const section = need(t.section(revision.sectionId));
      const source = need(t.source(section.sourceId));
      repo.transaction(() => goLive(t, section, revision));
      republish(tenantId, source.venue);
    },

    reject(tenantId: string, revisionId: number): void {
      const t = repo.forTenant(tenantId);
      const revision = need(t.revision(revisionId));
      if (revision.status !== 'pending')
        throw new KnowledgeError(409, _('this change was already decided: reload the page'));
      t.decide(revisionId, 'rejected', stamp());
    },

    /** A hand edit: the new text is live at once. `baseRevisionId` is the live revision the editor loaded. */
    edit(
      tenantId: string,
      sectionId: string,
      input: { markdown: string; title?: string; baseRevisionId: number | null; author?: string },
    ): Revision {
      const t = repo.forTenant(tenantId);
      const section = need(t.section(sectionId));
      const source = need(t.source(section.sourceId));
      if (typeof input.markdown !== 'string') throw new KnowledgeError(400, _('"markdown" must be text'));
      if (input.markdown.length > MAX_MANUAL_CHARS) throw new KnowledgeError(400, _('the text is too long'));
      if ((input.baseRevisionId ?? null) !== section.liveRevisionId) {
        throw new KnowledgeError(409, _('this section changed since you loaded it: reload and make the change again'));
      }
      const at = stamp();
      const title = cleanTitle(input.title, section.title);
      const revision = repo.transaction(() => {
        const made = t.addRevision({
          sectionId,
          origin: 'edited',
          status: 'approved',
          title,
          url: section.url,
          markdown: input.markdown,
          sha256: sha(input.markdown),
          fetchedAt: null,
          author: input.author ?? null,
          createdAt: at,
        });
        t.setLive(sectionId, made.id);
        t.renameSection(sectionId, title);
        return made;
      });
      republish(tenantId, source.venue);
      return revision;
    },

    removeSource(tenantId: string, sourceId: string): void {
      const t = repo.forTenant(tenantId);
      const source = need(t.source(sourceId));
      t.deleteSource(sourceId);
      republish(tenantId, source.venue);
    },

    updateSource(
      tenantId: string,
      sourceId: string,
      patch: {
        title?: string;
        includeGlobs?: string[];
        excludeSelectors?: string[];
        refreshHours?: number | null;
        autoApprove?: boolean;
      },
    ): Source {
      const t = repo.forTenant(tenantId);
      const source = need(t.source(sourceId));
      const next: Parameters<TenantRepo['updateSource']>[1] = {};
      if (patch.title !== undefined) next.title = cleanTitle(patch.title, source.title);
      if (patch.includeGlobs !== undefined) next.includeGlobs = cleanGlobs(patch.includeGlobs);
      if (patch.excludeSelectors !== undefined) {
        try {
          next.excludeSelectors = checkSelectors(patch.excludeSelectors);
        } catch (error) {
          throw new KnowledgeError(400, (error as Error).message);
        }
      }
      if (patch.refreshHours !== undefined) {
        if (
          patch.refreshHours !== null &&
          (!Number.isInteger(patch.refreshHours) || patch.refreshHours < 1 || patch.refreshHours > 24 * 90)
        ) {
          throw new KnowledgeError(400, _('"refreshHours" must be a whole number of hours, or null'));
        }
        next.refreshHours = patch.refreshHours;
      }
      if (patch.autoApprove !== undefined) next.autoApprove = patch.autoApprove === true;
      const updated = need(t.updateSource(sourceId, next));
      if (patch.title !== undefined) republish(tenantId, source.venue);
      return updated;
    },

    /** The list the page shows for one venue. */
    overview(tenantId: string, venue: string) {
      const t = repo.forTenant(tenantId);
      return t.sources(venue).map((source) => ({
        ...source,
        pendingCount: t.pendingCount(source.id),
        sections: t.sections(source.id).length,
      }));
    },

    /** One source with its sections, each with live text, open change and the diff between them. */
    detail(tenantId: string, sourceId: string) {
      const t = repo.forTenant(tenantId);
      const source = need(t.source(sourceId));
      const sections = t.sections(sourceId).map((section) => {
        const live = section.liveRevisionId === null ? undefined : t.revision(section.liveRevisionId);
        const pending = t.pending(section.id);
        const diff: DiffLine[] | null = pending ? lineDiff(live?.markdown ?? '', pending.markdown) : null;
        return {
          ...section,
          live: live ?? null,
          pending: pending ?? null,
          diff,
          diffChanged: diff ? changed(diff) : 0,
          // A fetched text would replace what a person wrote.
          overwritesEdit: Boolean(pending && live?.origin === 'edited'),
        };
      });
      return { source, sections };
    },

    history(tenantId: string, sectionId: string): Revision[] {
      const t = repo.forTenant(tenantId);
      need(t.section(sectionId));
      return t.revisions(sectionId);
    },

    /** What the bot knows: the snapshot as published. */
    published: snapshotOf,
  };
}

export type KnowledgeService = ReturnType<typeof createKnowledgeService>;
