/**
 * The join-code store.
 *
 * One property carries this file: a code can be spent exactly once. Everything
 * else — expiry, pruning, the in-memory layer — is only allowed to exist to the
 * extent that it cannot weaken that. So the cache is tested by making SQLite and
 * the cache disagree on purpose and checking which one wins, and single use is
 * tested through two independent handles on the same file, which is what
 * `ccledger invite` and `ccledger serve` actually are.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import { migratedDatabase } from './index.js';
import { createJoinCodeStore } from './joincodes.js';
import { JOIN_CODE_TTL_MS } from '../shared/constants.js';

/** A fixed clock, so nothing here depends on how long the suite takes. */
const NOW = 1_700_000_000_000;

/** A member the claimed codes can point at; `join_codes.member_id` is a real key. */
const MEMBER_ID = 'm_alice';

const openHandles: Database.Database[] = [];
const tempPaths: string[] = [];

afterEach(() => {
  for (const db of openHandles.splice(0)) {
    if (db.open) db.close();
  }
  for (const path of tempPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

/** A path under the OS temp directory, cleaned up after the test. */
function tempDbPath(): string {
  const path = join(tmpdir(), `ccledger-joincodes-${randomUUID()}.db`);
  tempPaths.push(path);
  return path;
}

/** A migrated database with one member in it, registered for teardown. */
function freshDb(path = ':memory:'): Database.Database {
  const db = migratedDatabase(path);
  openHandles.push(db);
  db.prepare(
    'INSERT OR IGNORE INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(MEMBER_ID, 'Alice', `hash:${MEMBER_ID}`, NOW);
  return db;
}

describe('create', () => {
  it('issues a canonical code that expires 24 hours out', () => {
    const store = createJoinCodeStore(freshDb());

    const code = store.create('Alice', { now: NOW });

    expect(code.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code.displayName).toBe('Alice');
    expect(code.createdAt).toBe(NOW);
    expect(code.expiresAt).toBe(NOW + JOIN_CODE_TTL_MS);
    expect(code.expiresAt - code.createdAt).toBe(24 * 60 * 60 * 1000);
    expect(code.usedAt).toBeNull();
    expect(code.memberId).toBeNull();
  });

  it('writes a row another process can read', () => {
    const path = tempDbPath();
    const issuer = createJoinCodeStore(freshDb(path));

    const code = issuer.create('Alice', { now: NOW });

    // A second handle on the same file: `invite` and `serve` are two processes.
    const server = createJoinCodeStore(freshDb(path));
    expect(server.inspect(code.code, NOW)).toMatchObject({
      status: 'open',
      joinCode: { displayName: 'Alice' },
    });
  });
});

describe('inspect', () => {
  it('reports an unknown code as unknown, whatever shape it is', () => {
    const store = createJoinCodeStore(freshDb());

    for (const code of ['ABCD-EFGH-JKMN', 'nonsense', '']) {
      expect(store.inspect(code, NOW).status).toBe('unknown');
    }
  });

  it('accepts the code however it was retyped', () => {
    const store = createJoinCodeStore(freshDb());
    const code = store.create('Alice', { now: NOW });

    expect(store.inspect(code.code.toLowerCase(), NOW).status).toBe('open');
    expect(store.inspect(code.code.replaceAll('-', ' '), NOW).status).toBe('open');
  });

  it('does not spend the code it inspects', () => {
    const store = createJoinCodeStore(freshDb());
    const code = store.create('Alice', { now: NOW });

    store.inspect(code.code, NOW);
    store.inspect(code.code, NOW);

    expect(store.claim(code.code, MEMBER_ID, NOW).status).toBe('open');
  });
});

describe('claim', () => {
  it('spends a code once and refuses it for ever after', () => {
    const store = createJoinCodeStore(freshDb());
    const code = store.create('Alice', { now: NOW });

    const first = store.claim(code.code, MEMBER_ID, NOW);
    const second = store.claim(code.code, MEMBER_ID, NOW + 1);

    expect(first.status).toBe('open');
    expect(first.joinCode?.usedAt).toBe(NOW);
    expect(first.joinCode?.memberId).toBe(MEMBER_ID);
    expect(second.status).toBe('used');
  });

  it('is single-use across two handles on the same file', () => {
    const path = tempDbPath();
    const one = createJoinCodeStore(freshDb(path));
    const two = createJoinCodeStore(freshDb(path));
    const code = one.create('Alice', { now: NOW });

    // Both processes have read the code as open before either spends it.
    expect(one.inspect(code.code, NOW).status).toBe('open');
    expect(two.inspect(code.code, NOW).status).toBe('open');

    const first = one.claim(code.code, MEMBER_ID, NOW);
    const second = two.claim(code.code, MEMBER_ID, NOW);

    expect(first.status).toBe('open');
    // The second store had `open` cached; the cache is never allowed to
    // authorise a claim, so SQLite still gets the final word.
    expect(second.status).toBe('used');
  });

  it('refuses a code that expired, and does not mark it used', () => {
    const db = freshDb();
    const store = createJoinCodeStore(db);
    const code = store.create('Alice', { now: NOW });

    const result = store.claim(code.code, MEMBER_ID, code.expiresAt + 1);

    expect(result.status).toBe('expired');
    const row = db.prepare('SELECT used_at FROM join_codes WHERE code = ?').get(code.code);
    expect(row).toEqual({ used_at: null });
  });

  it('refuses a code exactly at its expiry, not a millisecond later', () => {
    const store = createJoinCodeStore(freshDb());
    const code = store.create('Alice', { now: NOW });

    expect(store.claim(code.code, MEMBER_ID, code.expiresAt - 1).status).toBe('open');
    const other = store.create('Bob', { now: NOW });
    expect(store.claim(other.code, MEMBER_ID, other.expiresAt).status).toBe('expired');
  });

  it('refuses an unknown code without writing anything', () => {
    const db = freshDb();
    const store = createJoinCodeStore(db);

    expect(store.claim('ABCD-EFGH-JKMN', MEMBER_ID, NOW).status).toBe('unknown');
    expect(db.prepare('SELECT count(*) AS n FROM join_codes').get()).toEqual({ n: 0 });
  });

  it('honours a short-lived code, so expiry is not hard-coded', () => {
    const store = createJoinCodeStore(freshDb());
    const code = store.create('Alice', { now: NOW, ttlMs: 1000 });

    expect(code.expiresAt).toBe(NOW + 1000);
    expect(store.claim(code.code, MEMBER_ID, NOW + 1001).status).toBe('expired');
  });
});

describe('the in-memory layer', () => {
  it('never authorises a claim from cache alone', () => {
    const db = freshDb();
    const store = createJoinCodeStore(db);
    const code = store.create('Alice', { now: NOW });
    store.inspect(code.code, NOW);

    // Something outside this process spends it — a second `serve`, or an admin
    // with sqlite3 open. The cached "open" must not survive that.
    db.prepare('UPDATE join_codes SET used_at = ?, member_id = ? WHERE code = ?').run(
      NOW,
      MEMBER_ID,
      code.code,
    );

    expect(store.claim(code.code, MEMBER_ID, NOW).status).toBe('used');
  });

  it('only caches conclusions that cannot be revoked', () => {
    const db = freshDb();
    const store = createJoinCodeStore(db);
    const code = store.create('Alice', { now: NOW });
    expect(store.claim(code.code, MEMBER_ID, NOW).status).toBe('open');

    // Nothing in ccledger un-spends a code, so the cached `used` is safe. Prove
    // it is really being served from memory by deleting the row underneath it.
    db.prepare('DELETE FROM join_codes WHERE code = ?').run(code.code);

    expect(store.inspect(code.code, NOW).status).toBe('used');
  });

  it('stays bounded when it is fed codes that do not exist', () => {
    const db = freshDb();
    const store = createJoinCodeStore(db);

    // The key is caller-supplied. A thousand probes must not grow anything.
    for (let i = 0; i < 1000; i += 1) {
      expect(store.inspect(`ABCD-EFGH-JKM${'23456789'[i % 8] ?? '2'}`, NOW).status).toBe('unknown');
    }

    const code = store.create('Alice', { now: NOW });
    expect(store.claim(code.code, MEMBER_ID, NOW).status).toBe('open');
  });
});

describe('listOpen and prune', () => {
  it('lists only codes that are still claimable, newest first', () => {
    const store = createJoinCodeStore(freshDb());
    const old = store.create('Alice', { now: NOW });
    const recent = store.create('Bob', { now: NOW + 1000 });
    const spent = store.create('Carol', { now: NOW + 2000 });
    store.claim(spent.code, MEMBER_ID, NOW + 3000);
    const stale = store.create('Dave', { now: NOW - JOIN_CODE_TTL_MS * 2 });

    const open = store.listOpen(NOW + 4000);

    expect(open.map((entry) => entry.displayName)).toEqual(['Bob', 'Alice']);
    expect(open.map((entry) => entry.code)).toEqual([recent.code, old.code]);
    expect(open.map((entry) => entry.code)).not.toContain(stale.code);
  });

  it('deletes expired unclaimed codes and keeps the claimed ones as a record', () => {
    const db = freshDb();
    const store = createJoinCodeStore(db);
    const spent = store.create('Alice', { now: NOW });
    store.claim(spent.code, MEMBER_ID, NOW);
    const stale = store.create('Bob', { now: NOW });
    const live = store.create('Carol', { now: NOW, ttlMs: JOIN_CODE_TTL_MS * 3 });

    const pruned = store.prune(stale.expiresAt + 1);

    expect(pruned).toBe(1);
    const remaining = db
      .prepare('SELECT code FROM join_codes ORDER BY created_at')
      .all()
      .map((row) => (row as { code: string }).code);
    // The spent one stays: it is the record of who was let in and when.
    expect(new Set(remaining)).toEqual(new Set([spent.code, live.code]));
    expect(remaining).not.toContain(stale.code);
  });

  it('prunes nothing when everything is still live', () => {
    const store = createJoinCodeStore(freshDb());
    store.create('Alice', { now: NOW });

    expect(store.prune(NOW + 1000)).toBe(0);
  });
});
