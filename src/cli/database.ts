/**
 * Opening the database from a command, with the two failures that actually
 * happen turned into sentences: a `--db` path nothing can be written to, and a
 * database from a newer ccledger than the one being run.
 *
 * better-sqlite3's own message for the first is "unable to open database file",
 * which does not say which file — and on Windows the answer is usually that the
 * relative path resolved somewhere other than where the operator was looking.
 */

import { resolve } from 'node:path';

import type { Database } from '../db/index.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { fail, messageOf, warn } from './io.js';

/**
 * Opens and migrates the database, or exits 1 with the reason. Migrations run
 * on every command that touches the file, not just `serve`, so `invite` against
 * a database that has never been served still finds the tables it needs.
 */
export function openMigratedDatabase(path: string): Database.Database {
  const absolute = resolve(path);
  let db: Database.Database;
  try {
    db = openDatabase(path);
  } catch (error) {
    fail(`cannot open database at ${absolute}: ${messageOf(error)}`);
  }

  try {
    const applied = runMigrations(db);
    if (applied > 0) {
      warn(`applied ${String(applied)} migration${applied === 1 ? '' : 's'}`);
    }
  } catch (error) {
    // A half-applied migration is rolled back by the runner; the file is still
    // the user's, so close the handle rather than leaving a WAL behind.
    db.close();
    fail(`cannot migrate database at ${absolute}: ${messageOf(error)}`);
  }
  return db;
}
