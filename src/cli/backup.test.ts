/**
 * `ccledger backup` tests.
 *
 * The behaviour worth pinning down is not that a file appears — it is that the
 * file is a real snapshot and that every way of getting it wrong is refused
 * loudly. A backup tool whose failures are quiet is worse than no backup tool,
 * because the failure is only ever discovered on the day the backup is needed.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { migratedDatabase } from '../db/index.js';
import type { Database } from '../db/index.js';
import { openDatabase } from '../db/index.js';
import { formatSize, runBackup } from './backup.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** Thrown in place of `process.exit`, so a refusal can be asserted on. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
    this.name = 'Exited';
  }
}

/** What a captured run produced. */
interface Run {
  readonly out: string;
  readonly err: string;
  /** The exit code, or `undefined` when the command returned normally. */
  readonly code: number | undefined;
}

/** Runs a command with both streams captured and `process.exit` disarmed. */
async function capture(action: () => Promise<void>): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const write =
    (sink: string[]) =>
    (chunk: string | Uint8Array): boolean => {
      sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
  vi.spyOn(process.stdout, 'write').mockImplementation(write(out));
  vi.spyOn(process.stderr, 'write').mockImplementation(write(err));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
    throw new Exited(code ?? 0);
  }) as never);

  let code: number | undefined;
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Exited)) throw error;
    code = error.code;
  }
  return { out: out.join(''), err: err.join(''), code };
}

/** A temporary directory, removed after the test. */
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ccledger-backup-'));
  directories.push(directory);
  return directory;
}

/** A migrated database on disk with `count` members in it, left open. */
function seededDatabase(path: string, count: number): Database.Database {
  const db = migratedDatabase(path);
  insertMembers(db, 0, count);
  return db;
}

/** Inserts members numbered `[from, to)`. */
function insertMembers(db: Database.Database, from: number, to: number): void {
  const insert = db.prepare(
    'INSERT INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  );
  for (let index = from; index < to; index += 1) {
    insert.run(`m_${String(index)}`, `Member ${String(index)}`, `hash_${String(index)}`, 1_700_000);
  }
}

/** How many members a database file holds. */
function memberCount(path: string): number {
  const db = openDatabase(path);
  try {
    const row = db.prepare('SELECT count(*) AS total FROM members').get() as { total: number };
    return row.total;
  } finally {
    db.close();
  }
}

describe('runBackup', () => {
  it('copies every row while the source is still open', async () => {
    const directory = tempDir();
    const source = join(directory, 'ccledger.db');
    const target = join(directory, 'snapshot.db');
    // Left open for the whole run, which is the case this command exists for:
    // the answer to "how do I back up ccledger" must not be "stop ccledger".
    const db = seededDatabase(source, 12);
    try {
      const run = await capture(() => runBackup(target, { db: source }));

      expect(run.code).toBeUndefined();
      expect(run.err).toBe('');
      expect(run.out).toContain(target);
      // The seeded rows plus the placeholder member migration 2 writes.
      expect(memberCount(target)).toBe(memberCount(source));
      expect(memberCount(target)).toBeGreaterThanOrEqual(12);
      // One file, not a set of them. The snapshot is copied to `.partial` and
      // renamed into place, and a leftover from that would be both confusing
      // and, at WAL-sized, misleading about what the backup actually holds.
      expect(existsSync(`${target}.partial`)).toBe(false);
      expect(existsSync(`${target}-wal`)).toBe(false);
      expect(existsSync(`${target}-shm`)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('takes a snapshot rather than a live view of the source', async () => {
    const directory = tempDir();
    const source = join(directory, 'ccledger.db');
    const target = join(directory, 'snapshot.db');
    const db = seededDatabase(source, 5);
    try {
      await capture(() => runBackup(target, { db: source }));
      const atBackup = memberCount(target);

      insertMembers(db, 5, 20);

      // Writes after the copy must not reach it. A backup that tracked the
      // source would be a second handle on the same data, not a backup.
      expect(memberCount(target)).toBe(atBackup);
      expect(memberCount(source)).toBe(atBackup + 15);
    } finally {
      db.close();
    }
  });

  it('refuses a source that does not exist instead of writing an empty file', async () => {
    const directory = tempDir();
    const missing = join(directory, 'nowhere.db');
    const target = join(directory, 'snapshot.db');

    const run = await capture(() => runBackup(target, { db: missing }));

    expect(run.code).toBe(1);
    expect(run.err).toContain('no database at');
    // The failure mode this guards: better-sqlite3 creates a database when
    // asked to open one that is not there, so a mistyped --db would otherwise
    // report success over an empty file.
    expect(existsSync(target)).toBe(false);
  });

  it('refuses to overwrite an existing backup unless told to', async () => {
    const directory = tempDir();
    const source = join(directory, 'ccledger.db');
    const target = join(directory, 'snapshot.db');
    const db = seededDatabase(source, 3);
    writeFileSync(target, 'yesterday', 'utf8');
    try {
      const refused = await capture(() => runBackup(target, { db: source }));

      expect(refused.code).toBe(1);
      expect(refused.err).toContain('--force');
      expect(readFileSync(target, 'utf8')).toBe('yesterday');

      const forced = await capture(() => runBackup(target, { db: source, force: true }));

      expect(forced.code).toBeUndefined();
      expect(memberCount(target)).toBe(memberCount(source));
    } finally {
      db.close();
    }
  });

  it('refuses to back a database up over itself', async () => {
    const directory = tempDir();
    const source = join(directory, 'ccledger.db');
    const db = seededDatabase(source, 2);
    try {
      const run = await capture(() => runBackup(source, { db: source }));

      expect(run.code).toBe(1);
      expect(run.err).toContain('the database itself');
      expect(memberCount(source)).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it('creates the destination directory rather than failing inside SQLite', async () => {
    const directory = tempDir();
    const source = join(directory, 'ccledger.db');
    const target = join(directory, 'backups', '2026-08-26', 'snapshot.db');
    const db = seededDatabase(source, 4);
    try {
      const run = await capture(() => runBackup(target, { db: source }));

      expect(run.code).toBeUndefined();
      expect(memberCount(target)).toBe(memberCount(source));
    } finally {
      db.close();
    }
  });
});

describe('formatSize', () => {
  it('scales the unit to the number', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KiB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});
