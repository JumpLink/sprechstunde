import { _ } from '../i18n.js';
import { PROFILE_FILE } from '../core/settings.js';
import { MAX_UPLOAD_BYTES } from './file-kinds.js';
import { KnowledgeError, type KnowledgeService, type NewSourceInput } from './knowledge-service.js';

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Parsed lazily: a GET has no body to read. */
  body: () => Promise<Record<string, unknown>>;
  /** The body as it is, for an upload; refuses one above `limit` bytes. */
  raw: (limit: number) => Promise<Buffer>;
  header: (name: string) => string | undefined;
}

export interface ApiResult {
  status: number;
  payload: unknown;
  /** An original file to hand out instead of JSON. */
  file?: { name: string; mime: string; bytes: Buffer };
}

export interface KnowledgeApiOptions {
  service: KnowledgeService;
  tenantId: string;
  /** True when the profile file exists: a source belongs to a venue that can take calls. */
  venueExists: (file: string) => boolean;
  /** Who made a hand edit; shown in the history. */
  author?: string;
  now?: () => number;
}

const REFRESH_COOLDOWN_MS = 60_000;
const PREFIX = '/api/knowledge/';
const ID = /^[A-Za-z0-9]{1,40}$/;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const list = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;

/** Routes under `/api/knowledge/…`; undefined for any other path. Errors are `KnowledgeError`s. */
export function createKnowledgeApi(options: KnowledgeApiOptions) {
  const { service, tenantId } = options;
  const refreshing = new Set<string>();
  const lastRefresh = new Map<string, number>();
  const now = options.now ?? Date.now;

  const venueOf = (value: unknown): string => {
    const file = text(value);
    if (!file || !PROFILE_FILE.test(file)) {
      throw new KnowledgeError(400, _('"venue" must be the name of a .json file in the profiles directory'));
    }
    if (!options.venueExists(file)) throw new KnowledgeError(404, _('no such venue'));
    return file;
  };
  const idOf = (value: string | undefined): string => {
    if (!value || !ID.test(value)) throw new KnowledgeError(400, _('invalid id'));
    return value;
  };
  const numberId = (value: string | undefined): number => {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) throw new KnowledgeError(400, _('invalid id'));
    return id;
  };

  async function handle(request: ApiRequest): Promise<ApiResult | undefined> {
    if (!request.path.startsWith(PREFIX)) return undefined;
    const parts = request.path.slice(PREFIX.length).split('/');
    const [area, id, action] = parts;
    const { method } = request;
    const ok = (payload: unknown, status = 200): ApiResult => ({ status, payload });

    if (area === 'sources' && parts.length === 1) {
      if (method === 'GET') return ok(service.overview(tenantId, venueOf(request.query.get('venue'))));
      if (method === 'POST') {
        const wanted = await request.body();
        const input: NewSourceInput = {
          venue: venueOf(wanted.venue),
          kind: wanted.kind as NewSourceInput['kind'],
          title: text(wanted.title) ?? '',
          url: text(wanted.url),
          markdown: text(wanted.markdown),
          includeGlobs: list(wanted.includeGlobs),
          excludeSelectors: list(wanted.excludeSelectors),
          refreshHours: wanted.refreshHours === null ? null : (wanted.refreshHours as number | undefined),
          autoApprove: wanted.autoApprove === true,
          author: options.author,
        };
        return ok(await service.addSource(tenantId, input), 201);
      }
    }

    if (area === 'sources' && parts.length === 2) {
      const sourceId = idOf(id);
      if (method === 'GET') return ok(service.detail(tenantId, sourceId));
      if (method === 'PUT') {
        const wanted = await request.body();
        return ok(
          service.updateSource(tenantId, sourceId, {
            title: text(wanted.title),
            includeGlobs: list(wanted.includeGlobs),
            excludeSelectors: list(wanted.excludeSelectors),
            refreshHours: wanted.refreshHours === null ? null : (wanted.refreshHours as number | undefined),
            autoApprove: typeof wanted.autoApprove === 'boolean' ? wanted.autoApprove : undefined,
          }),
        );
      }
      if (method === 'DELETE') {
        service.removeSource(tenantId, sourceId);
        return ok({ ok: true });
      }
    }

    if (area === 'sources' && parts.length === 3 && action === 'refresh' && method === 'POST') {
      const sourceId = idOf(id);
      if (refreshing.has(sourceId)) throw new KnowledgeError(409, _('this source is being fetched right now'));
      const wait = Math.ceil(((lastRefresh.get(sourceId) ?? 0) + REFRESH_COOLDOWN_MS - now()) / 1000);
      if (wait > 0) {
        throw new KnowledgeError(429, _('this source was fetched a moment ago: try again shortly'), wait);
      }
      refreshing.add(sourceId);
      lastRefresh.set(sourceId, now());
      if (lastRefresh.size > 500) lastRefresh.delete(lastRefresh.keys().next().value!);
      try {
        return ok(await service.refresh(tenantId, sourceId));
      } finally {
        refreshing.delete(sourceId);
      }
    }

    if (area === 'sources' && action === 'files') {
      const sourceId = idOf(id);
      if (parts.length === 3 && method === 'POST') {
        // The name travels in a header, URI-encoded: the body is the file and nothing else.
        let name: string | undefined;
        try {
          name = decodeURIComponent(request.header('x-file-name') ?? '');
        } catch {
          name = undefined;
        }
        return ok(service.addFile(tenantId, sourceId, { name, bytes: await request.raw(MAX_UPLOAD_BYTES) }), 201);
      }
      if (parts.length === 3 && method === 'DELETE') {
        service.clearFiles(tenantId, sourceId);
        return ok({ ok: true });
      }
      if (parts.length === 4 && method === 'GET') {
        return { status: 200, payload: null, file: service.file(tenantId, sourceId, numberId(parts[3])) };
      }
    }

    if (area === 'sections' && parts.length === 3 && action === 'history' && method === 'GET') {
      return ok(service.history(tenantId, idOf(id)));
    }

    if (area === 'sections' && parts.length === 2 && method === 'PUT') {
      const wanted = await request.body();
      const base = wanted.baseRevisionId;
      if (base !== null && typeof base !== 'number') {
        throw new KnowledgeError(400, _('"baseRevisionId" must be the revision the page loaded, or null'));
      }
      return ok(
        service.edit(tenantId, idOf(id), {
          markdown: wanted.markdown as string,
          title: text(wanted.title),
          baseRevisionId: base,
          author: options.author,
        }),
      );
    }

    if (area === 'revisions' && parts.length === 3 && method === 'POST') {
      const revisionId = numberId(id);
      if (action === 'approve') service.approve(tenantId, revisionId);
      else if (action === 'reject') service.reject(tenantId, revisionId);
      else return undefined;
      return ok({ ok: true });
    }

    if (area === 'published' && parts.length === 1 && method === 'GET') {
      const venue = venueOf(request.query.get('venue'));
      return ok({ text: service.published(tenantId, venue), stale: service.isStale(tenantId, venue) });
    }

    return undefined;
  }

  return async function route(request: ApiRequest): Promise<ApiResult | undefined> {
    const result = await handle(request);
    // The change is saved; the UI is told when the bot's copy of it is still being written.
    const payload = result?.payload;
    if (
      result &&
      request.method !== 'GET' &&
      service.hasStale() &&
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
    ) {
      return { ...result, payload: { ...payload, publishFailed: true } };
    }
    return result;
  };
}

export type KnowledgeApi = ReturnType<typeof createKnowledgeApi>;
