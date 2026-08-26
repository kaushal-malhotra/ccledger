/**
 * Turning numbers into something readable, in one place.
 *
 * Everything is pinned to `en-US` rather than the browser's locale. A dashboard
 * where one teammate reads `1,234,567` and another reads `1.234.567` is a
 * dashboard where a screenshot in a chat means two different things, and the
 * rest of ccledger — the CLI output, the docs — is in one language already.
 *
 * The cost formatter is the one with a rule behind it. Costs arrive as integer
 * micros and are divided here and nowhere else: a value that has been through a
 * float before it reaches this function has already lost whatever it lost.
 */

import type { BucketSize } from '../../../src/shared/api.js';

/** Millionths of a dollar in a dollar. */
const MICROS_PER_DOLLAR = 1_000_000;

/** Full precision with thousands separators, for table cells. */
const COUNT = new Intl.NumberFormat('en-US');

/** Three significant digits and a magnitude suffix, for the summary tiles. */
const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Cents, for any amount a rounding to cents would not erase. */
const DOLLARS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Four decimals, for amounts under a cent. A team on a subscription plan
 * generates a great many requests that cost a fraction of a cent each, and a
 * column of `$0.00` says nothing about which of them was expensive.
 */
const SMALL_DOLLARS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/** Local date and time, for a tooltip on anything shown as "3 hours ago". */
const ABSOLUTE = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Local date alone, for a range label. */
const DATE_ONLY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

/** Month and day, for a chart axis where the year is in the heading already. */
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** The hour alone, for an axis of hourly buckets inside one or two days. */
const HOUR_ONLY = new Intl.DateTimeFormat('en-US', { hour: 'numeric' });

/** Day and hour, for the tooltip over an hourly bucket. */
const DAY_HOUR = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
});

/** The sentence every cost figure on this dashboard carries. */
export const COST_DISCLAIMER =
  'Estimated. Claude Code reports an API-equivalent price for every request. ' +
  'On a subscription plan no money changes hands per request, so this is a ' +
  'notional figure for comparing usage between people — not real spend.';

/** `1,234,567`. */
export function formatCount(value: number): string {
  return COUNT.format(value);
}

/** `1.2M`. Full precision belongs in a `title` beside it. */
export function formatCompact(value: number): string {
  return COMPACT.format(value);
}

/**
 * Integer micros as dollars. Exact zero is `$0.00`; anything that would round
 * to zero cents keeps four decimals instead of pretending to be free.
 */
export function formatCostMicros(micros: number): string {
  const dollars = micros / MICROS_PER_DOLLAR;
  if (dollars === 0) return DOLLARS.format(0);
  return Math.abs(dollars) < 0.01 ? SMALL_DOLLARS.format(dollars) : DOLLARS.format(dollars);
}

/** A percentage with one decimal, as `12.3%`. */
export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** Local date and time, spelled out. */
export function formatAbsolute(ms: number): string {
  return ABSOLUTE.format(new Date(ms));
}

/** Local date alone, spelled out. */
export function formatDate(ms: number): string {
  return DATE_ONLY.format(new Date(ms));
}

/**
 * How long ago something was, in the largest unit that still reads as a
 * quantity: `just now`, `4m ago`, `3h ago`, `12d ago`. Anything older than a
 * season gets a date, because "137d ago" is a number nobody converts.
 */
export function formatRelative(ms: number, now: number): string {
  const elapsed = now - ms;
  if (elapsed < 0) return 'just now';

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;

  const days = Math.floor(hours / 24);
  if (days <= 90) return `${String(days)}d ago`;

  return formatDate(ms);
}

/**
 * How long until something, in the same units and the opposite direction:
 * `in 23h`, `in 4m`, `expired`.
 *
 * `formatRelative` cannot do this. It measures elapsed time and folds every
 * negative value to `just now`, so an expiry a day away renders as though it
 * had already passed — which is exactly backwards for the one thing anybody
 * reads an expiry to find out.
 */
export function formatUntil(ms: number, now: number): string {
  const remaining = ms - now;
  if (remaining <= 0) return 'expired';

  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${String(minutes)}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${String(hours)}h`;

  const days = Math.floor(hours / 24);
  return `in ${String(days)}d`;
}

/** The label under a range picker: `Aug 20 – Aug 27, 2026`, in local time. */
export function formatRangeLabel(from: number, to: number): string {
  // The range is half-open, so the last instant it covers is a millisecond
  // before `to`. Labelling it with `to` itself would name a day the numbers
  // above it do not include.
  return `${formatDate(from)} – ${formatDate(to - 1)}`;
}

/**
 * A bucket start on a chart axis: `2 PM` for hourly buckets, `Aug 24` for
 * daily. Short on purpose — an axis tick that wraps is an axis tick that
 * collides with its neighbour.
 */
export function formatBucketLabel(ms: number, bucket: BucketSize): string {
  return bucket === 'hour' ? HOUR_ONLY.format(new Date(ms)) : MONTH_DAY.format(new Date(ms));
}

/**
 * A bucket start in a tooltip, where there is room to say which day an hour
 * belongs to and no neighbouring label to collide with.
 */
export function formatBucketFull(ms: number, bucket: BucketSize): string {
  return bucket === 'hour' ? DAY_HOUR.format(new Date(ms)) : DATE_ONLY.format(new Date(ms));
}
