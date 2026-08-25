/**
 * The summary tiles. The case worth a test is the empty one: the cache
 * percentage divides by the token total, and a new install's token total is
 * zero.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { UsageTotals } from '../../../src/shared/api.js';

import { StatTiles } from './StatTiles.js';

/** Totals with everything defaulted to zero. */
function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    requests: 0,
    sessions: 0,
    cost_micros: 0,
    ...overrides,
  };
}

describe('StatTiles', () => {
  it('shortens large numbers and keeps the exact one in the title', () => {
    const markup = renderToStaticMarkup(
      <StatTiles
        totals={totals({
          total_tokens: 1_234_567,
          cache_read_tokens: 600_000,
          cache_creation_tokens: 17_000,
          requests: 4_210,
          sessions: 96,
          cost_micros: 8_450_000,
        })}
        reporting={3}
      />,
    );

    expect(markup).toContain('1.2M');
    expect(markup).toContain('1,234,567 tokens');
    expect(markup).toContain('$8.45');
    expect(markup).toContain('50% of them cache');
    expect(markup).toContain('across 3 people');
  });

  it('does not divide by zero on an empty range', () => {
    const markup = renderToStaticMarkup(<StatTiles totals={totals()} reporting={0} />);

    expect(markup).toContain('0% of them cache');
    expect(markup).not.toContain('NaN');
    expect(markup).toContain('$0.00');
  });

  it('counts one person as a person', () => {
    const markup = renderToStaticMarkup(<StatTiles totals={totals()} reporting={1} />);
    expect(markup).toContain('across 1 person');
  });

  it('draws skeletons rather than zeros before the first response', () => {
    const markup = renderToStaticMarkup(<StatTiles totals={null} reporting={0} />);
    expect(markup).toContain('skeleton');
  });

  it('marks the cost tile as an estimate', () => {
    const markup = renderToStaticMarkup(<StatTiles totals={totals()} reporting={0} />);
    expect(markup).toContain('>est.<');
  });
});
