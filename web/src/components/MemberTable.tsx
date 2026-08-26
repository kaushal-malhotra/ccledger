import type { JSX, ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { AlertState, BucketSize, MemberUsage, UsageTotals } from '../../../src/shared/api.js';
import { badgeLabel, badgeTitle } from '../lib/alerts.js';
import { memberColor } from '../lib/colors.js';
import { formatCostMicros, formatCount, formatPercent } from '../lib/format.js';
import { describeTrend } from '../lib/series.js';
import { roundSharesPreservingTotal } from '../lib/share.js';
import type { SortDirection, SortValue } from '../lib/sort.js';
import { flipDirection, sortRows } from '../lib/sort.js';

import { Est } from './Est.js';
import { Sparkline } from './Sparkline.js';

/** What the table renders. */
export interface MemberTableProps {
  readonly members: readonly MemberUsage[];
  readonly totals: UsageTotals;
  readonly loading: boolean;
  /** Per-member tokens per bucket, for the trend column. */
  readonly trends: ReadonlyMap<string, number[]>;
  /** The bucket the trends are in, so their descriptions can say so. */
  readonly bucket: BucketSize;
  /** Member id to palette slot, so a row's swatch matches its band. */
  readonly slots: ReadonlyMap<string, number>;
  /**
   * Members currently over an alert threshold, keyed by member id.
   *
   * Deliberately not scoped to the range this table is showing: an alert is
   * about the current day or week, and a badge that appeared and disappeared as
   * someone moved the date picker would be one nobody could act on. The title
   * on each badge says so.
   */
  readonly alerts: ReadonlyMap<string, readonly AlertState[]>;
  /** The zone alert windows are aligned to, for the badge's tooltip. */
  readonly timezone: string;
  /** Opens a member's detail page. */
  readonly onSelect: (memberId: string) => void;
}

/** A member row with the share the table will actually print. */
interface Row extends MemberUsage {
  /** Rounded across the whole table so the column sums to exactly 100. */
  readonly display_share: number;
  /** Tokens per bucket over the range. Empty when the range holds none. */
  readonly trend: readonly number[];
  /** This member's band colour, as a `var(--series-n)` reference. */
  readonly color: string;
  /** Alert thresholds this member is currently over. Usually empty. */
  readonly alerts: readonly AlertState[];
}

/** One column: how it sorts, how it renders, and what it totals to. */
interface Column {
  readonly key: string;
  readonly label: ReactNode;
  /** Expanded meaning, for the header's tooltip. */
  readonly title?: string;
  readonly numeric: boolean;
  /** Absent on a column there is no useful order for. */
  readonly sortValue?: (row: Row) => SortValue;
  readonly cell: (row: Row) => ReactNode;
  readonly foot: (totals: UsageTotals, shareTotal: number) => ReactNode;
}

/** What the column factory needs that a row does not carry. */
interface ColumnContext {
  readonly bucket: BucketSize;
  readonly timezone: string;
  readonly onSelect: (memberId: string) => void;
}

/** Rows drawn while the first response is still in flight. */
const SKELETON_ROWS = 3;

/** The column the table opens on, per the stage brief. */
const DEFAULT_SORT = 'share';

/** The share bar and the number that names it. */
function ShareCell({ share }: { readonly share: number }): JSX.Element {
  return (
    <span className="share-inner">
      <span className="share-track" aria-hidden="true">
        <span className="share-bar" style={{ width: `${String(Math.max(share, 0))}%` }} />
      </span>
      <span className="share-value">{formatPercent(share)}</span>
    </span>
  );
}

/** A plain right-aligned count, with its own header and footer behaviour. */
function countColumn(
  key: string,
  label: string,
  title: string,
  pick: (row: MemberUsage) => number,
  pickTotal: (totals: UsageTotals) => number,
): Column {
  return {
    key,
    label,
    title,
    numeric: true,
    sortValue: pick,
    cell: (row) => formatCount(pick(row)),
    foot: (totals) => formatCount(pickTotal(totals)),
  };
}

/** Every column, left to right. */
function columnsFor(context: ColumnContext): Column[] {
  return [
    {
      key: 'name',
      label: 'Member',
      numeric: false,
      sortValue: (row) => row.display_name,
      cell: (row) => (
        <span className="member-cell">
          {/* The same colour as this member's band in the chart above, so the
              table doubles as a second legend and a reader can get from a
              ribbon to its numbers without holding a hue in their head. */}
          <span className="legend-swatch" style={{ background: row.color }} aria-hidden="true" />
          <button
            type="button"
            className="link-button member-name"
            onClick={() => {
              context.onSelect(row.member_id);
            }}
          >
            {row.display_name}
          </button>
          {row.revoked_at !== null && (
            <>
              {' '}
              <span className="badge badge-revoked">revoked</span>
            </>
          )}
          {row.alerts.map((state) => (
            <span
              key={state.rule_id}
              className="badge badge-alert"
              title={badgeTitle(state, context.timezone)}
            >
              {badgeLabel(state)}
            </span>
          ))}
        </span>
      ),
      foot: () => 'Total',
    },
    {
      key: DEFAULT_SORT,
      label: 'Share',
      title: 'Percentage of the tokens this range holds, across everyone.',
      numeric: true,
      sortValue: (row) => row.share_pct,
      cell: (row) => <ShareCell share={row.display_share} />,
      // The sum of what the rows print, not a recomputed 100: if rounding ever
      // stopped preserving the total, this is where it would show.
      foot: (_totals, shareTotal) => formatPercent(shareTotal),
    },
    countColumn(
      'total',
      'Tokens',
      'Input, output, cache reads and cache writes added together.',
      (row) => row.total_tokens,
      (totals) => totals.total_tokens,
    ),
    {
      key: 'trend',
      label: 'Trend',
      title: 'This member across the range, each sparkline scaled to its own peak.',
      numeric: false,
      // No order a reader would agree on: a sparkline is a shape, and sorting
      // by its last bucket or its peak would look like sorting by the picture.
      cell: (row) => (
        <Sparkline
          values={row.trend}
          color={row.color}
          label={describeTrend(row.display_name, row.trend, context.bucket)}
        />
      ),
      foot: () => '',
    },
    countColumn(
      'input',
      'In',
      'Input tokens.',
      (row) => row.input_tokens,
      (totals) => totals.input_tokens,
    ),
    countColumn(
      'output',
      'Out',
      'Output tokens.',
      (row) => row.output_tokens,
      (totals) => totals.output_tokens,
    ),
    countColumn(
      'cache_read',
      'Cache read',
      'Tokens read from the prompt cache. Cheap, but still tokens.',
      (row) => row.cache_read_tokens,
      (totals) => totals.cache_read_tokens,
    ),
    countColumn(
      'cache_write',
      'Cache write',
      'Tokens written into the prompt cache.',
      (row) => row.cache_creation_tokens,
      (totals) => totals.cache_creation_tokens,
    ),
    countColumn(
      'requests',
      'Requests',
      'API calls Claude Code reported.',
      (row) => row.requests,
      (totals) => totals.requests,
    ),
    countColumn(
      'sessions',
      'Sessions',
      'Distinct Claude Code sessions.',
      (row) => row.sessions,
      (totals) => totals.sessions,
    ),
    {
      key: 'cost',
      label: <>Cost, {<Est />}</>,
      numeric: true,
      sortValue: (row) => row.cost_micros,
      cell: (row) => formatCostMicros(row.cost_micros),
      foot: (totals) => formatCostMicros(totals.cost_micros),
    },
  ];
}

/** `aria-sort`'s spelling of a direction. */
function ariaSort(direction: SortDirection): 'ascending' | 'descending' {
  return direction === 'asc' ? 'ascending' : 'descending';
}

/**
 * Per-member usage, sortable, heaviest share first.
 *
 * The shares are rounded once for the whole table before anything is sorted, so
 * the column adds up to 100.0 and keeps adding up to 100.0 whichever column the
 * reader clicks. The footer prints the sum of what the rows actually show
 * rather than a hard-coded total, which makes the invariant visible instead of
 * assumed.
 */
export function MemberTable({
  members,
  totals,
  loading,
  trends,
  bucket,
  slots,
  alerts,
  timezone,
  onSelect,
}: MemberTableProps): JSX.Element {
  const [sortKey, setSortKey] = useState<string>(DEFAULT_SORT);
  const [direction, setDirection] = useState<SortDirection>('desc');

  const columns = useMemo(
    () => columnsFor({ bucket, timezone, onSelect }),
    [bucket, timezone, onSelect],
  );

  const rows = useMemo<Row[]>(() => {
    const shares = roundSharesPreservingTotal(members.map((member) => member.share_pct));
    return members.map((member, index) => ({
      ...member,
      display_share: shares[index] ?? 0,
      trend: trends.get(member.member_id) ?? [],
      color: memberColor(member.member_id, slots),
      alerts: alerts.get(member.member_id) ?? [],
    }));
  }, [members, trends, slots, alerts]);

  const shareTotal = useMemo(
    () => Number(rows.reduce((sum, row) => sum + row.display_share, 0).toFixed(6)),
    [rows],
  );

  const column = columns.find((entry) => entry.key === sortKey) ?? columns[0];
  const sorted = useMemo(() => {
    const sortValue = column?.sortValue;
    if (sortValue === undefined) return rows;
    return sortRows(rows, sortValue, direction, (row) => row.display_name);
  }, [rows, column, direction]);

  function toggle(key: string): void {
    if (key === sortKey) {
      setDirection(flipDirection(direction));
      return;
    }
    setSortKey(key);
    // A newly chosen column opens on its most interesting end: largest first
    // for a number, A-to-Z for a name.
    setDirection(columns.find((entry) => entry.key === key)?.numeric === false ? 'asc' : 'desc');
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((entry) => {
              const active = entry.key === sortKey;
              return (
                <th
                  key={entry.key}
                  scope="col"
                  className={entry.numeric ? 'num' : undefined}
                  {...(active && entry.sortValue !== undefined
                    ? { 'aria-sort': ariaSort(direction) }
                    : {})}
                >
                  {entry.sortValue === undefined ? (
                    <span className="th-inner" title={entry.title}>
                      {entry.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        toggle(entry.key);
                      }}
                      title={entry.title}
                    >
                      {entry.label}
                      <span className="sort-arrow" aria-hidden="true">
                        {active ? (direction === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {loading && rows.length === 0
            ? Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
                <tr key={`skeleton-${String(index)}`}>
                  {columns.map((entry) => (
                    <td key={entry.key} className={entry.numeric ? 'num' : undefined}>
                      <span className="skeleton">0,000,000</span>
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row) => (
                <tr key={row.member_id}>
                  {columns.map((entry) => (
                    <td
                      key={entry.key}
                      className={
                        entry.key === DEFAULT_SORT
                          ? 'num share-cell'
                          : entry.numeric
                            ? 'num'
                            : undefined
                      }
                    >
                      {entry.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>

        {rows.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((entry) => (
                <td key={entry.key} className={entry.numeric ? 'num' : undefined}>
                  {entry.foot(totals, shareTotal)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
