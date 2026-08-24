/**
 * `POST /join`: the one moment a teammate is given a token.
 *
 * Everything here happens once per person and is then never repeated, which is
 * exactly why it is worth writing carefully — a code that can be spent twice
 * hands two people the same identity, and a failure that reads as "something
 * went wrong" leaves a teammate with no idea whether to retype the code or ask
 * for a new one. So each way this can fail gets its own status and its own
 * sentence, and the spend and the member creation share one transaction.
 */

import type Database from 'better-sqlite3';

import { getConfig } from '../db/config.js';
import type { JoinCodeStore } from '../db/joincodes.js';
import { CONFIG_SERVER_NAME } from '../shared/constants.js';
import { normaliseDisplayName } from '../shared/invite.js';
import { normaliseJoinCode } from '../shared/joincode.js';
import type { JoinRequestBody, JoinResponseBody, Member } from '../shared/types.js';
import { createMember } from './auth.js';

/** Longest hostname a client may report. RFC 1035's limit on a full name. */
const MAX_HOSTNAME_LENGTH = 255;

/** Longest OS string a client may report; `os.platform()` plus a release. */
const MAX_OS_LENGTH = 64;

/** Fallback when a server has not been given a name yet. */
const DEFAULT_SERVER_NAME = 'ccledger';

/** A completed join, or the status and sentence to answer with. */
export type JoinResult =
  | { readonly ok: true; readonly body: JoinResponseBody; readonly member: Member }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Thrown to roll the transaction back when the claim loses a race it looked
 * like it had won. Private: it is a rollback mechanism, not an error type
 * anyone outside this file should be catching.
 */
class JoinRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JoinRejected';
  }
}

/** Trims and bounds an optional free-text field, or returns `null`. */
function optionalText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > maxLength) return null;
  // Same reasoning as a display name: these are rendered on the dashboard, and
  // a control character in a hostname is not a hostname.
  if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) return null;
  return trimmed;
}

/** Maps a code that could not be spent to the status that says why. */
function rejectionFor(status: 'unknown' | 'expired' | 'used'): {
  readonly status: number;
  readonly error: string;
} {
  switch (status) {
    case 'unknown':
      return { status: 404, error: 'no such join code; ask your admin for a new invite' };
    case 'expired':
      return {
        status: 410,
        error: 'this join code has expired; join codes last 24 hours, ask for a new invite',
      };
    case 'used':
      return {
        status: 409,
        error: 'this join code has already been used; join codes work once, ask for a new invite',
      };
  }
}

/**
 * Spends a join code and creates the member it was issued for.
 *
 * Never throws for anything a client did. The claim is re-checked inside the
 * transaction rather than trusted from the check above it, because between the
 * two another process may have spent the same code — and the `UPDATE ... WHERE
 * used_at IS NULL` is the only thing in this program that can settle that.
 */
export function joinWithCode(
  db: Database.Database,
  store: JoinCodeStore,
  body: JoinRequestBody,
  now: number = Date.now(),
): JoinResult {
  const code = normaliseJoinCode(body.code);
  if (code === undefined) {
    return {
      ok: false,
      status: 400,
      error: 'that is not a join code; it is three groups of four characters, e.g. H4KM-9TQZ-BXD3',
    };
  }

  const displayName = normaliseDisplayName(body.display_name);
  if (displayName === undefined) {
    return {
      ok: false,
      status: 400,
      error: 'display name must be 1 to 64 printable characters',
    };
  }

  // Cheap pre-check so the ordinary failures — a stale code, a reused one —
  // never open a transaction. The claim inside the transaction is what actually
  // decides; this only chooses the wording.
  const preview = store.inspect(code, now);
  if (preview.status !== 'open') {
    return { ok: false, ...rejectionFor(preview.status) };
  }

  const hostname = optionalText(body.hostname, MAX_HOSTNAME_LENGTH);
  const os = optionalText(body.os, MAX_OS_LENGTH);
  const serverName = getConfig(db, CONFIG_SERVER_NAME) ?? DEFAULT_SERVER_NAME;

  const run = db.transaction((): JoinResult => {
    const issued = createMember(db, {
      displayName,
      now,
      ...(hostname !== null ? { hostname } : {}),
      ...(os !== null ? { os } : {}),
    });
    const claim = store.claim(code, issued.member.id, now);
    if (claim.status !== 'open') {
      // Lost the race. Throwing is what rolls the member row back; the status
      // travels on the error because there is no other way out of a
      // better-sqlite3 transaction that does not commit.
      const rejection = rejectionFor(claim.status);
      throw new JoinRejected(rejection.status, rejection.error);
    }
    return {
      ok: true,
      member: issued.member,
      body: {
        token: issued.token,
        member_id: issued.member.id,
        server_name: serverName,
      },
    };
  });

  try {
    return run.immediate();
  } catch (error) {
    if (error instanceof JoinRejected) {
      return { ok: false, status: error.status, error: error.message };
    }
    throw error;
  }
}
