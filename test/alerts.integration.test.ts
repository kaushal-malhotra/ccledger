/**
 * Stage 6 acceptance, clause by clause.
 *
 * Everything here goes through the real HTTP surface with a real SQLite file
 * behind it: a teammate's token posts a real OTLP body, and the alert either
 * fires or it does not. The colocated unit tests cover the pieces; this file
 * exists to prove that the assembled path keeps the four promises the stage
 * made, and it is written against the brief rather than against what the
 * implementation happens to do.
 *
 * The stage's own acceptance sentence is the first `describe`: seed usage past
 * a 50% share threshold, confirm one webhook, confirm a second ingest in the
 * same window sends nothing.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { listAlertFires } from '../src/db/alerts.js';
import { setConfig } from '../src/db/config.js';
import { migratedDatabase } from '../src/db/index.js';
import { buildApp } from '../src/server/app.js';
import { generateAdminToken, generateMemberToken, hashToken } from '../src/server/auth.js';
import type { AlertsResponse, AlertRuleResponse } from '../src/shared/api.js';
import { windowBoundsAt } from '../src/shared/alerts.js';
import {
  CONFIG_ADMIN_TOKEN_HASH,
  CONFIG_TIMEZONE,
  UNATTRIBUTED_MEMBER_ID,
} from '../src/shared/constants.js';

/** The two teammates every test in this file has. */
const RAHIM = { id: 'm_rahim', name: 'Rahim', token: generateMemberToken() };
const ANA = { id: 'm_ana', name: 'Ana', token: generateMemberToken() };

/** The one admin token, for the rule routes. */
const ADMIN_TOKEN = generateAdminToken();

/**
 * The instant every seeded request is stamped with.
 *
 * The wall clock rather than a fixed date, because the ingest route does not
 * take a clock — evaluation asks `Date.now()`, as it must in production. A
 * fixed date would put every seeded row outside the window the server is
 * actually looking at, and the suite would pass or fail depending on what day
 * it was run.
 */
const NOW = Date.now();

/** Milliseconds in a week, for moving history out of the current window. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The week window `NOW` falls in, as the server will compute it. */
const WEEK = windowBoundsAt('week', NOW, 'UTC');

const openHandles: Database.Database[] = [];
const openApps: FastifyInstance[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
  for (const db of openHandles.splice(0)) {
    if (db.open) db.close();
  }
  for (const path of tempPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

/** A webhook endpoint that records what it was sent and answers as told. */
interface Endpoint {
  readonly url: string;
  readonly received: { text: string; body: Record<string, unknown> }[];
  /** Resolves once `count` deliveries have arrived, or rejects on a timeout. */
  waitFor: (count: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A real HTTP server standing in for Slack.
 *
 * A real one rather than a stub, because what the acceptance criterion asks
 * about is whether a webhook was *sent* — and a stubbed delivery function would
 * be testing that evaluation called something, not that a request left the
 * process with the payload in it.
 */
async function webhookEndpoint(status = 200): Promise<Endpoint> {
  const received: { text: string; body: Record<string, unknown> }[] = [];
  const app: FastifyInstance = Fastify();
  app.post('/hook', (request, reply) => {
    const body = request.body as Record<string, unknown>;
    received.push({ text: String(body.text ?? ''), body });
    reply.code(status).send(status >= 400 ? 'no' : 'ok');
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${String(port)}/hook`,
    received,
    waitFor: async (count: number): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`expected ${String(count)} deliveries, saw ${String(received.length)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () => app.close(),
  };
}

/** A loopback port nothing is listening on, so a connection to it is refused. */
async function closedLoopbackPort(): Promise<number> {
  const app: FastifyInstance = Fastify();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await app.close();
  return port;
}

/** A migrated database in a real file, with both teammates and the admin token. */
function freshApp(): { app: FastifyInstance; db: Database.Database } {
  const path = join(tmpdir(), `ccledger-alerts-${randomUUID()}.db`);
  tempPaths.push(path);
  const db = migratedDatabase(path);
  openHandles.push(db);

  const insert = db.prepare(
    'INSERT INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const member of [RAHIM, ANA]) {
    insert.run(member.id, member.name, hashToken(member.token), 1_700_000_000_000);
  }
  // The zone `ccledger serve` would have recorded. Pinned so a window boundary
  // means the same thing wherever this suite runs.
  setConfig(db, CONFIG_TIMEZONE, 'UTC');
  setConfig(db, CONFIG_ADMIN_TOKEN_HASH, hashToken(ADMIN_TOKEN));

  const app = buildApp({ db });
  openApps.push(app);
  return { app, db };
}

/** One `api_request` record, with the token count and instant a test chooses. */
function apiRequestRecord(options: {
  readonly id: string;
  readonly tokens: number;
  readonly ts: number;
  readonly costMicros?: number;
  readonly userId: string;
}): unknown {
  const iso = new Date(options.ts).toISOString();
  return {
    timeUnixNano: String(options.ts * 1_000_000),
    body: { stringValue: 'claude_code.api_request' },
    attributes: [
      { key: 'user.id', value: { stringValue: options.userId } },
      { key: 'session.id', value: { stringValue: `s-${options.userId}` } },
      { key: 'event.name', value: { stringValue: 'api_request' } },
      { key: 'event.timestamp', value: { stringValue: iso } },
      { key: 'model', value: { stringValue: 'claude-opus-5' } },
      { key: 'input_tokens', value: { intValue: options.tokens } },
      { key: 'output_tokens', value: { intValue: 0 } },
      { key: 'cache_read_tokens', value: { intValue: 0 } },
      { key: 'cache_creation_tokens', value: { intValue: 0 } },
      { key: 'cost_usd_micros', value: { intValue: options.costMicros ?? 0 } },
      { key: 'duration_ms', value: { intValue: 10 } },
      { key: 'client_request_id', value: { stringValue: options.id } },
    ],
  };
}

/** An OTLP/HTTP JSON envelope around one or more records. */
function envelope(records: readonly unknown[]): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude-code' } },
            { key: 'service.version', value: { stringValue: '2.1.241' } },
            { key: 'os.type', value: { stringValue: 'linux' } },
          ],
        },
        scopeLogs: [{ scope: { name: 'com.anthropic.claude_code' }, logRecords: records }],
      },
    ],
  });
}

/** Posts one member's usage as a real OTLP batch and returns the reply. */
function ingest(
  app: FastifyInstance,
  member: { readonly id: string; readonly token: string },
  options: { readonly id: string; readonly tokens: number; readonly ts?: number },
) {
  return app.inject({
    method: 'POST',
    url: '/v1/logs',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${member.token}` },
    payload: envelope([
      apiRequestRecord({
        id: options.id,
        tokens: options.tokens,
        ts: options.ts ?? NOW,
        userId: `install-${member.id}`,
      }),
    ]),
  });
}

/** Creates a rule through the admin API, as the dashboard's form would. */
async function createRule(
  app: FastifyInstance,
  body: Record<string, unknown>,
): Promise<AlertRuleResponse['rule']> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/alerts/rules',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return (JSON.parse(response.body) as AlertRuleResponse).rule;
}

/** Reads `GET /api/alerts`. */
async function readAlerts(app: FastifyInstance): Promise<AlertsResponse> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/alerts',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as AlertsResponse;
}

/**
 * Waits for whatever the ingest handler started after answering.
 *
 * Evaluation is deliberately not part of the response, so a test that asserts
 * on a webhook has to wait for something other than the reply. Polling the
 * fires table is what a person would do, and it is what makes the "sends
 * nothing" assertions meaningful rather than merely early.
 */
async function settle(db: Database.Database, expectedFires: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (listAlertFires(db, 100).length < expectedFires) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // A short grace period so a delivery that should NOT happen has had its
  // chance to happen before the test concludes that it did not.
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe('the stage 6 acceptance sentence', () => {
  it('seeds past a 50% share, sends one webhook, and sends nothing on the second ingest', async () => {
    const endpoint = await webhookEndpoint();
    try {
      const { app, db } = freshApp();
      await createRule(app, {
        metric: 'share_pct',
        window: 'week',
        threshold: 50,
        webhook_url: endpoint.url,
      });

      // Ana first, so that Rahim's batch is the one that crosses. Her own batch
      // makes her 100% of a pool nobody else has contributed to yet, which
      // `SHARE_MIN_CONTRIBUTORS` exists to stop being an alert.
      expect((await ingest(app, ANA, { id: 'a1', tokens: 400 })).statusCode).toBe(200);
      await settle(db, 0);
      expect(endpoint.received).toHaveLength(0);

      expect((await ingest(app, RAHIM, { id: 'r1', tokens: 600 })).statusCode).toBe(200);
      await endpoint.waitFor(1);

      expect(endpoint.received).toHaveLength(1);
      expect(endpoint.received[0]?.text).toContain('Rahim');
      expect(endpoint.received[0]?.text).toContain('60.0%');
      expect(endpoint.received[0]?.body.metric).toBe('share_pct');
      expect(endpoint.received[0]?.body.threshold).toBe(50);
      expect(endpoint.received[0]?.body.window_start).toBe(new Date(WEEK.start).toISOString());

      // A second ingest, still the same week, still over the threshold.
      expect((await ingest(app, RAHIM, { id: 'r2', tokens: 900 })).statusCode).toBe(200);
      await settle(db, 1);

      expect(endpoint.received).toHaveLength(1);
      expect(listAlertFires(db, 100)).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  });
});

describe('debounce across windows', () => {
  it('allows a fire again once the week rolls over', async () => {
    const endpoint = await webhookEndpoint();
    try {
      const { app, db } = freshApp();
      await createRule(app, {
        metric: 'tokens',
        window: 'week',
        threshold: 500,
        webhook_url: endpoint.url,
      });

      await ingest(app, RAHIM, { id: 'r1', tokens: 600 });
      await endpoint.waitFor(1);

      // Nothing new in this window, however much more arrives.
      await ingest(app, RAHIM, { id: 'r2', tokens: 600 });
      await settle(db, 1);
      expect(endpoint.received).toHaveLength(1);

      // A week passing and the history moving back a week are the same thing
      // from the server's point of view, and only one of them can be arranged
      // without taking the clock away from the route that has to read it.
      shiftHistoryBackOneWeek(db);
      await ingest(app, RAHIM, { id: 'r3', tokens: 600 });
      await endpoint.waitFor(2);

      const fires = listAlertFires(db, 100);
      expect(fires).toHaveLength(2);
      expect(new Set(fires.map((fire) => fire.window_start)).size).toBe(2);
    } finally {
      await endpoint.close();
    }
  });
});

/**
 * Moves every stored request and every recorded fire back by one week, so that
 * the window the server is currently looking at is empty and unfired.
 */
function shiftHistoryBackOneWeek(db: Database.Database): void {
  db.prepare('UPDATE requests SET ts = ts - @weekMs').run({ weekMs: WEEK_MS });
  db.prepare('UPDATE alert_fires SET window_start = window_start - @weekMs').run({
    weekMs: WEEK_MS,
  });
}

describe('a webhook failure does not break ingest', () => {
  it('answers 200 and records the failure when the endpoint refuses', async () => {
    const endpoint = await webhookEndpoint(500);
    try {
      const { app, db } = freshApp();
      await createRule(app, {
        metric: 'tokens',
        window: 'day',
        threshold: 100,
        webhook_url: endpoint.url,
      });

      const response = await ingest(app, RAHIM, { id: 'r1', tokens: 600 });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"partialSuccess":{}}');

      // Three attempts, with the real backoff between them.
      await endpoint.waitFor(3);
      const deadline = Date.now() + 5000;
      while (listAlertFires(db, 10)[0]?.delivery_status === 'pending' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const fire = listAlertFires(db, 10)[0];
      expect(fire?.delivery_status).toBe('failed');
      expect(fire?.attempts).toBe(3);
      expect(fire?.delivery_error).toContain('HTTP 500');
      // The usage is still stored. An alert that could not be delivered must
      // not cost the numbers it was about.
      expect(db.prepare('SELECT count(*) AS n FROM requests').get()).toEqual({ n: 1 });
    } finally {
      await endpoint.close();
    }
  });

  it('answers 200 when the endpoint does not exist at all', async () => {
    const { app, db } = freshApp();
    // A port that was listening a moment ago and is not now, so every attempt
    // is refused immediately rather than waiting out a firewall's timeout.
    const closed = await closedLoopbackPort();
    await createRule(app, {
      metric: 'tokens',
      window: 'day',
      threshold: 100,
      webhook_url: `http://127.0.0.1:${String(closed)}/hook`,
    });

    const response = await ingest(app, RAHIM, { id: 'r1', tokens: 600 });
    expect(response.statusCode).toBe(200);

    const deadline = Date.now() + 8000;
    while (listAlertFires(db, 10)[0]?.delivery_status === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(listAlertFires(db, 10)[0]?.delivery_status).toBe('failed');
  }, 20_000);

  it('answers 200 with a rule whose webhook is gone and whose fire is claimed', async () => {
    const { app, db } = freshApp();
    // No webhook at all: the fire exists to raise the badge and nothing else.
    await createRule(app, { metric: 'tokens', window: 'day', threshold: 100 });

    expect((await ingest(app, RAHIM, { id: 'r1', tokens: 600 })).statusCode).toBe(200);
    await settle(db, 1);
    expect(listAlertFires(db, 10)[0]?.delivery_status).toBe('skipped');
  });
});

describe('GET /api/alerts', () => {
  it('needs the admin token, like everything else under /api', async () => {
    const { app } = freshApp();
    expect((await app.inject({ method: 'GET', url: '/api/alerts' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/alerts/rules',
          payload: { metric: 'tokens', window: 'day', threshold: 1 },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('reports the zone, the rules, the fires and who is currently over', async () => {
    const { app, db } = freshApp();
    const rule = await createRule(app, { metric: 'share_pct', window: 'week', threshold: 50 });

    await ingest(app, ANA, { id: 'a1', tokens: 400 });
    await ingest(app, RAHIM, { id: 'r1', tokens: 600 });
    await settle(db, 1);

    const alerts = await readAlerts(app);
    expect(alerts.timezone).toBe('UTC');
    expect(alerts.rules.map((entry) => entry.id)).toEqual([rule.id]);
    expect(alerts.fires).toHaveLength(1);
    expect(alerts.fires[0]?.member_name).toBe('Rahim');
    expect(alerts.active).toHaveLength(1);
    expect(alerts.active[0]?.member_id).toBe(RAHIM.id);
    expect(alerts.active[0]?.fired).toBe(true);
    expect(alerts.active[0]?.value).toBeCloseTo(60, 6);
  });

  it('leaves the unattributed member out of the badge but inside the share', async () => {
    const { app, db } = freshApp();
    await createRule(app, { metric: 'share_pct', window: 'week', threshold: 50 });
    db.prepare(
      `INSERT INTO requests (id, ts, member_id, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_micros)
       VALUES ('legacy', @ts, @member, 900, 0, 0, 0, 0)`,
    ).run({ ts: NOW, member: UNATTRIBUTED_MEMBER_ID });

    await ingest(app, RAHIM, { id: 'r1', tokens: 100 });
    await settle(db, 0);

    const alerts = await readAlerts(app);
    // Rahim is 10% of a thousand, not 100% of his own hundred.
    expect(alerts.active).toEqual([]);
    expect(alerts.fires).toEqual([]);
  });
});

describe('rule CRUD over HTTP', () => {
  it('creates, patches, disables and deletes', async () => {
    const { app } = freshApp();
    const rule = await createRule(app, {
      metric: 'share_pct',
      window: 'week',
      threshold: 50,
      member_id: RAHIM.id,
    });
    expect(rule.member_name).toBe('Rahim');
    expect(rule.enabled).toBe(true);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/alerts/rules/${rule.id}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { threshold: 75, enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect((JSON.parse(patched.body) as AlertRuleResponse).rule).toMatchObject({
      threshold: 75,
      enabled: false,
      metric: 'share_pct',
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/alerts/rules/${rule.id}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(deleted.statusCode).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({
      rule_id: rule.id,
      deleted: true,
      fires_deleted: 0,
    });

    // Deleting twice is the same end state, not an error.
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/alerts/rules/${rule.id}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ deleted: false });
  });

  it('deletes a rule together with the fires that reference it', async () => {
    const { app, db } = freshApp();
    const rule = await createRule(app, { metric: 'tokens', window: 'day', threshold: 100 });
    await ingest(app, RAHIM, { id: 'r1', tokens: 600 });
    await settle(db, 1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/alerts/rules/${rule.id}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(JSON.parse(deleted.body)).toMatchObject({ deleted: true, fires_deleted: 1 });
    expect(listAlertFires(db, 10)).toEqual([]);
  });

  /** Bodies that describe a rule that could never fire. All of them are 400s. */
  const REJECTED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an unknown metric', { metric: 'vibes', window: 'day', threshold: 1 }],
    ['an unknown window', { metric: 'tokens', window: 'month', threshold: 1 }],
    ['a missing threshold', { metric: 'tokens', window: 'day' }],
    ['a zero threshold', { metric: 'tokens', window: 'day', threshold: 0 }],
    ['a negative threshold', { metric: 'tokens', window: 'day', threshold: -5 }],
    ['a share above 100', { metric: 'share_pct', window: 'day', threshold: 150 }],
    [
      'a webhook that is not a URL',
      { metric: 'tokens', window: 'day', threshold: 1, webhook_url: 'hooks.slack.com' },
    ],
    [
      'a webhook naming a scheme this server will not fetch',
      { metric: 'tokens', window: 'day', threshold: 1, webhook_url: 'file:///etc/passwd' },
    ],
    [
      'a member who does not exist',
      { metric: 'tokens', window: 'day', threshold: 1, member_id: 'm_nobody' },
    ],
  ];

  for (const [name, payload] of REJECTED) {
    it(`refuses ${name} with a 400`, async () => {
      const { app } = freshApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/alerts/rules',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toHaveProperty('error');
    });
  }

  it('drops a field nobody defined rather than storing it', async () => {
    const { app } = freshApp();
    // Fastify's validator is configured to strip what a schema does not
    // declare, which is the behaviour every other route here already has. The
    // point worth pinning is that the unknown field does not survive.
    const rule = await createRule(app, {
      metric: 'tokens',
      window: 'day',
      threshold: 1,
      colour: 'red',
    });
    expect(rule).not.toHaveProperty('colour');
  });

  it('re-checks the threshold against the metric a patch is changing it to', async () => {
    const { app } = freshApp();
    const rule = await createRule(app, { metric: 'tokens', window: 'day', threshold: 4_000_000 });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/alerts/rules/${rule.id}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { metric: 'share_pct' },
    });
    // Four million percent is not a share, and the patch did not mention the
    // threshold — so the check has to look at what the rule will become.
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for a patch to a rule that is not there', async () => {
    const { app } = freshApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/alerts/rules/ar_nope',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { threshold: 1 },
    });
    expect(response.statusCode).toBe(404);
  });
});
