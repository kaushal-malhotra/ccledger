/**
 * The share column has to add up. Stage 4's acceptance criterion is that the
 * table shows shares summing to 100%, and the shares the server sends already
 * do — this is the rounding that could take that away again.
 */

import { describe, expect, it } from 'vitest';

import { roundSharesPreservingTotal } from './share.js';

/** Sums a list, to a precision a decimal place cannot hide behind. */
function sum(values: readonly number[]): number {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(10));
}

describe('roundSharesPreservingTotal', () => {
  it('keeps thirds adding up to exactly 100', () => {
    const rounded = roundSharesPreservingTotal([100 / 3, 100 / 3, 100 / 3]);

    expect(sum(rounded)).toBe(100);
    // Every displayed value is within one unit of the true one.
    for (const value of rounded) expect(Math.abs(value - 100 / 3)).toBeLessThanOrEqual(0.1);
  });

  it('leaves values that already round cleanly alone', () => {
    expect(roundSharesPreservingTotal([75, 25])).toEqual([75, 25]);
  });

  it('preserves the total across many small shares', () => {
    const values = Array.from({ length: 17 }, () => 100 / 17);
    expect(sum(roundSharesPreservingTotal(values))).toBe(100);
  });

  it('gives the leftover to whoever lost the most in the flooring', () => {
    // Flooring to a tenth loses 0.04 from the first, nothing from the second
    // and 0.06 from the third, so the one leftover tenth goes to the third —
    // which is also the only row the difference is visible on.
    const rounded = roundSharesPreservingTotal([99.04, 0.9, 0.06]);

    expect(sum(rounded)).toBe(100);
    expect(rounded).toEqual([99, 0.9, 0.1]);
  });

  it('resolves a tie by position, so the heaviest row absorbs it', () => {
    // Three exact thirds all lose the same amount, and the table is ordered
    // heaviest first, so the extra tenth lands on the row where it matters
    // least — and lands there every time.
    expect(roundSharesPreservingTotal([100 / 3, 100 / 3, 100 / 3])).toEqual([33.4, 33.3, 33.3]);
  });

  it('leaves an empty range at zero rather than inventing a hundred percent', () => {
    expect(roundSharesPreservingTotal([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('handles no rows at all', () => {
    expect(roundSharesPreservingTotal([])).toEqual([]);
  });

  it('is deterministic when two values tie', () => {
    const values = [100 / 3, 100 / 3, 100 / 3];
    expect(roundSharesPreservingTotal(values)).toEqual(roundSharesPreservingTotal(values));
  });

  it('honours a different number of decimals', () => {
    const rounded = roundSharesPreservingTotal([100 / 3, 100 / 3, 100 / 3], 2);

    expect(sum(rounded)).toBe(100);
    for (const value of rounded) expect(Math.abs(value - 100 / 3)).toBeLessThanOrEqual(0.01);
  });
});
