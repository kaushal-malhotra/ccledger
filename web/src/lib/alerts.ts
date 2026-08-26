/**
 * Turning alert rules into the words the Settings page shows.
 *
 * Everything here is pure, and the option lists are declared here rather than
 * imported from `src/shared/alerts.ts`. The types come from `src/shared`, as
 * `import type`, which the bundler erases — but the *values* would not be
 * erased, and pulling a module that builds `Intl` formatters and does calendar
 * arithmetic into the browser bundle to get three strings is not a trade worth
 * making. The lists are checked against the shared ones by this module's test.
 */

import type { AlertFire, AlertRule, AlertState } from '../../../src/shared/api.js';
import type { AlertDeliveryStatus, AlertMetric, AlertWindow } from '../../../src/shared/alerts.js';

import { formatCount, formatPercent } from './format.js';

/** One choice in a `<select>`. */
export interface Choice<T> {
  readonly value: T;
  readonly label: string;
  /** The `<option>`'s tooltip, and the hint under the control. */
  readonly hint: string;
}

/**
 * The metrics, share first.
 *
 * The order is the argument. On a shared subscription nobody spends dollars —
 * they consume a slice of a flat plan — so the metric a team actually argues
 * about is the one the form should open on.
 */
export const METRIC_CHOICES: readonly Choice<AlertMetric>[] = [
  {
    value: 'share_pct',
    label: 'Share of tokens',
    hint: 'Percentage of everyone’s tokens in the window. The one to use on a shared plan.',
  },
  {
    value: 'tokens',
    label: 'Tokens',
    hint: 'An absolute token count. For a fixed budget rather than a comparison.',
  },
  {
    value: 'cost_usd',
    label: 'Estimated cost',
    hint: 'Notional dollars. Real money only if your team is on API billing.',
  },
];

/** The windows, shortest first. */
export const WINDOW_CHOICES: readonly Choice<AlertWindow>[] = [
  { value: 'day', label: 'Per day', hint: 'Resets at midnight in the server’s timezone.' },
  { value: 'week', label: 'Per week', hint: 'Resets on Monday in the server’s timezone.' },
];

/** The metric a new rule opens on. */
export const DEFAULT_METRIC: AlertMetric = 'share_pct';

/** The window a new rule opens on. */
export const DEFAULT_WINDOW: AlertWindow = 'week';

/** The unit shown beside a threshold input, so the number has a meaning. */
export function thresholdUnit(metric: AlertMetric): string {
  if (metric === 'share_pct') return '%';
  if (metric === 'cost_usd') return 'USD';
  return 'tokens';
}

/** A threshold or a value, in the unit of its metric. */
export function formatMetric(metric: AlertMetric, value: number): string {
  if (metric === 'share_pct') return formatPercent(value);
  if (metric === 'cost_usd') return `$${value.toFixed(2)}`;
  return formatCount(Math.round(value));
}

/** `Share of tokens`, `Tokens`, `Estimated cost`. */
export function metricLabel(metric: AlertMetric): string {
  return METRIC_CHOICES.find((choice) => choice.value === metric)?.label ?? metric;
}

/** `Per day`, `Per week`. */
export function windowLabel(window: AlertWindow): string {
  return WINDOW_CHOICES.find((choice) => choice.value === window)?.label ?? window;
}

/** `a day`, `a week` — for a sentence rather than a column header. */
export function windowNoun(window: AlertWindow): string {
  return window === 'day' ? 'a day' : 'a week';
}

/**
 * A rule as one sentence: who it watches, what it watches, and when it resets.
 * The table shows the parts in columns as well; this is what a screen reader
 * and a narrow viewport get.
 */
export function describeRule(rule: AlertRule): string {
  const who = rule.member_name ?? (rule.member_id === null ? 'Anyone' : rule.member_id);
  return `${who} over ${formatMetric(rule.metric, rule.threshold)} ${metricLabel(
    rule.metric,
  ).toLowerCase()} in ${windowNoun(rule.window)}`;
}

/** What the delivery column says, in the admin's terms rather than the code's. */
export function deliveryLabel(status: AlertDeliveryStatus): string {
  if (status === 'delivered') return 'sent';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'no webhook';
  return 'sending…';
}

/** The badge class a delivery status renders with. */
export function deliveryTone(status: AlertDeliveryStatus): string {
  if (status === 'delivered') return 'badge badge-active';
  if (status === 'failed') return 'badge badge-revoked';
  return 'badge';
}

/**
 * The active states, keyed by member.
 *
 * A member can be over two rules at once — a daily and a weekly one, say — so
 * the value is a list and the row decides how much of it to show.
 */
export function activeByMember(
  active: readonly AlertState[],
): ReadonlyMap<string, readonly AlertState[]> {
  const byMember = new Map<string, AlertState[]>();
  for (const state of active) {
    const existing = byMember.get(state.member_id);
    if (existing === undefined) {
      byMember.set(state.member_id, [state]);
    } else {
      existing.push(state);
    }
  }
  return byMember;
}

/** The badge on a member row: the value, not the rule that named it. */
export function badgeLabel(state: AlertState): string {
  return `over ${formatMetric(state.metric, state.threshold)}`;
}

/** The badge's tooltip, which is where the whole sentence fits. */
export function badgeTitle(state: AlertState, timezone: string): string {
  return (
    `${state.member_name} is at ${formatMetric(state.metric, state.value)} ` +
    `of ${metricLabel(state.metric).toLowerCase()} this ${state.window}, ` +
    `over the ${formatMetric(state.metric, state.threshold)} alert. ` +
    `Measured over the current ${state.window} in ${timezone}, not the range shown above.`
  );
}

/** How a fire's value reads in the recent-fires list. */
export function fireValue(fire: AlertFire): string {
  return `${formatMetric(fire.metric, fire.value)} of ${formatMetric(fire.metric, fire.threshold)}`;
}
