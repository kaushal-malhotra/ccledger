/**
 * The frame around every chart.
 *
 * Rendered to a string rather than into a DOM, like the other component tests
 * here: what these assert is which of the three states the card is in and what
 * it says in each, and none of that needs a layout.
 *
 * The distinction worth defending is skeleton versus stale. Both mean "a
 * request is in flight", and drawing the wrong one is the difference between a
 * page that keeps its shape while the range is nudged and a page that blinks
 * grey every time.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChartCard } from './ChartCard.js';
import type { ChartCardProps } from './ChartCard.js';

/** A card with everything defaulted but the state a test is about. */
function render(overrides: Partial<ChartCardProps> = {}): string {
  const props: ChartCardProps = {
    title: 'Tokens over time',
    summary: 'Stacked area chart. 1,234 tokens across 2 members.',
    legend: [
      { key: 'a', label: 'Alice', color: 'var(--series-1)', value: '1,000' },
      { key: 'b', label: 'Bob', color: 'var(--series-2)', value: '234' },
    ],
    legendLabel: 'Members in this chart',
    loading: false,
    stale: false,
    empty: false,
    height: 260,
    children: <svg data-testid="plot" />,
    ...overrides,
  };
  return renderToStaticMarkup(<ChartCard {...props} />);
}

describe('ChartCard', () => {
  it('labels the plot with the summary, so the picture has a text equivalent', () => {
    const markup = render();
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Stacked area chart. 1,234 tokens across 2 members."');
  });

  it('shows the legend whenever there is a chart to read', () => {
    const markup = render();
    expect(markup).toContain('Alice');
    expect(markup).toContain('Bob');
    expect(markup).toContain('var(--series-1)');
    // The identity is in text beside the swatch, never only in the colour.
    expect(markup).toContain('legend-label');
  });

  it('draws a skeleton on a first load, not a spinner', () => {
    const markup = render({ loading: true });
    expect(markup).toContain('skeleton');
    expect(markup).not.toContain('data-testid="plot"');
    expect(markup).toContain('Loading Tokens over time');
  });

  it('keeps the previous plot at reduced opacity while refetching', () => {
    const markup = render({ stale: true });
    expect(markup).toContain('is-stale');
    // The chart the reader was looking at is still on screen.
    expect(markup).toContain('data-testid="plot"');
    expect(markup).not.toContain('skeleton');
  });

  it('replaces the plot with its own sentence when the range holds nothing', () => {
    const markup = render({ empty: true, emptyNote: 'Nobody reported any tokens in this range.' });
    expect(markup).toContain('Nobody reported any tokens in this range.');
    expect(markup).not.toContain('data-testid="plot"');
  });

  it('falls back to a general sentence when no empty note is given', () => {
    expect(render({ empty: true })).toContain('No usage in this range.');
  });

  it('reserves the plot height in every state, so nothing jumps on arrival', () => {
    for (const state of [{ loading: true }, { empty: true }, {}]) {
      expect(render(state)).toContain('height:260px');
    }
  });
});
