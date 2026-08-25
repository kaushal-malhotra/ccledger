/**
 * Stage 4 acceptance, clause by clause.
 *
 * The colocated tests cover the SQL and the routes in isolation. This file
 * exists to prove the assembled path: real OTLP payloads go in through
 * `/v1/logs` as two different teammates, and the numbers that come back out of
 * `/api/summary` are the numbers those payloads described. Nothing here reaches
 * into the database — if the dashboard would show it, this test asks for it the
 * way the dashboard would.
 *
 * The clause the stage is graded on is the last one in the first block: with
 * seeded data, per-member totals are correct and the shares sum to 100%.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { migratedDatabase } from '../src/db/index.js';
import { buildApp } from '../src/server/app.js';
import { createMember, ensureAdminToken } from '../src/server/auth.js';
import { dashboardRoot } from '../src/server/dashboard.js';
import type {
  MemberDetailResponse,
  MembersResponse,
  ModelsResponse,
  SummaryResponse,
  TimeseriesResponse,
} from '../src/shared/api.js';

/** The two stage 0 captures, as the raw JSON text an exporter would send. */
const FIXTURES = {
  '001': readFileSync(new URL('./fixtures/001.json', import.meta.url), 'utf8'),
  '002': readFileSync(new URL('./fixtures/002.json', import.meta.url), 'utf8'),
} as const;

/**
 * What the one `api_request` in each fixture reports. Read off the captures by
 * hand, so a change to the parser that quietly alters a column fails here
 * rather than agreeing with itself.
 */
const CAPTURED = {
  '001': {
    tokens: 898 + 13 + 0 + 0,
    costMicros: 963,
    model: 'claude-haiku-4-5-20251001',
    source: 'generate_session_title',
  },
  '002': {
    tokens: 2 + 317 + 21_360 + 8_097,
    costMicros: 99_585,
    model: 'claude-opus-5',
    source: 'sdk',
  },
} as const;

/** Every token in both captures put together. */
const ALL_TOKENS = CAPTURED['001'].tokens + CAPTURED['002'].tokens;

/** A range wide enough to hold whenever the captures were taken. */
const WIDE = 'from=2020-01-01&to=2100-01-01';

/** The one error shape this server sends. */
interface ErrorBody {
  readonly error: string;
}

const openHandles: Database.Database[] = [];
const tempFiles: string[] = [];

afterEach(() => {
  while (openHandles.length > 0) openHandles.pop()?.close();
  for (const path of tempFiles.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

/** A server on a real file, two enrolled teammates, and the admin token. */
function server(): {
  readonly app: FastifyInstance;
  readonly admin: Readonly<Record<string, string>>;
  readonly alice: string;
  readonly bob: string;
  readonly aliceId: string;
  readonly bobId: string;
} {
  const path = join(tmpdir(), `ccledger-api-${randomUUID()}.db`);
  tempFiles.push(path);
  const db = migratedDatabase(path);
  openHandles.push(db);

  const alice = createMember(db, { displayName: 'Alice', hostname: 'alice-box', os: 'darwin' });
  const bob = createMember(db, { displayName: 'Bob' });
  const admin = ensureAdminToken(db);

  return {
    app: buildApp({ db }),
    admin: { authorization: `Bearer ${admin.token ?? ''}` },
    alice: alice.token,
    bob: bob.token,
    aliceId: alice.member.id,
    bobId: bob.member.id,
  };
}

/** Posts one capture as the holder of `token`, the way an exporter would. */
async function ingest(
  app: FastifyInstance,
  token: string,
  fixture: keyof typeof FIXTURES,
): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/logs',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: FIXTURES[fixture],
  });
  return response.statusCode;
}

/** GETs an API path with the admin token and parses the body. */
async function read<T>(
  app: FastifyInstance,
  admin: Readonly<Record<string, string>>,
  url: string,
): Promise<T> {
  const response = await app.inject({ method: 'GET', url, headers: admin });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as T;
}

/** Alice sends capture 001, Bob sends 002, and both are accepted. */
async function seeded(): Promise<ReturnType<typeof server>> {
  const context = server();
  expect(await ingest(context.app, context.alice, '001')).toBe(200);
  expect(await ingest(context.app, context.bob, '002')).toBe(200);
  return context;
}

describe('per-member aggregates over real ingested payloads', () => {
  it('attributes each capture to the teammate whose token carried it', async () => {
    const { app, admin, aliceId, bobId } = await seeded();
    const body = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}`);

    const byId = new Map(body.members.map((member) => [member.member_id, member]));
    expect(byId.get(aliceId)?.total_tokens).toBe(CAPTURED['001'].tokens);
    expect(byId.get(bobId)?.total_tokens).toBe(CAPTURED['002'].tokens);
    expect(byId.get(aliceId)?.cost_micros).toBe(CAPTURED['001'].costMicros);
    expect(byId.get(bobId)?.cost_micros).toBe(CAPTURED['002'].costMicros);
  });

  it('returns every aggregate the stage asked for', async () => {
    const { app, admin } = await seeded();
    const body = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}`);
    const member = body.members[0];

    expect(member).toBeDefined();
    for (const field of [
      'total_tokens',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'requests',
      'sessions',
      'cost_micros',
      'share_pct',
    ] as const) {
      expect(member?.[field]).toBeTypeOf('number');
    }
  });

  it('adds the members up to the range totals', async () => {
    const { app, admin } = await seeded();
    const body = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}`);

    expect(body.totals.total_tokens).toBe(ALL_TOKENS);
    expect(body.totals.requests).toBe(2);
    expect(body.totals.cost_micros).toBe(CAPTURED['001'].costMicros + CAPTURED['002'].costMicros);
    expect(body.members.reduce((sum, member) => sum + member.total_tokens, 0)).toBe(
      body.totals.total_tokens,
    );
  });

  it('returns shares that sum to 100 percent', async () => {
    const { app, admin, aliceId } = await seeded();
    const body = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}`);

    expect(body.members.reduce((sum, member) => sum + member.share_pct, 0)).toBeCloseTo(100, 9);
    const alice = body.members.find((member) => member.member_id === aliceId);
    expect(alice?.share_pct).toBeCloseTo((CAPTURED['001'].tokens / ALL_TOKENS) * 100, 9);
  });

  it('keeps every cost an integer count of micros', async () => {
    const { app, admin } = await seeded();
    const body = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}`);

    expect(Number.isInteger(body.totals.cost_micros)).toBe(true);
    for (const member of body.members) expect(Number.isInteger(member.cost_micros)).toBe(true);
  });

  it('does not double count a redelivered batch', async () => {
    const context = await seeded();
    const before = await read<SummaryResponse>(context.app, context.admin, `/api/summary?${WIDE}`);

    // OTLP delivery is at-least-once. The same bytes again must move nothing.
    expect(await ingest(context.app, context.alice, '001')).toBe(200);
    expect(await ingest(context.app, context.bob, '002')).toBe(200);

    const after = await read<SummaryResponse>(context.app, context.admin, `/api/summary?${WIDE}`);
    expect(after.totals).toEqual(before.totals);
    expect(after.members).toEqual(before.members);
  });
});

describe('separating overhead from real work', () => {
  it('splits the two captures along the query_source they carry', async () => {
    const { app, admin, aliceId, bobId } = await seeded();

    const work = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}&group=work`);
    const overhead = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}&group=overhead`);

    // 002 is `sdk`; 001 is a session title Claude Code generated for itself.
    expect(work.totals.total_tokens).toBe(CAPTURED['002'].tokens);
    expect(overhead.totals.total_tokens).toBe(CAPTURED['001'].tokens);
    expect(work.members.find((member) => member.member_id === bobId)?.share_pct).toBeCloseTo(
      100,
      9,
    );
    expect(overhead.members.find((member) => member.member_id === aliceId)?.share_pct).toBeCloseTo(
      100,
      9,
    );
  });

  it('lists both sources whichever way the filter is pointed', async () => {
    const { app, admin } = await seeded();
    const body = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}&group=overhead`);

    expect(body.sources.map((source) => source.query_source).sort()).toEqual([
      CAPTURED['001'].source,
      CAPTURED['002'].source,
    ]);
  });
});

describe('the other four endpoints', () => {
  it('breaks the range down by model', async () => {
    const { app, admin } = await seeded();
    const body = await read<ModelsResponse>(app, admin, `/api/models?${WIDE}`);

    expect(body.models.map((model) => model.model).sort()).toEqual([
      CAPTURED['001'].model,
      CAPTURED['002'].model,
    ]);
    expect(body.models.reduce((sum, model) => sum + model.share_pct, 0)).toBeCloseTo(100, 9);
  });

  it('buckets the range without losing a token', async () => {
    const { app, admin } = await seeded();
    const body = await read<TimeseriesResponse>(app, admin, `/api/timeseries?${WIDE}&bucket=day`);

    expect(body.points.reduce((sum, point) => sum + point.total_tokens, 0)).toBe(ALL_TOKENS);
    expect(body.members.length).toBe(2);
  });

  it('lists both teammates, and moves a shared install to its latest owner', async () => {
    const { app, admin, aliceId, bobId } = await seeded();
    const body = await read<MembersResponse>(app, admin, '/api/members');
    const byId = new Map(body.members.map((member) => [member.member_id, member]));

    expect(body.members.length).toBe(2);
    expect(byId.get(aliceId)?.join_hostname).toBe('alice-box');

    // Both captures were taken on one machine, so both carry the same
    // `user.id` — and `installs` is keyed on that. A batch is authenticated,
    // so the install belongs to whoever most recently reported from it, which
    // is Bob. That is the documented upsert rule, and it is what lets someone
    // who rejoins with a new token keep the machine they report from.
    expect(byId.get(bobId)?.installs).toBe(1);
    expect(byId.get(aliceId)?.installs).toBe(0);

    // Losing the install row does not make Alice look gone: her own requests
    // are still the newest sign of life the list has for her.
    expect(byId.get(aliceId)?.last_seen).toBeTypeOf('number');
  });

  it('agrees with itself between the table and one member s detail', async () => {
    const { app, admin, bobId } = await seeded();
    const summary = await read<SummaryResponse>(app, admin, `/api/summary?${WIDE}`);
    const detail = await read<MemberDetailResponse>(app, admin, `/api/members/${bobId}?${WIDE}`);

    const fromTable = summary.members.find((member) => member.member_id === bobId);
    expect(detail.totals.total_tokens).toBe(fromTable?.total_tokens);
    expect(detail.share_pct).toBe(fromTable?.share_pct);
    expect(detail.sessions.length).toBe(1);
    expect(detail.installs.length).toBe(1);
    expect(detail.models.map((model) => model.model)).toEqual([CAPTURED['002'].model]);
  });

  it('revokes a member and stops their telemetry at the door', async () => {
    const context = await seeded();
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/members/${context.aliceId}/revoke`,
      headers: context.admin,
    });

    expect(response.statusCode).toBe(200);
    expect(await ingest(context.app, context.alice, '001')).toBe(403);
    // Bob is untouched by it.
    expect(await ingest(context.app, context.bob, '002')).toBe(200);
  });
});

describe('the guard and the validation', () => {
  const paths: readonly string[] = [
    '/api/summary',
    '/api/timeseries',
    '/api/models',
    '/api/members',
    '/api/members/m_anything',
  ];

  for (const path of paths) {
    it(`refuses ${path} without the admin token`, async () => {
      const { app, alice } = server();

      expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
      // Nor will an ingest token do: they are different credentials.
      const asMember = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: `Bearer ${alice}` },
      });
      expect(asMember.statusCode).toBe(401);
    });
  }

  it('refuses the revoke route without the admin token', async () => {
    const { app, aliceId } = server();
    const response = await app.inject({ method: 'POST', url: `/api/members/${aliceId}/revoke` });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a from or to that is not an ISO instant, with 400', async () => {
    const { app, admin } = server();
    const rejected = [
      'from=yesterday',
      'from=2026-02-30',
      'from=1787184000000',
      'from=2026-08-20T09:00:00',
      'to=%00',
      'from=2026-08-21T00:00:00Z&to=2026-08-20T00:00:00Z',
    ];

    for (const query of rejected) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/summary?${query}`,
        headers: admin,
      });
      expect(response.statusCode).toBe(400);
      expect((JSON.parse(response.body) as ErrorBody).error).toBeTruthy();
    }
  });

  it('never answers 5xx for a range it cannot use', async () => {
    const { app, admin } = server();
    const response = await app.inject({
      method: 'GET',
      url: '/api/summary?from=' + 'x'.repeat(500),
      headers: admin,
    });
    expect(response.statusCode).toBeLessThan(500);
  });
});

describe('the dashboard at /', () => {
  // Which branch runs depends on whether `vite build` has been run in this
  // checkout, and the gate runs `test` before `build`. Both branches are real
  // behaviour and both are asserted, so the test says something either way.
  it('serves the built dashboard, or explains why there is none', async () => {
    const { app } = server();
    const response = await app.inject({ method: 'GET', url: '/' });

    if (dashboardRoot() === undefined) {
      expect(response.statusCode).toBe(503);
      expect(response.body).toContain('npm run build');
      return;
    }

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<div id="root">');
    // The page holds an admin token, so it may not be framed and may not run
    // code it did not ship with.
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not shadow any of the routes that were there before it', async () => {
    const { app, alice } = server();

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/summary' })).statusCode).toBe(401);
    const logs = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${alice}`, 'content-type': 'application/json' },
      payload: '{"resourceLogs":[]}',
    });
    expect(logs.statusCode).toBe(200);
  });
});
