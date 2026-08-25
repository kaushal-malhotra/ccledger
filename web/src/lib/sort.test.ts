/**
 * Column sorting, and the one rule that is easy to get wrong: a row with no
 * value stays at the bottom whichever way the arrow points.
 */

import { describe, expect, it } from 'vitest';

import { flipDirection, sortRows } from './sort.js';

/** A stand-in for a member row: a name, a number, and a nullable timestamp. */
interface Row {
  readonly name: string;
  readonly tokens: number;
  readonly lastSeen: number | null;
}

const ROWS: readonly Row[] = [
  { name: 'Carol', tokens: 100, lastSeen: null },
  { name: 'alice', tokens: 300, lastSeen: 20 },
  { name: 'Bob', tokens: 100, lastSeen: 10 },
];

/** The names of a sorted result, in order. */
function names(rows: readonly Row[]): string[] {
  return rows.map((row) => row.name);
}

describe('sortRows', () => {
  it('sorts numbers descending', () => {
    const sorted = sortRows(
      ROWS,
      (row) => row.tokens,
      'desc',
      (row) => row.name,
    );
    expect(names(sorted)).toEqual(['alice', 'Bob', 'Carol']);
  });

  it('breaks ties with the tiebreak accessor rather than input order', () => {
    const sorted = sortRows(
      ROWS,
      (row) => row.tokens,
      'asc',
      (row) => row.name,
    );
    // Bob and Carol both have 100; the name decides, case-insensitively.
    expect(names(sorted).slice(0, 2)).toEqual(['Bob', 'Carol']);
  });

  it('compares names without letting case decide', () => {
    const sorted = sortRows(
      ROWS,
      (row) => row.name,
      'asc',
      (row) => row.name,
    );
    expect(names(sorted)).toEqual(['alice', 'Bob', 'Carol']);
  });

  it('keeps a missing value last in both directions', () => {
    const ascending = sortRows(
      ROWS,
      (row) => row.lastSeen,
      'asc',
      (row) => row.name,
    );
    const descending = sortRows(
      ROWS,
      (row) => row.lastSeen,
      'desc',
      (row) => row.name,
    );

    expect(names(ascending).at(-1)).toBe('Carol');
    expect(names(descending).at(-1)).toBe('Carol');
    expect(names(ascending).slice(0, 2)).toEqual(['Bob', 'alice']);
    expect(names(descending).slice(0, 2)).toEqual(['alice', 'Bob']);
  });

  it('does not modify the array it was given', () => {
    const before = names(ROWS);
    sortRows(
      ROWS,
      (row) => row.tokens,
      'desc',
      (row) => row.name,
    );
    expect(names(ROWS)).toEqual(before);
  });
});

describe('flipDirection', () => {
  it('is its own inverse', () => {
    expect(flipDirection('asc')).toBe('desc');
    expect(flipDirection(flipDirection('asc'))).toBe('asc');
  });
});
