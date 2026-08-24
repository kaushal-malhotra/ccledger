/**
 * Join codes: issuing one, and spending it exactly once.
 *
 * The single-use guarantee is one statement — an `UPDATE ... WHERE used_at IS
 * NULL` whose `changes` count decides whether the caller won. Nothing else in
 * this file may be trusted to enforce it, because `ccledger invite` and
 * `ccledger serve` are separate processes against the same file and neither can
 * see the other's memory.
 *
 * That is also what makes the in-memory layer safe. It caches only conclusions
 * that can never be revoked: a code that has been claimed stays claimed, and a
 * code whose expiry has passed stays expired. A cached "still open" is never
 * acted on — that always goes back to SQLite, because another process may have
 * spent it a millisecond ago.
 */

import type Database from 'better-sqlite3';

import { JOIN_CODE_TTL_MS } from '../shared/constants.js';
import { generateJoinCode, normaliseJoinCode } from '../shared/joincode.js';

/** A `join_codes` row, column names as in `schema-identity.sql`. */
interface JoinCodeRow {
  readonly code: string;
  readonly display_name: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly used_at: number | null;
  readonly member_id: string | null;
}

/** A join code as the rest of the program sees it. */
export interface JoinCode {
  /** Canonical form, e.g. `H4KM-9TQZ-BXD3`. */
  readonly code: string;
  /** Display name the admin suggested when issuing it. */
  readonly displayName: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds. Claimable strictly before this. */
  readonly expiresAt: number;
  /** Epoch milliseconds it was claimed, or `null` while it is still open. */
  readonly usedAt: number | null;
  /** The member it created, or `null` while it is still open. */
  readonly memberId: string | null;
}

/** Why a code can or cannot be spent. Each maps to a different HTTP status. */
export type JoinCodeStatus = 'open' | 'unknown' | 'expired' | 'used';

/** The state of one code, with the row itself when there is one. */
export interface JoinCodeLookup {
  readonly status: JoinCodeStatus;
  /** Absent only when `status` is `unknown`. */
  readonly joinCode?: JoinCode;
}

/** Knobs for issuing a code; both have defaults worth relying on. */
export interface CreateJoinCodeOptions {
  /** Clock, for tests. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Lifetime in milliseconds. Defaults to the 24 hours PRD section 11 sets. */
  readonly ttlMs?: number;
}

/**
 * Codes whose fate this process has already established. Bounded, because the
 * key is caller-supplied: an endpoint being probed must not be able to grow a
 * map without limit.
 */
const MAX_CACHED_CODES = 512;

/** Attempts to find an unused code before giving up. */
const CODE_GENERATION_ATTEMPTS = 5;

/** Maps a row to the shape callers see. */
function toJoinCode(row: JoinCodeRow): JoinCode {
  return {
    code: row.code,
    displayName: row.display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    memberId: row.member_id,
  };
}

/** The status of a row that has already been found. */
function statusOf(joinCode: JoinCode, now: number): Exclude<JoinCodeStatus, 'unknown'> {
  if (joinCode.usedAt !== null) return 'used';
  if (joinCode.expiresAt <= now) return 'expired';
  return 'open';
}

/** Issuing, inspecting and claiming codes against one database handle. */
export interface JoinCodeStore {
  /** Issues a code for `displayName`. The returned code is the only copy there is. */
  create(displayName: string, options?: CreateJoinCodeOptions): JoinCode;
  /** Reads a code's state without spending it. Input may be in any spacing or case. */
  inspect(code: string, now?: number): JoinCodeLookup;
  /**
   * Spends a code for `memberId`. `open` means the caller won and the row is
   * now marked used; anything else means it was not theirs to spend. Safe to
   * call inside a wider transaction — the write is a single statement.
   */
  claim(code: string, memberId: string, now?: number): JoinCodeLookup;
  /** Codes issued and not yet spent, newest first. For the admin's own view. */
  listOpen(now?: number): readonly JoinCode[];
  /** Deletes expired, unclaimed codes. Returns how many went. */
  prune(now?: number): number;
}

/**
 * Builds a store over one database handle. One per process: the cache inside it
 * is this process's memory of what it has already established, and sharing it
 * across databases would be sharing it across servers.
 */
export function createJoinCodeStore(db: Database.Database): JoinCodeStore {
  const insert = db.prepare(
    'INSERT INTO join_codes (code, display_name, created_at, expires_at) VALUES (?, ?, ?, ?)',
  );
  const select = db.prepare<[string], JoinCodeRow>('SELECT * FROM join_codes WHERE code = ?');
  const spend = db.prepare(
    'UPDATE join_codes SET used_at = ?, member_id = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?',
  );
  const selectOpen = db.prepare<[number], JoinCodeRow>(
    'SELECT * FROM join_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
  );
  const deleteExpired = db.prepare(
    'DELETE FROM join_codes WHERE used_at IS NULL AND expires_at <= ?',
  );

  /** Codes this process has seen reach a state they can never leave. */
  const settled = new Map<string, JoinCode>();

  /** Remembers a code only once its state is final; an open code is not final. */
  function remember(joinCode: JoinCode, now: number): void {
    if (statusOf(joinCode, now) === 'open') return;
    // Wholesale, not least-recently-used: this is a cache, so the only cost of
    // dropping an entry is one query, and a policy is not worth the code.
    if (settled.size >= MAX_CACHED_CODES) settled.clear();
    settled.set(joinCode.code, joinCode);
  }

  /** Normalises, then answers from the cache when the answer cannot change. */
  function lookup(raw: string, now: number): JoinCodeLookup {
    const code = normaliseJoinCode(raw);
    if (code === undefined) return { status: 'unknown' };

    const cached = settled.get(code);
    if (cached !== undefined) {
      // Only ever `used` or `expired` — see `remember`. Both are permanent, so
      // this answer cannot go stale however many processes share the file.
      return { status: statusOf(cached, now), joinCode: cached };
    }

    const row = select.get(code);
    if (row === undefined) return { status: 'unknown' };
    const joinCode = toJoinCode(row);
    remember(joinCode, now);
    return { status: statusOf(joinCode, now), joinCode };
  }

  return {
    create(displayName, options = {}) {
      const now = options.now ?? Date.now();
      const expiresAt = now + (options.ttlMs ?? JOIN_CODE_TTL_MS);
      // A collision needs two of 31^12 codes to coincide. The retry is here so
      // that if one ever does, an admin gets a code rather than a stack trace.
      for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
        const code = generateJoinCode();
        if (select.get(code) !== undefined) continue;
        insert.run(code, displayName, now, expiresAt);
        return { code, displayName, createdAt: now, expiresAt, usedAt: null, memberId: null };
      }
      throw new Error('could not generate an unused join code');
    },

    inspect(code, now = Date.now()) {
      return lookup(code, now);
    },

    claim(code, memberId, now = Date.now()) {
      const before = lookup(code, now);
      if (before.status !== 'open' || before.joinCode === undefined) return before;

      const info = spend.run(now, memberId, before.joinCode.code, now);
      if (info.changes === 1) {
        const claimed: JoinCode = { ...before.joinCode, usedAt: now, memberId };
        remember(claimed, now);
        return { status: 'open', joinCode: claimed };
      }

      // The row was open when it was read and is not now: something else won
      // between the two statements. Re-read rather than assuming which race was
      // lost — expiry and a competing claim are both possible.
      settled.delete(before.joinCode.code);
      const after = lookup(before.joinCode.code, now);
      if (after.status === 'open') {
        // Not reachable through a single database handle, which serialises its
        // own writes. Reported as spent rather than retried: a caller told the
        // claim succeeded when it did not would hand out an unbacked token.
        return { status: 'used', joinCode: after.joinCode ?? before.joinCode };
      }
      return after;
    },

    listOpen(now = Date.now()) {
      return selectOpen.all(now).map(toJoinCode);
    },

    prune(now = Date.now()) {
      return deleteExpired.run(now).changes;
    },
  };
}
