/**
 * The aggregates, against a real SQLite file in memory.
 *
 * These tests are written against numbers a reader can add up by hand: every
 * seeded request uses small round token counts, so an assertion that fails says
 * which column drifted rather than that two large sums disagree. The two facts
 * worth guarding above the rest are that shares sum to 100 and that costs come
 * back as integers — the first is stage 4's acceptance criterion, and the second
 * is what stops a dollar figure from being a float that has already lost cents.
 */

import { describe, expect, it } from 'vitest';

import type { Database } from './index.js';
import { migratedDatabase } from './index.js';
import {
  ALL_SOURCES,
  BUCKET_MS,
  installsOfMember,
  memberEntry,
  memberList,
  memberUsageInRange,
  modelUsageInRange,
  sessionUsageInRange,
  sourcePredicate,
  sourceUsageInRange,
  timeseriesInRange,
  timeseriesMembers,
  totalsInRange,
} from './queries.js';
import type { SourceFilter, UsageRange } from './queries.js';
import { SOURCE_NONE, UNATTRIBUTED_MEMBER_ID } from '../shared/constants.js';
import type { ModelFamily } from '../shared/types.js';

/** Midnight UTC on a Thursday, so a day bucket is unambiguous to read. */
const DAY_ONE = Date.UTC(2026, 7, 20, 0, 0, 0);

/** Milliseconds in an hour, spelled out where a test shifts a timestamp. */
const HOUR = 60 * 60 * 1000;

/** Milliseconds in a day. */
const DAY = 24 * HOUR;

/** The whole seeded week, and then some. */
const WIDE: UsageRange = { from: DAY_ONE - DAY, to: DAY_ONE + 7 * DAY };

/** One seeded `requests` row. Every field has a default a test can ignore. */
interface SeedRequest {
  readonly id: string;
  readonly ts: number;
  readonly memberId: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly family?: ModelFamily;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
  readonly costMicros?: number;
  readonly source?: string;
  readonly installId?: string;
}

/** Inserts a member with a token hash unique to its id. */
function seedMember(
  db: Database.Database,
  id: string,
  displayName: string,
  options: { readonly revokedAt?: number; readonly hostname?: string } = {},
): void {
  db.prepare(
    `INSERT INTO members
       (id, display_name, token_hash, created_at, revoked_at, join_hostname, join_os)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    displayName,
    `hash-${id}`,
    DAY_ONE - DAY,
    options.revokedAt ?? null,
    options.hostname ?? null,
    null,
  );
}

/** Inserts one request row, defaulting every column a test did not name. */
function seedRequest(db: Database.Database, request: SeedRequest): void {
  db.prepare(
    `INSERT INTO requests (
       id, ts, member_id, install_id, session_id, prompt_id, model, model_family,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_micros, duration_ms, query_source, speed, effort
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
  ).run(
    request.id,
    request.ts,
    request.memberId,
    request.installId ?? null,
    request.sessionId ?? null,
    null,
    request.model ?? 'claude-opus-5',
    request.family ?? 'opus',
    request.input ?? 0,
    request.output ?? 0,
    request.cacheRead ?? 0,
    request.cacheCreation ?? 0,
    request.costMicros ?? 0,
    request.source ?? null,
  );
}

/** Inserts one install row. */
function seedInstall(
  db: Database.Database,
  id: string,
  memberId: string,
  seen: { readonly first: number; readonly last: number },
): void {
  db.prepare(
    `INSERT INTO installs
       (id, member_id, hostname, os_type, os_version, arch, cc_version, terminal_type,
        first_seen, last_seen)
     VALUES (?, ?, NULL, 'windows', '10.0', 'x64', '2.1.241', 'vscode', ?, ?)`,
  ).run(id, memberId, seen.first, seen.last);
}

/**
 * Three members and eight requests: Alice heavy on opus, Bob lighter on sonnet,
 * Carol enrolled but silent. Two of Alice's requests are session-title
 * overhead, and one of Bob's carries no `query_source` at all.
 */
function seeded(): Database.Database {
  const db = migratedDatabase(':memory:');
  seedMember(db, 'm_alice', 'Alice', { hostname: 'alice-box' });
  seedMember(db, 'm_bob', 'Bob');
  seedMember(db, 'm_carol', 'Carol');

  seedRequest(db, {
    id: 'r1',
    ts: DAY_ONE + HOUR,
    memberId: 'm_alice',
    sessionId: 's_a1',
    input: 100,
    output: 200,
    cacheRead: 300,
    cacheCreation: 400,
    costMicros: 1_000,
    source: 'sdk',
    installId: 'i_alice_1',
  });
  seedRequest(db, {
    id: 'r2',
    ts: DAY_ONE + 2 * HOUR,
    memberId: 'm_alice',
    sessionId: 's_a1',
    input: 100,
    output: 100,
    costMicros: 2_000,
    source: 'sdk',
    installId: 'i_alice_1',
  });
  seedRequest(db, {
    id: 'r3',
    ts: DAY_ONE + DAY + HOUR,
    memberId: 'm_alice',
    sessionId: 's_a2',
    input: 200,
    output: 200,
    costMicros: 3_000,
    source: 'generate_session_title',
    installId: 'i_alice_2',
  });
  seedRequest(db, {
    id: 'r4',
    ts: DAY_ONE + DAY + 2 * HOUR,
    memberId: 'm_alice',
    sessionId: 's_a2',
    input: 100,
    output: 300,
    costMicros: 4_000,
    source: 'compact',
    installId: 'i_alice_2',
  });
  seedRequest(db, {
    id: 'r5',
    ts: DAY_ONE + 3 * HOUR,
    memberId: 'm_bob',
    sessionId: 's_b1',
    model: 'claude-sonnet-5',
    family: 'sonnet',
    input: 50,
    output: 50,
    costMicros: 500,
    source: 'sdk',
    installId: 'i_bob_1',
  });
  seedRequest(db, {
    id: 'r6',
    ts: DAY_ONE + 4 * HOUR,
    memberId: 'm_bob',
    sessionId: 's_b2',
    model: 'claude-sonnet-5',
    family: 'sonnet',
    input: 100,
    output: 100,
    costMicros: 500,
    installId: 'i_bob_1',
  });

  seedInstall(db, 'i_alice_1', 'm_alice', { first: DAY_ONE, last: DAY_ONE + 2 * HOUR });
  seedInstall(db, 'i_alice_2', 'm_alice', { first: DAY_ONE + DAY, last: DAY_ONE + DAY + 2 * HOUR });
  seedInstall(db, 'i_bob_1', 'm_bob', { first: DAY_ONE, last: DAY_ONE + 10 * DAY });
  return db;
}

/** Sums a numeric field of a row list. */
function sumOf<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

describe('sourcePredicate', () => {
  it('binds every value it filters on and interpolates none of them', () => {
    const predicate = sourcePredicate({ group: 'overhead', source: 'sdk' });
    expect(predicate.sql).not.toContain('sdk');
    expect(predicate.sql).not.toContain('generate_session_title');
    expect(Object.values(predicate.params)).toContain('sdk');
    expect(Object.values(predicate.params)).toContain('generate_session_title');
  });

  it('adds nothing at all for the unfiltered case', () => {
    expect(sourcePredicate(ALL_SOURCES)).toEqual({ sql: '', params: {} });
  });
});

describe('totalsInRange', () => {
  it('sums every token column and counts distinct sessions', () => {
    const db = seeded();
    const totals = totalsInRange(db, WIDE, ALL_SOURCES);

    expect(totals.input_tokens).toBe(650);
    expect(totals.output_tokens).toBe(950);
    expect(totals.cache_read_tokens).toBe(300);
    expect(totals.cache_creation_tokens).toBe(400);
    expect(totals.total_tokens).toBe(650 + 950 + 300 + 400);
    expect(totals.requests).toBe(6);
    expect(totals.sessions).toBe(4);
    expect(totals.cost_micros).toBe(11_000);
    db.close();
  });

  it('keeps cost as an integer count of micros', () => {
    const db = seeded();
    const totals = totalsInRange(db, WIDE, ALL_SOURCES);
    expect(Number.isInteger(totals.cost_micros)).toBe(true);
    db.close();
  });

  it('treats the range as half open, so back-to-back ranges never double count', () => {
    const db = seeded();
    const boundary = DAY_ONE + DAY;
    const before = totalsInRange(db, { from: DAY_ONE, to: boundary }, ALL_SOURCES);
    const after = totalsInRange(db, { from: boundary, to: boundary + DAY }, ALL_SOURCES);
    const whole = totalsInRange(db, { from: DAY_ONE, to: boundary + DAY }, ALL_SOURCES);

    expect(before.requests + after.requests).toBe(whole.requests);
    expect(before.total_tokens + after.total_tokens).toBe(whole.total_tokens);
    db.close();
  });

  it('returns zeros rather than nulls for an empty range', () => {
    const db = seeded();
    const totals = totalsInRange(
      db,
      { from: DAY_ONE - 10 * DAY, to: DAY_ONE - 9 * DAY },
      ALL_SOURCES,
    );
    expect(totals).toEqual({
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      requests: 0,
      sessions: 0,
      cost_micros: 0,
    });
    db.close();
  });

  it('separates overhead from work, and the two partition the whole', () => {
    const db = seeded();
    const all = totalsInRange(db, WIDE, ALL_SOURCES);
    const work = totalsInRange(db, WIDE, { group: 'work' });
    const overhead = totalsInRange(db, WIDE, { group: 'overhead' });

    expect(overhead.requests).toBe(2);
    expect(overhead.total_tokens).toBe(800);
    expect(work.requests + overhead.requests).toBe(all.requests);
    expect(work.total_tokens + overhead.total_tokens).toBe(all.total_tokens);
    db.close();
  });

  it('counts a request with no query_source as work rather than dropping it', () => {
    const db = seeded();
    const work = totalsInRange(db, WIDE, { group: 'work' });
    const none = totalsInRange(db, WIDE, { group: 'all', source: SOURCE_NONE });

    expect(none.requests).toBe(1);
    expect(work.requests).toBe(4);
    db.close();
  });

  it('filters to one exact source', () => {
    const db = seeded();
    const sdk = totalsInRange(db, WIDE, { group: 'all', source: 'sdk' });
    expect(sdk.requests).toBe(3);
    db.close();
  });

  it('ands the two predicates instead of letting one win', () => {
    const db = seeded();
    const impossible = totalsInRange(db, WIDE, { group: 'overhead', source: 'sdk' });
    expect(impossible.requests).toBe(0);
    db.close();
  });
});

describe('memberUsageInRange', () => {
  it('returns shares that sum to 100 percent', () => {
    const db = seeded();
    const members = memberUsageInRange(db, WIDE, ALL_SOURCES);
    expect(sumOf(members, (member) => member.share_pct)).toBeCloseTo(100, 9);
    db.close();
  });

  it('orders by tokens descending and attributes them per member', () => {
    const db = seeded();
    const members = memberUsageInRange(db, WIDE, ALL_SOURCES);

    expect(members.map((member) => member.member_id)).toEqual(['m_alice', 'm_bob', 'm_carol']);
    const alice = members[0];
    expect(alice?.total_tokens).toBe(2000);
    expect(alice?.sessions).toBe(2);
    expect(alice?.cost_micros).toBe(10_000);
    expect(alice?.last_request).toBe(DAY_ONE + DAY + 2 * HOUR);
    db.close();
  });

  it('keeps an enrolled member who reported nothing, at zero', () => {
    const db = seeded();
    const carol = memberUsageInRange(db, WIDE, ALL_SOURCES).find(
      (member) => member.member_id === 'm_carol',
    );

    expect(carol).toBeDefined();
    expect(carol?.total_tokens).toBe(0);
    expect(carol?.requests).toBe(0);
    expect(carol?.share_pct).toBe(0);
    expect(carol?.last_request).toBeNull();
    db.close();
  });

  it('gives every member a zero share rather than a null one in an empty range', () => {
    const db = seeded();
    const members = memberUsageInRange(
      db,
      { from: DAY_ONE - 10 * DAY, to: DAY_ONE - 9 * DAY },
      ALL_SOURCES,
    );

    expect(members.length).toBe(3);
    for (const member of members) expect(member.share_pct).toBe(0);
    db.close();
  });

  it('drops a revoked member with no activity but keeps one with history', () => {
    const db = seeded();
    db.prepare('UPDATE members SET revoked_at = ? WHERE id = ?').run(DAY_ONE + 5 * DAY, 'm_carol');
    db.prepare('UPDATE members SET revoked_at = ? WHERE id = ?').run(DAY_ONE + 5 * DAY, 'm_bob');
    const ids = memberUsageInRange(db, WIDE, ALL_SOURCES).map((member) => member.member_id);

    expect(ids).toContain('m_bob');
    expect(ids).not.toContain('m_carol');
    db.close();
  });

  it('hides the seeded placeholder member until it actually owns rows', () => {
    const db = seeded();
    expect(memberUsageInRange(db, WIDE, ALL_SOURCES).map((m) => m.member_id)).not.toContain(
      UNATTRIBUTED_MEMBER_ID,
    );

    seedRequest(db, { id: 'r_old', ts: DAY_ONE, memberId: UNATTRIBUTED_MEMBER_ID, input: 10 });
    expect(memberUsageInRange(db, WIDE, ALL_SOURCES).map((m) => m.member_id)).toContain(
      UNATTRIBUTED_MEMBER_ID,
    );
    db.close();
  });

  it('recomputes shares against the filtered total, not the unfiltered one', () => {
    const db = seeded();
    const overhead = memberUsageInRange(db, WIDE, { group: 'overhead' });
    const alice = overhead.find((member) => member.member_id === 'm_alice');

    // Only Alice produced overhead, so she is all of it.
    expect(alice?.share_pct).toBeCloseTo(100, 9);
    expect(sumOf(overhead, (member) => member.share_pct)).toBeCloseTo(100, 9);
    db.close();
  });

  it('agrees with the range totals, member by member', () => {
    const db = seeded();
    const totals = totalsInRange(db, WIDE, ALL_SOURCES);
    const members = memberUsageInRange(db, WIDE, ALL_SOURCES);

    expect(sumOf(members, (member) => member.total_tokens)).toBe(totals.total_tokens);
    expect(sumOf(members, (member) => member.requests)).toBe(totals.requests);
    expect(sumOf(members, (member) => member.cost_micros)).toBe(totals.cost_micros);
    db.close();
  });
});

describe('sourceUsageInRange', () => {
  it('classifies each source and covers every request exactly once', () => {
    const db = seeded();
    const sources = sourceUsageInRange(db, WIDE);
    const byName = new Map(sources.map((source) => [source.query_source, source]));

    expect(byName.get('sdk')?.group).toBe('work');
    expect(byName.get('generate_session_title')?.group).toBe('overhead');
    expect(byName.get('compact')?.group).toBe('overhead');
    expect(byName.get(null)?.group).toBe('work');
    expect(sumOf(sources, (source) => source.requests)).toBe(6);
    expect(sumOf(sources, (source) => source.share_pct)).toBeCloseTo(100, 9);
    db.close();
  });
});

describe('modelUsageInRange', () => {
  it('groups by the raw model string and carries the family through', () => {
    const db = seeded();
    const models = modelUsageInRange(db, WIDE, ALL_SOURCES);

    expect(models.map((model) => model.model)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(models[0]?.model_family).toBe('opus');
    expect(models[1]?.total_tokens).toBe(300);
    expect(sumOf(models, (model) => model.share_pct)).toBeCloseTo(100, 9);
    db.close();
  });

  it('scopes to one member when asked', () => {
    const db = seeded();
    const models = modelUsageInRange(db, WIDE, ALL_SOURCES, 'm_bob');

    expect(models.length).toBe(1);
    expect(models[0]?.model).toBe('claude-sonnet-5');
    expect(models[0]?.share_pct).toBeCloseTo(100, 9);
    db.close();
  });
});

describe('timeseriesInRange', () => {
  it('buckets by the hour, one row per member per bucket', () => {
    const db = seeded();
    const points = timeseriesInRange(db, WIDE, ALL_SOURCES, BUCKET_MS.hour, 0);

    expect(points.length).toBe(6);
    expect(points[0]?.bucket_start).toBe(DAY_ONE + HOUR);
    expect(points.every((point) => point.bucket_start % BUCKET_MS.hour === 0)).toBe(true);
    expect(sumOf(points, (point) => point.total_tokens)).toBe(
      totalsInRange(db, WIDE, ALL_SOURCES).total_tokens,
    );
    db.close();
  });

  it('collapses a day into one bucket per member', () => {
    const db = seeded();
    const points = timeseriesInRange(db, WIDE, ALL_SOURCES, BUCKET_MS.day, 0);
    const firstDay = points.filter((point) => point.bucket_start === DAY_ONE);

    expect(firstDay.map((point) => point.member_id)).toEqual(['m_alice', 'm_bob']);
    expect(firstDay[0]?.requests).toBe(2);
    db.close();
  });

  it('aligns day boundaries to the offset it is given', () => {
    const db = seeded();
    // Six hours east: local midnight is 18:00 UTC the day before, so a request
    // at 01:00 UTC belongs to the bucket that opened at 18:00 UTC.
    const points = timeseriesInRange(db, WIDE, ALL_SOURCES, BUCKET_MS.day, 6 * 60);
    const starts = new Set(points.map((point) => point.bucket_start));

    expect(starts.has(DAY_ONE - 6 * HOUR)).toBe(true);
    expect(starts.has(DAY_ONE)).toBe(false);
    db.close();
  });

  it('lists the members it covers, heaviest first', () => {
    const db = seeded();
    const members = timeseriesMembers(db, WIDE, ALL_SOURCES);

    expect(members.map((member) => member.member_id)).toEqual(['m_alice', 'm_bob']);
    expect(members[0]?.display_name).toBe('Alice');
    db.close();
  });
});

describe('memberList', () => {
  it('reports install counts and the latest sign of life', () => {
    const db = seeded();
    const byId = new Map(memberList(db).map((member) => [member.member_id, member]));

    expect(byId.get('m_alice')?.installs).toBe(2);
    // Bob's install heartbeat is newer than any request he made.
    expect(byId.get('m_bob')?.last_seen).toBe(DAY_ONE + 10 * DAY);
    expect(byId.get('m_carol')?.installs).toBe(0);
    expect(byId.get('m_carol')?.last_seen).toBeNull();
    expect(byId.get('m_alice')?.join_hostname).toBe('alice-box');
    db.close();
  });

  it('sorts the never-seen to the end', () => {
    const db = seeded();
    const ids = memberList(db).map((member) => member.member_id);
    expect(ids).toEqual(['m_bob', 'm_alice', 'm_carol']);
    db.close();
  });

  it('hides the placeholder member unless it owns rows', () => {
    const db = seeded();
    expect(memberList(db).map((member) => member.member_id)).not.toContain(UNATTRIBUTED_MEMBER_ID);

    seedRequest(db, { id: 'r_old', ts: DAY_ONE, memberId: UNATTRIBUTED_MEMBER_ID, input: 10 });
    expect(memberList(db).map((member) => member.member_id)).toContain(UNATTRIBUTED_MEMBER_ID);
    db.close();
  });

  it('finds one member by id, and nothing for an unknown one', () => {
    const db = seeded();
    expect(memberEntry(db, 'm_alice')?.display_name).toBe('Alice');
    expect(memberEntry(db, 'm_nobody')).toBeUndefined();
    db.close();
  });
});

describe('sessionUsageInRange', () => {
  it('aggregates per session, heaviest first, with a first and last request', () => {
    const db = seeded();
    const sessions = sessionUsageInRange(db, 'm_alice', WIDE, ALL_SOURCES, 100);

    expect(sessions.map((session) => session.session_id)).toEqual(['s_a1', 's_a2']);
    expect(sessions[0]?.total_tokens).toBe(1200);
    expect(sessions[0]?.started_at).toBe(DAY_ONE + HOUR);
    expect(sessions[0]?.ended_at).toBe(DAY_ONE + 2 * HOUR);
    db.close();
  });

  it('honours the cap it is given', () => {
    const db = seeded();
    expect(sessionUsageInRange(db, 'm_alice', WIDE, ALL_SOURCES, 1).length).toBe(1);
    db.close();
  });

  it('applies the source filter', () => {
    const db = seeded();
    const filter: SourceFilter = { group: 'overhead' };
    const sessions = sessionUsageInRange(db, 'm_alice', WIDE, filter, 100);

    expect(sessions.map((session) => session.session_id)).toEqual(['s_a2']);
    db.close();
  });
});

describe('installsOfMember', () => {
  it('returns the machines reporting under a member, freshest first', () => {
    const db = seeded();
    const installs = installsOfMember(db, 'm_alice');

    expect(installs.map((install) => install.install_id)).toEqual(['i_alice_2', 'i_alice_1']);
    expect(installs[0]?.terminal_type).toBe('vscode');
    expect(installs[0]?.cc_version).toBe('2.1.241');
    db.close();
  });
});
