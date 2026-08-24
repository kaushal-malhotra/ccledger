/**
 * `server_config`: the handful of values a server remembers about itself.
 *
 * Everything here is a string. The alternative — a column per setting on a
 * one-row table — turns every new setting into a migration, and this table
 * exists precisely for the settings that arrive one at a time.
 */

import type Database from 'better-sqlite3';

/** One `server_config` row. */
interface ConfigRow {
  readonly value: string;
}

/** The stored value for `key`, or `undefined` if it has never been set. */
export function getConfig(db: Database.Database, key: string): string | undefined {
  const row = db
    .prepare<[string], ConfigRow>('SELECT value FROM server_config WHERE key = ?')
    .get(key);
  return row?.value;
}

/** Sets `key`, overwriting any previous value, and stamps when that happened. */
export function setConfig(
  db: Database.Database,
  key: string,
  value: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO server_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/**
 * Sets `key` only if it has no value yet, and returns whichever value is in
 * force afterwards. One statement, so two `serve` processes starting against
 * the same database cannot both decide they are the first.
 */
export function setConfigIfAbsent(
  db: Database.Database,
  key: string,
  value: string,
  now: number = Date.now(),
): string {
  db.prepare(
    'INSERT INTO server_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
  ).run(key, value, now);
  return getConfig(db, key) ?? value;
}
