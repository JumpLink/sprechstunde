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
import { cleanFileName, detectFile, IMAGE_TYPES, limitFor, PDF_TYPES, type DocumentKind } from './file-kinds.js';
import { sha256Of, type FileStore } from './file-store.js';
import { checkSelectors, htmlToMarkdown } from './html-markdown.js';
import {
  type KnowledgeRepo,
  type Revision,
  type Section,
  type Source,
  type SourceFile,
  type SourceKind,
  type TenantRepo,
} from './knowledge-repo.js';
import { changed, lineDiff, type DiffLine } from './line-diff.js';
import { matchesGlobs, parseSitemap, sameHost } from './sitemap.js';
import { createLimiter } from './limiter.js';
import { MAX_OCR_PAGES, OcrFailed, type Ocr } from './ocr.js';
import { MAX_PATTERN_CHARS } from './wildcard.js';

export const MAX_PAGES = 30;
export const MAX_SOURCES_PER_VENUE = 50;
/** Revisions kept per section (see `pruneRevisions` for what is kept on top). */
export const KEEP_REVISIONS = 20;
export const KEEP_EDITS = 20;
const MAX_PARALLEL_FETCHES = 2;
export const MAX_SITEMAPS = 3;
export const MAX_MANUAL_CHARS = 100_000;
export const MAX_TITLE_CHARS = 120;
export const DEFAULT_REFRESH_HOURS = 24;

/** The service reports user mistakes with a status the HTTP layer maps one to one. */
export class KnowledgeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 429 | 502,
    message: string,
    /** Seconds until a 429 may be tried again. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export interface ServiceOptions {
  repo: KnowledgeRepo;
  fetcher: SafeFetcher;
  /** The originals of document sources. */
  files: FileStore;
  /** Reads a PDF or a picture; the one place that costs money per call. */
  ocr: Ocr;
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

const isDocument = (kind: SourceKind): kind is DocumentKind & SourceKind => kind === 'pdf' || kind === 'image';

/** Which files, in which order: what a reading is made from. */
const fileSetSha = (files: SourceFile[]): string => sha(JSON.stringify(files.map((file) => file.sha256)));

/** What a reading joins its pages with; a thematic break reads as a break and costs the assistant nothing. */
/** Kept apart from the `_()` strings: an older xgettext reads a slash literal as a regex start and stops. */
const lastSegment = (path: string): string => path.slice(path.lastIndexOf(String.fromCharCode(47)) + 1);
const PAGE_BREAK = '\n\n---\n\n';

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

function cleanHours(value: number | null | undefined): number | null {
  const hours = value === undefined ? DEFAULT_REFRESH_HOURS : value;
  if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 24 * 90)) {
    throw new KnowledgeError(400, _('"refreshHours" must be a whole number of hours, or null'));
  }
  return hours;
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
    const key = JSON.stringify([tenantId, venue]);
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
    page: { url: string | null; title: string; markdown: string; note?: string },
    listed: string,
  ): 'unchanged' | 'pending' | 'approved' => {
    const at = stamp();
    const sectionUrl = source.kind === 'web' ? (source.url ?? listed) : listed;
    // A document source is one section; a web page or a listed page is found by its address.
    const section = isDocument(source.kind)
      ? (t.sections(source.id)[0] ??
        t.addSection(source.id, { url: source.url, title: cleanTitle(page.title, source.title), createdAt: at }))
      : (t.sectionByUrl(source.id, sectionUrl) ??
        t.addSection(source.id, { url: sectionUrl, title: cleanTitle(page.title, source.title), createdAt: at }));
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
      note: page.note ?? null,
      createdAt: at,
    });
    const approved = source.autoApprove && live?.origin !== 'edited';
    if (approved) goLive(t, section, revision);
    t.pruneRevisions(section.id, KEEP_REVISIONS, KEEP_EDITS);
    return approved ? 'approved' : 'pending';
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

  /** Frees stored files that no source of the tenant uses any more. */
  const release = (tenantId: string, t: TenantRepo, shas: string[]): void => {
    for (const hash of new Set(shas)) if (t.fileUsers(hash) === 0) options.files.remove(tenantId, hash);
  };

  const originalName = (address: string, kind: DocumentKind): string => {
    try {
      return cleanFileName(decodeURIComponent(lastSegment(new URL(address).pathname)), kind);
    } catch {
      return kind;
    }
  };

  /** A document source with an address: the file at it replaces the stored one when its bytes differ. */
  const fetchDocument = async (tenantId: string, t: TenantRepo, source: Source): Promise<void> => {
    const kind = source.kind as DocumentKind;
    const result = await fetcher.fetch(source.url!, {
      binary: true,
      types: kind === 'pdf' ? PDF_TYPES : IMAGE_TYPES,
      maxBytes: limitFor(kind),
    });
    const bytes = result.bytes!;
    const found = detectFile(bytes);
    if (found?.kind !== kind) {
      throw new FetchRefused('type', _('the page is not a kind of document that can be read'));
    }
    const current = t.files(source.id);
    if (current.length === 1 && current[0]!.sha256 === sha256Of(bytes)) return;
    const stored = options.files.put(tenantId, bytes);
    repo.transaction(() => {
      t.clearFiles(source.id);
      t.addFile(source.id, {
        sha256: stored,
        name: originalName(result.url, kind),
        mime: found.mime,
        bytes: bytes.length,
      });
    });
    release(
      tenantId,
      t,
      current.map((file) => file.sha256),
    );
  };

  /** Reads the files of a document source, unless they are the ones the live reading came from. */
  const readDocument = async (
    tenantId: string,
    t: TenantRepo,
    source: Source,
    summary: RefreshSummary,
  ): Promise<RefreshSummary> => {
    const kind = source.kind as DocumentKind;
    const fail = (error: unknown): RefreshSummary => {
      const expected = error instanceof FetchRefused || error instanceof OcrFailed || error instanceof KnowledgeError;
      if (!expected) log('document reading failed: ' + (error as Error).message);
      summary.error = expected ? (error as Error).message : _('internal error');
      summary.failed = 1;
      t.markChecked(source.id, stamp(), summary.error, false);
      return summary;
    };
    try {
      if (source.url) await fetchDocument(tenantId, t, source);
      const stored = t.files(source.id);
      if (stored.length === 0) throw new KnowledgeError(400, _('no file has been uploaded yet'));
      const setSha = fileSetSha(stored);
      if (setSha === source.ocrSha) {
        t.markChecked(source.id, stamp(), null, true);
        summary.pages = 1;
        summary.unchanged = 1;
        return summary;
      }
      const pages: string[] = [];
      for (const file of stored) {
        const bytes = options.files.get(tenantId, file.sha256);
        if (!bytes) throw new KnowledgeError(400, _('a stored file is missing: upload it again'));
        pages.push(...(await options.ocr({ kind, mime: file.mime, bytes })));
      }
      const markdown = pages
        .map((page) => page.trim())
        .filter((page) => page !== '')
        .join(PAGE_BREAK);
      if (markdown === '') throw new KnowledgeError(400, _('no text was found in the document'));
      const result = repo.transaction(() => {
        const taken = takePage(
          t,
          source,
          {
            url: source.url,
            title: source.title,
            markdown,
            ...(pages.length >= MAX_OCR_PAGES && { note: `capped:${MAX_OCR_PAGES}` }),
          },
          source.url ?? '',
        );
        t.setOcr(source.id, setSha, pages.length);
        return taken;
      });
      summary.pages = 1;
      summary[result]++;
      t.markChecked(source.id, stamp(), null, true);
      if (result === 'approved') republish(tenantId, source.venue);
      return summary;
    } catch (error) {
      return fail(error);
    }
  };

  const fetchSlots = createLimiter(MAX_PARALLEL_FETCHES);

  return {
    republish,

    /** True when the venue's published text is behind the database. */
    isStale: (tenantId: string, venue: string): boolean => stale.has(JSON.stringify([tenantId, venue])),
    hasStale: (): boolean => stale.size > 0,
    /** Tries every stale snapshot again; returns how many are still behind. */
    retryStale(): number {
      for (const { tenantId, venue } of stale.values()) republish(tenantId, venue);
      return stale.size;
    },

    async addSource(tenantId: string, input: NewSourceInput): Promise<Source> {
      const t = repo.forTenant(tenantId);
      if (t.sources(input.venue).length >= MAX_SOURCES_PER_VENUE) {
        throw new KnowledgeError(
          400,
          _('a venue may have at most %s sources').replace('%s', String(MAX_SOURCES_PER_VENUE)),
        );
      }
      if (!['manual', 'web', 'sitemap', 'pdf', 'image'].includes(input.kind)) {
        throw new KnowledgeError(400, _('"kind" must be one of: %s').replace('%s', 'manual, web, sitemap, pdf, image'));
      }
      const at = stamp();
      const fallbackTitle = {
        manual: _('Notes'),
        web: _('Web page'),
        sitemap: _('Web page'),
        pdf: _('Document'),
        image: _('Photos'),
      }[input.kind];
      const title = cleanTitle(input.title, fallbackTitle);
      if (isDocument(input.kind)) {
        // With an address the file is fetched like a page; without one it is uploaded afterwards.
        const hasUrl = typeof input.url === 'string' && input.url.trim() !== '';
        return t.createSource({
          venue: input.venue,
          kind: input.kind,
          title,
          url: hasUrl ? checkAddress(input.url) : null,
          refreshHours: hasUrl ? cleanHours(input.refreshHours) : null,
          autoApprove: input.autoApprove === true,
          createdAt: at,
        });
      }
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
      const refreshHours = cleanHours(input.refreshHours);
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
    /** The scheduler and the API share these slots, so a burst of requests cannot open a burst of fetches. */
    refresh(tenantId: string, sourceId: string): Promise<RefreshSummary> {
      return fetchSlots.run(() => this.refreshNow(tenantId, sourceId));
    },

    async refreshNow(tenantId: string, sourceId: string): Promise<RefreshSummary> {
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
      if (isDocument(source.kind)) return readDocument(tenantId, t, source, summary);
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
          const result = repo.transaction(() => takePage(t, source, page, address));
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
        t.pruneRevisions(sectionId, KEEP_REVISIONS, KEEP_EDITS);
        return made;
      });
      republish(tenantId, source.venue);
      return revision;
    },

    removeSource(tenantId: string, sourceId: string): void {
      const t = repo.forTenant(tenantId);
      const source = need(t.source(sourceId));
      const stored = t.files(sourceId).map((file) => file.sha256);
      t.deleteSource(sourceId);
      release(tenantId, t, stored);
      republish(tenantId, source.venue);
    },

    /** An uploaded file: its bytes decide what it is. A PDF source holds one file, a picture source up to 30. */
    addFile(tenantId: string, sourceId: string, input: { name: unknown; bytes: Uint8Array }): SourceFile {
      const t = repo.forTenant(tenantId);
      const source = need(t.source(sourceId));
      if (!isDocument(source.kind)) throw new KnowledgeError(400, _('this source takes no files'));
      if (source.url) {
        throw new KnowledgeError(400, _('this source is fetched from a web address and takes no uploaded files'));
      }
      const found = detectFile(input.bytes);
      if (!found) throw new KnowledgeError(400, _('this is not a PDF or a picture (PNG, JPEG or WebP)'));
      if (found.kind !== source.kind) {
        throw new KnowledgeError(
          400,
          source.kind === 'pdf' ? _('this source takes a PDF') : _('this source takes pictures'),
        );
      }
      if (input.bytes.length > limitFor(found.kind)) throw new KnowledgeError(413, _('the file is too large'));
      const present = t.files(sourceId);
      if (source.kind === 'image' && present.length >= MAX_OCR_PAGES) {
        throw new KnowledgeError(400, _('at most %s pictures are allowed').replace('%s', String(MAX_OCR_PAGES)));
      }
      const stored = options.files.put(tenantId, input.bytes);
      const row = repo.transaction(() => {
        if (source.kind === 'pdf') t.clearFiles(sourceId);
        return t.addFile(sourceId, {
          sha256: stored,
          name: cleanFileName(input.name, source.kind),
          mime: found.mime,
          bytes: input.bytes.length,
        });
      });
      if (source.kind === 'pdf') {
        release(
          tenantId,
          t,
          present.map((file) => file.sha256),
        );
      }
      return row;
    },

    /** Drops the uploaded files, so the next set starts at the first position. The live text stays. */
    clearFiles(tenantId: string, sourceId: string): void {
      const t = repo.forTenant(tenantId);
      const source = need(t.source(sourceId));
      if (!isDocument(source.kind) || source.url) throw new KnowledgeError(400, _('this source takes no files'));
      const present = t.files(sourceId).map((file) => file.sha256);
      t.clearFiles(sourceId);
      release(tenantId, t, present);
    },

    /** One original file, for the page to show or download. */
    file(tenantId: string, sourceId: string, position: number): { name: string; mime: string; bytes: Buffer } {
      const t = repo.forTenant(tenantId);
      need(t.source(sourceId));
      const row = need(t.files(sourceId).find((file) => file.position === position));
      const bytes = options.files.get(tenantId, row.sha256);
      if (!bytes) throw new KnowledgeError(404, _('not found'));
      return { name: row.name, mime: row.mime, bytes };
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
      const files = t.files(sourceId).map(({ position, name, mime, bytes }) => ({ position, name, mime, bytes }));
      return { source, files, sections };
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
