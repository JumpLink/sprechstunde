/**
 * The original files of document sources, content-addressed: `<root>/<tenant>/<sha256>`. The same
 * bytes uploaded twice are one file. Nothing here is served from a public directory; the admin API
 * hands a file out by source and position.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function createFileStore(root: string) {
  const pathOf = (tenantId: string, sha: string): string => {
    if (!TENANT.test(tenantId) || !SHA256.test(sha)) throw new Error('invalid file reference');
    return join(root, tenantId, sha);
  };

  return {
    /** Stores the bytes and returns their sha256. */
    put(tenantId: string, bytes: Uint8Array): string {
      const sha = sha256Of(bytes);
      const path = pathOf(tenantId, sha);
      if (existsSync(path)) return sha;
      mkdirSync(join(root, tenantId), { recursive: true, mode: 0o700 });
      // Written aside and renamed, so a crash never leaves half a file under its final name.
      const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(temp, bytes, { mode: 0o600 });
        renameSync(temp, path);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
      return sha;
    },

    get(tenantId: string, sha: string): Buffer | undefined {
      const path = pathOf(tenantId, sha);
      return existsSync(path) ? readFileSync(path) : undefined;
    },

    remove(tenantId: string, sha: string): void {
      rmSync(pathOf(tenantId, sha), { force: true });
    },
  };
}

export type FileStore = ReturnType<typeof createFileStore>;
