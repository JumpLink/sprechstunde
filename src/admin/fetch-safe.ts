/**
 * Fetches a web page a customer named, from a server that is meant to be reachable from the
 * internet one day. The address is untrusted input, so every request goes through the same gate:
 *
 * - http(s) only, on the default ports, without credentials in the address;
 * - the name is resolved here, every answer must be a public address (`isPublicAddress`), and the
 *   connection is pinned to the address that was checked, so a second lookup cannot differ;
 * - redirects are followed by hand, at most three, each hop through the same checks;
 * - robots.txt of the host is honoured (cached), and one host is not hit more than once a second;
 * - a deadline, a size cap that also counts decompressed bytes, and a content-type allow-list.
 *
 * DNS and the transport are injected so the tests never touch a network.
 */

import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { _ } from '../i18n.js';
import { isPublicAddress } from './net-guard.js';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsRules } from './robots.js';

export const MAX_REDIRECTS = 3;
export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;
export const HOST_INTERVAL_MS = 1000;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const MAX_ROBOTS_BYTES = 512 * 1024;
const REPO_URL = 'https://github.com/JumpLink/sprechstunde';

export const PAGE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown'];
export const SITEMAP_TYPES = ['application/xml', 'text/xml', 'text/plain'];

export type RefusedCode =
  | 'url'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'dns'
  | 'private'
  | 'robots'
  | 'redirects'
  | 'timeout'
  | 'size'
  | 'type'
  | 'status'
  | 'network';

/** Why a fetch did not happen. `message` is for the person who typed the address. */
export class FetchRefused extends Error {
  constructor(
    readonly code: RefusedCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchRefused';
  }
}

export interface TransportRequest {
  url: URL;
  /** The address `url.hostname` resolved to and passed the check; the connection goes there. */
  address: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** Gives the connection up without reading the rest of the body. */
  close?: () => void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (host: string) => Promise<string[]>;

export interface SafeFetchOptions {
  resolve?: Resolver;
  transport?: Transport;
  userAgent?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxBytes?: number;
  timeoutMs?: number;
  hostIntervalMs?: number;
}

export interface FetchRequest {
  /** Content types that may be returned; lower case, without parameters. */
  types?: string[];
  /** Skip robots.txt: only for robots.txt itself. */
  ignoreRobots?: boolean;
}

export interface FetchResult {
  /** The address after redirects. */
  url: string;
  contentType: string;
  text: string;
}

function version(): string {
  try {
    const file = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(file) as { version?: string }).version ?? '0';
  } catch {
    return '0';
  }
}

export const defaultUserAgent = (): string => `sprechstunde/${version()} (+${REPO_URL})`;

const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);

const DECODERS = {
  gzip: createGunzip,
  'x-gzip': createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
} as const;

// Own agents: the global one follows NODE_USE_ENV_PROXY, which would send the request through a proxy
// and so around the address pinned below.
const agents = { 'http:': new http.Agent(), 'https:': new https.Agent() };

/** The real thing: node:http(s), connecting to the checked address while keeping name and TLS host. */
export const nodeTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(address);
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        signal,
        agent: agents[url.protocol === 'https:' ? 'https:' : 'http:'],
        ...(isIP(host) === 0 && { servername: host }),
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
      (response) => {
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') out[name] = value;
          else if (Array.isArray(value)) out[name] = value.join(', ');
        }
        const encoding = (out['content-encoding'] ?? '').trim().toLowerCase();
        const decoder = encoding in DECODERS ? DECODERS[encoding as keyof typeof DECODERS]() : undefined;
        let body: AsyncIterable<Uint8Array> = response;
        if (decoder) {
          response.on('error', (error) => decoder.destroy(error));
          response.pipe(decoder);
          body = decoder;
        }
        resolve({ status: response.statusCode ?? 0, headers: out, body, close: () => response.destroy() });
      },
    );
    request.on('error', reject);
    request.end();
  });

const MAX_TRACKED_HOSTS = 500;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function createSafeFetcher(options: SafeFetchOptions = {}) {
  const resolveHost = options.resolve ?? dnsResolver;
  const transport = options.transport ?? nodeTransport;
  const userAgent = options.userAgent ?? defaultUserAgent();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const interval = options.hostIntervalMs ?? HOST_INTERVAL_MS;

  /** Oldest entries go first, so a stream of new hosts cannot grow the maps without end. */
  const capped = (map: Map<string, unknown>): void => {
    while (map.size > MAX_TRACKED_HOSTS) map.delete(map.keys().next().value!);
  };
  const robotsCache = new Map<string, { rules: RobotsRules; until: number }>();
  const nextSlot = new Map<string, number>();

  const check = (url: URL): void => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new FetchRefused('scheme', _('only http and https addresses can be fetched'));
    }
    if (url.username || url.password) {
      throw new FetchRefused('credentials', _('an address with a user name or password is not accepted'));
    }
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (port !== '80' && port !== '443') {
      throw new FetchRefused('port', _('only the default web ports are accepted'));
    }
  };

  const addressOf = async (url: URL): Promise<string> => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    if (isIP(host) !== 0) addresses = [host];
    else {
      try {
        addresses = await resolveHost(host);
      } catch {
        throw new FetchRefused('dns', _('the host name could not be resolved'));
      }
    }
    if (addresses.length === 0) throw new FetchRefused('dns', _('the host name could not be resolved'));
    // One private answer among public ones is enough to refuse: the resolver chooses which is used.
    if (!addresses.every(isPublicAddress)) {
      throw new FetchRefused('private', _('this address leads to a private or internal network'));
    }
    return addresses[0]!;
  };

  /** One slot per host and interval, handed out in order. */
  const wait = async (host: string): Promise<void> => {
    const at = Math.max(now(), nextSlot.get(host) ?? 0);
    nextSlot.set(host, at + interval);
    capped(nextSlot);
    const delay = at - now();
    if (delay > 0) await sleep(delay);
  };

  const read = async (
    body: AsyncIterable<Uint8Array>,
    declared: string | undefined,
    limit: number,
  ): Promise<Buffer> => {
    if (declared !== undefined && Number(declared) > limit) {
      throw new FetchRefused('size', _('the page is too large'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > limit) throw new FetchRefused('size', _('the page is too large'));
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  const decode = (bytes: Buffer, contentType: string): string => {
    const label = new RegExp('charset=["\']?([\\w-]+)', 'i').exec(contentType)?.[1] ?? 'utf-8';
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  };

  /** The request without robots; the caller has done that. Follows redirects, each hop checked. */
  const get = async (
    start: URL,
    request: FetchRequest,
    limit: number,
    signal: AbortSignal,
    robots: (url: URL) => Promise<void>,
  ): Promise<FetchResult> => {
    let url = start;
    let open: TransportResponse | undefined;
    try {
      return await hops();
    } finally {
      open?.close?.();
    }

    async function hops(): Promise<FetchResult> {
      for (let hop = 0; ; hop++) {
        open?.close?.();
        check(url);
        const address = await addressOf(url);
        await robots(url);
        await wait(url.host);
        let response: TransportResponse;
        try {
          response = await transport({
            url,
            address,
            signal,
            headers: {
              'user-agent': userAgent,
              accept: (request.types ?? PAGE_TYPES).join(', '),
              'accept-encoding': 'gzip, deflate, br',
              host: url.host,
            },
          });
          open = response;
        } catch (error) {
          if (error instanceof FetchRefused) throw error;
          if (signal.aborted) throw new FetchRefused('timeout', _('the page took too long to answer'));
          throw new FetchRefused('network', _('the page could not be fetched'));
        }
        if (REDIRECTS.has(response.status)) {
          const location = response.headers.location;
          if (!location) throw new FetchRefused('status', _('the page answered with a redirect without a target'));
          if (hop >= MAX_REDIRECTS) throw new FetchRefused('redirects', _('the page redirects too often'));
          try {
            url = new URL(location, url);
          } catch {
            throw new FetchRefused('url', _('the page redirects to an invalid address'));
          }
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new FetchRefused('status', _('the page answered with an error'), response.status);
        }
        const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (!(request.types ?? PAGE_TYPES).includes(contentType)) {
          throw new FetchRefused('type', _('the page is not a kind of document that can be read'));
        }
        try {
          const bytes = await read(response.body, response.headers['content-length'], limit);
          return { url: url.href, contentType, text: decode(bytes, response.headers['content-type'] ?? '') };
        } catch (error) {
          if (error instanceof FetchRefused) throw error;
          if (signal.aborted) throw new FetchRefused('timeout', _('the page took too long to answer'));
          throw new FetchRefused('network', _('the page could not be fetched'));
        }
      }
    }
  };

  const robotsFor = async (url: URL, signal: AbortSignal): Promise<RobotsRules> => {
    const key = url.origin;
    const cached = robotsCache.get(key);
    if (cached && cached.until > now()) return cached.rules;
    const address = new URL('/robots.txt', url);
    let rules: RobotsRules;
    let ttl = ROBOTS_TTL_MS;
    try {
      const result = await get(
        address,
        { types: ['text/plain'], ignoreRobots: true },
        MAX_ROBOTS_BYTES,
        signal,
        async () => {},
      );
      rules = parseRobots(result.text, userAgent.split('/')[0]!);
    } catch (error) {
      if (error instanceof FetchRefused && error.code === 'status' && (error.status ?? 0) < 500) {
        rules = ALLOW_ALL; // no robots.txt
      } else if (error instanceof FetchRefused && (error.code === 'type' || error.code === 'size')) {
        rules = ALLOW_ALL;
      } else if (error instanceof FetchRefused && (error.code === 'private' || error.code === 'scheme')) {
        throw error;
      } else {
        // A server error or silence: we cannot know what the site wants, so we do not go. Ask again soon.
        rules = DISALLOW_ALL;
        ttl = 60_000;
      }
    }
    robotsCache.set(key, { rules, until: now() + ttl });
    capped(robotsCache);
    return rules;
  };

  return {
    /** Fetches one page; throws `FetchRefused` for everything that is not a readable 2xx answer. */
    async fetch(address: string, request: FetchRequest = {}): Promise<FetchResult> {
      let start: URL;
      try {
        start = new URL(address);
      } catch {
        throw new FetchRefused('url', _('this is not a valid web address'));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await get(start, request, maxBytes, controller.signal, async (url) => {
          if (request.ignoreRobots) return;
          const rules = await robotsFor(url, controller.signal);
          if (!rules.allowed(`${url.pathname}${url.search}`)) {
            throw new FetchRefused('robots', _('the site asks robots not to fetch this page'));
          }
        });
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}

export type SafeFetcher = ReturnType<typeof createSafeFetcher>;
