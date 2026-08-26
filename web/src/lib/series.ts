/**
 * Turning `/api/timeseries` into something a stacked area can draw.
 *
 * Two things happen here that a chart component should not be doing inline, and
 * both are the sort of thing that is wrong quietly rather than loudly.
 *
 * **Empty buckets are filled in.** The endpoint does not emit a bucket nobody
 * used, which is the right thing for a wire format and the wrong thing for a
 * line: handed Monday and Wednesday, every charting library draws a slope
 * between them, so a day when the team did nothing renders as a day when the
 * team did about half. The grid is regenerated from the range and the bucket
 * width and every hole is a zero.
 *
 * **The tail is folded.** The palette holds eight hues and a ninth would have to
 * repeat one, so a team past eight gets its top seven by name and everyone else
 * summed into one neutral band. The stack total is unchanged by the fold, which
 * is what keeps a bucket's height equal to the row in the table beneath it.
 */

import type { BucketSize, RangeInfo, TimeseriesResponse } from '../../../src/shared/api.js';

import { OTHER_COLOR, memberColor } from './colors.js';
import { formatBucketLabel, formatCount, formatPercent } from './format.js';

/** The data key everyone past the palette is stacked under. */
export const OTHER_KEY = '__other';

/** The data key carrying a row's stack total. */
export const TOTAL_KEY = '__total';

/** How many bands a stack may carry before the tail is folded into one. */
export const MAX_BANDS = 8;

/**
 * A runaway guard, not a product decision. The server picks hourly buckets only
 * for ranges under three days, so a real range is at most 72 hourly points or
 * one point per day; only a hand-typed custom range of several years could
 * approach this, and a truncated chart beats a hung tab.
 */
const MAX_GRID_POINTS = 2000;

/** One band of the stack: a member, or the folded tail. */
export interface Band {
  /** The row key this band's value lives under. A member id, or `OTHER_KEY`. */
  readonly key: string;
  readonly label: string;
  /** A `var(--series-n)` reference, resolved by the theme. */
  readonly color: string;
  /** Tokens over the whole range, which is what the bands are ordered by. */
  readonly total: number;
  /** How many members this band stands for. Always 1 except for the tail. */
  readonly members: number;
}

/** One bucket, flattened so each band is a key a chart can name. */
export interface SeriesRow {
  /** Epoch milliseconds at the start of the bucket. */
  readonly bucket_start: number;
  readonly [key: string]: number;
}

/** Everything the timeseries chart and its summary read. */
export interface SeriesData {
  readonly bands: readonly Band[];
  readonly rows: readonly SeriesRow[];
  /** Tokens over the whole range, across every band. */
  readonly total: number;
  /** The busiest bucket, or `null` when nothing was used. */
  readonly peak: { readonly bucket_start: number; readonly total: number } | null;
  /** Members with any usage in the range, before the fold. */
  readonly memberCount: number;
}

/**
 * The bucket an instant falls in, aligned the way the server aligns it.
 *
 * `Math.floor` where the SQL truncates: the two agree for every instant after
 * the epoch, and this dashboard has no way to ask about one before it.
 */
export function bucketStartOf(ms: number, bucketMs: number, offsetMinutes: number): number {
  const offsetMs = offsetMinutes * 60_000;
  return Math.floor((ms + offsetMs) / bucketMs) * bucketMs - offsetMs;
}

/** Every bucket start in `[fromMs, toMs)`, including the ones with no data. */
export function bucketGrid(
  fromMs: number,
  toMs: number,
  bucketMs: number,
  offsetMinutes: number,
): number[] {
  if (bucketMs <= 0 || toMs <= fromMs) return [];

  const grid: number[] = [];
  let cursor = bucketStartOf(fromMs, bucketMs, offsetMinutes);
  while (cursor < toMs && grid.length < MAX_GRID_POINTS) {
    grid.push(cursor);
    cursor += bucketMs;
  }
  return grid;
}

/**
 * The bands a response gets, heaviest first, with anyone past the palette
 * folded into one neutral tail.
 */
function bandsOf(
  response: TimeseriesResponse,
  slots: ReadonlyMap<string, number>,
): { bands: Band[]; keyOf: Map<string, string> } {
  const overflowing = response.members.length > MAX_BANDS;
  const named = overflowing ? response.members.slice(0, MAX_BANDS - 1) : response.members;
  const folded = response.members.slice(named.length);

  const keyOf = new Map<string, string>();
  const bands: Band[] = named.map((member) => {
    keyOf.set(member.member_id, member.member_id);
    return {
      key: member.member_id,
      label: member.display_name,
      color: memberColor(member.member_id, slots),
      total: member.total_tokens,
      members: 1,
    };
  });

  if (folded.length > 0) {
    for (const member of folded) keyOf.set(member.member_id, OTHER_KEY);
    bands.push({
      key: OTHER_KEY,
      label: `${String(folded.length)} others`,
      color: OTHER_COLOR,
      total: folded.reduce((sum, member) => sum + member.total_tokens, 0),
      members: folded.length,
    });
  }

  return { bands, keyOf };
}

/** The stacked-area view of a timeseries response. */
export function buildSeries(
  response: TimeseriesResponse,
  slots: ReadonlyMap<string, number>,
): SeriesData {
  const { bands, keyOf } = bandsOf(response, slots);

  const byBucket = new Map<number, Map<string, number>>();
  for (const start of bucketGrid(
    response.range.from_ms,
    response.range.to_ms,
    response.bucket_ms,
    response.tz_offset_minutes,
  )) {
    byBucket.set(start, new Map());
  }

  for (const point of response.points) {
    // A point outside the regenerated grid would mean the server bucketed to a
    // boundary this did not predict. Keeping it is what stops that from
    // silently subtracting tokens from the chart.
    let bucket = byBucket.get(point.bucket_start);
    if (bucket === undefined) {
      bucket = new Map();
      byBucket.set(point.bucket_start, bucket);
    }
    const key = keyOf.get(point.member_id) ?? OTHER_KEY;
    bucket.set(key, (bucket.get(key) ?? 0) + point.total_tokens);
  }

  let total = 0;
  let peak: SeriesData['peak'] = null;

  const rows: SeriesRow[] = [...byBucket.keys()]
    .sort((a, b) => a - b)
    .map((start) => {
      const values = byBucket.get(start) ?? new Map<string, number>();
      const row: Record<string, number> = { bucket_start: start };
      let rowTotal = 0;
      for (const band of bands) {
        const value = values.get(band.key) ?? 0;
        row[band.key] = value;
        rowTotal += value;
      }
      row[TOTAL_KEY] = rowTotal;
      total += rowTotal;
      if (rowTotal > 0 && (peak === null || rowTotal > peak.total)) {
        peak = { bucket_start: start, total: rowTotal };
      }
      return row as SeriesRow;
    });

  return {
    bands,
    rows,
    total,
    peak,
    memberCount: response.members.filter((member) => member.total_tokens > 0).length,
  };
}

/** How a bucket width reads in a sentence: `daily`, `hourly`. */
export function bucketAdverb(bucket: BucketSize): string {
  return bucket === 'hour' ? 'hourly' : 'daily';
}

/**
 * What a screen reader is told instead of the picture.
 *
 * The shape of the data, not the shape of the chart: how much, over how long,
 * where the peak is, and who the bands are as percentages. A reader who cannot
 * see the stack still gets the two things it is for — the trend and the split.
 */
export function describeSeries(
  data: SeriesData,
  bucket: BucketSize,
  range: RangeInfo,
  noun = 'Stacked area chart',
): string {
  const span = `${formatBucketLabel(range.from_ms, 'day')} to ${formatBucketLabel(range.to_ms - 1, 'day')}`;

  if (data.total === 0) {
    return `${noun} of tokens per ${bucket}. No usage between ${span}.`;
  }

  const parts = [
    `${noun} of tokens per ${bucket}, ${span}.`,
    `${formatCount(data.total)} tokens in total across ${String(data.memberCount)} ${
      data.memberCount === 1 ? 'member' : 'members'
    }, in ${String(data.rows.length)} ${bucketAdverb(bucket)} buckets.`,
  ];

  if (data.peak !== null) {
    parts.push(
      `Busiest was ${formatBucketLabel(data.peak.bucket_start, bucket)} with ${formatCount(data.peak.total)} tokens.`,
    );
  }

  const split = data.bands
    .filter((band) => band.total > 0)
    .map((band) => `${band.label} ${formatPercent((band.total / data.total) * 100)}`)
    .join(', ');
  if (split !== '') parts.push(`Split: ${split}.`);

  return parts.join(' ');
}

/**
 * Per-bucket tokens for every member, on the same grid the stacked chart uses.
 *
 * Kept separate from `buildSeries` because the sparklines in the table need a
 * row for every member, including the ones the stack folded into its tail — the
 * table lists everybody, so a member being ninth by usage is no reason for
 * their row to lose its trend.
 *
 * Points are placed by grid position, so the arrays are all the same length and
 * the same length as the chart above them. The grid is regenerated from the
 * very response that carried the points, so a point can only fall outside it if
 * the server bucketed to a boundary its own `bucket_ms` does not describe.
 */
export function memberTrends(response: TimeseriesResponse): ReadonlyMap<string, number[]> {
  const grid = bucketGrid(
    response.range.from_ms,
    response.range.to_ms,
    response.bucket_ms,
    response.tz_offset_minutes,
  );

  const positionOf = new Map<number, number>();
  grid.forEach((start, position) => positionOf.set(start, position));

  const trends = new Map<string, number[]>();
  for (const member of response.members) {
    trends.set(
      member.member_id,
      grid.map(() => 0),
    );
  }

  for (const point of response.points) {
    const position = positionOf.get(point.bucket_start);
    if (position === undefined) continue;

    let trend = trends.get(point.member_id);
    if (trend === undefined) {
      trend = grid.map(() => 0);
      trends.set(point.member_id, trend);
    }
    trend[position] = (trend[position] ?? 0) + point.total_tokens;
  }

  return trends;
}

/** What a screen reader is told in place of one row's sparkline. */
export function describeTrend(name: string, values: readonly number[], bucket: BucketSize): string {
  if (values.length === 0 || values.every((value) => value === 0)) {
    return `${name}: no usage in this range.`;
  }
  const peak = values.reduce((highest, value) => Math.max(highest, value), 0);
  return (
    `${name}: ${bucketAdverb(bucket)} trend over ${String(values.length)} buckets, ` +
    `peaking at ${formatCount(peak)} tokens.`
  );
}
