/**
 * Shaping a timeseries response into a stack.
 *
 * The assertion carrying stage 5's acceptance criterion is in the first block:
 * the per-bucket totals the chart draws have to add up to the same number the
 * member table prints. Everything else here defends one of the two ways that
 * can quietly stop being true — a bucket nobody used going missing, or the
 * folded tail losing the members it stands for.
 */

import { describe, expect, it } from 'vitest';

import type { TimeseriesResponse } from '../../../src/shared/api.js';

import { assignSlots } from './colors.js';
import {
  MAX_BANDS,
  OTHER_KEY,
  TOTAL_KEY,
  bucketGrid,
  bucketStartOf,
  buildSeries,
  describeSeries,
  describeTrend,
  memberTrends,
} from './series.js';

/** A day, in milliseconds. */
const DAY = 86_400_000;

/** A round UTC midnight to build ranges from. */
const START = Date.UTC(2026, 7, 20);

/** One member's bucket, as the endpoint would emit it. */
function point(bucket: number, memberId: string, tokens: number) {
  return {
    bucket_start: bucket,
    member_id: memberId,
    total_tokens: tokens,
    requests: 1,
    cost_micros: tokens,
  };
}

/** A response over `days` daily buckets from `START`, aligned to UTC. */
function response(options: {
  readonly days: number;
  readonly members: ReadonlyArray<{ id: string; name: string; total: number }>;
  readonly points: ReadonlyArray<ReturnType<typeof point>>;
}): TimeseriesResponse {
  const toMs = START + options.days * DAY;
  return {
    range: {
      from: new Date(START).toISOString(),
      to: new Date(toMs).toISOString(),
      from_ms: START,
      to_ms: toMs,
    },
    filter: { group: 'all', source: null },
    bucket: 'day',
    bucket_ms: DAY,
    tz_offset_minutes: 0,
    members: options.members.map((member) => ({
      member_id: member.id,
      display_name: member.name,
      total_tokens: member.total,
    })),
    points: options.points,
  };
}

/** Three members over three days, the shape the stage asks about. */
function threeMembers(): TimeseriesResponse {
  return response({
    days: 3,
    members: [
      { id: 'a', name: 'Alice', total: 600 },
      { id: 'b', name: 'Bob', total: 300 },
      { id: 'c', name: 'Cara', total: 100 },
    ],
    points: [
      point(START, 'a', 100),
      point(START, 'b', 50),
      point(START + DAY, 'a', 200),
      point(START + DAY, 'b', 250),
      point(START + DAY, 'c', 40),
      point(START + 2 * DAY, 'a', 300),
      point(START + 2 * DAY, 'c', 60),
    ],
  });
}

const NO_SLOTS = new Map<string, number>();

describe('buildSeries over three members', () => {
  it('gives each bucket a total equal to the members summed in it', () => {
    const data = buildSeries(threeMembers(), NO_SLOTS);

    expect(data.rows.map((row) => row[TOTAL_KEY])).toEqual([150, 490, 360]);
    for (const row of data.rows) {
      const banded = data.bands.reduce((sum, band) => sum + (row[band.key] ?? 0), 0);
      expect(row[TOTAL_KEY]).toBe(banded);
    }
  });

  it('adds the buckets up to what the member table shows', () => {
    const body = threeMembers();
    const data = buildSeries(body, NO_SLOTS);

    // The table's total, and the table's per-member rows.
    const tableTotal = body.members.reduce((sum, member) => sum + member.total_tokens, 0);
    expect(data.total).toBe(tableTotal);

    for (const member of body.members) {
      const banded = data.rows.reduce((sum, row) => sum + (row[member.member_id] ?? 0), 0);
      expect(banded).toBe(member.total_tokens);
    }
  });

  it('orders the bands heaviest first, so the largest sits on the baseline', () => {
    const data = buildSeries(threeMembers(), NO_SLOTS);
    expect(data.bands.map((band) => band.label)).toEqual(['Alice', 'Bob', 'Cara']);
  });

  it('names the busiest bucket', () => {
    const data = buildSeries(threeMembers(), NO_SLOTS);
    expect(data.peak).toEqual({ bucket_start: START + DAY, total: 490 });
  });

  it('gives every member a colour that is theirs in every chart', () => {
    const slots = assignSlots([
      { member_id: 'a', created_at: 1 },
      { member_id: 'b', created_at: 2 },
      { member_id: 'c', created_at: 3 },
    ]);
    const data = buildSeries(threeMembers(), slots);

    const colours = data.bands.map((band) => band.color);
    expect(new Set(colours).size).toBe(3);
    for (const colour of colours) expect(colour).toMatch(/^var\(--series-[1-8]\)$/);
  });
});

describe('buckets nobody used', () => {
  it('emits a zero rather than letting the line skip the day', () => {
    const body = response({
      days: 4,
      members: [{ id: 'a', name: 'Alice', total: 300 }],
      // Nothing on the second or third day.
      points: [point(START, 'a', 100), point(START + 3 * DAY, 'a', 200)],
    });
    const data = buildSeries(body, NO_SLOTS);

    expect(data.rows).toHaveLength(4);
    expect(data.rows.map((row) => row[TOTAL_KEY])).toEqual([100, 0, 0, 200]);
  });

  it('keeps a point the regenerated grid did not predict', () => {
    const body = response({
      days: 1,
      members: [{ id: 'a', name: 'Alice', total: 150 }],
      points: [point(START, 'a', 100), point(START + 5 * DAY, 'a', 50)],
    });
    const data = buildSeries(body, NO_SLOTS);

    // The stray bucket is kept and sorted into place, so nothing is subtracted
    // from the chart without saying so.
    expect(data.total).toBe(150);
    expect(data.rows.at(-1)?.bucket_start).toBe(START + 5 * DAY);
  });

  it('reports an empty range as empty rather than as a flat line of nothing', () => {
    const data = buildSeries(response({ days: 3, members: [], points: [] }), NO_SLOTS);

    expect(data.total).toBe(0);
    expect(data.peak).toBeNull();
    expect(data.bands).toEqual([]);
  });
});

describe('a team larger than the palette', () => {
  /** Nine members, descending, so the ninth is the one that gets folded. */
  function nine(): TimeseriesResponse {
    const members = Array.from({ length: 9 }, (_unused, index) => ({
      id: `m${String(index)}`,
      name: `Member ${String(index)}`,
      total: (9 - index) * 100,
    }));
    return response({
      days: 1,
      members,
      points: members.map((member) => point(START, member.id, member.total)),
    });
  }

  it('names the heaviest and sums the rest into one band', () => {
    const data = buildSeries(nine(), NO_SLOTS);

    expect(data.bands).toHaveLength(MAX_BANDS);
    const tail = data.bands.at(-1);
    expect(tail?.key).toBe(OTHER_KEY);
    expect(tail?.label).toBe('2 others');
    expect(tail?.members).toBe(2);
    // Members 7 and 8, at 200 and 100.
    expect(tail?.total).toBe(300);
  });

  it('folds without changing the height of the stack', () => {
    const body = nine();
    const data = buildSeries(body, NO_SLOTS);
    const tableTotal = body.members.reduce((sum, member) => sum + member.total_tokens, 0);

    expect(data.total).toBe(tableTotal);
    expect(data.rows[0]?.[TOTAL_KEY]).toBe(tableTotal);
  });

  it('leaves a team that exactly fits the palette unfolded', () => {
    const body = nine();
    const eight = { ...body, members: body.members.slice(0, MAX_BANDS) };
    const data = buildSeries(eight, NO_SLOTS);

    expect(data.bands).toHaveLength(MAX_BANDS);
    expect(data.bands.some((band) => band.key === OTHER_KEY)).toBe(false);
  });
});

describe('bucketStartOf', () => {
  it('floors to the bucket the server would have chosen', () => {
    expect(bucketStartOf(START + 3_600_000, DAY, 0)).toBe(START);
    expect(bucketStartOf(START, DAY, 0)).toBe(START);
  });

  it('aligns daily buckets to the viewer midnight, not to UTC', () => {
    // Five hours west: the local day begins at 05:00 UTC.
    const offset = -300;
    const local = bucketStartOf(START + 6 * 3_600_000, DAY, offset);
    expect(local).toBe(START + 5 * 3_600_000);
  });
});

describe('bucketGrid', () => {
  it('covers the half-open range without running past its end', () => {
    const grid = bucketGrid(START, START + 3 * DAY, DAY, 0);
    expect(grid).toEqual([START, START + DAY, START + 2 * DAY]);
  });

  it('is empty for a range that ends where it starts', () => {
    expect(bucketGrid(START, START, DAY, 0)).toEqual([]);
  });

  it('covers a partial bucket at each end', () => {
    const grid = bucketGrid(START + 1000, START + DAY + 1000, DAY, 0);
    expect(grid).toEqual([START, START + DAY]);
  });
});

describe('memberTrends', () => {
  it('gives every member one value per bucket, zeros included', () => {
    const trends = memberTrends(threeMembers());

    expect(trends.get('a')).toEqual([100, 200, 300]);
    expect(trends.get('b')).toEqual([50, 250, 0]);
    expect(trends.get('c')).toEqual([0, 40, 60]);
  });

  it('covers a member the stack folded into its tail', () => {
    const members = Array.from({ length: 9 }, (_unused, index) => ({
      id: `m${String(index)}`,
      name: `Member ${String(index)}`,
      total: 100,
    }));
    const trends = memberTrends(
      response({
        days: 1,
        members,
        points: members.map((member) => point(START, member.id, 100)),
      }),
    );

    expect(trends.size).toBe(9);
    expect(trends.get('m8')).toEqual([100]);
  });
});

describe('describeSeries', () => {
  it('says how much, over how long, where the peak is and who the bands are', () => {
    const body = threeMembers();
    const summary = describeSeries(buildSeries(body, NO_SLOTS), 'day', body.range);

    expect(summary).toContain('Stacked area chart');
    expect(summary).toContain('1,000 tokens');
    expect(summary).toContain('3 members');
    expect(summary).toContain('Alice 60.0%');
    expect(summary).toContain('Cara 10.0%');
  });

  it('separates thousands, so a screen reader does not read a digit run', () => {
    const body = response({
      days: 1,
      members: [{ id: 'a', name: 'Alice', total: 1_234_567 }],
      points: [point(START, 'a', 1_234_567)],
    });
    expect(describeSeries(buildSeries(body, NO_SLOTS), 'day', body.range)).toContain('1,234,567');
  });

  it('says an empty range is empty', () => {
    const body = response({ days: 3, members: [], points: [] });
    expect(describeSeries(buildSeries(body, NO_SLOTS), 'day', body.range)).toContain('No usage');
  });

  it('takes a different noun for a single member page', () => {
    const body = threeMembers();
    const summary = describeSeries(buildSeries(body, NO_SLOTS), 'day', body.range, 'Area chart');
    expect(summary.startsWith('Area chart')).toBe(true);
  });
});

describe('describeTrend', () => {
  it('names the member and their peak', () => {
    expect(describeTrend('Alice', [10, 4000, 30], 'day')).toBe(
      'Alice: daily trend over 3 buckets, peaking at 4,000 tokens.',
    );
  });

  it('says so when there is nothing to trend', () => {
    expect(describeTrend('Bob', [0, 0], 'hour')).toBe('Bob: no usage in this range.');
    expect(describeTrend('Bob', [], 'hour')).toBe('Bob: no usage in this range.');
  });
});
