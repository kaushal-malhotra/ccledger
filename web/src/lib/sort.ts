/**
 * Sorting a table column.
 *
 * One rule worth stating: a missing value sorts last in both directions.
 * "Never seen" is not a very small date and not a very large one — it is the
 * absence of a date, and a member who has never reported should not head the
 * table just because the column was clicked twice.
 */

/** Which way a column is sorted. */
export type SortDirection = 'asc' | 'desc';

/** The kinds of value a column can hold. `null` means the row has none. */
export type SortValue = number | string | null;

/** Reads the sortable value out of a row. */
export type SortAccessor<T> = (row: T) => SortValue;

/** The other direction. */
export function flipDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

/** Compares two values of the same column, ascending, with nulls last. */
function compareValues(a: SortValue, b: SortValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a).localeCompare(String(b), 'en-US', { sensitivity: 'base' });
  }
  return a - b;
}

/**
 * A sorted copy of `rows`. Stable, and stabilised further by `tiebreak`, so two
 * members with identical numbers keep a fixed order between renders rather than
 * swapping places whenever the data is refetched.
 */
export function sortRows<T>(
  rows: readonly T[],
  accessor: SortAccessor<T>,
  direction: SortDirection,
  tiebreak: SortAccessor<T>,
): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compareValues(accessor(a), accessor(b));
    // Nulls stay last whichever way the column points, so the direction is
    // applied to the comparison of two present values and nothing else.
    if (primary !== 0) {
      const aMissing = accessor(a) === null;
      const bMissing = accessor(b) === null;
      if (aMissing !== bMissing) return primary;
      return sign * primary;
    }
    return compareValues(tiebreak(a), tiebreak(b));
  });
}
