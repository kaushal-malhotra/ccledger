/**
 * Forward-only migration runner. The schema itself lives in `schema.sql`;
 * this file owns `schema_version` and the order things are applied in.
 */

import { existsSync, readFileSync } from 'node:fs';

import type Database from 'better-sqlite3';

import {
  UNATTRIBUTED_MEMBER_ID,
  UNATTRIBUTED_MEMBER_NAME,
  UNATTRIBUTED_TOKEN_HASH,
} from '../shared/constants.js';

/** One numbered, irreversible step. `up` runs inside a transaction. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database.Database) => void;
}

/** Bookkeeping table the runner owns; deliberately not in `schema.sql`. */
const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
`;

/**
 * Locates `schema.sql` for both layouts: next to the compiled module in
 * `dist/db/` after `npm run build`, and next to the source under vitest. No
 * `__dirname` — this package is ESM.
 */
function readSchemaSql(): string {
  const alongside = new URL('./schema.sql', import.meta.url);
  if (existsSync(alongside)) {
    return readFileSync(alongside, 'utf8');
  }

  // A `dist/` build whose asset copy step did not run. Fall back to the source
  // tree rather than failing with an opaque ENOENT from inside a transaction.
  const inSourceTree = new URL('../../src/db/schema.sql', import.meta.url);
  if (existsSync(inSourceTree)) {
    return readFileSync(inSourceTree, 'utf8');
  }

  throw new Error(
    `schema.sql not found at ${alongside.href} or ${inSourceTree.href}; ` +
      'the build asset copy step did not run',
  );
}

/** Every migration, ascending. Append only — published versions are immutable. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(readSchemaSql());
    },
  },
  {
    version: 2,
    name: 'seed-unattributed-member',
    up: (db) => {
      // `requests.member_id` and `installs.member_id` are NOT NULL foreign keys
      // and stage 1 has no auth, so without this row every ingest insert fails.
      db.prepare(
        'INSERT OR IGNORE INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
      ).run(UNATTRIBUTED_MEMBER_ID, UNATTRIBUTED_MEMBER_NAME, UNATTRIBUTED_TOKEN_HASH, Date.now());
    },
  },
];

/** Highest version this build knows how to apply. */
const LATEST_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

/** Reads `version` off a `SELECT max(version)` row without trusting its shape. */
function versionOf(row: unknown): number {
  if (typeof row !== 'object' || row === null) {
    return 0;
  }
  const value = (row as { version?: unknown }).version;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Highest applied migration version, or 0 on a database that has never been
 * migrated. Creates `schema_version` if it is missing.
 */
export function currentVersion(db: Database.Database): number {
  db.exec(SCHEMA_VERSION_DDL);
  return versionOf(db.prepare('SELECT max(version) AS version FROM schema_version').get());
}

/**
 * Applies every migration newer than the database's current version and
 * returns how many ran. Re-running is a no-op.
 */
export function runMigrations(db: Database.Database): number {
  const from = currentVersion(db);

  if (from > LATEST_VERSION) {
    throw new Error(
      `database is at schema version ${from} but this ccledger build only knows up to ` +
        `${LATEST_VERSION}; migrations are forward-only, so upgrade ccledger rather than ` +
        'downgrading the database',
    );
  }

  const stamp = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  );

  // One transaction per migration, not one for the batch: a failure at step N
  // leaves steps 1..N-1 applied and stamped, so the retry resumes rather than
  // starting over.
  const applyOne = db.transaction((migration: Migration) => {
    migration.up(db);
    stamp.run(migration.version, migration.name, Date.now());
  });

  let applied = 0;
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= from) {
      continue;
    }
    applyOne(migration);
    applied += 1;
  }

  return applied;
}
