/**
 * `joinWithCode`, below the HTTP layer.
 *
 * Two things are worth reaching past Fastify for. The first is the mapping from
 * each way a code can fail to the status that says so, because "410 gone" and
 * "409 conflict" are the difference between a teammate asking for a new invite
 * and a teammate retyping the one they have. The second is the rollback: if the
 * claim loses a race after the member row is written, that member must not
 * survive, or a token exists that no code paid for.
 */

import { describe, expect, it, afterEach } from 'vitest';

import type Database from 'better-sqlite3';

import { authenticateMemberToken } from './auth.js';
import { joinWithCode } from './join.js';
import { setConfig } from '../db/config.js';
import { migratedDatabase } from '../db/index.js';
import type { JoinCodeLookup, JoinCodeStore } from '../db/joincodes.js';
import { createJoinCodeStore } from '../db/joincodes.js';
import { CONFIG_SERVER_NAME, JOIN_CODE_TTL_MS } from '../shared/constants.js';

/** A fixed clock, so nothing here depends on how long the suite takes. */
const NOW = 1_700_000_000_000;

const openHandles: Database.Database[] = [];

afterEach(() => {
  for (const db of openHandles.splice(0)) {
    if (db.open) db.close();
  }
});

/** A migrated in-memory database, registered for teardown. */
function freshDb(): Database.Database {
  const db = migratedDatabase(':memory:');
  openHandles.push(db);
  return db;
}

/** A database, a store over it, and one open code to spend. */
function ready(): { db: Database.Database; store: JoinCodeStore; code: string } {
  const db = freshDb();
  const store = createJoinCodeStore(db);
  return { db, store, code: store.create('Alice', { now: NOW }).code };
}

/** Rows in `members` beyond the placeholder the migrations seed. */
function memberCount(db: Database.Database): number {
  const row = db.prepare("SELECT count(*) AS n FROM members WHERE id != 'unattributed'").get();
  return (row as { n: number }).n;
}

describe('joinWithCode', () => {
  it('spends the code, creates the member, and hands back a working token', () => {
    const { db, store, code } = ready();
    setConfig(db, CONFIG_SERVER_NAME, 'desk-01', NOW);

    const result = joinWithCode(
      db,
      store,
      { code, display_name: 'Alice', hostname: 'alice-mbp', os: 'darwin' },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.server_name).toBe('desk-01');
    expect(result.body.member_id).toBe(result.member.id);
    expect(result.body.token).toMatch(/^ccm_[A-Za-z0-9_-]{32}$/);
    expect(result.member.joinHostname).toBe('alice-mbp');
    expect(result.member.joinOs).toBe('darwin');
    expect(authenticateMemberToken(db, result.body.token).status).toBe('ok');
    expect(store.inspect(code, NOW).status).toBe('used');
  });

  it('falls back to a default server name rather than an empty one', () => {
    const { db, store, code } = ready();

    const result = joinWithCode(db, store, { code, display_name: 'Alice' }, NOW);

    expect(result.ok && result.body.server_name).toBe('ccledger');
  });

  it('takes the joiner at their word about their name, not the invite', () => {
    const { db, store } = ready();
    const code = store.create('alice', { now: NOW }).code;

    const result = joinWithCode(db, store, { code, display_name: '  Alice Ahmed  ' }, NOW);

    expect(result.ok && result.member.displayName).toBe('Alice Ahmed');
  });

  it('answers 409 the second time and creates nothing', () => {
    const { db, store, code } = ready();
    expect(joinWithCode(db, store, { code, display_name: 'Alice' }, NOW).ok).toBe(true);

    const second = joinWithCode(db, store, { code, display_name: 'Mallory' }, NOW + 1);

    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(!second.ok && second.error).toMatch(/already been used/);
    expect(memberCount(db)).toBe(1);
  });

  it('answers 410 for an expired code and creates nothing', () => {
    const { db, store, code } = ready();

    const result = joinWithCode(db, store, { code, display_name: 'Alice' }, NOW + JOIN_CODE_TTL_MS);

    expect(result).toMatchObject({ ok: false, status: 410 });
    expect(!result.ok && result.error).toMatch(/expired/);
    expect(memberCount(db)).toBe(0);
  });

  it('answers 404 for a code nobody issued', () => {
    const { db, store } = ready();

    const result = joinWithCode(db, store, { code: 'ABCD-EFGH-JKMN', display_name: 'Alice' }, NOW);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(memberCount(db)).toBe(0);
  });

  it('answers 400 for something that is not a code at all', () => {
    const { db, store } = ready();

    const result = joinWithCode(db, store, { code: 'hello there', display_name: 'Alice' }, NOW);

    expect(result).toMatchObject({ ok: false, status: 400 });
    // The message says what a code looks like, because the likeliest cause is
    // someone pasting the wrong half of the invite.
    expect(!result.ok && result.error).toMatch(/three groups of four/);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too long', 'x'.repeat(65)],
    ['carrying a newline', 'Alice\nBob'],
  ])('answers 400 for a display name that is %s, leaving the code unspent', (_label, name) => {
    const { db, store, code } = ready();

    const result = joinWithCode(db, store, { code, display_name: name }, NOW);

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(memberCount(db)).toBe(0);
    // The code is the scarce thing here; a typo in a name must not burn it.
    expect(store.inspect(code, NOW).status).toBe('open');
  });

  it('drops a hostname or os it cannot use rather than refusing the join', () => {
    const { db, store, code } = ready();

    const result = joinWithCode(
      db,
      store,
      { code, display_name: 'Alice', hostname: 'x'.repeat(300), os: '   ' },
      NOW,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.member.joinHostname).toBeNull();
    expect(result.ok && result.member.joinOs).toBeNull();
  });

  it('rolls the member back when the claim loses a race', () => {
    const { db, store, code } = ready();
    // A store that reports the code open and then loses the claim, which is
    // what a second `serve` process spending it in between looks like.
    const racing: JoinCodeStore = {
      ...store,
      claim(): JoinCodeLookup {
        return { status: 'used' };
      },
    };

    const result = joinWithCode(db, racing, { code, display_name: 'Alice' }, NOW);

    expect(result).toMatchObject({ ok: false, status: 409 });
    // The member row was written before the claim; it must not have survived,
    // or a token exists that no join code paid for.
    expect(memberCount(db)).toBe(0);
  });
});
