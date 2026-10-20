import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = 'var/db/sprechstunde.sqlite';

export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  const wanted = env.SPRECHSTUNDE_DB || DEFAULT_DB_PATH;
  return wanted === ':memory:' ? wanted : resolve(wanted);
}

/**
 * Schema versions, applied in order and recorded in `PRAGMA user_version`. A released entry is never
 * edited: a change is a new entry at the end. Every table carries `tenant_id` (ADR 1).
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE source (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    venue TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'web', 'sitemap')),
    title TEXT NOT NULL,
    url TEXT,
    include_globs TEXT NOT NULL DEFAULT '[]',
    exclude_selectors TEXT NOT NULL DEFAULT '[]',
    refresh_hours INTEGER,
    auto_approve INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_fetched_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );
  CREATE INDEX source_venue ON source (tenant_id, venue);

  CREATE TABLE section (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT,
    title TEXT NOT NULL,
    live_revision_id INTEGER,
    gone INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, source_id) REFERENCES source (tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX section_source ON section (tenant_id, source_id);

  CREATE TABLE revision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('fetched', 'edited')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    title TEXT NOT NULL,
    url TEXT,
    markdown TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    fetched_at TEXT,
    author TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (tenant_id, section_id) REFERENCES section (tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX revision_section ON revision (tenant_id, section_id, id);
  `,
  // Document sources. SQLite cannot widen a CHECK, so `source` is rebuilt (see `migrate` for why the
  // foreign keys are off meanwhile). `ocr_sha` names the set of files the live reading came from, so
  // the same files are never read, and paid for, twice.
  `
  CREATE TABLE source_next (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    venue TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'web', 'sitemap', 'pdf', 'image')),
    title TEXT NOT NULL,
    url TEXT,
    include_globs TEXT NOT NULL DEFAULT '[]',
    exclude_selectors TEXT NOT NULL DEFAULT '[]',
    refresh_hours INTEGER,
    auto_approve INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_fetched_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    ocr_sha TEXT,
    ocr_pages INTEGER,
    PRIMARY KEY (tenant_id, id)
  );
  INSERT INTO source_next (tenant_id, id, venue, kind, title, url, include_globs, exclude_selectors, refresh_hours,
    auto_approve, last_checked_at, last_fetched_at, last_error, created_at)
    SELECT tenant_id, id, venue, kind, title, url, include_globs, exclude_selectors, refresh_hours,
      auto_approve, last_checked_at, last_fetched_at, last_error, created_at FROM source;
  DROP TABLE source;
  ALTER TABLE source_next RENAME TO source;
  CREATE INDEX source_venue ON source (tenant_id, venue);

  CREATE TABLE source_file (
    tenant_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, source_id, position),
    FOREIGN KEY (tenant_id, source_id) REFERENCES source (tenant_id, id) ON DELETE CASCADE
  );
  CREATE INDEX source_file_sha ON source_file (tenant_id, sha256);
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) {
    throw new Error(`the database is from a newer version (schema ${row.user_version})`);
  }
  // Rebuilding a table another one points at means dropping it, and with foreign keys on, that would
  // cascade into the children. The pragma is a no-op inside a transaction, so it is switched here, and
  // `foreign_key_check` stands in for it before each commit.
  const keys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let version = row.user_version; version < MIGRATIONS.length; version++) {
      db.exec('BEGIN');
      try {
        db.exec(MIGRATIONS[version]!);
        if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error(`migration ${version + 1} left rows without their parent`);
        }
        db.exec(`PRAGMA user_version = ${version + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${keys ? 'ON' : 'OFF'}`);
  }
}

/** `:memory:` for tests; a file is created with its directory. */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}
