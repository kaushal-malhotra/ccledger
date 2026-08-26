/**
 * Alert evaluation: what happens after an ingest transaction commits.
 *
 * Four rules shape this file, and all four are about not being trusted with the
 * request.
 *
 * **It runs on ingest, not on a cron.** At this volume a member's window totals
 * are two indexed aggregates, so evaluating them when the numbers change is
 * cheaper than a scheduler and fires within a second of the crossing rather
 * than within a polling interval.
 *
 * **Only the member who just ingested is evaluated.** Every metric here is
 * monotone in that member's own usage: their tokens and cost can only rise, and
 * their share can only rise, because everyone else's ingest raises the
 * denominator and lowers theirs. So nobody else can have newly crossed a
 * threshold as a result of this batch, and evaluating the whole team on every
 * request would be work with a provably empty result.
 *
 * **The fire row is written before the webhook is sent, not after.** The brief
 * says to check `alert_fires` before firing and record afterwards; the check is
 * here and does the ordinary work, but the record cannot wait for delivery. A
 * webhook takes up to five seconds and Node runs the next request in the
 * meantime, so a fire recorded on completion would let a second batch from the
 * same member read an empty table and send the same alert again — which is the
 * exact duplicate the debounce exists to prevent. Writing first, as an
 * `INSERT OR IGNORE` against a unique index, makes the claim and the debounce
 * the same operation. What delivery adds afterwards is its outcome.
 *
 * **Nothing here may fail an ingest.** `runAlertEvaluation` catches everything,
 * logs it, and resolves. The route calls it without awaiting, so a slow
 * endpoint on someone's Slack costs an exporter nothing.
 */

import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';

import {
  claimAlertFire,
  enabledAlertRules,
  enabledAlertRulesForMember,
  firedWindowKeys,
  hasFiredInWindow,
  memberWindowUsage,
  memberWindowUsages,
  recordAlertDelivery,
} from '../db/alerts.js';
import type { MemberWindowUsage, WindowUsage } from '../db/alerts.js';
import { getConfig } from '../db/config.js';
import type { AlertRule, AlertState } from '../shared/api.js';
import type {
  AlertDeliveryStatus,
  AlertMetric,
  AlertUsageContext,
  AlertWindow,
  WindowBounds,
} from '../shared/alerts.js';
import {
  SHARE_MIN_CONTRIBUTORS,
  buildAlertPayload,
  systemTimeZone,
  windowBoundsAt,
} from '../shared/alerts.js';
import { CONFIG_TIMEZONE } from '../shared/constants.js';
import { findMember } from './auth.js';
import { deliverWebhook, truncateError } from './webhook.js';
import type { WebhookDeliver } from './webhook.js';

/** Micros in a dollar. `cost_micros` is only ever divided at the point of use. */
const MICROS_PER_DOLLAR = 1_000_000;

/** The levels this module logs at; a plain object satisfies it in tests. */
export type AlertLogger = Pick<FastifyBaseLogger, 'debug' | 'warn' | 'error'>;

/** Knobs the ingest route sets, and the seams tests replace. */
export interface AlertEvaluationOptions {
  /** The member whose batch just landed — the only one worth evaluating. */
  readonly memberId: string;
  /** Clock. Defaults to `Date.now()`. */
  readonly now?: number;
  readonly logger?: AlertLogger;
  /** Defaults to the real HTTP delivery. */
  readonly deliver?: WebhookDeliver;
  /** Overrides the stored zone. Only tests pass this. */
  readonly timezone?: string;
}

/** One fire this evaluation claimed. */
export interface ClaimedFire {
  readonly fireId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly metric: AlertMetric;
  readonly window: AlertWindow;
  readonly threshold: number;
  readonly value: number;
  readonly windowStart: number;
  /** False for a rule with no webhook URL — the badge is the whole delivery. */
  readonly dispatched: boolean;
}

/** What one pass over a member's rules did. */
export interface AlertEvaluation {
  /** Rules considered, whether or not they crossed. */
  readonly evaluated: number;
  readonly fires: readonly ClaimedFire[];
  /** Resolves once every webhook this pass started has settled, or failed. */
  readonly settled: Promise<void>;
}

/**
 * The zone alert windows are aligned to: what `ccledger serve` recorded, or
 * this machine's zone on a server that has never been started through the CLI —
 * which in practice means a test, since `serve` writes the value on every boot.
 */
export function resolveTimeZone(db: Database.Database): string {
  return getConfig(db, CONFIG_TIMEZONE) ?? systemTimeZone();
}

/** A member's value for one metric over one window. */
export function metricValue(metric: AlertMetric, usage: WindowUsage): number {
  if (metric === 'tokens') return usage.totalTokens;
  if (metric === 'cost_usd') return usage.costMicros / MICROS_PER_DOLLAR;
  return usage.periodTokens > 0 ? (100 * usage.totalTokens) / usage.periodTokens : 0;
}

/**
 * Whether a rule should count this member as over its threshold.
 *
 * One predicate rather than a comparison at each call site, because two of them
 * exist — the one that fires a webhook and the one that raises the badge — and
 * a dashboard that flags somebody no alert will ever fire for, or fires an
 * alert about somebody the dashboard says is fine, is worse than either
 * behaviour on its own.
 *
 * At the threshold counts as over it: a rule written as "50%" is read by the
 * person who wrote it as "half", and half is not under half.
 */
export function crossesThreshold(
  metric: AlertMetric,
  threshold: number,
  usage: WindowUsage,
): boolean {
  // A share of a pool one person contributed to is 100% by construction. See
  // `SHARE_MIN_CONTRIBUTORS`.
  if (metric === 'share_pct' && usage.contributors < SHARE_MIN_CONTRIBUTORS) return false;
  return metricValue(metric, usage) >= threshold;
}

/** The usage figures a webhook carries alongside the metric that fired. */
function usageContext(usage: WindowUsage): AlertUsageContext {
  return {
    total_tokens: usage.totalTokens,
    cost_usd: usage.costMicros / MICROS_PER_DOLLAR,
    share_pct: metricValue('share_pct', usage),
    period_total_tokens: usage.periodTokens,
  };
}

/**
 * Writes a delivery outcome without letting the write itself become a failure.
 *
 * This runs after an `await`, by which time the request that started it is long
 * answered — and in a test, the database may already be closed. A throw here
 * would surface as an unhandled rejection in a process that has nothing left to
 * do about it.
 */
function recordOutcome(
  db: Database.Database,
  fireId: string,
  outcome: {
    readonly status: AlertDeliveryStatus;
    readonly attempts: number;
    readonly error: string | null;
    readonly deliveredAt: number | null;
  },
  logger: AlertLogger | undefined,
): void {
  try {
    recordAlertDelivery(db, fireId, outcome);
  } catch (error) {
    logger?.error({ err: error, fireId }, 'could not record alert delivery outcome');
  }
}

/**
 * Posts one fire and records what happened. Never rejects: the caller collects
 * these into a promise the ingest route does not await, so a rejection would
 * have nowhere to go.
 */
function dispatch(
  db: Database.Database,
  fire: ClaimedFire,
  rule: AlertRule,
  url: string,
  payload: ReturnType<typeof buildAlertPayload>,
  deliver: WebhookDeliver,
  logger: AlertLogger | undefined,
): Promise<void> {
  return deliver(url, payload).then(
    (result) => {
      recordOutcome(
        db,
        fire.fireId,
        {
          status: result.ok ? 'delivered' : 'failed',
          attempts: result.attempts,
          error: result.error ?? null,
          deliveredAt: result.ok ? Date.now() : null,
        },
        logger,
      );
      if (!result.ok) {
        // The rule id, never the URL: a Slack incoming-webhook URL is a
        // credential, and a log line is the easiest place to leak one.
        logger?.warn(
          { ruleId: rule.id, status: result.status, attempts: result.attempts },
          'alert webhook gave up',
        );
      }
    },
    (error: unknown) => {
      // `deliverWebhook` turns every failure into a result rather than a
      // rejection, so reaching here means an injected deliver threw. Recorded
      // the same way, because from the fire's point of view it is the same fact.
      const message = error instanceof Error ? error.message : String(error);
      recordOutcome(
        db,
        fire.fireId,
        { status: 'failed', attempts: 0, error: truncateError(message), deliveredAt: null },
        logger,
      );
      logger?.error({ err: error, ruleId: rule.id }, 'alert webhook threw');
    },
  );
}

/**
 * Evaluates every enabled rule that applies to one member and claims the fires
 * that cross.
 *
 * Synchronous up to the point a webhook is handed off, which is what makes the
 * claim atomic against a concurrent request: by the time this returns, every
 * fire it decided on is already a row.
 */
export function evaluateAlerts(
  db: Database.Database,
  options: AlertEvaluationOptions,
): AlertEvaluation {
  const now = options.now ?? Date.now();
  const logger = options.logger;
  const deliver = options.deliver ?? ((url, payload) => deliverWebhook(url, payload));

  const rules = enabledAlertRulesForMember(db, options.memberId);
  if (rules.length === 0) {
    return { evaluated: 0, fires: [], settled: Promise.resolve() };
  }

  const timezone = options.timezone ?? resolveTimeZone(db);
  const member = findMember(db, options.memberId);
  const memberName = member?.displayName ?? options.memberId;

  // One aggregate per distinct window, however many rules share it. A team with
  // a daily and a weekly rule for every member still costs two pairs of sums.
  const bounds = new Map<AlertWindow, WindowBounds>();
  const usages = new Map<AlertWindow, WindowUsage>();
  const fires: ClaimedFire[] = [];
  const deliveries: Promise<void>[] = [];

  for (const rule of rules) {
    let window = bounds.get(rule.window);
    let usage = usages.get(rule.window);
    if (window === undefined || usage === undefined) {
      window = windowBoundsAt(rule.window, now, timezone);
      usage = memberWindowUsage(db, window, options.memberId);
      bounds.set(rule.window, window);
      usages.set(rule.window, usage);
    }

    const value = metricValue(rule.metric, usage);
    if (!crossesThreshold(rule.metric, rule.threshold, usage)) continue;

    // The check the brief asks for. It settles every ordinary repeat without
    // touching the write path; the claim below is what settles the rest.
    if (hasFiredInWindow(db, rule.id, options.memberId, window.start)) continue;

    const url = rule.webhook_url;
    const claim = claimAlertFire(db, {
      ruleId: rule.id,
      memberId: options.memberId,
      firedAt: now,
      value,
      windowStart: window.start,
      deliveryStatus: url === null ? 'skipped' : 'pending',
    });
    if (!claim.claimed) {
      // Another evaluation got there between the check and the insert. Its
      // webhook is already on its way; this one has nothing left to do.
      logger?.debug({ ruleId: rule.id, memberId: options.memberId }, 'alert already claimed');
      continue;
    }

    const fire: ClaimedFire = {
      fireId: claim.id,
      ruleId: rule.id,
      memberId: options.memberId,
      metric: rule.metric,
      window: rule.window,
      threshold: rule.threshold,
      value,
      windowStart: window.start,
      dispatched: url !== null,
    };
    fires.push(fire);
    logger?.debug(
      { ruleId: rule.id, memberId: options.memberId, metric: rule.metric, value },
      'alert fired',
    );

    if (url === null) continue;
    const payload = buildAlertPayload({
      ruleId: rule.id,
      memberId: options.memberId,
      memberName,
      metric: rule.metric,
      threshold: rule.threshold,
      value,
      bounds: window,
      firedAt: now,
      usage: usageContext(usage),
    });
    deliveries.push(dispatch(db, fire, rule, url, payload, deliver, logger));
  }

  return {
    evaluated: rules.length,
    fires,
    settled: Promise.all(deliveries).then(() => undefined),
  };
}

/**
 * `evaluateAlerts` with every failure absorbed.
 *
 * The ingest route calls this without awaiting, so the promise it returns is
 * for tests and for nothing else — but it still must not reject, because an
 * unhandled rejection in a Node 20 process is a crash. A logged error here
 * means the dashboard is missing an alert; an exception escaping it would mean
 * a teammate's exporter is retrying a batch that was already stored.
 */
export async function runAlertEvaluation(
  db: Database.Database,
  options: AlertEvaluationOptions,
): Promise<void> {
  try {
    await evaluateAlerts(db, options).settled;
  } catch (error) {
    options.logger?.error({ err: error, memberId: options.memberId }, 'alert evaluation failed');
  }
}

/**
 * Every (rule, member) pair at or over its threshold right now.
 *
 * This is the badge, and it is deliberately not derived from `alert_fires`. A
 * fire is a moment; a badge is a condition. Someone who crossed on Monday and
 * is still over on Wednesday has one fire and should still be flagged, and
 * someone whose rule was raised after they crossed has a fire and should not
 * be. So the states are recomputed from the current window every time, with
 * `fired` carried alongside to say which of them have already notified.
 *
 * Members with no usage in the window are absent from the aggregate, which
 * costs nothing: a threshold is always above zero, so a member at zero cannot
 * be over one.
 */
export function activeAlertStates(
  db: Database.Database,
  options: { readonly now?: number; readonly timezone?: string } = {},
): AlertState[] {
  const now = options.now ?? Date.now();
  const timezone = options.timezone ?? resolveTimeZone(db);
  const rules = enabledAlertRules(db);
  if (rules.length === 0) return [];

  const bounds = new Map<AlertWindow, WindowBounds>();
  const usages = new Map<AlertWindow, MemberWindowUsage[]>();
  for (const rule of rules) {
    if (bounds.has(rule.window)) continue;
    const window = windowBoundsAt(rule.window, now, timezone);
    bounds.set(rule.window, window);
    usages.set(rule.window, memberWindowUsages(db, window).members);
  }

  // One read of the fire table for every window in play, rather than a lookup
  // per pair. The earliest window start bounds it; nothing older can match.
  const earliest = Math.min(...[...bounds.values()].map((window) => window.start));
  const fired = firedWindowKeys(db, earliest);

  const states: AlertState[] = [];
  for (const rule of rules) {
    const window = bounds.get(rule.window);
    const members = usages.get(rule.window);
    if (window === undefined || members === undefined) continue;

    for (const usage of members) {
      if (rule.member_id !== null && rule.member_id !== usage.memberId) continue;
      if (!crossesThreshold(rule.metric, rule.threshold, usage)) continue;
      const value = metricValue(rule.metric, usage);
      states.push({
        rule_id: rule.id,
        member_id: usage.memberId,
        member_name: usage.displayName,
        metric: rule.metric,
        window: rule.window,
        threshold: rule.threshold,
        value,
        window_start: window.start,
        window_end: window.end,
        fired: fired.has(`${rule.id}|${usage.memberId}|${String(window.start)}`),
      });
    }
  }

  // Furthest over first, so the dashboard's own ordering matches the urgency.
  return states.sort(
    (a, b) =>
      b.value / b.threshold - a.value / a.threshold || a.member_name.localeCompare(b.member_name),
  );
}
