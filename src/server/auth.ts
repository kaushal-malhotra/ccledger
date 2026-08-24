/**
 * Identity: who is allowed to write telemetry, and who is allowed to read it.
 *
 * Two separate secrets, and they are separate on purpose. A member token
 * (`ccm_`) is issued once per teammate at join time, lives in a settings file on
 * their machine, and can do exactly one thing — POST to the ingest route. The
 * admin token (`cca_`) is issued once per server, is never written to a
 * teammate's machine, and guards everything under `/api`. Neither can stand in
 * for the other: they are stored in different tables and checked by different
 * code, and the differing prefix means an admin who pastes the wrong one into a
 * teammate's config finds out immediately rather than a month later.
 *
 * Only hashes are stored. There is no work factor and no salt, and both are
 * deliberate: these are not passwords but 192-bit random strings, so there is no
 * dictionary to run and nothing for a salt to defeat, while a slow hash on the
 * ingest path would be a cost paid on every batch a teammate sends.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getConfig, setConfig } from '../db/config.js';
import {
  ADMIN_TOKEN_PREFIX,
  CONFIG_ADMIN_TOKEN_HASH,
  CONFIG_ADMIN_TOKEN_SET_AT,
  MEMBER_TOKEN_PREFIX,
  TOKEN_BODY_LENGTH,
  TOKEN_ENTROPY_BYTES,
} from '../shared/constants.js';
import type { Member } from '../shared/types.js';

import { fail, failUnauthorized } from './reply.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The member a bearer token resolved to. `null` on every route that does
     * not authenticate one — the type is not optional so a handler that forgets
     * to check gets a type error rather than `undefined`.
     */
    member: Member | null;
  }
}

/** A `members` row, column names as in the schema. */
interface MemberRow {
  readonly id: string;
  readonly display_name: string;
  readonly token_hash: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
  readonly join_hostname: string | null;
  readonly join_os: string | null;
}

/** The characters a token body may contain: base64url, unpadded. */
const TOKEN_BODY = new RegExp(`^[A-Za-z0-9_-]{${String(TOKEN_BODY_LENGTH)}}$`);

/** Digits of a sha256 rendered as hex; the width `timingSafeEqual` needs to match. */
const SHA256_HEX_LENGTH = 64;

/** What an `Authorization` header resolved to, and the member behind it. */
export type MemberAuthResult =
  | { readonly status: 'ok'; readonly member: Member }
  | { readonly status: 'revoked'; readonly member: Member }
  | { readonly status: 'unknown' };

/** Everything `POST /join` knows about a member at the moment it creates one. */
export interface NewMember {
  readonly displayName: string;
  readonly hostname?: string;
  readonly os?: string;
  /** Epoch milliseconds. Defaults to `Date.now()`. */
  readonly now?: number;
}

/** A newly created member and the only copy of its token that will ever exist. */
export interface IssuedMember {
  readonly member: Member;
  readonly token: string;
}

/** What `ensureAdminToken` did, and the token to print if it made one. */
export interface AdminTokenResult {
  /** Present only when a token was just issued — it is not recoverable later. */
  readonly token?: string;
  /** True when a token already existed before this call. */
  readonly existed: boolean;
  /** True when an existing token was replaced. */
  readonly rotated: boolean;
}

/** Maps a row to the shape the rest of the program uses. */
function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    joinHostname: row.join_hostname,
    joinOs: row.join_os,
  };
}

/** `TOKEN_BODY_LENGTH` base64url characters of cryptographic randomness. */
function randomTokenBody(): string {
  return randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

/** A member's ingest token. Shown once, at join, and never stored in the clear. */
export function generateMemberToken(): string {
  return `${MEMBER_TOKEN_PREFIX}${randomTokenBody()}`;
}

/** The server's admin token. Shown once, on first `serve`, and on rotation. */
export function generateAdminToken(): string {
  return `${ADMIN_TOKEN_PREFIX}${randomTokenBody()}`;
}

/** An id for a new member. Not a secret: it appears in URLs and on the dashboard. */
export function generateMemberId(): string {
  return `m_${randomBytes(12).toString('base64url')}`;
}

/** The sha256 of a token, hex. The only form that reaches storage. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when `token` has the given prefix and a well-formed body. */
export function isWellFormedToken(token: string, prefix: string): boolean {
  return token.startsWith(prefix) && TOKEN_BODY.test(token.slice(prefix.length));
}

/**
 * The token out of an `Authorization: Bearer ...` header, or `undefined`.
 * The scheme is compared case-insensitively because RFC 7235 says it is; the
 * token itself is not, because it is a secret and case carries entropy.
 */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Resolves a member token. `unknown` covers both a token that is not a token
 * and one that is simply not ours — the caller cannot act differently on the
 * two, and answering differently would tell someone probing which is which.
 *
 * The lookup is an index probe on the hash rather than a constant-time compare.
 * That is sound here: an attacker cannot steer a timing signal towards a 192-bit
 * random string they have no way to enumerate, and the value being compared is
 * already a digest of the secret rather than the secret itself.
 */
export function authenticateMemberToken(db: Database.Database, token: string): MemberAuthResult {
  if (!isWellFormedToken(token, MEMBER_TOKEN_PREFIX)) return { status: 'unknown' };
  const row = db
    .prepare<[string], MemberRow>('SELECT * FROM members WHERE token_hash = ?')
    .get(hashToken(token));
  if (row === undefined) return { status: 'unknown' };
  const member = toMember(row);
  return member.revokedAt === null ? { status: 'ok', member } : { status: 'revoked', member };
}

/** The member with this id, or `undefined`. */
export function findMember(db: Database.Database, id: string): Member | undefined {
  const row = db.prepare<[string], MemberRow>('SELECT * FROM members WHERE id = ?').get(id);
  return row === undefined ? undefined : toMember(row);
}

/**
 * Creates a member and issues its token. The token is returned and never
 * stored, so this is the only moment it exists anywhere but the teammate's
 * machine — a lost token is replaced by a new invitation, not recovered.
 */
export function createMember(db: Database.Database, details: NewMember): IssuedMember {
  const now = details.now ?? Date.now();
  const id = generateMemberId();
  const token = generateMemberToken();
  const hostname = details.hostname ?? null;
  const os = details.os ?? null;

  db.prepare(
    `INSERT INTO members
       (id, display_name, token_hash, created_at, revoked_at, join_hostname, join_os)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, details.displayName, hashToken(token), now, hostname, os);

  return {
    token,
    member: {
      id,
      displayName: details.displayName,
      createdAt: now,
      revokedAt: null,
      joinHostname: hostname,
      joinOs: os,
    },
  };
}

/**
 * Marks a member revoked. Returns false when there is no such member or it was
 * already revoked — re-revoking must not move the timestamp, which is the only
 * record of when their access actually stopped.
 */
export function revokeMember(db: Database.Database, id: string, now: number = Date.now()): boolean {
  const info = db
    .prepare('UPDATE members SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, id);
  return info.changes === 1;
}

/**
 * A `preHandler` that requires a member token and attaches the member.
 *
 * 401 for a token this server does not know, 403 for one it knows and has
 * revoked. The difference matters to whoever is holding it: the first means
 * "your config is wrong", the second means "ask your admin". Both are 4xx, so
 * an OTLP exporter drops the batch instead of retrying it forever.
 */
export function requireMember(
  db: Database.Database,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const token = parseBearerToken(request.headers.authorization);
    if (token === undefined) {
      failUnauthorized(reply, 'missing Authorization: Bearer <token> header');
      return;
    }

    const result = authenticateMemberToken(db, token);
    if (result.status === 'unknown') {
      failUnauthorized(reply, 'unknown token');
      return;
    }
    if (result.status === 'revoked') {
      fail(reply, 403, 'this token has been revoked');
      return;
    }

    request.member = result.member;
  };
}

/**
 * Ensures the server has an admin token, issuing one if it has none or if
 * `rotate` is set. The returned token is present only when one was just
 * issued — there is no way to read an existing one back, which is the point.
 *
 * The read and the write are one immediate transaction so that two `serve`
 * processes racing on the same file cannot both conclude they are the first and
 * print two tokens, only one of which works.
 */
export function ensureAdminToken(
  db: Database.Database,
  options: { readonly rotate?: boolean; readonly now?: number } = {},
): AdminTokenResult {
  const now = options.now ?? Date.now();
  const rotate = options.rotate ?? false;

  const issue = db.transaction((): AdminTokenResult => {
    const existing = getConfig(db, CONFIG_ADMIN_TOKEN_HASH);
    if (existing !== undefined && !rotate) {
      return { existed: true, rotated: false };
    }
    const token = generateAdminToken();
    setConfig(db, CONFIG_ADMIN_TOKEN_HASH, hashToken(token), now);
    setConfig(db, CONFIG_ADMIN_TOKEN_SET_AT, String(now), now);
    return { token, existed: existing !== undefined, rotated: existing !== undefined };
  });

  return issue.immediate();
}

/** Compares two hex digests without leaking where they first differ. */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== SHA256_HEX_LENGTH || b.length !== SHA256_HEX_LENGTH) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * True when `token` is this server's admin token. Constant-time against the
 * stored digest: unlike a member token, this one is compared in JavaScript
 * rather than by an index probe, so the comparison is ours to get right.
 */
export function verifyAdminToken(db: Database.Database, token: string): boolean {
  if (!isWellFormedToken(token, ADMIN_TOKEN_PREFIX)) return false;
  const stored = getConfig(db, CONFIG_ADMIN_TOKEN_HASH);
  if (stored === undefined) return false;
  return digestsMatch(hashToken(token), stored);
}

/**
 * An `onRequest` hook that refuses anything under `/api` without the admin
 * token. Registered against a path prefix rather than route by route, so a
 * route added to that prefix later is guarded whether or not anyone remembers
 * to guard it — and so an unauthenticated caller cannot learn which `/api`
 * paths exist by comparing 401s against 404s.
 */
export function requireAdmin(
  db: Database.Database,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const token = parseBearerToken(request.headers.authorization);
    if (token === undefined) {
      failUnauthorized(reply, 'missing Authorization: Bearer <admin token> header');
      return;
    }
    if (!verifyAdminToken(db, token)) {
      failUnauthorized(reply, 'unknown admin token');
      return;
    }
  };
}
