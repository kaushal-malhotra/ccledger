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
 * Locates a `.sql` asset for both layouts: next to the compiled module in
 * `dist/db/` after `npm run build`, and next to the source under vitest. No
 * `__dirname` — this package is ESM.
 */
function readSqlAsset(filename: string): string {
  const alongside = new URL(`./${filename}`, import.meta.url);
  if (existsSync(alongside)) {
    return readFileSync(alongside, 'utf8');
  }

  // A `dist/` build whose asset copy step did not run. Fall back to the source
  // tree rather than failing with an opaque ENOENT from inside a transaction.
  const inSourceTree = new URL(`../../src/db/${filename}`, import.meta.url);
  if (existsSync(inSourceTree)) {
    return readFileSync(inSourceTree, 'utf8');
  }

  throw new Error(
    `${filename} not found at ${alongside.href} or ${inSourceTree.href}; ` +
      'the build asset copy step did not run',
  );
}

/** True when `table` already has a column called `column`. */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  // `pragma_table_info` is a table-valued function, so the table name binds as
  // a parameter instead of being interpolated into the SQL.
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
  return rows.some((row) => (row as { name?: unknown }).name === column);
}

/**
 * `ALTER TABLE ... ADD COLUMN`, skipped when the column is already there.
 * SQLite has no `IF NOT EXISTS` for this, and the alternative — letting the
 * duplicate-column error through — would be indistinguishable from a real
 * failure inside the migration transaction.
 */
function addColumn(db: Database.Database, table: string, column: string, type: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Every migration, ascending. Append only — published versions are immutable. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(readSqlAsset('schema.sql'));
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
  {
    version: 3,
    name: 'identity',
    up: (db) => {
      db.exec(readSqlAsset('schema-identity.sql'));
      // What machine a token was first issued for. Two people called "Alex"
      // are otherwise indistinguishable in the members list, and this is the
      // only place the information is available — OTLP carries no hostname.
      addColumn(db, 'members', 'join_hostname', 'TEXT');
      addColumn(db, 'members', 'join_os', 'TEXT');
    },
  },
  {
    version: 4,
    name: 'alerting',
    up: (db) => {
      db.exec(readSqlAsset('schema-alerts.sql'));
      // When a rule was written and when it was last edited. Neither is in the
      // the original column list because neither is needed to evaluate a rule; both
      // are needed to show one, and "who changed the budget on Tuesday" is the
      // first question asked after an alert nobody expected.
      addColumn(db, 'alert_rules', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'alert_rules', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
      // What became of the webhook. A fire is recorded before delivery is
      // attempted — that is what makes the debounce atomic — so without these
      // the row would say a notification went out when it may not have.
      addColumn(db, 'alert_fires', 'delivery_status', "TEXT NOT NULL DEFAULT 'pending'");
      addColumn(db, 'alert_fires', 'delivery_error', 'TEXT');
      addColumn(db, 'alert_fires', 'delivered_at', 'INTEGER');
      addColumn(db, 'alert_fires', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
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
