/**
 * Formatting, with the cost cases first: the dashboard's only job that can
 * mislead rather than merely look wrong is turning integer micros into a
 * dollar figure.
 */

import { describe, expect, it } from 'vitest';

import {
  COST_DISCLAIMER,
  formatCompact,
  formatCostMicros,
  formatCount,
  formatPercent,
  formatRelative,
  formatUntil,
} from './format.js';

/** A fixed present, so "3h ago" means the same thing on every machine. */
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

/** Milliseconds in a minute. */
const MINUTE = 60_000;

describe('formatCostMicros', () => {
  it('divides by a million and shows cents', () => {
    expect(formatCostMicros(12_340_000)).toBe('$12.34');
    expect(formatCostMicros(1_000_000)).toBe('$1.00');
  });

  it('shows exact zero as zero', () => {
    expect(formatCostMicros(0)).toBe('$0.00');
  });

  it('keeps four decimals for amounts a cent would round away', () => {
    // The very number stage 0 captured for one session-title request.
    expect(formatCostMicros(963)).toBe('$0.0010');
    expect(formatCostMicros(99_585)).toBe('$0.10');
  });

  it('never rounds a nonzero cost to a bare $0.00', () => {
    expect(formatCostMicros(1)).not.toBe('$0.00');
  });
});

describe('formatCount', () => {
  it('separates thousands', () => {
    expect(formatCount(1_234_567)).toBe('1,234,567');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatCompact', () => {
  it('shortens large numbers for a summary tile', () => {
    expect(formatCompact(1_234_567)).toBe('1.2M');
    expect(formatCompact(45_300)).toBe('45.3K');
    expect(formatCompact(812)).toBe('812');
  });
});

describe('formatPercent', () => {
  it('always shows one decimal, so a column stays aligned', () => {
    expect(formatPercent(100)).toBe('100.0%');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(33.333)).toBe('33.3%');
  });
});

describe('formatRelative', () => {
  it('reads in the largest unit that is still a quantity', () => {
    expect(formatRelative(NOW - 20_000, NOW)).toBe('just now');
    expect(formatRelative(NOW - 4 * MINUTE, NOW)).toBe('4m ago');
    expect(formatRelative(NOW - 3 * 60 * MINUTE, NOW)).toBe('3h ago');
    expect(formatRelative(NOW - 12 * 24 * 60 * MINUTE, NOW)).toBe('12d ago');
  });

  it('falls back to a date once the count stops meaning anything', () => {
    expect(formatRelative(NOW - 200 * 24 * 60 * MINUTE, NOW)).toMatch(/\d{4}$/);
  });

  it('does not report the future as an age', () => {
    expect(formatRelative(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('COST_DISCLAIMER', () => {
  it('says the figure is notional rather than money that was spent', () => {
    expect(COST_DISCLAIMER).toContain('notional');
    expect(COST_DISCLAIMER).toContain('not real spend');
  });
});

describe('formatUntil', () => {
  const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

  it('counts down in the largest unit that still reads as a quantity', () => {
    expect(formatUntil(NOW + 23 * 60 * 60 * 1000, NOW)).toBe('in 23h');
    expect(formatUntil(NOW + 45 * 60 * 1000, NOW)).toBe('in 45m');
    expect(formatUntil(NOW + 3 * 24 * 60 * 60 * 1000, NOW)).toBe('in 3d');
    expect(formatUntil(NOW + 20_000, NOW)).toBe('in under a minute');
  });

  it('says expired rather than folding the past into the present', () => {
    // This is the whole reason it exists: formatRelative answers "just now"
    // here, which reads as though the code were still good.
    expect(formatUntil(NOW - 1000, NOW)).toBe('expired');
    expect(formatUntil(NOW, NOW)).toBe('expired');
  });
});
