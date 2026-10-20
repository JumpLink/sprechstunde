import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cleanSnapshotTemps, publishSnapshot, renderSnapshot, snapshotPath } from '../core/knowledge-snapshot.js';
import { DEFAULT_TENANT, profileFilePath } from '../core/settings.js';
import { createSafeFetcher, type SafeFetcher } from './fetch-safe.js';
import { createFileStore } from './file-store.js';
import { dbPath, openDb } from './knowledge-db.js';
import { createKnowledgeApi } from './knowledge-api.js';
import { createKnowledgeRepo } from './knowledge-repo.js';
import { createKnowledgeService, type KnowledgeService } from './knowledge-service.js';
import { mistralOcr, type Ocr } from './ocr.js';

export const SCHEDULE_INTERVAL_MS = 10 * 60 * 1000;

/** Refreshes every source whose interval has passed, one after the other; one failure does not stop the rest. */
export async function runDue(
  service: KnowledgeService,
  tenantId: string,
  log: (message: string) => void = console.error,
): Promise<number> {
  let done = 0;
  for (const source of service.due(tenantId)) {
    try {
      await service.refresh(tenantId, source.id);
      done++;
    } catch (error) {
      log(`knowledge refresh failed: ${(error as Error).message}`);
    }
  }
  return done;
}

/**
 * The database, the service and the API of one admin process. The snapshot goes next to the
 * profile, so the agent finds it where it finds the profile; a tenant other than the default has no
 * profiles directory of its own yet and publishes nothing.
 */
export function createKnowledgeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: SafeFetcher = createSafeFetcher(),
  ocr: Ocr = mistralOcr(),
) {
  const database = dbPath(env);
  const repo = createKnowledgeRepo(openDb(database));
  // The originals sit next to the database, so one backup of `var/db` holds both.
  const files = createFileStore(
    database === ':memory:' ? mkdtempSync(join(tmpdir(), 'sprechstunde-files-')) : join(dirname(database), 'files'),
  );
  const service = createKnowledgeService({
    repo,
    fetcher,
    files,
    ocr,
    render: renderSnapshot,
    publish: (tenantId, venue, text) => {
      if (tenantId !== DEFAULT_TENANT) return;
      const path = snapshotPath(venue, env);
      if (path) publishSnapshot(path, text);
    },
  });
  const api = createKnowledgeApi({
    service,
    tenantId: DEFAULT_TENANT,
    venueExists: (file) => {
      const path = profileFilePath(file, env);
      return path !== null && existsSync(path);
    },
  });
  // A snapshot lost or left stale (restored database, edited by hand) is rebuilt at start.
  const cleaned = new Set<string>();
  for (const { tenantId, venue } of repo.venues()) {
    const path = tenantId === DEFAULT_TENANT ? snapshotPath(venue, env) : null;
    if (path && !cleaned.has(dirname(path))) {
      cleaned.add(dirname(path));
      cleanSnapshotTemps(dirname(path));
    }
    service.republish(tenantId, venue);
  }
  return { repo, service, api };
}
