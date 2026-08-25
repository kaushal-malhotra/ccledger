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

/** The label under a range picker: `Aug 20 – Aug 27, 2026`, in local time. */
export function formatRangeLabel(from: number, to: number): string {
  // The range is half-open, so the last instant it covers is a millisecond
  // before `to`. Labelling it with `to` itself would name a day the numbers
  // above it do not include.
  return `${formatDate(from)} – ${formatDate(to - 1)}`;
}
