/**
 * The date range the dashboard is looking at.
 *
 * Every preset starts at a local midnight rather than at "now minus N hours".
 * A rolling window is easier to compute and worse to read: "7d" that begins at
 * 14:20 last Thursday puts two half-days at the ends of every daily chart, and
 * the number in the table stops matching what anyone means by "this week".
 *
 * All arithmetic goes through `Date`'s local accessors, so a range that spans a
 * daylight-saving change is still a whole number of local days — subtracting
 * `n * 86400000` would be off by an hour twice a year, in the direction that
 * silently drops or double-counts requests at a boundary.
 */

/** The presets the picker offers. */
export type RangePreset = 'today' | '7d' | '30d' | 'custom';

/** A half-open range of epoch milliseconds, `[from, to)`. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

/** How many local days back each preset begins, counting today as day zero. */
const PRESET_DAYS: Readonly<Record<Exclude<RangePreset, 'custom'>, number>> = {
  today: 0,
  '7d': 6,
  '30d': 29,
};

/** The label each preset shows on its button. */
export const PRESET_LABELS: Readonly<Record<RangePreset, string>> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  custom: 'Custom',
};

/** Local midnight that begins the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight `days` whole local days before the day containing `ms`. */
export function localDaysAgo(ms: number, days: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/**
 * The range a preset means at `now`: from a local midnight up to this instant.
 * `to` is the present rather than the end of today, so nothing is claimed about
 * hours that have not happened.
 */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, now: number): Range {
  return { from: localDaysAgo(now, PRESET_DAYS[preset]), to: now };
}

/** Splits a `YYYY-MM-DD` value from a date input, or `undefined` if it is not one. */
function parseLocalDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Local midnight, not `new Date(value)`, which reads a bare date as UTC and
  // would shift the whole range by the viewer's offset.
  const date = new Date(year, month - 1, day);
  const rolledOver =
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day;
  return rolledOver ? undefined : date;
}

/**
 * The range two `<input type="date">` values mean. The end date is inclusive to
 * whoever typed it — asking for the 1st to the 3rd means three whole days — so
 * `to` is the midnight that ends it, which is the midnight that begins the 4th.
 */
export function customRange(from: string, to: string): Range | undefined {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (start === undefined || end === undefined) return undefined;

  const endExclusive = new Date(end);
  endExclusive.setDate(endExclusive.getDate() + 1);
  if (start.getTime() >= endExclusive.getTime()) return undefined;

  return { from: start.getTime(), to: endExclusive.getTime() };
}

/** A `YYYY-MM-DD` value for a date input, in local time. */
export function toDateInputValue(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** The `from`/`to` query parameters for a range, as ISO instants in UTC. */
export function toQueryParams(range: Range): { from: string; to: string } {
  return { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() };
}

/**
 * Minutes east of UTC at `ms`, which is what `/api/timeseries` aligns its
 * buckets to. `getTimezoneOffset` counts the other way, hence the sign.
 */
export function tzOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}
