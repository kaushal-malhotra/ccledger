/**
 * `ccledger backup <path>`.
 *
 * Copying a live SQLite file with `cp` is the mistake this command exists to
 * prevent. ccledger runs in WAL mode, so at any moment the committed state of
 * the database is spread across `ccledger.db` and `ccledger.db-wal`; a file
 * copy takes the first without the second and lands somewhere in the middle of
 * a write, producing a file that opens cleanly and is missing rows. SQLite's
 * online backup API instead walks the source page by page under a read lock,
 * restarting if a writer changes a page it has already copied, and yields a
 * consistent snapshot without ever asking the server to stop.
 *
 * Which is the other half of the point: this runs against a database a server
 * is actively writing to, so the answer to "how do I back up ccledger" is not
 * "stop ccledger".
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { openDatabase } from '../db/index.js';
import { fail, messageOf, say } from './io.js';

/** Options for `ccledger backup`, as Commander hands them over. */
export interface BackupOptions {
  /** SQLite file path to copy from; the same one `serve` uses. */
  readonly db: string;
  /** Overwrite the destination if a file is already there. */
  readonly force?: boolean;
}

/** Bytes in a mebibyte, for the one size this prints. */
const BYTES_PER_MIB = 1024 * 1024;

/**
 * Removes a database file and the two sidecars SQLite may have left beside it.
 * Best effort: this only ever runs against paths this command created itself.
 */
function clear(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

/** A byte count as a short human-readable string. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < BYTES_PER_MIB) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / BYTES_PER_MIB).toFixed(1)} MiB`;
}

/**
 * Copies the database to `destination` while the server keeps running, or exits
 * non-zero saying which end of it could not be opened.
 */
export async function runBackup(destination: string, options: BackupOptions): Promise<void> {
  const source = resolve(options.db);
  const target = resolve(destination);

  // Checked rather than left to better-sqlite3, which creates a database when
  // asked to open one that is not there. Without this, backing up a mistyped
  // `--db` path would report success and write an empty file — the one failure
  // mode of a backup tool that is only discovered when the backup is needed.
  if (!existsSync(source)) {
    fail(`no database at ${source}; pass --db if it is somewhere else`);
  }
  if (source === target) {
    fail('the backup destination is the database itself');
  }
  if (existsSync(target) && options.force !== true) {
    fail(`${target} already exists; pass --force to overwrite it`);
  }

  // A missing parent directory otherwise surfaces from inside SQLite as
  // "unable to open database file", which names neither the path nor the
  // reason. Creating it is what the operator meant by naming it.
  const parent = dirname(target);
  if (!existsSync(parent)) {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      fail(`cannot create ${parent}: ${messageOf(error)}`);
    }
  }

  // Copied beside the destination and renamed over it at the end, for two
  // reasons. A backup interrupted halfway — a full disk, a killed process —
  // otherwise leaves a truncated file sitting at exactly the path someone will
  // later reach for, and `--force` has to be able to replace whatever is
  // already there, which SQLite cannot do itself: the online backup API opens
  // the destination as a database, so a path holding anything else fails with
  // "file is not a database" instead of being overwritten.
  const partial = `${target}.partial`;
  clear(partial);

  const db = openDatabase(source);
  try {
    // No migration first, deliberately: a backup must be able to run against a
    // database written by a newer ccledger than this one, and migrating the
    // source would be a write nobody asked a backup to make.
    await db.backup(partial);
  } catch (error) {
    clear(partial);
    fail(`backup failed: ${messageOf(error)}`);
  } finally {
    db.close();
  }

  try {
    // Overwrites on both platforms: Node's rename maps to `MoveFileEx` with
    // `MOVEFILE_REPLACE_EXISTING` on Windows and to `rename(2)` elsewhere.
    renameSync(partial, target);
  } catch (error) {
    clear(partial);
    fail(`cannot move the snapshot into place at ${target}: ${messageOf(error)}`);
  }

  const size = statSync(target).size;
  say(`backed up ${source}`);
  say(`        to ${target}  (${formatSize(size)})`);
}
