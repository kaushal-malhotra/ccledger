import type { JSX } from 'react';
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { BucketSize, TimeseriesResponse } from '../../../src/shared/api.js';
import { formatBucketFull, formatBucketLabel, formatCompact, formatCount } from '../lib/format.js';
import type { SeriesData } from '../lib/series.js';
import { TOTAL_KEY, bucketAdverb, buildSeries, describeSeries } from '../lib/series.js';

import { ChartCard } from './ChartCard.js';
import type { LegendEntry } from './ChartLegend.js';

/** What the timeseries chart reads. */
export interface TokensOverTimeProps {
  /** `null` until the first response lands. */
  readonly response: TimeseriesResponse | null;
  /** Member id to palette slot, from the enrolment list. */
  readonly slots: ReadonlyMap<string, number>;
  readonly loading: boolean;
  /**
   * Narrows the chart to one member, for their detail page. The team response
   * is reused rather than refetched: `/api/timeseries` reports every member's
   * buckets in one body, so a member's own series is already in hand.
   */
  readonly only?: string | undefined;
  readonly title?: string | undefined;
}

/** Plot height, x-axis band included, so the card never scrolls inside itself. */
const PLOT_HEIGHT = 260;

/** About how many x-axis labels fit before they start colliding. */
const TARGET_TICKS = 8;

/**
 * Room on the right for the last x-axis label. The final bucket sits on the
 * plot's right edge and its label is centred on it, so without an overhang the
 * date the range ends on is the one that gets its tail clipped.
 */
const LABEL_OVERHANG = 26;

/**
 * How many buckets to skip between labels. Recharts counts the gap rather than
 * the labels, so `0` means every bucket gets one.
 */
function tickInterval(bucketCount: number): number {
  if (bucketCount <= TARGET_TICKS) return 0;
  return Math.ceil(bucketCount / TARGET_TICKS) - 1;
}

/**
 * The readout under the crosshair.
 *
 * Every band at that bucket, not just the one the pointer happens to be over —
 * a stacked area is read by comparing bands, and making the reader hit a
 * particular ribbon to see its number defeats that. Bands sitting at zero are
 * left out: a team of eight where two people worked that hour should show two
 * rows, not six zeroes and two numbers.
 */
function StackTooltip(props: {
  readonly active: boolean;
  readonly label: string | number | undefined;
  readonly data: SeriesData;
  readonly bucket: BucketSize;
}): JSX.Element | null {
  if (!props.active || props.label === undefined) return null;

  const bucketStart = Number(props.label);
  const row = props.data.rows.find((entry) => entry.bucket_start === bucketStart);
  if (row === undefined) return null;

  // Reversed, so the list runs top-to-bottom in the order the bands are drawn.
  const items = props.data.bands
    .map((band) => ({ band, value: row[band.key] ?? 0 }))
    .filter((entry) => entry.value > 0)
    .reverse();

  return (
    <div className="tip">
      <div className="tip-head">{formatBucketFull(bucketStart, props.bucket)}</div>
      {items.length === 0 ? (
        <div className="tip-none">No usage</div>
      ) : (
        <>
          <ul className="tip-rows">
            {items.map((entry) => (
              <li key={entry.band.key}>
                <span
                  className="tip-key"
                  style={{ background: entry.band.color }}
                  aria-hidden="true"
                />
                <span className="tip-label">{entry.band.label}</span>
                <span className="tip-value">{formatCount(entry.value)}</span>
              </li>
            ))}
          </ul>
          <div className="tip-total">
            <span className="tip-label">Total</span>
            <span className="tip-value">{formatCount(row[TOTAL_KEY] ?? 0)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Tokens over time, one band per member.
 *
 * The bucket width is the server's choice, not this component's — `/api/timeseries`
 * picks hours for a range under three days and days above it, and the response
 * says which it used. Asking for one here would put the same heuristic in two
 * places and let them disagree.
 *
 * The bands are stacked heaviest-first so the largest sits on the baseline,
 * where its shape is readable, and the smaller ones ride on top. Each carries a
 * two-pixel stroke in the surface colour, which is what separates one band from
 * the next: a stack drawn as touching fills needs the gap between them to be
 * negative space rather than an outline, or every band gains a border that
 * reads as data.
 */
export function TokensOverTime({
  response,
  slots,
  loading,
  only,
  title,
}: TokensOverTimeProps): JSX.Element {
  const data = useMemo(() => {
    if (response === null) return null;
    if (only === undefined) return buildSeries(response, slots);
    return buildSeries(
      {
        ...response,
        members: response.members.filter((member) => member.member_id === only),
        points: response.points.filter((point) => point.member_id === only),
      },
      slots,
    );
  }, [response, slots, only]);

  const legend = useMemo<LegendEntry[]>(
    () =>
      data === null
        ? []
        : data.bands.map((band) => ({
            key: band.key,
            label: band.label,
            color: band.color,
            value: formatCount(band.total),
          })),
    [data],
  );

  const bucket: BucketSize = response?.bucket ?? 'day';
  const summary =
    data === null || response === null
      ? ''
      : describeSeries(
          data,
          bucket,
          response.range,
          only === undefined ? 'Stacked area chart' : 'Area chart',
        );

  return (
    <ChartCard
      title={title ?? 'Tokens over time'}
      note={response === null ? undefined : `${bucketAdverb(bucket)} buckets`}
      summary={summary}
      legend={legend}
      legendLabel="Members in this chart"
      loading={loading && data === null}
      stale={loading && data !== null}
      empty={data !== null && data.total === 0}
      emptyNote={
        only === undefined
          ? 'Nobody reported any tokens in this range.'
          : 'This member reported no tokens in this range.'
      }
      height={PLOT_HEIGHT}
    >
      {data !== null && (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data.rows}
            margin={{ top: 8, right: LABEL_OVERHANG, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis
              dataKey="bucket_start"
              interval={tickInterval(data.rows.length)}
              tickFormatter={(value: string | number) => formatBucketLabel(Number(value), bucket)}
              tick={{ fill: 'var(--ink-faint)', fontSize: 12 }}
              stroke="var(--line-strong)"
              tickLine={false}
              minTickGap={8}
            />
            <YAxis
              width={56}
              tickFormatter={(value: string | number) => formatCompact(Number(value))}
              tick={{ fill: 'var(--ink-faint)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }}
              isAnimationActive={false}
              content={(tooltip) => (
                <StackTooltip
                  active={tooltip.active}
                  label={tooltip.label}
                  data={data}
                  bucket={bucket}
                />
              )}
            />
            {data.bands.map((band) => (
              <Area
                key={band.key}
                dataKey={band.key}
                name={band.label}
                stackId="tokens"
                // Straight segments between buckets. A smoothed curve would
                // invent values between two hours that nothing was measured at,
                // and can bulge below zero on the way into a quiet bucket.
                type="linear"
                fill={band.color}
                fillOpacity={0.9}
                stroke="var(--surface)"
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
