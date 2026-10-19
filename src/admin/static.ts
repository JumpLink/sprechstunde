import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The built settings app (`npm run web:build` writes it to `dist/web`). Resolved against this
 * file, so it is found both from `dist/admin` (the build) and from `src/admin` (tsx).
 */
export function findWebDir(here: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  return [resolve(here, '../web'), resolve(here, '../../dist/web')].find((dir) => existsSync(join(dir, 'index.html')));
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Nothing leaves the page but requests to this server; samples are vendor audio or blobs. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // Component libraries set inline `style` attributes (positions, animations).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export interface StaticReply {
  status: number;
  type: string;
  body: Uint8Array;
  headers: Record<string, string>;
}

export type StaticResult = StaticReply | 'not-built' | 'not-found';

/**
 * The file for a URL path, or index.html for a page path (no file extension: the app's router
 * decides what to show). A missing file with an extension is a 404, never index.html, so a
 * stale asset name does not come back as HTML.
 */
export function serveStatic(webDir: string | undefined, urlPath: string): StaticResult {
  if (!webDir) return 'not-built';
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return 'not-found';
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return 'not-found';

  const root = resolve(webDir);
  const wanted = resolve(root, `.${decoded}`);
  if (wanted !== root && !wanted.startsWith(root + sep)) return 'not-found';

  const page = extname(decoded) === '';
  const file = page ? join(root, 'index.html') : wanted;
  if (!existsSync(file) || !statSync(file).isFile()) return 'not-found';

  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const immutable = decoded.startsWith('/assets/');
  return {
    status: 200,
    type,
    body: readFileSync(file),
    headers: {
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      ...(type.startsWith('text/html') && { 'content-security-policy': CSP, 'x-frame-options': 'DENY' }),
    },
  };
}
