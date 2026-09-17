import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import { migratedDatabase, openDatabase } from './index.js';
import { MIGRATIONS, currentVersion, runMigrations } from './migrate.js';
import {
  UNATTRIBUTED_MEMBER_ID,
  UNATTRIBUTED_MEMBER_NAME,
  UNATTRIBUTED_TOKEN_HASH,
} from '../shared/constants.js';

/**
 * Tables `schema.sql` defines, plus the runner’s own bookkeeping table and the
 * two identity tables migration 3 adds.
 */
const EXPECTED_TABLES = [
  'alert_fires',
  'alert_rules',
  'installs',
  'join_codes',
  'members',
  'requests',
  'schema_version',
  'server_config',
];

/** The three indexes `schema.sql` requires, as `[name, columns]`. */
const EXPECTED_INDEXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['idx_requests_ts', ['ts']],
  ['idx_requests_member_ts', ['member_id', 'ts']],
  ['idx_requests_model', ['model']],
];

/** `requests` columns in declared order, straight from `schema.sql`. */
const REQUESTS_COLUMNS = [
  'id',
  'ts',
  'member_id',
  'install_id',
  'session_id',
  'prompt_id',
  'model',
  'model_family',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_micros',
  'duration_ms',
  'query_source',
  'speed',
  'effort',
  'profile_name',
];

const LATEST_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

/** Handles and paths to tear down after each test. */
const openHandles: Database.Database[] = [];
const tempPaths: string[] = [];

/** A unique, unused path under the OS temp directory. */
function tempDbPath(): string {
  const path = join(tmpdir(), `ccledger-migrate-${randomUUID()}.db`);
  tempPaths.push(path);
  return path;
}

/** Opens an unmigrated database and registers it for teardown. */
function open(path: string): Database.Database {
  const db = openDatabase(path);
  openHandles.push(db);
  return db;
}

afterEach(() => {
  for (const db of openHandles.splice(0)) {
    db.close();
  }
  for (const path of tempPaths.splice(0)) {
    // WAL leaves sidecar files next to the database.
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

/** Pulls a `name` column off sqlite rows, failing loudly on an unexpected shape. */
function names(rows: readonly unknown[]): string[] {
  return rows.map((row) => {
    if (typeof row === 'object' && row !== null) {
      const value = (row as { name?: unknown }).name;
      if (typeof value === 'string') {
        return value;
      }
    }
    throw new Error(`row has no string name: ${JSON.stringify(row)}`);
  });
}

/** Reads an `n` count column off a single aggregate row. */
function count(row: unknown): number {
  if (typeof row === 'object' && row !== null) {
    const value = (row as { n?: unknown }).n;
    if (typeof value === 'number') {
      return value;
    }
  }
  throw new Error(`row has no numeric n: ${JSON.stringify(row)}`);
}

/** Table names present in the database, sorted. */
function tableNames(db: Database.Database): string[] {
  return names(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all(),
  ).sort();
}

describe('runMigrations', () => {
  it('applies every migration to a fresh database', () => {
    const db = open(':memory:');

    const applied = runMigrations(db);

    expect(applied).toBe(MIGRATIONS.length);
    expect(currentVersion(db)).toBe(LATEST_VERSION);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it('records one schema_version row per migration, with its name', () => {
    const db = open(tempDbPath());

    runMigrations(db);

    const rows = names(db.prepare('SELECT name FROM schema_version ORDER BY version').all());
    expect(rows).toEqual(MIGRATIONS.map((migration) => migration.name));
  });

  it('applies nothing on a second run and leaves schema_version untouched', () => {
    const db = open(tempDbPath());

    expect(runMigrations(db)).toBe(MIGRATIONS.length);
    const before = db.prepare('SELECT version, name, applied_at FROM schema_version').all();

    expect(runMigrations(db)).toBe(0);

    const after = db.prepare('SELECT version, name, applied_at FROM schema_version').all();
    expect(after).toEqual(before);
    expect(currentVersion(db)).toBe(LATEST_VERSION);
  });

  it('seeds the placeholder member exactly once across two runs', () => {
    const db = open(':memory:');

    runMigrations(db);
    runMigrations(db);

    expect(count(db.prepare('SELECT count(*) AS n FROM members').get())).toBe(1);
    const member = db.prepare('SELECT id, display_name, token_hash FROM members').get();
    expect(member).toMatchObject({
      id: UNATTRIBUTED_MEMBER_ID,
      display_name: UNATTRIBUTED_MEMBER_NAME,
      token_hash: UNATTRIBUTED_TOKEN_HASH,
    });
  });

  it('creates the three indexes `schema.sql` requires', () => {
    const db = open(':memory:');
    runMigrations(db);

    const present = names(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests'")
        .all(),
    );

    for (const [index, columns] of EXPECTED_INDEXES) {
      expect(present).toContain(index);
      expect(names(db.prepare('SELECT name FROM pragma_index_info(?)').all(index))).toEqual(
        columns,
      );
    }
  });

  it('refuses to run against a database stamped ahead of this build', () => {
    const db = open(':memory:');
    runMigrations(db);

    db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
      LATEST_VERSION + 1,
      'from-a-newer-ccledger',
      Date.now(),
    );

    expect(() => runMigrations(db)).toThrow(/forward-only/);
  });

  it('finds and applies schema.sql when loaded from src, under vitest', () => {
    expect(existsSync(new URL('./schema.sql', import.meta.url))).toBe(true);

    const db = open(':memory:');
    runMigrations(db);

    expect(names(db.prepare('SELECT name FROM pragma_table_info(?)').all('requests'))).toEqual(
      REQUESTS_COLUMNS,
    );
    // "window" is a SQLite keyword; an unquoted column would have failed exec.
    expect(names(db.prepare('SELECT name FROM pragma_table_info(?)').all('alert_rules'))).toContain(
      'window',
    );
  });
});

describe('migration 3, identity', () => {
  it('adds the join_codes columns the single-use claim depends on', () => {
    const db = open(':memory:');
    runMigrations(db);

    expect(names(db.prepare('SELECT name FROM pragma_table_info(?)').all('join_codes'))).toEqual([
      'code',
      'display_name',
      'created_at',
      'expires_at',
      'used_at',
      'member_id',
    ]);
  });

  it('widens members rather than replacing it, keeping the seeded row', () => {
    const db = open(':memory:');
    runMigrations(db);

    const columns = names(db.prepare('SELECT name FROM pragma_table_info(?)').all('members'));
    expect(columns).toEqual([
      'id',
      'display_name',
      'token_hash',
      'created_at',
      'revoked_at',
      'join_hostname',
      'join_os',
    ]);
    // Migration 2 seeded a row before migration 3 altered the table; an ALTER
    // that dropped and recreated it would have taken that row with it.
    expect(count(db.prepare('SELECT count(*) AS n FROM members').get())).toBe(1);
  });

  it('is safe to re-apply by hand against an already-migrated database', () => {
    const db = open(':memory:');
    runMigrations(db);

    // What an operator recovering a half-stamped database would do. The
    // ALTERs are guarded on pragma_table_info, so this must not throw.
    const identity = MIGRATIONS.find((migration) => migration.name === 'identity');
    expect(identity).toBeDefined();
    expect(() => identity?.up(db)).not.toThrow();
  });

  it('stores server_config as a key/value table', () => {
    const db = open(':memory:');
    runMigrations(db);

    expect(names(db.prepare('SELECT name FROM pragma_table_info(?)').all('server_config'))).toEqual(
      ['key', 'value', 'updated_at'],
    );
  });
});

describe('foreign keys', () => {
  it('rejects a requests row whose member is absent', () => {
    const db = migratedDatabase(':memory:');
    openHandles.push(db);

    expect(() =>
      db
        .prepare('INSERT INTO requests (id, ts, member_id) VALUES (?, ?, ?)')
        .run('req-1', 1787503991194, 'no-such-member'),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('accepts a requests row owned by the seeded placeholder member', () => {
    const db = migratedDatabase(tempDbPath());
    openHandles.push(db);

    const info = db
      .prepare('INSERT INTO requests (id, ts, member_id) VALUES (?, ?, ?)')
      .run('req-1', 1787503991194, UNATTRIBUTED_MEMBER_ID);

    expect(info.changes).toBe(1);
  });
});
