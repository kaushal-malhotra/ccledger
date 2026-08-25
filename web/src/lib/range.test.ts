/**
 * Range arithmetic, asserted structurally.
 *
 * These tests deliberately never name an absolute instant. The whole point of
 * this module is that its answers depend on the viewer's timezone, so a test
 * that pinned one would either encode the machine that wrote it or prove
 * nothing. What is asserted instead is the shape: a preset begins at a local
 * midnight, spans a whole number of local days, and covers the days a person
 * asking for it would say it covers.
 */

import { describe, expect, it } from 'vitest';

import {
  customRange,
  localDaysAgo,
  presetRange,
  startOfLocalDay,
  toDateInputValue,
  toQueryParams,
  tzOffsetMinutes,
} from './range.js';

/** An arbitrary afternoon, so a preset's `from` is visibly not `now`. */
const NOW = new Date(2026, 7, 20, 14, 37, 12, 500).getTime();

/** True when `ms` is midnight in the local zone. */
function isLocalMidnight(ms: number): boolean {
  const date = new Date(ms);
  return (
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0
  );
}

/** Local calendar days a half-open range touches. */
function daysCovered(from: number, to: number): number {
  let days = 0;
  for (let day = startOfLocalDay(from); day < to; day = localDaysAgo(day, -1)) days += 1;
  return days;
}

describe('startOfLocalDay', () => {
  it('lands on local midnight and stays there', () => {
    const midnight = startOfLocalDay(NOW);
    expect(isLocalMidnight(midnight)).toBe(true);
    expect(startOfLocalDay(midnight)).toBe(midnight);
  });

  it('never moves an instant forward', () => {
    expect(startOfLocalDay(NOW)).toBeLessThanOrEqual(NOW);
  });
});

describe('localDaysAgo', () => {
  it('counts local days rather than fixed blocks of milliseconds', () => {
    // A day is 23, 24 or 25 hours depending on the daylight-saving rules where
    // the viewer is, so this asserts the count, not the arithmetic.
    const sevenBack = localDaysAgo(NOW, 7);
    expect(isLocalMidnight(sevenBack)).toBe(true);
    expect(daysCovered(sevenBack, startOfLocalDay(NOW))).toBe(7);
  });
});

describe('presetRange', () => {
  it('starts today at this morning s midnight and ends now', () => {
    const range = presetRange('today', NOW);
    expect(range.from).toBe(startOfLocalDay(NOW));
    expect(range.to).toBe(NOW);
    expect(daysCovered(range.from, range.to)).toBe(1);
  });

  it('covers seven local days including today', () => {
    const range = presetRange('7d', NOW);
    expect(isLocalMidnight(range.from)).toBe(true);
    expect(daysCovered(range.from, range.to)).toBe(7);
  });

  it('covers thirty local days including today', () => {
    expect(daysCovered(presetRange('30d', NOW).from, NOW)).toBe(30);
  });
});

describe('customRange', () => {
  it('treats the end date as inclusive', () => {
    const range = customRange('2026-08-01', '2026-08-03');
    expect(range).toBeDefined();
    if (range === undefined) return;
    expect(daysCovered(range.from, range.to)).toBe(3);
    expect(isLocalMidnight(range.from)).toBe(true);
    expect(isLocalMidnight(range.to)).toBe(true);
  });

  it('accepts a single day', () => {
    const range = customRange('2026-08-01', '2026-08-01');
    expect(range).toBeDefined();
    if (range === undefined) return;
    expect(daysCovered(range.from, range.to)).toBe(1);
  });

  it('rejects a range that runs backwards', () => {
    expect(customRange('2026-08-03', '2026-08-01')).toBeUndefined();
  });

  it('rejects a date the calendar does not have', () => {
    expect(customRange('2026-02-30', '2026-03-05')).toBeUndefined();
    expect(customRange('2026-13-01', '2026-13-05')).toBeUndefined();
  });

  it('rejects anything that is not a date input value', () => {
    expect(customRange('', '2026-08-01')).toBeUndefined();
    expect(customRange('last tuesday', '2026-08-01')).toBeUndefined();
  });
});

describe('toDateInputValue', () => {
  it('round-trips through customRange', () => {
    const start = startOfLocalDay(NOW);
    const value = toDateInputValue(start);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(customRange(value, value)?.from).toBe(start);
  });
});

describe('toQueryParams', () => {
  it('sends UTC instants, whatever zone the viewer is in', () => {
    const params = toQueryParams({ from: startOfLocalDay(NOW), to: NOW });
    expect(params.from.endsWith('Z')).toBe(true);
    expect(Date.parse(params.from)).toBe(startOfLocalDay(NOW));
    expect(Date.parse(params.to)).toBe(NOW);
  });
});

describe('tzOffsetMinutes', () => {
  it('counts east of UTC, the direction the API expects', () => {
    expect(tzOffsetMinutes(NOW)).toBe(-new Date(NOW).getTimezoneOffset());
  });
});
