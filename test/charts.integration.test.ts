/**
 * Stage 5 acceptance: a range with three members renders a readable stacked
 * area whose per-bucket totals match the table.
 *
 * "Renders" is not something a headless test can see, so this asserts the thing
 * a reader would be checking if they could: that the stack the chart is handed
 * and the numbers the table prints are the same numbers. It gets there the long
 * way — OTLP payloads in through `/v1/logs` as three different teammates, out
 * through `/api/timeseries` and `/api/summary`, and then through
 * `buildSeries()`, the very function the chart component calls.
 *
 * Importing the dashboard's own helper is the point. A test that re-derived the
 * buckets here would prove that two pieces of arithmetic in this repository
 * agree, which is not the claim; the claim is that what the chart draws sums to
 * what the table shows.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { migratedDatabase } from '../src/db/index.js';
import { buildApp } from '../src/server/app.js';
import { createMember, ensureAdminToken } from '../src/server/auth.js';
import type { SummaryResponse, TimeseriesResponse } from '../src/shared/api.js';
import { buildSeries, memberTrends } from '../web/src/lib/series.js';

/** A day, in milliseconds. */
const DAY = 86_400_000;

/** The UTC midnight the synthetic week begins at. */
const START = Date.UTC(2026, 4, 4);

/**
 * The three teammates and what each of them reported, day by day. Written out
 * rather than generated so the expected per-bucket totals below can be read off
 * by hand — a fixture that computes its own expectation proves nothing.
 */
const PLAN = [
  { name: 'Alice', daily: [3000, 0, 5000, 1000] },
  { name: 'Bob', daily: [0, 2000, 500, 0] },
  { name: 'Cara', daily: [700, 700, 0, 300] },
] as const;

/** What each bucket should come to, in order: the columns of `PLAN` summed. */
const EXPECTED_BUCKETS = [3700, 2700, 5500, 1300];

/** One OTLP attribute. */
function attr(key: string, value: Record<string, unknown>): Record<string, unknown> {
  return { key, value };
}

/**
 * One `api_request` record. The token split is arbitrary but adds to `tokens`,
 * and `client_request_id` is unique per record — it is the primary key ingest
 * dedupes on, so reusing one would silently drop the second event.
 */
function apiRequest(at: number, tokens: number, session: string): Record<string, unknown> {
  const output = Math.min(tokens, 100);
  return {
    timeUnixNano: `${String(at)}000000`,
    observedTimeUnixNano: `${String(at)}000000`,
    body: { stringValue: 'claude_code.api_request' },
    attributes: [
      attr('event.name', { stringValue: 'api_request' }),
      attr('event.timestamp', { stringValue: new Date(at).toISOString() }),
      attr('session.id', { stringValue: session }),
      attr('terminal.type', { stringValue: 'vscode' }),
      attr('model', { stringValue: 'claude-opus-5' }),
      attr('input_tokens', { intValue: String(tokens - output) }),
      attr('output_tokens', { intValue: String(output) }),
      attr('cache_read_tokens', { intValue: 0 }),
      attr('cache_creation_tokens', { intValue: 0 }),
      attr('cost_usd_micros', { intValue: String(tokens) }),
      attr('client_request_id', { stringValue: randomUUID() }),
      attr('query_source', { stringValue: 'user' }),
    ],
  };
}

/** The smallest valid OTLP envelope around a batch of records. */
function envelope(records: readonly unknown[]): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr('host.arch', { stringValue: 'amd64' }),
            attr('os.type', { stringValue: 'windows' }),
            attr('os.version', { stringValue: '10.0.26200' }),
            attr('service.name', { stringValue: 'claude-code' }),
            attr('service.version', { stringValue: '2.1.241' }),
          ],
          droppedAttributesCount: 0,
        },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.241' },
            logRecords: records,
          },
        ],
      },
    ],
  };
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

/** What a seeded server hands back. */
interface Seeded {
  readonly app: FastifyInstance;
  readonly admin: Readonly<Record<string, string>>;
  readonly ids: ReadonlyMap<string, string>;
}

/** A server with the three teammates enrolled and every day of `PLAN` ingested. */
async function seeded(): Promise<Seeded> {
  const path = join(tmpdir(), `ccledger-charts-${randomUUID()}.db`);
  tempFiles.push(path);
  const db = migratedDatabase(path);
  openHandles.push(db);

  const app = buildApp({ db });
  const admin = ensureAdminToken(db);
  const ids = new Map<string, string>();

  for (const person of PLAN) {
    const enrolled = createMember(db, { displayName: person.name });
    ids.set(person.name, enrolled.member.id);

    const records = person.daily.flatMap((tokens, day) =>
      tokens === 0
        ? []
        : // Mid-afternoon, so a bucket cannot be nudged across a boundary by a
          // timezone offset in either direction.
          [
            apiRequest(
              START + day * DAY + 14 * 3_600_000,
              tokens,
              `session-${person.name}-${String(day)}`,
            ),
          ],
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { authorization: `Bearer ${enrolled.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(envelope(records)),
    });
    expect(response.statusCode).toBe(200);
  }

  return { app, admin: { authorization: `Bearer ${admin.token ?? ''}` }, ids };
}

/** GETs an API path with the admin token and parses the body. */
async function read<T>(context: Seeded, url: string): Promise<T> {
  const response = await context.app.inject({ method: 'GET', url, headers: context.admin });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as T;
}

/**
 * The range the dashboard would ask for, in UTC, plus the `tz_offset` the
 * dashboard sends. Four days is over the three-day threshold, so the server
 * picks daily buckets without being told to — which is what the dashboard
 * relies on rather than choosing for itself.
 */
const QUERY =
  `from=${new Date(START).toISOString()}` +
  `&to=${new Date(START + 4 * DAY).toISOString()}` +
  `&tz_offset=0`;

/** No colour assignment: these assertions are about numbers, not hues. */
const NO_SLOTS = new Map<string, number>();

describe('stage 5 acceptance: the stack agrees with the table', () => {
  it('lets the server choose daily buckets for a range over three days', async () => {
    const context = await seeded();
    const body = await read<TimeseriesResponse>(context, `/api/timeseries?${QUERY}`);

    expect(body.bucket).toBe('day');
    expect(body.bucket_ms).toBe(DAY);
  });

  it('draws one band per member, heaviest first', async () => {
    const context = await seeded();
    const body = await read<TimeseriesResponse>(context, `/api/timeseries?${QUERY}`);
    const series = buildSeries(body, NO_SLOTS);

    // Alice 9,000, Bob 2,500, Cara 1,700 — the order the stack is built in, so
    // the largest band sits on the baseline where its shape is readable.
    expect(series.bands.map((band) => band.label)).toEqual(['Alice', 'Bob', 'Cara']);
  });

  it('gives every bucket the total those three members reported in it', async () => {
    const context = await seeded();
    const body = await read<TimeseriesResponse>(context, `/api/timeseries?${QUERY}`);
    const series = buildSeries(body, NO_SLOTS);

    expect(series.rows).toHaveLength(EXPECTED_BUCKETS.length);
    expect(series.rows.map((row) => row.__total)).toEqual(EXPECTED_BUCKETS);
  });

  it('adds the buckets up to the total the table prints', async () => {
    const context = await seeded();
    const [chart, table] = await Promise.all([
      read<TimeseriesResponse>(context, `/api/timeseries?${QUERY}`),
      read<SummaryResponse>(context, `/api/summary?${QUERY}`),
    ]);
    const series = buildSeries(chart, NO_SLOTS);

    expect(series.total).toBe(table.totals.total_tokens);
    expect(series.total).toBe(EXPECTED_BUCKETS.reduce((sum, value) => sum + value, 0));
  });

  it('adds each band up to that member s row in the table', async () => {
    const context = await seeded();
    const [chart, table] = await Promise.all([
      read<TimeseriesResponse>(context, `/api/timeseries?${QUERY}`),
      read<SummaryResponse>(context, `/api/summary?${QUERY}`),
    ]);
    const series = buildSeries(chart, NO_SLOTS);

    for (const row of table.members) {
      const banded = series.rows.reduce((sum, bucket) => sum + (bucket[row.member_id] ?? 0), 0);
      expect(banded).toBe(row.total_tokens);
    }
  });

  it('keeps a day nobody worked as a zero rather than dropping the bucket', async () => {
    const context = await seeded();
    const body = await read<TimeseriesResponse>(context, `/api/timeseries?${QUERY}`);
    const series = buildSeries(body, NO_SLOTS);

    const alice = context.ids.get('Alice') ?? '';
    // Alice reported nothing on the second day. The endpoint does not emit that
    // bucket; the chart still has to have a point there, at zero, or the line
    // slopes straight through the day she took off.
    expect(body.points.some((point) => point.member_id === alice && point.total_tokens === 0)).toBe(
      false,
    );
    expect(series.rows[1]?.[alice]).toBe(0);
    expect(series.rows.map((row) => row[alice])).toEqual([3000, 0, 5000, 1000]);
  });

  it('gives the table one sparkline value per bucket for every member', async () => {
    const context = await seeded();
    const body = await read<TimeseriesResponse>(context, `/api/timeseries?${QUERY}`);
    const trends = memberTrends(body);

    for (const person of PLAN) {
      const id = context.ids.get(person.name) ?? '';
      expect(trends.get(id)).toEqual([...person.daily]);
    }
  });
});
