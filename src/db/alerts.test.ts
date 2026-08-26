/**
 * The alert tables, against a real in-memory SQLite.
 *
 * The test that carries the most weight is the one for `claimAlertFire`. The
 * debounce is a unique index rather than a convention, and an index that stops
 * being unique — because a column was made nullable, or because the expression
 * changed — would break nothing loudly. It would just start sending two
 * webhooks.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import {
  alertRuleById,
  claimAlertFire,
  createAlertRule,
  deleteAlertRule,
  enabledAlertRules,
  enabledAlertRulesForMember,
  firedWindowKeys,
  hasFiredInWindow,
  listAlertFires,
  listAlertRules,
  memberWindowUsage,
  memberWindowUsages,
  periodUsageInWindow,
  recordAlertDelivery,
  updateAlertRule,
} from './alerts.js';
import type { AlertRuleInput } from './alerts.js';
import { migratedDatabase } from './index.js';
import type { WindowBounds } from '../shared/alerts.js';

const open: Database.Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) {
    if (db.open) db.close();
  }
});

/** A migrated in-memory database with two members already enrolled. */
function fresh(): Database.Database {
  const db = migratedDatabase(':memory:');
  open.push(db);
  const insert = db.prepare(
    'INSERT INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  );
  insert.run('m_rahim', 'Rahim', 'hash-rahim', 1_700_000_000_000);
  insert.run('m_ana', 'Ana', 'hash-ana', 1_700_000_000_000);
  return db;
}

/** A rule with everything defaulted but what a test cares about. */
function ruleInput(overrides: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return {
    memberId: null,
    window: 'week',
    metric: 'share_pct',
    threshold: 50,
    webhookUrl: 'https://hooks.example.invalid/x',
    enabled: true,
    ...overrides,
  };
}

/** The window every usage test measures over. */
const WINDOW: WindowBounds = {
  window: 'week',
  timezone: 'UTC',
  start: Date.parse('2026-08-24T00:00:00Z'),
  end: Date.parse('2026-08-31T00:00:00Z'),
};

/** Writes one `requests` row with the token split a test asks for. */
function request(
  db: Database.Database,
  id: string,
  memberId: string,
  ts: number,
  tokens: number,
  costMicros = 0,
): void {
  db.prepare(
    `INSERT INTO requests
       (id, ts, member_id, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, cost_micros)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
  ).run(id, ts, memberId, tokens, costMicros);
}

describe('rule CRUD', () => {
  it('stores a rule and reads it back with the member name joined on', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput({ memberId: 'm_rahim' }), 1_700_000_000_000);

    expect(rule.id).toMatch(/^ar_/);
    expect(rule.member_id).toBe('m_rahim');
    expect(rule.member_name).toBe('Rahim');
    expect(rule.enabled).toBe(true);
    expect(rule.created_at).toBe(1_700_000_000_000);
    expect(rule.updated_at).toBe(1_700_000_000_000);
    expect(alertRuleById(db, rule.id)).toEqual(rule);
  });

  it('leaves the member name null on a rule that names nobody', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());
    expect(rule.member_id).toBeNull();
    expect(rule.member_name).toBeNull();
  });

  it('patches only the fields the patch carries', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput(), 1_000);
    const patched = updateAlertRule(db, rule.id, { threshold: 75 }, 2_000);

    expect(patched?.threshold).toBe(75);
    expect(patched?.metric).toBe('share_pct');
    expect(patched?.webhook_url).toBe('https://hooks.example.invalid/x');
    expect(patched?.created_at).toBe(1_000);
    expect(patched?.updated_at).toBe(2_000);
  });

  it('can clear a webhook URL and a member, which is different from omitting them', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput({ memberId: 'm_ana' }));
    const cleared = updateAlertRule(db, rule.id, { webhookUrl: null, memberId: null });
    expect(cleared?.webhook_url).toBeNull();
    expect(cleared?.member_id).toBeNull();
  });

  it('returns undefined rather than throwing for a rule that is not there', () => {
    const db = fresh();
    expect(alertRuleById(db, 'ar_nope')).toBeUndefined();
    expect(updateAlertRule(db, 'ar_nope', { threshold: 1 })).toBeUndefined();
  });

  it('lists enabled rules and the ones that apply to one member', () => {
    const db = fresh();
    const everyone = createAlertRule(db, ruleInput(), 1);
    const rahim = createAlertRule(db, ruleInput({ memberId: 'm_rahim' }), 2);
    const ana = createAlertRule(db, ruleInput({ memberId: 'm_ana' }), 3);
    const off = createAlertRule(db, ruleInput({ enabled: false }), 4);

    expect(listAlertRules(db)).toHaveLength(4);
    expect(enabledAlertRules(db).map((rule) => rule.id)).toEqual([everyone.id, rahim.id, ana.id]);
    expect(enabledAlertRulesForMember(db, 'm_rahim').map((rule) => rule.id)).toEqual([
      everyone.id,
      rahim.id,
    ]);
    expect(enabledAlertRulesForMember(db, 'm_ana').map((rule) => rule.id)).toEqual([
      everyone.id,
      ana.id,
    ]);
    expect(enabledAlertRules(db).some((rule) => rule.id === off.id)).toBe(false);
  });

  it('takes a rule fires with it, and says how many', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());
    claimAlertFire(db, {
      ruleId: rule.id,
      memberId: 'm_rahim',
      firedAt: 1,
      value: 60,
      windowStart: WINDOW.start,
      deliveryStatus: 'pending',
    });

    expect(deleteAlertRule(db, rule.id)).toEqual({ deleted: true, firesDeleted: 1 });
    expect(listAlertFires(db, 10)).toEqual([]);
    // Deleting again is not an error; it is the same end state.
    expect(deleteAlertRule(db, rule.id)).toEqual({ deleted: false, firesDeleted: 0 });
  });
});

describe('window usage', () => {
  it('sums the four token columns for one member inside the window', () => {
    const db = fresh();
    request(db, 'r1', 'm_rahim', WINDOW.start + 1000, 600, 900);
    request(db, 'r2', 'm_ana', WINDOW.start + 2000, 400, 100);
    // Outside the window on both sides, so neither may be counted.
    request(db, 'r3', 'm_rahim', WINDOW.start - 1, 5000);
    request(db, 'r4', 'm_rahim', WINDOW.end, 5000);

    const usage = memberWindowUsage(db, WINDOW, 'm_rahim');
    expect(usage.totalTokens).toBe(600);
    expect(usage.costMicros).toBe(900);
    expect(usage.periodTokens).toBe(1000);
    expect(usage.contributors).toBe(2);
    expect(periodUsageInWindow(db, WINDOW)).toEqual({ totalTokens: 1000, contributors: 2 });
  });

  it('reports zero for a member with nothing in the window', () => {
    const db = fresh();
    const usage = memberWindowUsage(db, WINDOW, 'm_rahim');
    expect(usage).toEqual({ totalTokens: 0, costMicros: 0, periodTokens: 0, contributors: 0 });
  });

  it('groups every member with usage, heaviest first, and shares one denominator', () => {
    const db = fresh();
    request(db, 'r1', 'm_rahim', WINDOW.start + 1, 600);
    request(db, 'r2', 'm_ana', WINDOW.start + 2, 400);

    const { members, period } = memberWindowUsages(db, WINDOW);
    expect(period).toEqual({ totalTokens: 1000, contributors: 2 });
    expect(members.map((row) => row.memberId)).toEqual(['m_rahim', 'm_ana']);
    expect(members[0]?.displayName).toBe('Rahim');
    expect(members.every((row) => row.periodTokens === 1000)).toBe(true);
  });

  it('keeps unattributed rows out of the member list but inside the denominator', () => {
    const db = fresh();
    request(db, 'r1', 'm_rahim', WINDOW.start + 1, 500);
    request(db, 'r2', 'unattributed', WINDOW.start + 2, 500);

    const { members, period } = memberWindowUsages(db, WINDOW);
    expect(members.map((row) => row.memberId)).toEqual(['m_rahim']);
    // A share is a share of everything that happened, including the rows stage
    // 1 could not attribute — otherwise Rahim reads as 100% of a half. The
    // placeholder counts as a contributor for the same reason.
    expect(period).toEqual({ totalTokens: 1000, contributors: 2 });
  });
});

describe('claimAlertFire', () => {
  /** A claim with everything defaulted but what a test varies. */
  function claim(db: Database.Database, ruleId: string, windowStart = WINDOW.start) {
    return claimAlertFire(db, {
      ruleId,
      memberId: 'm_rahim',
      firedAt: 1_700_000_000_000,
      value: 60,
      windowStart,
      deliveryStatus: 'pending',
    });
  }

  it('claims once per rule, member and window', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());

    expect(claim(db, rule.id).claimed).toBe(true);
    expect(claim(db, rule.id).claimed).toBe(false);
    expect(claim(db, rule.id).claimed).toBe(false);
    expect(listAlertFires(db, 10)).toHaveLength(1);
  });

  it('claims again in the next window', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());

    expect(claim(db, rule.id, WINDOW.start).claimed).toBe(true);
    expect(claim(db, rule.id, WINDOW.end).claimed).toBe(true);
    expect(listAlertFires(db, 10)).toHaveLength(2);
  });

  it('keeps two members on the same rule apart', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());
    const shared = {
      ruleId: rule.id,
      firedAt: 1,
      value: 60,
      windowStart: WINDOW.start,
      deliveryStatus: 'pending',
    } as const;

    expect(claimAlertFire(db, { ...shared, memberId: 'm_rahim' }).claimed).toBe(true);
    expect(claimAlertFire(db, { ...shared, memberId: 'm_ana' }).claimed).toBe(true);
    expect(claimAlertFire(db, { ...shared, memberId: 'm_rahim' }).claimed).toBe(false);
  });

  it('answers the check the evaluator makes before it claims', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());
    expect(hasFiredInWindow(db, rule.id, 'm_rahim', WINDOW.start)).toBe(false);
    claim(db, rule.id);
    expect(hasFiredInWindow(db, rule.id, 'm_rahim', WINDOW.start)).toBe(true);
    expect(hasFiredInWindow(db, rule.id, 'm_ana', WINDOW.start)).toBe(false);
    expect(hasFiredInWindow(db, rule.id, 'm_rahim', WINDOW.end)).toBe(false);
  });

  it('reports the claimed windows as keys the badge computation can look up', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());
    claim(db, rule.id);
    const keys = firedWindowKeys(db, WINDOW.start);
    expect(keys.has(`${rule.id}|m_rahim|${String(WINDOW.start)}`)).toBe(true);
    // An older window is out of the range asked for.
    expect(firedWindowKeys(db, WINDOW.end).size).toBe(0);
  });
});

describe('delivery outcomes', () => {
  it('records success and failure against the fire that started them', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput());
    const claimed = claimAlertFire(db, {
      ruleId: rule.id,
      memberId: 'm_rahim',
      firedAt: 1_700_000_000_000,
      value: 60,
      windowStart: WINDOW.start,
      deliveryStatus: 'pending',
    });

    expect(listAlertFires(db, 10)[0]?.delivery_status).toBe('pending');

    recordAlertDelivery(db, claimed.id, {
      status: 'failed',
      attempts: 3,
      error: 'HTTP 500: nope',
      deliveredAt: null,
    });
    const failed = listAlertFires(db, 10)[0];
    expect(failed?.delivery_status).toBe('failed');
    expect(failed?.attempts).toBe(3);
    expect(failed?.delivery_error).toBe('HTTP 500: nope');
    expect(failed?.delivered_at).toBeNull();

    recordAlertDelivery(db, claimed.id, {
      status: 'delivered',
      attempts: 1,
      error: null,
      deliveredAt: 1_700_000_001_000,
    });
    const delivered = listAlertFires(db, 10)[0];
    expect(delivered?.delivery_status).toBe('delivered');
    expect(delivered?.delivery_error).toBeNull();
    expect(delivered?.delivered_at).toBe(1_700_000_001_000);
  });

  it('joins each fire to its rule and its member, newest first', () => {
    const db = fresh();
    const rule = createAlertRule(db, ruleInput({ metric: 'tokens', threshold: 100 }));
    claimAlertFire(db, {
      ruleId: rule.id,
      memberId: 'm_rahim',
      firedAt: 10,
      value: 150,
      windowStart: WINDOW.start,
      deliveryStatus: 'pending',
    });
    claimAlertFire(db, {
      ruleId: rule.id,
      memberId: 'm_ana',
      firedAt: 20,
      value: 200,
      windowStart: WINDOW.start,
      deliveryStatus: 'skipped',
    });

    const fires = listAlertFires(db, 10);
    expect(fires.map((fire) => fire.member_name)).toEqual(['Ana', 'Rahim']);
    expect(fires[0]?.metric).toBe('tokens');
    expect(fires[0]?.window).toBe('week');
    expect(fires[0]?.threshold).toBe(100);
    expect(fires[0]?.delivery_status).toBe('skipped');
    expect(listAlertFires(db, 1)).toHaveLength(1);
  });
});
