/**
 * The read API over HTTP, driven through `app.inject()`.
 *
 * The aggregates themselves are covered in `src/db/queries.test.ts`; what is
 * under test here is everything between the query string and that layer — who
 * is allowed to ask, which ranges are refused, and whether the answer has the
 * shape the dashboard is written against.
 *
 * Two things get more attention than the rest. The first is the guard: an
 * `/api` path must answer 401 to a missing token, a member token and a garbage
 * token alike, and it must do so for paths that do not exist, or the 404s
 * become a map of the API for anyone who asks for it. The second is range
 * validation, because a range that parses to `NaN` does not fail loudly — it
 * silently selects nothing and the dashboard renders a convincing empty state.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { ensureAdminToken, generateAdminToken, generateMemberToken, hashToken } from './auth.js';
import { resolveBucket, resolveFilter, resolveRange } from './api.js';
import type { Database } from '../db/index.js';
import { migratedDatabase } from '../db/index.js';
import type {
  MemberDetailResponse,
  MembersResponse,
  ModelsResponse,
  RevokeResponse,
  SummaryResponse,
  TimeseriesResponse,
} from '../shared/api.js';

/** Midnight UTC, so a day bucket in an assertion is readable. */
const DAY_ONE = Date.UTC(2026, 7, 20, 0, 0, 0);

/** Milliseconds in an hour. */
const HOUR = 60 * 60 * 1000;

/** Milliseconds in a day. */
const DAY = 24 * HOUR;

/** A range wide enough to hold everything the harness seeds. */
const RANGE = `from=${new Date(DAY_ONE - DAY).toISOString()}&to=${new Date(
  DAY_ONE + 7 * DAY,
).toISOString()}`;

/** The one error shape this server sends. */
interface ErrorBody {
  readonly error: string;
}

/** A built app, the database under it, and the admin token that opens it. */
interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database.Database;
  readonly adminToken: string;
  readonly adminHeaders: Readonly<Record<string, string>>;
}

const openHandles: Database.Database[] = [];

afterEach(() => {
  while (openHandles.length > 0) openHandles.pop()?.close();
});

/** Inserts a member with a unique token hash and no join metadata. */
function seedMember(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO members (id, display_name, token_hash, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(id, name, hashToken(`token-for-${id}`), DAY_ONE - DAY);
}

/** Inserts one request row with round numbers a reader can add up. */
function seedRequest(
  db: Database.Database,
  row: {
    readonly id: string;
    readonly ts: number;
    readonly memberId: string;
    readonly sessionId: string;
    readonly model: string;
    readonly tokens: number;
    readonly costMicros: number;
    readonly source: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO requests (
       id, ts, member_id, install_id, session_id, model, model_family,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_micros, query_source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
  ).run(
    row.id,
    row.ts,
    row.memberId,
    `i_${row.memberId}`,
    row.sessionId,
    row.model,
    row.model.includes('opus') ? 'opus' : 'sonnet',
    row.tokens,
    row.costMicros,
    row.source,
  );
}

/**
 * Two members and four requests: Alice at 750 tokens over two sessions, one of
 * them session-title overhead, and Bob at 250 over one. The totals are chosen
 * so the shares are 75 and 25 and no assertion needs a calculator.
 */
function harness(): Harness {
  const db = migratedDatabase(':memory:');
  openHandles.push(db);
  seedMember(db, 'm_alice', 'Alice');
  seedMember(db, 'm_bob', 'Bob');

  seedRequest(db, {
    id: 'r1',
    ts: DAY_ONE + HOUR,
    memberId: 'm_alice',
    sessionId: 's_a1',
    model: 'claude-opus-5',
    tokens: 500,
    costMicros: 5_000,
    source: 'sdk',
  });
  seedRequest(db, {
    id: 'r2',
    ts: DAY_ONE + 2 * HOUR,
    memberId: 'm_alice',
    sessionId: 's_a2',
    model: 'claude-opus-5',
    tokens: 250,
    costMicros: 2_500,
    source: 'generate_session_title',
  });
  seedRequest(db, {
    id: 'r3',
    ts: DAY_ONE + 3 * HOUR,
    memberId: 'm_bob',
    sessionId: 's_b1',
    model: 'claude-sonnet-5',
    tokens: 150,
    costMicros: 1_500,
    source: 'sdk',
  });
  seedRequest(db, {
    id: 'r4',
    ts: DAY_ONE + 2 * DAY,
    memberId: 'm_bob',
    sessionId: 's_b1',
    model: 'claude-sonnet-5',
    tokens: 100,
    costMicros: 1_000,
    source: null,
  });

  db.prepare(
    `INSERT INTO installs
       (id, member_id, hostname, os_type, os_version, arch, cc_version, terminal_type,
        first_seen, last_seen)
     VALUES ('i_m_alice', 'm_alice', NULL, 'windows', '10.0', 'x64', '2.1.241', 'vscode', ?, ?)`,
  ).run(DAY_ONE, DAY_ONE + 2 * HOUR);

  const app = buildApp({ db });
  const issued = ensureAdminToken(db);
  const adminToken = issued.token ?? '';
  return {
    app,
    db,
    adminToken,
    adminHeaders: { authorization: `Bearer ${adminToken}` },
  };
}

describe('the admin guard over /api', () => {
  it('refuses a request with no token, and says how to bring one', async () => {
    const { app } = harness();
    const response = await app.inject({ method: 'GET', url: '/api/summary' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('refuses a member token, which is a different credential', async () => {
    const { app, db } = harness();
    const memberToken = generateMemberToken();
    db.prepare('UPDATE members SET token_hash = ? WHERE id = ?').run(
      hashToken(memberToken),
      'm_alice',
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/summary',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a well-formed admin token that is not this server s', async () => {
    const { app } = harness();
    const response = await app.inject({
      method: 'GET',
      url: '/api/summary',
      headers: { authorization: `Bearer ${generateAdminToken()}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 401 rather than 404 for an /api path that does not exist', async () => {
    const { app, adminHeaders } = harness();

    expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(401);
    // With the token, the same path is honestly a 404 — the guard is not
    // hiding the API from someone who has already proved they may see it.
    expect(
      (await app.inject({ method: 'GET', url: '/api/nope', headers: adminHeaders })).statusCode,
    ).toBe(404);
  });
});

describe('range validation', () => {
  const badRanges: ReadonlyArray<readonly [string, string]> = [
    ['a word', 'from=yesterday'],
    ['a day that does not exist', 'from=2026-02-30'],
    ['a month that does not exist', 'from=2026-13-01'],
    ['a local time with no zone', 'from=2026-08-20T09:00:00'],
    ['a unix timestamp', 'from=1787184000000'],
    ['an empty value', 'from='],
    ['from after to', 'from=2026-08-21T00:00:00Z&to=2026-08-20T00:00:00Z'],
    ['from equal to to', 'from=2026-08-20T00:00:00Z&to=2026-08-20T00:00:00Z'],
  ];

  for (const [name, query] of badRanges) {
    it(`rejects ${name} with 400`, async () => {
      const { app, adminHeaders } = harness();
      const response = await app.inject({
        method: 'GET',
        url: `/api/summary?${query}`,
        headers: adminHeaders,
      });

      expect(response.statusCode).toBe(400);
      expect((JSON.parse(response.body) as ErrorBody).error).toBeTruthy();
    });
  }

  it('accepts a bare calendar date and reads it as midnight UTC', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: '/api/summary?from=2026-08-20&to=2026-08-21',
      headers: adminHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as SummaryResponse;
    expect(body.range.from).toBe('2026-08-20T00:00:00.000Z');
    expect(body.range.from_ms).toBe(DAY_ONE);
  });

  it('accepts an offset other than Z and normalises it', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: '/api/summary?from=2026-08-20T06:00:00%2B06:00&to=2026-08-21',
      headers: adminHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as SummaryResponse).range.from).toBe(
      '2026-08-20T00:00:00.000Z',
    );
  });

  it('defaults to the last seven days when asked for nothing', () => {
    const now = Date.UTC(2026, 7, 27, 12, 0, 0);
    const resolved = resolveRange({}, now);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.range.to).toBe(now);
    expect(now - resolved.range.from).toBe(7 * DAY);
  });

  it('rejects a timezone offset no timezone has', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: `/api/timeseries?${RANGE}&tz_offset=5000`,
      headers: adminHeaders,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a bucket it does not have', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: `/api/timeseries?${RANGE}&bucket=minute`,
      headers: adminHeaders,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a source group it does not have', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: `/api/summary?${RANGE}&group=everything`,
      headers: adminHeaders,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/summary', () => {
  it('returns per-member totals whose shares sum to 100', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: `/api/summary?${RANGE}`,
      headers: adminHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as SummaryResponse;

    expect(body.totals.total_tokens).toBe(1000);
    expect(body.totals.requests).toBe(4);
    expect(body.totals.sessions).toBe(3);
    expect(body.totals.cost_micros).toBe(10_000);

    expect(body.members.map((member) => member.display_name)).toEqual(['Alice', 'Bob']);
    expect(body.members[0]?.share_pct).toBeCloseTo(75, 9);
    expect(body.members[1]?.share_pct).toBeCloseTo(25, 9);
    expect(body.members.reduce((sum, member) => sum + member.share_pct, 0)).toBeCloseTo(100, 9);
  });

  it('sends totals as the eight aggregate fields and nothing else', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: `/api/summary?${RANGE}`,
      headers: adminHeaders,
    });
    const body = JSON.parse(response.body) as SummaryResponse;

    expect(Object.keys(body.totals).sort()).toEqual([
      'cache_creation_tokens',
      'cache_read_tokens',
      'cost_micros',
      'input_tokens',
      'output_tokens',
      'requests',
      'sessions',
      'total_tokens',
    ]);
  });

  it('lists every source in the range whatever the filter selects', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: `/api/summary?${RANGE}&group=overhead`,
      headers: adminHeaders,
    });
    const body = JSON.parse(response.body) as SummaryResponse;

    expect(body.filter).toEqual({ group: 'overhead', source: null });
    expect(body.totals.requests).toBe(1);
    // The control that would switch the filter back is still fully populated.
    // `null` sorts as the string "null", between the other two.
    expect(body.sources.map((source) => source.query_source).sort()).toEqual([
      'generate_session_title',
      null,
      'sdk',
    ]);
  });

  it('separates overhead from real work', async () => {
    const { app, adminHeaders } = harness();
    const work = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/summary?${RANGE}&group=work`,
          headers: adminHeaders,
        })
      ).body,
    ) as SummaryResponse;

    expect(work.totals.total_tokens).toBe(750);
    expect(work.members[0]?.total_tokens).toBe(500);
  });

  it('narrows to one exact source', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/summary?${RANGE}&source=sdk`,
          headers: adminHeaders,
        })
      ).body,
    ) as SummaryResponse;

    expect(body.filter).toEqual({ group: 'all', source: 'sdk' });
    expect(body.totals.requests).toBe(2);
  });

  it('narrows to the requests carrying no source at all', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/summary?${RANGE}&source=none`,
          headers: adminHeaders,
        })
      ).body,
    ) as SummaryResponse;

    expect(body.totals.requests).toBe(1);
    expect(body.totals.total_tokens).toBe(100);
  });
});

describe('GET /api/timeseries', () => {
  it('picks hourly buckets for a short range and daily for a long one', () => {
    expect(resolveBucket({}, { from: 0, to: 2 * DAY })).toBe('hour');
    expect(resolveBucket({}, { from: 0, to: 3 * DAY })).toBe('day');
    expect(resolveBucket({ bucket: 'hour' }, { from: 0, to: 30 * DAY })).toBe('hour');
  });

  it('returns one point per member per bucket, with a legend', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/timeseries?${RANGE}&bucket=day`,
          headers: adminHeaders,
        })
      ).body,
    ) as TimeseriesResponse;

    expect(body.bucket).toBe('day');
    expect(body.bucket_ms).toBe(DAY);
    expect(body.tz_offset_minutes).toBe(0);
    expect(body.members.map((member) => member.member_id)).toEqual(['m_alice', 'm_bob']);
    expect(body.points.length).toBe(3);
    expect(body.points[0]).toEqual({
      bucket_start: DAY_ONE,
      member_id: 'm_alice',
      total_tokens: 750,
      requests: 2,
      cost_micros: 7_500,
    });
  });

  it('never loses tokens to bucketing', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/timeseries?${RANGE}&bucket=hour&tz_offset=330`,
          headers: adminHeaders,
        })
      ).body,
    ) as TimeseriesResponse;

    expect(body.points.reduce((sum, point) => sum + point.total_tokens, 0)).toBe(1000);
    expect(body.tz_offset_minutes).toBe(330);
  });
});

describe('GET /api/models', () => {
  it('breaks the range down by model, heaviest first', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/models?${RANGE}`, headers: adminHeaders }))
        .body,
    ) as ModelsResponse;

    expect(body.models.map((model) => model.model)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(body.models[0]?.model_family).toBe('opus');
    expect(body.models[0]?.requests).toBe(2);
    expect(body.models.reduce((sum, model) => sum + model.share_pct, 0)).toBeCloseTo(100, 9);
  });
});

describe('GET /api/members', () => {
  it('lists everyone with a last-seen and an install count', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/members', headers: adminHeaders })).body,
    ) as MembersResponse;

    const byId = new Map(body.members.map((member) => [member.member_id, member]));
    expect(byId.get('m_alice')?.installs).toBe(1);
    expect(byId.get('m_alice')?.last_seen).toBe(DAY_ONE + 2 * HOUR);
    expect(byId.get('m_bob')?.installs).toBe(0);
    expect(byId.get('m_bob')?.last_seen).toBe(DAY_ONE + 2 * DAY);
  });
});

describe('GET /api/members/:id', () => {
  it('answers 404 for an id nobody has', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'GET',
      url: '/api/members/m_nobody',
      headers: adminHeaders,
    });

    expect(response.statusCode).toBe(404);
    expect((JSON.parse(response.body) as ErrorBody).error).toBe('no such member');
  });

  it('returns sessions, models and installs for one member', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/members/m_alice?${RANGE}`,
          headers: adminHeaders,
        })
      ).body,
    ) as MemberDetailResponse;

    expect(body.member.display_name).toBe('Alice');
    expect(body.totals.total_tokens).toBe(750);
    expect(body.share_pct).toBeCloseTo(75, 9);
    expect(body.sessions.map((session) => session.session_id)).toEqual(['s_a1', 's_a2']);
    expect(body.sessions_total).toBe(2);
    expect(body.models.map((model) => model.model)).toEqual(['claude-opus-5']);
    expect(body.installs.map((install) => install.install_id)).toEqual(['i_m_alice']);
    expect(body.installs[0]?.terminal_type).toBe('vscode');
  });

  it('reports zeros rather than failing for a member with nothing in the range', async () => {
    const { app, adminHeaders } = harness();
    const body = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/members/m_alice?from=2020-01-01&to=2020-01-02',
          headers: adminHeaders,
        })
      ).body,
    ) as MemberDetailResponse;

    expect(body.totals.total_tokens).toBe(0);
    expect(body.share_pct).toBe(0);
    expect(body.sessions).toEqual([]);
  });

  it('agrees with the summary table it is opened from', async () => {
    const { app, adminHeaders } = harness();
    const summary = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/summary?${RANGE}`, headers: adminHeaders }))
        .body,
    ) as SummaryResponse;
    const detail = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/members/m_bob?${RANGE}`,
          headers: adminHeaders,
        })
      ).body,
    ) as MemberDetailResponse;

    const fromTable = summary.members.find((member) => member.member_id === 'm_bob');
    expect(detail.totals.total_tokens).toBe(fromTable?.total_tokens);
    expect(detail.share_pct).toBe(fromTable?.share_pct);
  });
});

describe('POST /api/members/:id/revoke', () => {
  it('answers 404 for an id nobody has', async () => {
    const { app, adminHeaders } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/members/m_nobody/revoke',
      headers: adminHeaders,
    });
    expect(response.statusCode).toBe(404);
  });

  it('revokes once and then reports the original moment, not a new one', async () => {
    const { app, adminHeaders } = harness();
    const first = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/members/m_alice/revoke',
          headers: adminHeaders,
        })
      ).body,
    ) as RevokeResponse;

    expect(first.revoked).toBe(true);
    expect(first.revoked_at).toBeTypeOf('number');

    const second = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/members/m_alice/revoke',
          headers: adminHeaders,
        })
      ).body,
    ) as RevokeResponse;

    expect(second.revoked).toBe(false);
    expect(second.revoked_at).toBe(first.revoked_at);
  });

  it('actually stops that member from writing telemetry', async () => {
    const { app, db, adminHeaders } = harness();
    const memberToken = generateMemberToken();
    db.prepare('UPDATE members SET token_hash = ? WHERE id = ?').run(
      hashToken(memberToken),
      'm_alice',
    );

    const before = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' },
      payload: '{"resourceLogs":[]}',
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: '/api/members/m_alice/revoke',
      headers: adminHeaders,
    });

    const after = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' },
      payload: '{"resourceLogs":[]}',
    });
    expect(after.statusCode).toBe(403);
  });

  it('needs the admin token, like everything else under /api', async () => {
    const { app } = harness();
    const response = await app.inject({ method: 'POST', url: '/api/members/m_alice/revoke' });
    expect(response.statusCode).toBe(401);
  });
});

describe('resolveFilter', () => {
  it('carries both predicates rather than letting one replace the other', () => {
    expect(resolveFilter({ group: 'work', source: 'sdk' })).toEqual({
      filter: { group: 'work', source: 'sdk' },
      info: { group: 'work', source: 'sdk' },
    });
  });

  it('defaults to counting everything', () => {
    expect(resolveFilter({})).toEqual({
      filter: { group: 'all' },
      info: { group: 'all', source: null },
    });
  });
});
