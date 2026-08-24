/** Database handles: connection pragmas in one place, migrations on request. */

import Database from 'better-sqlite3';

import { runMigrations } from './migrate.js';

export type { Database };

/**
 * Opens a SQLite database with ccledger's pragmas. `':memory:'` is allowed and
 * is what the tests use.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);

  // WAL is what lets the dashboard read while ingest writes. It needs real
  // files on disk, so an in-memory database keeps the default journal.
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  // Off by default in SQLite, and the whole point of requests.member_id being a
  // declared foreign key is that it is enforced.
  db.pragma('foreign_keys = ON');

  // Ingest bursts and the dashboard's reads overlap; wait rather than throwing
  // SQLITE_BUSY at an exporter that would then retry the whole batch.
  db.pragma('busy_timeout = 5000');

  return db;
}

/** Opens a database and brings it up to the latest schema version. */
export function migratedDatabase(path: string): Database.Database {
  const db = openDatabase(path);
  runMigrations(db);
  return db;
}
