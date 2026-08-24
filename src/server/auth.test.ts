/**
 * Tokens, hashing, and the two things a token can be.
 *
 * The property the whole file is built around is that a token is never stored:
 * what reaches SQLite is a digest, and the digest cannot be turned back into a
 * token. So alongside the ordinary round-trip there are assertions that the
 * plaintext is absent from the database — the kind of thing that is true today
 * and quietly stops being true the first time someone adds a debug column.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import {
  authenticateMemberToken,
  createMember,
  ensureAdminToken,
  findMember,
  generateAdminToken,
  generateMemberId,
  generateMemberToken,
  hashToken,
  isWellFormedToken,
  parseBearerToken,
  revokeMember,
  verifyAdminToken,
} from './auth.js';
import { getConfig } from '../db/config.js';
import { migratedDatabase } from '../db/index.js';
import {
  ADMIN_TOKEN_PREFIX,
  CONFIG_ADMIN_TOKEN_HASH,
  CONFIG_ADMIN_TOKEN_SET_AT,
  MEMBER_TOKEN_PREFIX,
  TOKEN_BODY_LENGTH,
} from '../shared/constants.js';

/** A fixed clock, so nothing here depends on how long the suite takes. */
const NOW = 1_700_000_000_000;

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
  const path = join(tmpdir(), `ccledger-auth-${randomUUID()}.db`);
  tempPaths.push(path);
  return path;
}

/** A migrated database, registered for teardown. */
function freshDb(path = ':memory:'): Database.Database {
  const db = migratedDatabase(path);
  openHandles.push(db);
  return db;
}

describe('token format', () => {
  it('issues member tokens as ccm_ and 32 url-safe characters', () => {
    const token = generateMemberToken();

    expect(token.startsWith(MEMBER_TOKEN_PREFIX)).toBe(true);
    expect(token.slice(MEMBER_TOKEN_PREFIX.length)).toHaveLength(TOKEN_BODY_LENGTH);
    expect(token).toMatch(/^ccm_[A-Za-z0-9_-]{32}$/);
    // base64url is url-safe precisely because it uses neither of these.
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
    expect(token).not.toContain('=');
  });

  it('issues admin tokens under a different prefix, so the two cannot be swapped', () => {
    const admin = generateAdminToken();

    expect(admin).toMatch(/^cca_[A-Za-z0-9_-]{32}$/);
    expect(ADMIN_TOKEN_PREFIX).not.toBe(MEMBER_TOKEN_PREFIX);
    expect(isWellFormedToken(admin, MEMBER_TOKEN_PREFIX)).toBe(false);
    expect(isWellFormedToken(generateMemberToken(), ADMIN_TOKEN_PREFIX)).toBe(false);
  });

  it('does not repeat a token or a member id', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateMemberToken()));
    const ids = new Set(Array.from({ length: 1000 }, () => generateMemberId()));

    expect(tokens.size).toBe(1000);
    expect(ids.size).toBe(1000);
  });

  it.each([
    ['no prefix', 'abcdefghijklmnopqrstuvwxyz012345'],
    ['the wrong prefix', 'cca_abcdefghijklmnopqrstuvwxyz012345'],
    ['a short body', 'ccm_abc'],
    ['a long body', `ccm_${'a'.repeat(33)}`],
    ['characters base64url does not use', `ccm_${'+'.repeat(32)}`],
    ['nothing but the prefix', 'ccm_'],
    ['empty', ''],
  ])('rejects a member token with %s', (_label, token) => {
    expect(isWellFormedToken(token, MEMBER_TOKEN_PREFIX)).toBe(false);
  });
});

describe('hashToken', () => {
  it('round-trips: the same token always hashes to the same digest', () => {
    const token = generateMemberToken();

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different tokens different digests, including near neighbours', () => {
    const token = generateMemberToken();
    const nudged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    expect(hashToken(nudged)).not.toBe(hashToken(token));
    expect(hashToken(generateMemberToken())).not.toBe(hashToken(token));
  });

  it('cannot be confused with the placeholder member the migrations seed', () => {
    const db = freshDb();

    const seeded = db
      .prepare('SELECT token_hash FROM members')
      .all()
      .map((row) => (row as { token_hash: string }).token_hash);

    // The placeholder's hash is not a hex digest, so nothing can hash to it and
    // no bearer token can ever authenticate as it.
    for (const hash of seeded) {
      expect(hash).not.toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('parseBearerToken', () => {
  it('takes the token out of a well-formed header', () => {
    expect(parseBearerToken('Bearer ccm_abc')).toBe('ccm_abc');
    // RFC 7235 says the scheme is case-insensitive; exporters differ.
    expect(parseBearerToken('bearer ccm_abc')).toBe('ccm_abc');
    expect(parseBearerToken('BEARER ccm_abc')).toBe('ccm_abc');
    expect(parseBearerToken('  Bearer   ccm_abc  ')).toBe('ccm_abc');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['a bare token', 'ccm_abc'],
    ['another scheme', 'Basic ccm_abc'],
    ['the scheme alone', 'Bearer'],
    ['the scheme and nothing else', 'Bearer '],
    ['two tokens', 'Bearer ccm_abc ccm_def'],
  ])('returns nothing for a header that is %s', (_label, header) => {
    expect(parseBearerToken(header)).toBeUndefined();
  });
});

describe('createMember and authenticateMemberToken', () => {
  it('creates a member whose token authenticates', () => {
    const db = freshDb();

    const issued = createMember(db, { displayName: 'Alice', now: NOW });

    expect(issued.member.displayName).toBe('Alice');
    expect(issued.member.createdAt).toBe(NOW);
    expect(issued.member.revokedAt).toBeNull();
    expect(authenticateMemberToken(db, issued.token)).toEqual({
      status: 'ok',
      member: issued.member,
    });
  });

  it('records the machine the token was issued for, and nulls when it was not told', () => {
    const db = freshDb();

    const withDetails = createMember(db, {
      displayName: 'Alice',
      hostname: 'alice-mbp',
      os: 'darwin',
      now: NOW,
    });
    const without = createMember(db, { displayName: 'Bob', now: NOW });

    expect(withDetails.member.joinHostname).toBe('alice-mbp');
    expect(withDetails.member.joinOs).toBe('darwin');
    expect(without.member.joinHostname).toBeNull();
    expect(without.member.joinOs).toBeNull();
    expect(findMember(db, withDetails.member.id)).toEqual(withDetails.member);
  });

  it('stores only the digest — the token itself is nowhere in the file', () => {
    const path = tempDbPath();
    const db = freshDb(path);

    const issued = createMember(db, { displayName: 'Alice', now: NOW });
    // Checkpoint so everything is in the main file rather than a WAL sidecar.
    db.pragma('wal_checkpoint(TRUNCATE)');

    const stored = db
      .prepare('SELECT token_hash FROM members WHERE id = ?')
      .get(issued.member.id) as { token_hash: string };
    expect(stored.token_hash).toBe(hashToken(issued.token));
    expect(stored.token_hash).not.toBe(issued.token);
    expect(readFileSync(path, 'latin1')).not.toContain(issued.token);
  });

  it('does not authenticate another member with the same name', () => {
    const db = freshDb();
    const alice = createMember(db, { displayName: 'Alice', now: NOW });
    const other = createMember(db, { displayName: 'Alice', now: NOW });

    expect(alice.member.id).not.toBe(other.member.id);
    expect(authenticateMemberToken(db, alice.token)).toMatchObject({
      member: { id: alice.member.id },
    });
  });

  it.each([
    ['a token nobody was issued', generateMemberToken()],
    ['a token that is not a token', 'hello'],
    ['an admin token', generateAdminToken()],
    ['an empty string', ''],
    ['a hex digest, in case a hash was pasted in place of a token', hashToken('x')],
  ])('reports %s as unknown, without saying which kind of wrong it is', (_label, token) => {
    const db = freshDb();
    createMember(db, { displayName: 'Alice', now: NOW });

    expect(authenticateMemberToken(db, token)).toEqual({ status: 'unknown' });
  });
});

describe('revokeMember', () => {
  it('turns an ok token into a revoked one without deleting anything', () => {
    const db = freshDb();
    const issued = createMember(db, { displayName: 'Alice', now: NOW });

    expect(revokeMember(db, issued.member.id, NOW + 1000)).toBe(true);

    const result = authenticateMemberToken(db, issued.token);
    expect(result.status).toBe('revoked');
    expect(result.status === 'revoked' && result.member.revokedAt).toBe(NOW + 1000);
    // The member survives, because their rows in `requests` still point at it.
    expect(findMember(db, issued.member.id)).toBeDefined();
  });

  it('does not move the timestamp when revoked a second time', () => {
    const db = freshDb();
    const issued = createMember(db, { displayName: 'Alice', now: NOW });
    revokeMember(db, issued.member.id, NOW + 1000);

    expect(revokeMember(db, issued.member.id, NOW + 9999)).toBe(false);

    // The only record of when their access actually stopped must not drift.
    expect(findMember(db, issued.member.id)?.revokedAt).toBe(NOW + 1000);
  });

  it('reports nothing revoked for a member that does not exist', () => {
    expect(revokeMember(freshDb(), 'm_nobody', NOW)).toBe(false);
  });
});

describe('the admin token', () => {
  it('is issued once and only returned at that moment', () => {
    const db = freshDb();

    const first = ensureAdminToken(db, { now: NOW });
    const second = ensureAdminToken(db, { now: NOW + 1000 });

    expect(first.token).toBeDefined();
    expect(first.existed).toBe(false);
    expect(first.rotated).toBe(false);
    // Nothing can print it again: only the digest was kept.
    expect(second.token).toBeUndefined();
    expect(second.existed).toBe(true);
    expect(getConfig(db, CONFIG_ADMIN_TOKEN_SET_AT)).toBe(String(NOW));
  });

  it('verifies the token it issued and refuses everything else', () => {
    const db = freshDb();
    const issued = ensureAdminToken(db, { now: NOW });
    const token = issued.token ?? '';

    expect(verifyAdminToken(db, token)).toBe(true);
    expect(verifyAdminToken(db, generateAdminToken())).toBe(false);
    expect(verifyAdminToken(db, `${token} `)).toBe(false);
    expect(verifyAdminToken(db, token.toUpperCase())).toBe(false);
    expect(verifyAdminToken(db, '')).toBe(false);
    // A member token is a valid token for a different thing.
    expect(verifyAdminToken(db, createMember(db, { displayName: 'Alice' }).token)).toBe(false);
  });

  it('refuses everything on a server that has never issued one', () => {
    const db = freshDb();

    expect(verifyAdminToken(db, generateAdminToken())).toBe(false);
    expect(getConfig(db, CONFIG_ADMIN_TOKEN_HASH)).toBeUndefined();
  });

  it('rotates: the new token works and the old one stops', () => {
    const db = freshDb();
    const first = ensureAdminToken(db, { now: NOW });

    const rotated = ensureAdminToken(db, { rotate: true, now: NOW + 1000 });

    expect(rotated.token).toBeDefined();
    expect(rotated.rotated).toBe(true);
    expect(rotated.existed).toBe(true);
    expect(rotated.token).not.toBe(first.token);
    expect(verifyAdminToken(db, rotated.token ?? '')).toBe(true);
    expect(verifyAdminToken(db, first.token ?? '')).toBe(false);
    expect(getConfig(db, CONFIG_ADMIN_TOKEN_SET_AT)).toBe(String(NOW + 1000));
  });

  it('stores only the digest — the admin token is nowhere in the file either', () => {
    const path = tempDbPath();
    const db = freshDb(path);

    const issued = ensureAdminToken(db, { now: NOW });
    db.pragma('wal_checkpoint(TRUNCATE)');

    expect(getConfig(db, CONFIG_ADMIN_TOKEN_HASH)).toBe(hashToken(issued.token ?? ''));
    expect(readFileSync(path, 'latin1')).not.toContain(issued.token ?? 'unreachable');
  });

  it('is not a member, so it cannot be revoked into a member row', () => {
    const db = freshDb();
    ensureAdminToken(db, { now: NOW });

    // The admin token lives in `server_config`; the members table is untouched
    // beyond the placeholder the migrations seed.
    expect(db.prepare('SELECT count(*) AS n FROM members').get()).toEqual({ n: 1 });
  });
});
