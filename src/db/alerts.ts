/**
 * Every read and write alerting makes: the rules, the fires that debounce them,
 * and the two aggregates a threshold is compared against.
 *
 * The same rule as `queries.ts` holds here — nothing returns rows for
 * JavaScript to add up. What is different is that these run on the ingest path
 * rather than on a dashboard request, so the shapes are chosen for how little
 * they touch: evaluating a member costs one scalar aggregate per distinct
 * window plus one for the period total, both served by
 * `idx_requests_member_ts` and `idx_requests_ts`.
 *
 * `window` is a SQLite keyword — it introduces a window function — so it is
 * quoted in every statement that names the column, exactly as `schema.sql`
 * quotes it in the table definition.
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { AlertFire, AlertRule } from '../shared/api.js';
import type {
  AlertDeliveryStatus,
  AlertMetric,
  AlertWindow,
  WindowBounds,
} from '../shared/alerts.js';
import { UNATTRIBUTED_MEMBER_ID } from '../shared/constants.js';

/** Named parameters as better-sqlite3 takes them. */
type Params = Record<string, string | number | null>;

/** The four token columns, summed. Written against a `requests` aliased `r`. */
const TOKEN_SUM = `COALESCE(SUM(
    r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens
  ), 0)`;

/**
 * A rule as it is stored. `enabled` is an INTEGER in SQLite and a boolean
 * everywhere else, which is the one conversion this file owns.
 */
interface AlertRuleRow {
  readonly id: string;
  readonly member_id: string | null;
  readonly member_name: string | null;
  readonly window: AlertWindow;
  readonly metric: AlertMetric;
  readonly threshold: number;
  readonly webhook_url: string | null;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
}

/** A fire joined to the rule that raised it. */
interface AlertFireRow {
  readonly id: string;
  readonly rule_id: string;
  readonly member_id: string;
  readonly member_name: string | null;
  readonly fired_at: number;
  readonly value: number;
  readonly window_start: number;
  readonly metric: AlertMetric;
  readonly window: AlertWindow;
  readonly threshold: number;
  readonly delivery_status: AlertDeliveryStatus;
  readonly delivery_error: string | null;
  readonly delivered_at: number | null;
  readonly attempts: number;
}

/**
 * Columns every rule read selects. The display name is joined rather than
 * stored, so renaming a member renames them on the rule too.
 */
const RULE_COLUMNS = `
    ar.id AS id,
    ar.member_id AS member_id,
    m.display_name AS member_name,
    ar."window" AS "window",
    ar.metric AS metric,
    ar.threshold AS threshold,
    ar.webhook_url AS webhook_url,
    ar.enabled AS enabled,
    ar.created_at AS created_at,
    ar.updated_at AS updated_at`;

/** Rules read with their member's name attached; the join is optional by design. */
const RULE_FROM = 'FROM alert_rules ar LEFT JOIN members m ON m.id = ar.member_id';

/** Turns a stored row into the wire shape. */
function toRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    member_id: row.member_id,
    member_name: row.member_name,
    window: row.window,
    metric: row.metric,
    threshold: row.threshold,
    webhook_url: row.webhook_url,
    enabled: row.enabled !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** What creating a rule needs. Everything is already validated by the caller. */
export interface AlertRuleInput {
  /** `null` applies the rule to every member independently. */
  readonly memberId: string | null;
  readonly window: AlertWindow;
  readonly metric: AlertMetric;
  readonly threshold: number;
  readonly webhookUrl: string | null;
  readonly enabled: boolean;
}

/** Any subset of a rule's fields, for a patch. */
export type AlertRulePatchInput = Partial<AlertRuleInput>;

/** Writes a new rule and returns it as stored. */
export function createAlertRule(
  db: Database.Database,
  input: AlertRuleInput,
  now: number = Date.now(),
): AlertRule {
  const id = `ar_${randomUUID()}`;
  db.prepare(
    `INSERT INTO alert_rules
       (id, member_id, "window", metric, threshold, webhook_url, enabled, created_at, updated_at)
     VALUES (@id, @memberId, @window, @metric, @threshold, @webhookUrl, @enabled, @now, @now)`,
  ).run({
    id,
    memberId: input.memberId,
    window: input.window,
    metric: input.metric,
    threshold: input.threshold,
    webhookUrl: input.webhookUrl,
    enabled: input.enabled ? 1 : 0,
    now,
  });
  const created = alertRuleById(db, id);
  // Unreachable: the insert above either threw or wrote this id.
  if (created === undefined) throw new Error(`alert rule ${id} vanished after being written`);
  return created;
}

/**
 * Applies a patch and returns the rule as it now stands, or `undefined` if
 * there is no such rule. An empty patch still stamps `updated_at`, which is the
 * honest record of someone having pressed Save.
 */
export function updateAlertRule(
  db: Database.Database,
  id: string,
  patch: AlertRulePatchInput,
  now: number = Date.now(),
): AlertRule | undefined {
  const current = alertRuleById(db, id);
  if (current === undefined) return undefined;

  const memberId = patch.memberId === undefined ? current.member_id : patch.memberId;
  const webhookUrl = patch.webhookUrl === undefined ? current.webhook_url : patch.webhookUrl;
  const enabled = patch.enabled ?? current.enabled;

  db.prepare(
    `UPDATE alert_rules
        SET member_id = @memberId,
            "window" = @window,
            metric = @metric,
            threshold = @threshold,
            webhook_url = @webhookUrl,
            enabled = @enabled,
            updated_at = @now
      WHERE id = @id`,
  ).run({
    id,
    memberId,
    window: patch.window ?? current.window,
    metric: patch.metric ?? current.metric,
    threshold: patch.threshold ?? current.threshold,
    webhookUrl,
    enabled: enabled ? 1 : 0,
    now,
  });
  return alertRuleById(db, id);
}

/** What deleting a rule took with it. */
export interface AlertRuleDeletion {
  /** False when the rule was already gone. Deleting twice is not an error. */
  readonly deleted: boolean;
  readonly firesDeleted: number;
}

/**
 * Removes a rule and its recorded fires, in one transaction.
 *
 * The fires go because `alert_fires.rule_id` is a declared foreign key and
 * `foreign_keys` is ON, so they would block the delete otherwise — and because
 * a fires list citing rules that no longer exist cannot be read. It is the one
 * destructive thing in this file, which is why the UI confirms it in place and
 * says how many fires are about to go with it.
 */
export function deleteAlertRule(db: Database.Database, id: string): AlertRuleDeletion {
  const remove = db.transaction((ruleId: string): AlertRuleDeletion => {
    const fires = db.prepare('DELETE FROM alert_fires WHERE rule_id = ?').run(ruleId);
    const rule = db.prepare('DELETE FROM alert_rules WHERE id = ?').run(ruleId);
    return { deleted: rule.changes > 0, firesDeleted: fires.changes };
  });
  return remove(id);
}

/** One rule by id, or `undefined`. */
export function alertRuleById(db: Database.Database, id: string): AlertRule | undefined {
  const row = db
    .prepare<Params, AlertRuleRow>(`SELECT${RULE_COLUMNS} ${RULE_FROM} WHERE ar.id = @id`)
    .get({ id });
  return row === undefined ? undefined : toRule(row);
}

/** Every rule, newest first. Disabled ones included — the UI shows them greyed. */
export function listAlertRules(db: Database.Database): AlertRule[] {
  return db
    .prepare<Params, AlertRuleRow>(
      `SELECT${RULE_COLUMNS} ${RULE_FROM} ORDER BY ar.created_at DESC, ar.id ASC`,
    )
    .all({})
    .map(toRule);
}

/** Every enabled rule, in a stable order. */
export function enabledAlertRules(db: Database.Database): AlertRule[] {
  return db
    .prepare<Params, AlertRuleRow>(
      `SELECT${RULE_COLUMNS} ${RULE_FROM}
        WHERE ar.enabled <> 0
        ORDER BY ar.created_at ASC, ar.id ASC`,
    )
    .all({})
    .map(toRule);
}

/**
 * The enabled rules that apply to one member: the ones naming them, plus the
 * ones naming nobody. This is the first query every ingest makes on the alert
 * path, which is why `idx_alert_rules_member` exists.
 */
export function enabledAlertRulesForMember(db: Database.Database, memberId: string): AlertRule[] {
  return db
    .prepare<Params, AlertRuleRow>(
      `SELECT${RULE_COLUMNS} ${RULE_FROM}
        WHERE ar.enabled <> 0
          AND (ar.member_id IS NULL OR ar.member_id = @memberId)
        ORDER BY ar.created_at ASC, ar.id ASC`,
    )
    .all({ memberId })
    .map(toRule);
}

/** One member's totals inside a window, and everyone's, for the share. */
export interface WindowUsage {
  readonly totalTokens: number;
  readonly costMicros: number;
  /** Tokens across every member in the same window — the share denominator. */
  readonly periodTokens: number;
  /** Distinct members with any usage in the window, the placeholder included. */
  readonly contributors: number;
}

/** What the window holds in total, for the share and for the guard on it. */
export interface PeriodUsage {
  readonly totalTokens: number;
  readonly contributors: number;
}

/** A `SUM` row that better-sqlite3 has already COALESCEd to a number. */
interface SumRow {
  readonly total_tokens: number;
  readonly cost_micros: number;
}

/**
 * Everyone's tokens in a window, and how many members produced them.
 *
 * The tokens are the denominator of `share_pct`, computed the same way
 * `totalsInRange` computes the dashboard's — over every request in the span,
 * with no member or source narrowing — so the two figures cannot disagree about
 * what a percentage is a percentage of. The count is what
 * `SHARE_MIN_CONTRIBUTORS` is compared against, and it deliberately includes
 * the placeholder member: those are real tokens somebody spent, and they are
 * already in the denominator.
 */
export function periodUsageInWindow(db: Database.Database, bounds: WindowBounds): PeriodUsage {
  const row = db
    .prepare<Params, { total_tokens: number; contributors: number }>(
      `SELECT ${TOKEN_SUM} AS total_tokens,
              COUNT(DISTINCT r.member_id) AS contributors
         FROM requests r
        WHERE r.ts >= @from AND r.ts < @to`,
    )
    .get({ from: bounds.start, to: bounds.end });
  return { totalTokens: row?.total_tokens ?? 0, contributors: row?.contributors ?? 0 };
}

/** One member's tokens and notional cost in a window, plus the period total. */
export function memberWindowUsage(
  db: Database.Database,
  bounds: WindowBounds,
  memberId: string,
): WindowUsage {
  const row = db
    .prepare<Params, SumRow>(
      `SELECT ${TOKEN_SUM} AS total_tokens,
              COALESCE(SUM(r.cost_micros), 0) AS cost_micros
         FROM requests r
        WHERE r.member_id = @memberId AND r.ts >= @from AND r.ts < @to`,
    )
    .get({ memberId, from: bounds.start, to: bounds.end });
  const period = periodUsageInWindow(db, bounds);
  return {
    totalTokens: row?.total_tokens ?? 0,
    costMicros: row?.cost_micros ?? 0,
    periodTokens: period.totalTokens,
    contributors: period.contributors,
  };
}

/** One member's usage inside a window, for the badge computation. */
export interface MemberWindowUsage extends WindowUsage {
  readonly memberId: string;
  readonly displayName: string;
}

/**
 * Every member with usage in a window, and the period total behind them.
 *
 * Members with no rows are absent, and that is not a gap: a threshold is always
 * greater than zero, so a member who used nothing cannot be over one. The
 * placeholder member is excluded from the rows but not from the period total,
 * because stage 1's unattributed requests are real tokens that a real share is
 * a share of.
 */
export function memberWindowUsages(
  db: Database.Database,
  bounds: WindowBounds,
): { readonly members: MemberWindowUsage[]; readonly period: PeriodUsage } {
  const period = periodUsageInWindow(db, bounds);
  const rows = db
    .prepare<Params, { member_id: string; display_name: string } & SumRow>(
      `SELECT r.member_id AS member_id,
              m.display_name AS display_name,
              ${TOKEN_SUM} AS total_tokens,
              COALESCE(SUM(r.cost_micros), 0) AS cost_micros
         FROM requests r
         JOIN members m ON m.id = r.member_id
        WHERE r.ts >= @from AND r.ts < @to
          AND r.member_id <> @placeholder
        GROUP BY r.member_id, m.display_name
        ORDER BY total_tokens DESC, m.display_name COLLATE NOCASE ASC`,
    )
    .all({ from: bounds.start, to: bounds.end, placeholder: UNATTRIBUTED_MEMBER_ID });

  return {
    members: rows.map((row) => ({
      memberId: row.member_id,
      displayName: row.display_name,
      totalTokens: row.total_tokens,
      costMicros: row.cost_micros,
      periodTokens: period.totalTokens,
      contributors: period.contributors,
    })),
    period,
  };
}

/** A fire about to be claimed. */
export interface AlertFireClaim {
  readonly ruleId: string;
  readonly memberId: string;
  readonly firedAt: number;
  readonly value: number;
  /** Start of the window, in epoch milliseconds. The debounce key. */
  readonly windowStart: number;
  readonly deliveryStatus: AlertDeliveryStatus;
}

/** The id of a claimed fire, or `undefined` when this window already had one. */
export interface AlertFireClaimResult {
  readonly claimed: boolean;
  readonly id: string;
}

/**
 * Claims the one fire a rule gets for a member in a window.
 *
 * `INSERT OR IGNORE` against `idx_alert_fires_window`, so the claim is the
 * debounce: whichever caller writes the row first is the one that delivers, and
 * a second evaluation of the same window is told `claimed: false` and sends
 * nothing. Nothing here reads before writing, because a read followed by a
 * write is two statements a concurrent evaluation can interleave with.
 */
export function claimAlertFire(db: Database.Database, claim: AlertFireClaim): AlertFireClaimResult {
  const id = `af_${randomUUID()}`;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO alert_fires
         (id, rule_id, member_id, fired_at, value, window_start, delivery_status, attempts)
       VALUES (@id, @ruleId, @memberId, @firedAt, @value, @windowStart, @deliveryStatus, 0)`,
    )
    .run({
      id,
      ruleId: claim.ruleId,
      memberId: claim.memberId,
      firedAt: claim.firedAt,
      value: claim.value,
      windowStart: claim.windowStart,
      deliveryStatus: claim.deliveryStatus,
    });
  return { claimed: info.changes === 1, id };
}

/** True when this rule already fired for this member in this window. */
export function hasFiredInWindow(
  db: Database.Database,
  ruleId: string,
  memberId: string,
  windowStart: number,
): boolean {
  const row = db
    .prepare<Params, { one: number }>(
      `SELECT 1 AS one FROM alert_fires
        WHERE rule_id = @ruleId AND member_id = @memberId AND window_start = @windowStart`,
    )
    .get({ ruleId, memberId, windowStart });
  return row !== undefined;
}

/** How a webhook attempt ended, as recorded against the fire that started it. */
export interface AlertDeliveryOutcome {
  readonly status: AlertDeliveryStatus;
  readonly attempts: number;
  /** Truncated by the caller; `null` when nothing went wrong. */
  readonly error: string | null;
  readonly deliveredAt: number | null;
}

/** Records what became of a fire's webhook. */
export function recordAlertDelivery(
  db: Database.Database,
  id: string,
  outcome: AlertDeliveryOutcome,
): void {
  db.prepare(
    `UPDATE alert_fires
        SET delivery_status = @status,
            attempts = @attempts,
            delivery_error = @error,
            delivered_at = @deliveredAt
      WHERE id = @id`,
  ).run({
    id,
    status: outcome.status,
    attempts: outcome.attempts,
    error: outcome.error,
    deliveredAt: outcome.deliveredAt,
  });
}

/** Recent fires, newest first, each joined to the rule that raised it. */
export function listAlertFires(db: Database.Database, limit: number): AlertFire[] {
  return db
    .prepare<Params, AlertFireRow>(
      `SELECT
         af.id AS id,
         af.rule_id AS rule_id,
         af.member_id AS member_id,
         m.display_name AS member_name,
         af.fired_at AS fired_at,
         af.value AS value,
         af.window_start AS window_start,
         ar.metric AS metric,
         ar."window" AS "window",
         ar.threshold AS threshold,
         af.delivery_status AS delivery_status,
         af.delivery_error AS delivery_error,
         af.delivered_at AS delivered_at,
         af.attempts AS attempts
       FROM alert_fires af
       JOIN alert_rules ar ON ar.id = af.rule_id
       LEFT JOIN members m ON m.id = af.member_id
       ORDER BY af.fired_at DESC, af.id DESC
       LIMIT @limit`,
    )
    .all({ limit });
}

/**
 * The `(rule, member, window)` triples already fired at or after `since`, as
 * keys of the form `ruleId|memberId|windowStart`. One query rather than a
 * lookup per rule, because the badge computation asks about every rule and
 * every member at once.
 */
export function firedWindowKeys(db: Database.Database, since: number): Set<string> {
  const rows = db
    .prepare<Params, { rule_id: string; member_id: string | null; window_start: number }>(
      `SELECT rule_id, member_id, window_start FROM alert_fires WHERE window_start >= @since`,
    )
    .all({ since });
  return new Set(
    rows.map((row) => `${row.rule_id}|${row.member_id ?? ''}|${String(row.window_start)}`),
  );
}
