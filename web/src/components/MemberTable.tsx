import type { JSX, ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { MemberUsage, UsageTotals } from '../../../src/shared/api.js';
import { formatCostMicros, formatCount, formatPercent } from '../lib/format.js';
import { roundSharesPreservingTotal } from '../lib/share.js';
import type { SortDirection, SortValue } from '../lib/sort.js';
import { flipDirection, sortRows } from '../lib/sort.js';

import { Est } from './Est.js';

/** What the table renders. */
export interface MemberTableProps {
  readonly members: readonly MemberUsage[];
  readonly totals: UsageTotals;
  readonly loading: boolean;
}

/** A member row with the share the table will actually print. */
interface Row extends MemberUsage {
  /** Rounded across the whole table so the column sums to exactly 100. */
  readonly display_share: number;
}

/** One column: how it sorts, how it renders, and what it totals to. */
interface Column {
  readonly key: string;
  readonly label: ReactNode;
  /** Expanded meaning, for the header's tooltip. */
  readonly title?: string;
  readonly numeric: boolean;
  readonly sortValue: (row: Row) => SortValue;
  readonly cell: (row: Row) => ReactNode;
  readonly foot: (totals: UsageTotals, shareTotal: number) => ReactNode;
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
const COLUMNS: readonly Column[] = [
  {
    key: 'name',
    label: 'Member',
    numeric: false,
    sortValue: (row) => row.display_name,
    cell: (row) => (
      <>
        <span className="member-name">{row.display_name}</span>
        {row.revoked_at !== null && (
          <>
            {' '}
            <span className="badge badge-revoked">revoked</span>
          </>
        )}
      </>
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
export function MemberTable({ members, totals, loading }: MemberTableProps): JSX.Element {
  const [sortKey, setSortKey] = useState<string>(DEFAULT_SORT);
  const [direction, setDirection] = useState<SortDirection>('desc');

  const rows = useMemo<Row[]>(() => {
    const shares = roundSharesPreservingTotal(members.map((member) => member.share_pct));
    return members.map((member, index) => ({
      ...member,
      display_share: shares[index] ?? 0,
    }));
  }, [members]);

  const shareTotal = useMemo(
    () => Number(rows.reduce((sum, row) => sum + row.display_share, 0).toFixed(6)),
    [rows],
  );

  const column = COLUMNS.find((entry) => entry.key === sortKey) ?? COLUMNS[0];
  const sorted = useMemo(
    () =>
      column === undefined
        ? rows
        : sortRows(rows, column.sortValue, direction, (row) => row.display_name),
    [rows, column, direction],
  );

  function toggle(key: string): void {
    if (key === sortKey) {
      setDirection(flipDirection(direction));
      return;
    }
    setSortKey(key);
    // A newly chosen column opens on its most interesting end: largest first
    // for a number, A-to-Z for a name.
    setDirection(COLUMNS.find((entry) => entry.key === key)?.numeric === false ? 'asc' : 'desc');
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {COLUMNS.map((entry) => {
              const active = entry.key === sortKey;
              return (
                <th
                  key={entry.key}
                  scope="col"
                  className={entry.numeric ? 'num' : undefined}
                  {...(active ? { 'aria-sort': ariaSort(direction) } : {})}
                >
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
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {loading && rows.length === 0
            ? Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
                <tr key={`skeleton-${String(index)}`}>
                  {COLUMNS.map((entry) => (
                    <td key={entry.key} className={entry.numeric ? 'num' : undefined}>
                      <span className="skeleton">0,000,000</span>
                    </td>
                  ))}
                </tr>
              ))
            : sorted.map((row) => (
                <tr key={row.member_id}>
                  {COLUMNS.map((entry) => (
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
              {COLUMNS.map((entry) => (
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
