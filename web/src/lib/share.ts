/**
 * Rounding a column of percentages so it still adds up.
 *
 * The server computes shares in SQL against the period total, so they sum to
 * 100 exactly. Rounding each one to a decimal place independently breaks that:
 * three members at 33.333% each are displayed as 33.3% and the column reads
 * 99.9%, which is the first thing anyone checking the dashboard against a bill
 * will notice.
 *
 * The fix is the largest-remainder method — floor everything, then hand the
 * leftover units to whoever lost the most in the flooring. Every displayed
 * value stays within one unit of its true value, and the column sums to exactly
 * what the underlying numbers sum to.
 */

/** Decimal places every share on the dashboard is shown to. */
export const SHARE_DECIMALS = 1;

/** Ten to the power of `decimals`, as an integer. */
function scaleFor(decimals: number): number {
  return 10 ** decimals;
}

/**
 * Rounds `values` to `decimals` places so their sum is preserved exactly.
 *
 * An all-zero column stays all zeros rather than having 100 distributed across
 * it: an empty range is the common case on a new install, and inventing shares
 * for members who used nothing would be the dashboard's first lie.
 */
export function roundSharesPreservingTotal(
  values: readonly number[],
  decimals: number = SHARE_DECIMALS,
): number[] {
  const scale = scaleFor(decimals);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length === 0 || total <= 0) return values.map(() => 0);

  const target = Math.round(total * scale);
  const floors = values.map((value) => Math.floor(value * scale));
  const distributed = floors.reduce((sum, floor) => sum + floor, 0);

  // Sorted by what each value lost to the floor, largest loss first. The index
  // breaks ties so the same input always produces the same output — a share
  // that moves between two rows on a re-render is a bug report waiting.
  const byRemainder = values
    .map((value, index) => ({ index, remainder: value * scale - (floors[index] ?? 0) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = [...floors];
  let owed = target - distributed;

  // `owed` is normally a small positive number of units. It can be negative
  // when floating-point noise pushes the sum the other way, and the fix is
  // symmetric: take units back from whoever gained the least.
  for (let step = 0; owed > 0 && step < byRemainder.length; step += 1) {
    const entry = byRemainder[step];
    if (entry === undefined) break;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    owed -= 1;
  }
  for (let step = byRemainder.length - 1; owed < 0 && step >= 0; step -= 1) {
    const entry = byRemainder[step];
    if (entry === undefined) break;
    result[entry.index] = (result[entry.index] ?? 0) - 1;
    owed += 1;
  }

  return result.map((units) => units / scale);
}
