/**
 * Evaluation, which is where the four promises of the alerting brief are kept:
 * a crossing fires exactly once, a second crossing in the same window does not
 * fire, a new window allows a fire again, and a webhook that fails is recorded
 * rather than raised.
 *
 * Every test drives a real database and a real window calculation with the zone
 * pinned to UTC, so a boundary here means the same thing on the machine that
 * wrote these tests and on the one running them.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import {
  activeAlertStates,
  crossesThreshold,
  evaluateAlerts,
  metricValue,
  runAlertEvaluation,
} from './alerts.js';
import type { WebhookDeliver, WebhookResult } from './webhook.js';
import { createAlertRule, listAlertFires } from '../db/alerts.js';
import type { AlertRuleInput } from '../db/alerts.js';
import { setConfig } from '../db/config.js';
import { migratedDatabase } from '../db/index.js';
import type { AlertWebhookPayload } from '../shared/alerts.js';
import { windowBoundsAt } from '../shared/alerts.js';
import { CONFIG_TIMEZONE } from '../shared/constants.js';

const open: Database.Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) {
    if (db.open) db.close();
  }
});

/** Wednesday 26 August 2026, mid-morning UTC. */
const NOW = Date.parse('2026-08-26T09:00:00Z');

/** The week and day windows `NOW` falls in, as evaluation will compute them. */
const WEEK = windowBoundsAt('week', NOW, 'UTC');
const DAY = windowBoundsAt('day', NOW, 'UTC');

/** A migrated database with two members and the zone pinned. */
function fresh(): Database.Database {
  const db = migratedDatabase(':memory:');
  open.push(db);
  const insert = db.prepare(
    'INSERT INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  );
  insert.run('m_rahim', 'Rahim', 'hash-rahim', 1_700_000_000_000);
  insert.run('m_ana', 'Ana', 'hash-ana', 1_700_000_000_000);
  // The zone `serve` would have written. Pinned so a window boundary is the
  // same fact wherever these tests run.
  setConfig(db, CONFIG_TIMEZONE, 'UTC');
  return db;
}

/** A rule with everything defaulted but what a test cares about. */
function rule(db: Database.Database, overrides: Partial<AlertRuleInput> = {}) {
  return createAlertRule(db, {
    memberId: null,
    window: 'week',
    metric: 'share_pct',
    threshold: 50,
    webhookUrl: 'https://hooks.example.invalid/x',
    enabled: true,
    ...overrides,
  });
}

/** Writes usage for a member at an instant inside a window. */
function usage(
  db: Database.Database,
  id: string,
  memberId: string,
  tokens: number,
  costMicros = 0,
  ts = NOW,
): void {
  db.prepare(
    `INSERT INTO requests
       (id, ts, member_id, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, cost_micros)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
  ).run(id, ts, memberId, tokens, costMicros);
}

/** A delivery stub that records every payload and answers however it is told. */
function recorder(result: WebhookResult = { ok: true, status: 200, attempts: 1 }): {
  readonly deliver: WebhookDeliver;
  readonly sent: { url: string; payload: AlertWebhookPayload }[];
} {
  const sent: { url: string; payload: AlertWebhookPayload }[] = [];
  const deliver: WebhookDeliver = (url, payload) => {
    sent.push({ url, payload });
    return Promise.resolve(result);
  };
  return { deliver, sent };
}

describe('metricValue', () => {
  it('reads each metric in its own unit', () => {
    const window = { totalTokens: 600, costMicros: 1_250_000, periodTokens: 1000, contributors: 2 };
    expect(metricValue('tokens', window)).toBe(600);
    expect(metricValue('cost_usd', window)).toBe(1.25);
    expect(metricValue('share_pct', window)).toBe(60);
  });

  it('calls an empty period zero share rather than dividing by nothing', () => {
    expect(
      metricValue('share_pct', {
        totalTokens: 0,
        costMicros: 0,
        periodTokens: 0,
        contributors: 0,
      }),
    ).toBe(0);
  });
});

describe('crossesThreshold', () => {
  it('counts a value exactly at the threshold as over it', () => {
    const usage = { totalTokens: 500, costMicros: 0, periodTokens: 1000, contributors: 2 };
    expect(crossesThreshold('share_pct', 50, usage)).toBe(true);
    expect(crossesThreshold('share_pct', 50.1, usage)).toBe(false);
  });

  it('will not call one person 100% of a pool they are the only member of', () => {
    const alone = { totalTokens: 500, costMicros: 0, periodTokens: 500, contributors: 1 };
    expect(metricValue('share_pct', alone)).toBe(100);
    expect(crossesThreshold('share_pct', 50, alone)).toBe(false);
    // The absolute metrics still mean something for a team of one.
    expect(crossesThreshold('tokens', 100, alone)).toBe(true);
  });
});

describe('threshold crossing', () => {
  it('fires exactly once and posts one webhook', async () => {
    const db = fresh();
    const created = rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const hook = recorder();
    const evaluation = evaluateAlerts(db, {
      memberId: 'm_rahim',
      now: NOW,
      deliver: hook.deliver,
    });
    await evaluation.settled;

    expect(evaluation.fires).toHaveLength(1);
    expect(evaluation.fires[0]?.ruleId).toBe(created.id);
    expect(evaluation.fires[0]?.value).toBeCloseTo(60, 6);
    expect(evaluation.fires[0]?.windowStart).toBe(WEEK.start);

    expect(hook.sent).toHaveLength(1);
    expect(hook.sent[0]?.url).toBe('https://hooks.example.invalid/x');
    expect(hook.sent[0]?.payload.text).toContain('Rahim');
    expect(hook.sent[0]?.payload.value).toBeCloseTo(60, 6);
    expect(hook.sent[0]?.payload.usage.period_total_tokens).toBe(1000);

    const fires = listAlertFires(db, 10);
    expect(fires).toHaveLength(1);
    expect(fires[0]?.delivery_status).toBe('delivered');
    expect(fires[0]?.attempts).toBe(1);
  });

  it('does not fire while the value is under the threshold', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 400);
    usage(db, 'r2', 'm_ana', 600);

    const hook = recorder();
    const evaluation = evaluateAlerts(db, {
      memberId: 'm_rahim',
      now: NOW,
      deliver: hook.deliver,
    });
    await evaluation.settled;

    expect(evaluation.evaluated).toBe(1);
    expect(evaluation.fires).toEqual([]);
    expect(hook.sent).toEqual([]);
    expect(listAlertFires(db, 10)).toEqual([]);
  });

  it('treats exactly the threshold as over it', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 500);
    usage(db, 'r2', 'm_ana', 500);

    const hook = recorder();
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;
    expect(hook.sent).toHaveLength(1);
  });
});

describe('debounce', () => {
  it('does not fire a second time in the same window', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const hook = recorder();
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;

    // More usage, still the same week, still over the threshold.
    usage(db, 'r3', 'm_rahim', 900, 0, NOW + 60_000);
    const second = evaluateAlerts(db, {
      memberId: 'm_rahim',
      now: NOW + 60_000,
      deliver: hook.deliver,
    });
    await second.settled;

    expect(second.fires).toEqual([]);
    expect(hook.sent).toHaveLength(1);
    expect(listAlertFires(db, 10)).toHaveLength(1);
  });

  it('fires again once the window rolls over', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const hook = recorder();
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;

    // The following week: fresh usage, and a window this rule has not fired in.
    const nextWeek = WEEK.end + 9 * 60 * 60 * 1000;
    usage(db, 'r3', 'm_rahim', 600, 0, nextWeek);
    usage(db, 'r4', 'm_ana', 400, 0, nextWeek);
    const second = evaluateAlerts(db, {
      memberId: 'm_rahim',
      now: nextWeek,
      deliver: hook.deliver,
    });
    await second.settled;

    expect(second.fires).toHaveLength(1);
    expect(second.fires[0]?.windowStart).toBe(WEEK.end);
    expect(hook.sent).toHaveLength(2);
    expect(listAlertFires(db, 10)).toHaveLength(2);
  });

  it('keeps one member from consuming another member’s fire', async () => {
    const db = fresh();
    rule(db, { threshold: 30 });
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const hook = recorder();
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;
    await evaluateAlerts(db, { memberId: 'm_ana', now: NOW, deliver: hook.deliver }).settled;

    expect(hook.sent.map((call) => call.payload.member_name)).toEqual(['Rahim', 'Ana']);
  });

  it('sends one webhook when two evaluations of the same window overlap', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    // Both started before either has settled — which is exactly what two OTLP
    // batches arriving together look like, and the case a record-on-completion
    // debounce would send twice.
    const hook = recorder();
    const first = evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver });
    const second = evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver });
    await Promise.all([first.settled, second.settled]);

    expect(hook.sent).toHaveLength(1);
    expect(listAlertFires(db, 10)).toHaveLength(1);
  });
});

describe('rule scope', () => {
  it('evaluates a rule naming nobody for the member who ingested', async () => {
    const db = fresh();
    rule(db, { metric: 'tokens', threshold: 100 });
    usage(db, 'r1', 'm_ana', 500);

    const hook = recorder();
    await evaluateAlerts(db, { memberId: 'm_ana', now: NOW, deliver: hook.deliver }).settled;
    expect(hook.sent[0]?.payload.member_id).toBe('m_ana');
  });

  it('ignores a rule that names somebody else', async () => {
    const db = fresh();
    rule(db, { memberId: 'm_ana', metric: 'tokens', threshold: 100 });
    usage(db, 'r1', 'm_rahim', 500);

    const hook = recorder();
    const evaluation = evaluateAlerts(db, {
      memberId: 'm_rahim',
      now: NOW,
      deliver: hook.deliver,
    });
    await evaluation.settled;
    expect(evaluation.evaluated).toBe(0);
    expect(hook.sent).toEqual([]);
  });

  it('ignores a disabled rule', async () => {
    const db = fresh();
    rule(db, { enabled: false, metric: 'tokens', threshold: 1 });
    usage(db, 'r1', 'm_rahim', 500);

    const hook = recorder();
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;
    expect(hook.sent).toEqual([]);
  });

  it('measures a day rule over the day and a week rule over the week', async () => {
    const db = fresh();
    rule(db, { window: 'day', metric: 'tokens', threshold: 100, webhookUrl: null });
    rule(db, { window: 'week', metric: 'tokens', threshold: 100, webhookUrl: null });
    // Monday's usage is in the week but not in Wednesday's day.
    usage(db, 'r1', 'm_rahim', 150, 0, WEEK.start + 60_000);

    const evaluation = evaluateAlerts(db, { memberId: 'm_rahim', now: NOW });
    await evaluation.settled;

    expect(evaluation.fires).toHaveLength(1);
    expect(evaluation.fires[0]?.window).toBe('week');
    expect(evaluation.fires[0]?.windowStart).toBe(WEEK.start);
  });

  it('fires a cost rule in dollars, not micros', async () => {
    const db = fresh();
    rule(db, { metric: 'cost_usd', threshold: 40 });
    usage(db, 'r1', 'm_rahim', 10, 47_300_000);

    const hook = recorder();
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;
    expect(hook.sent[0]?.payload.value).toBeCloseTo(47.3, 6);
    expect(hook.sent[0]?.payload.text).toContain('$47.30');
  });

  it('aligns the window to the configured zone rather than to UTC', async () => {
    const db = fresh();
    setConfig(db, CONFIG_TIMEZONE, 'Asia/Tokyo');
    rule(db, { window: 'day', metric: 'tokens', threshold: 1, webhookUrl: null });
    // 22:30 UTC is already the 27th in Tokyo, so Tokyo's day began at 15:00 UTC.
    const evening = Date.parse('2026-08-26T22:30:00Z');
    usage(db, 'r1', 'm_rahim', 10, 0, evening);

    const evaluation = evaluateAlerts(db, { memberId: 'm_rahim', now: evening });
    await evaluation.settled;
    expect(evaluation.fires[0]?.windowStart).toBe(Date.parse('2026-08-26T15:00:00Z'));
  });
});

describe('delivery', () => {
  it('records a failure against the fire and keeps the fire', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const hook = recorder({ ok: false, status: 500, attempts: 3, error: 'HTTP 500: nope' });
    const evaluation = evaluateAlerts(db, {
      memberId: 'm_rahim',
      now: NOW,
      deliver: hook.deliver,
    });
    await evaluation.settled;

    expect(evaluation.fires).toHaveLength(1);
    const fires = listAlertFires(db, 10);
    expect(fires[0]?.delivery_status).toBe('failed');
    expect(fires[0]?.attempts).toBe(3);
    expect(fires[0]?.delivery_error).toBe('HTTP 500: nope');
    expect(fires[0]?.delivered_at).toBeNull();
  });

  it('does not retry a failed fire in the same window', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const hook = recorder({ ok: false, status: 500, attempts: 3, error: 'HTTP 500' });
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: hook.deliver }).settled;

    // A failed delivery is still a fire. Re-sending it on the next batch would
    // turn one broken endpoint into a message per API request.
    expect(hook.sent).toHaveLength(1);
  });

  it('records a rule with no webhook as skipped and sends nothing', async () => {
    const db = fresh();
    rule(db, { webhookUrl: null });
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const hook = recorder();
    const evaluation = evaluateAlerts(db, {
      memberId: 'm_rahim',
      now: NOW,
      deliver: hook.deliver,
    });
    await evaluation.settled;

    expect(hook.sent).toEqual([]);
    expect(evaluation.fires[0]?.dispatched).toBe(false);
    expect(listAlertFires(db, 10)[0]?.delivery_status).toBe('skipped');
  });

  it('absorbs a delivery that throws rather than resolving', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const throwing: WebhookDeliver = () => Promise.reject(new Error('exploded'));
    await expect(
      evaluateAlerts(db, { memberId: 'm_rahim', now: NOW, deliver: throwing }).settled,
    ).resolves.toBeUndefined();

    const fires = listAlertFires(db, 10);
    expect(fires[0]?.delivery_status).toBe('failed');
    expect(fires[0]?.delivery_error).toBe('exploded');
  });
});

describe('runAlertEvaluation', () => {
  it('resolves rather than rejecting when the database is gone', async () => {
    const db = fresh();
    rule(db);
    usage(db, 'r1', 'm_rahim', 600);
    db.close();

    const logged: unknown[] = [];
    await expect(
      runAlertEvaluation(db, {
        memberId: 'm_rahim',
        now: NOW,
        logger: {
          debug: () => undefined,
          warn: () => undefined,
          error: (...args: unknown[]) => logged.push(args),
        },
      }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });

  it('is a no-op with no rules, and touches nothing', async () => {
    const db = fresh();
    usage(db, 'r1', 'm_rahim', 600);
    await expect(
      runAlertEvaluation(db, { memberId: 'm_rahim', now: NOW }),
    ).resolves.toBeUndefined();
    expect(listAlertFires(db, 10)).toEqual([]);
  });
});

describe('activeAlertStates', () => {
  it('reports whoever is over a threshold in the current window', () => {
    const db = fresh();
    const created = rule(db, { threshold: 50 });
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    const states = activeAlertStates(db, { now: NOW });
    expect(states).toHaveLength(1);
    expect(states[0]?.member_id).toBe('m_rahim');
    expect(states[0]?.member_name).toBe('Rahim');
    expect(states[0]?.rule_id).toBe(created.id);
    expect(states[0]?.value).toBeCloseTo(60, 6);
    expect(states[0]?.window_start).toBe(WEEK.start);
    expect(states[0]?.window_end).toBe(WEEK.end);
    // Nothing has been evaluated, so the condition holds but nothing has fired.
    expect(states[0]?.fired).toBe(false);
  });

  it('says which of the states have already fired', async () => {
    const db = fresh();
    rule(db, { webhookUrl: null });
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW }).settled;

    expect(activeAlertStates(db, { now: NOW })[0]?.fired).toBe(true);
  });

  it('keeps flagging someone who is still over after their one fire', async () => {
    const db = fresh();
    rule(db, { webhookUrl: null });
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);
    await evaluateAlerts(db, { memberId: 'm_rahim', now: NOW }).settled;

    // A badge is a condition, not an event: the debounce stops the second
    // webhook, and must not stop the flag.
    const later = NOW + 2 * 60 * 60 * 1000;
    const states = activeAlertStates(db, { now: later });
    expect(states).toHaveLength(1);
    expect(states[0]?.member_id).toBe('m_rahim');
  });

  it('narrows a member-scoped rule to that member', () => {
    const db = fresh();
    rule(db, { memberId: 'm_ana', metric: 'tokens', threshold: 100 });
    usage(db, 'r1', 'm_rahim', 600);
    usage(db, 'r2', 'm_ana', 400);

    expect(activeAlertStates(db, { now: NOW }).map((state) => state.member_id)).toEqual(['m_ana']);
  });

  it('is empty when no rule exists and when nobody is over one', () => {
    const db = fresh();
    usage(db, 'r1', 'm_rahim', 600);
    expect(activeAlertStates(db, { now: NOW })).toEqual([]);

    rule(db, { metric: 'tokens', threshold: 10_000 });
    expect(activeAlertStates(db, { now: NOW })).toEqual([]);
  });

  it('sorts the furthest over its threshold first', () => {
    const db = fresh();
    rule(db, { metric: 'tokens', threshold: 100 });
    usage(db, 'r1', 'm_rahim', 200);
    usage(db, 'r2', 'm_ana', 900);

    expect(activeAlertStates(db, { now: NOW }).map((state) => state.member_name)).toEqual([
      'Ana',
      'Rahim',
    ]);
  });

  it('measures a daily rule over today, not over the week', () => {
    const db = fresh();
    rule(db, { window: 'day', metric: 'tokens', threshold: 100 });
    // Monday's usage: inside the week, outside Wednesday.
    usage(db, 'r1', 'm_rahim', 500, 0, WEEK.start + 60_000);

    expect(activeAlertStates(db, { now: NOW })).toEqual([]);

    usage(db, 'r2', 'm_rahim', 500, 0, DAY.start + 60_000);
    expect(activeAlertStates(db, { now: NOW })).toHaveLength(1);
  });
});
