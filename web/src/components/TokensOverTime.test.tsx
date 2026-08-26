/**
 * The stacked area, rendered.
 *
 * Recharts measures its own box, so a string render produces the frame and not
 * the ribbons — which is the right level for these assertions anyway. What has
 * to hold is what a reader who cannot see the ribbons gets: a summary carrying
 * the numbers, a legend naming every band, and the right one of the three
 * states. The geometry is Recharts' problem and is covered by the data tests in
 * `lib/series.test.ts`.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimeseriesResponse } from '../../../src/shared/api.js';
import { assignSlots } from '../lib/colors.js';

import { TokensOverTime } from './TokensOverTime.js';

/** A day, in milliseconds. */
const DAY = 86_400_000;

/** A round UTC midnight to build ranges from. */
const START = Date.UTC(2026, 7, 20);

/** Three members over three days, aligned to UTC so buckets are predictable. */
function threeMembers(): TimeseriesResponse {
  return {
    range: {
      from: new Date(START).toISOString(),
      to: new Date(START + 3 * DAY).toISOString(),
      from_ms: START,
      to_ms: START + 3 * DAY,
    },
    filter: { group: 'all', source: null },
    bucket: 'day',
    bucket_ms: DAY,
    tz_offset_minutes: 0,
    members: [
      { member_id: 'a', display_name: 'Alice', total_tokens: 600 },
      { member_id: 'b', display_name: 'Bob', total_tokens: 300 },
      { member_id: 'c', display_name: 'Cara', total_tokens: 100 },
    ],
    points: [
      { bucket_start: START, member_id: 'a', total_tokens: 600, requests: 3, cost_micros: 6 },
      { bucket_start: START + DAY, member_id: 'b', total_tokens: 300, requests: 2, cost_micros: 3 },
      {
        bucket_start: START + 2 * DAY,
        member_id: 'c',
        total_tokens: 100,
        requests: 1,
        cost_micros: 1,
      },
    ],
  };
}

const SLOTS = assignSlots([
  { member_id: 'a', created_at: 1 },
  { member_id: 'b', created_at: 2 },
  { member_id: 'c', created_at: 3 },
]);

/** Renders the chart over a response. */
function render(response: TimeseriesResponse | null, loading = false): string {
  return renderToStaticMarkup(
    <TokensOverTime response={response} slots={SLOTS} loading={loading} />,
  );
}

describe('TokensOverTime', () => {
  it('summarises the chart in text, with separated thousands', () => {
    const markup = render(threeMembers());

    expect(markup).toContain('role="img"');
    expect(markup).toContain('Stacked area chart of tokens per day');
    expect(markup).toContain('1,000 tokens in total across 3 members');
    expect(markup).toContain('Alice 60.0%');
  });

  it('shows a legend naming every band, so colour is never the only signal', () => {
    const markup = render(threeMembers());

    for (const name of ['Alice', 'Bob', 'Cara']) expect(markup).toContain(name);
    expect(markup).toContain('aria-label="Members in this chart"');
    // Each band's own total is beside its name, not only in the picture.
    expect(markup).toContain('600');
  });

  it('gives each member a different palette slot', () => {
    const markup = render(threeMembers());
    const used = new Set(markup.match(/--series-\d/g) ?? []);
    expect(used.size).toBeGreaterThanOrEqual(3);
  });

  it('says which bucket width the server chose', () => {
    expect(render(threeMembers())).toContain('daily buckets');

    const hourly: TimeseriesResponse = { ...threeMembers(), bucket: 'hour', bucket_ms: 3_600_000 };
    expect(render(hourly)).toContain('hourly buckets');
  });

  it('draws a skeleton before the first response, not a spinner', () => {
    const markup = render(null, true);
    expect(markup).toContain('skeleton');
    expect(markup).not.toContain('recharts');
  });

  it('has its own empty state when the range holds nothing', () => {
    const empty: TimeseriesResponse = { ...threeMembers(), members: [], points: [] };
    const markup = render(empty);

    // The note is ordinary text rather than a summary on an empty picture, so
    // it is what a screen reader is given as well as what a reader sees.
    expect(markup).toContain('Nobody reported any tokens in this range.');
    expect(markup).not.toContain('role="img"');
    expect(markup).not.toContain('recharts');
  });

  it('narrows to one member for their own page', () => {
    const markup = renderToStaticMarkup(
      <TokensOverTime
        response={threeMembers()}
        slots={SLOTS}
        loading={false}
        only="b"
        title="Bob over time"
      />,
    );

    expect(markup).toContain('Bob over time');
    expect(markup).toContain('Area chart of tokens per day');
    expect(markup).toContain('Bob 100.0%');
    expect(markup).not.toContain('Alice');
  });

  it('tells a member with nothing in the range that it is theirs that is empty', () => {
    const markup = renderToStaticMarkup(
      <TokensOverTime response={threeMembers()} slots={SLOTS} loading={false} only="nobody" />,
    );
    expect(markup).toContain('This member reported no tokens in this range.');
  });
});
