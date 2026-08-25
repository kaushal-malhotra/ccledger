/**
 * The toolbar. Its one piece of real logic is the source dropdown, which is
 * built from whatever `query_source` values the range happens to contain —
 * including the `null` one, which has no name to print and no value to send.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { SourceUsage } from '../../../src/shared/api.js';
import { ALL_ACTIVITY } from '../lib/filter.js';
import type { Range } from '../lib/range.js';

import { Toolbar } from './Toolbar.js';

/** A range covering an arbitrary day. */
const RANGE: Range = { from: Date.UTC(2026, 7, 20), to: Date.UTC(2026, 7, 21) };

/** A source row with only the fields the dropdown reads. */
function source(query_source: string | null, requests: number): SourceUsage {
  return {
    query_source,
    group: query_source === 'compact' ? 'overhead' : 'work',
    share_pct: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    requests,
    sessions: 0,
    cost_micros: 0,
  };
}

/** Renders the toolbar. None of the callbacks fire during static rendering. */
function render(options: {
  readonly sources?: readonly SourceUsage[];
  readonly range?: Range | undefined;
  readonly preset?: 'today' | '7d' | '30d' | 'custom';
}): string {
  const noop = (): void => {
    /* not exercised by static rendering */
  };
  return renderToStaticMarkup(
    <Toolbar
      preset={options.preset ?? '7d'}
      onPreset={noop}
      customFrom="2026-08-01"
      customTo="2026-08-07"
      onCustomFrom={noop}
      onCustomTo={noop}
      range={'range' in options ? options.range : RANGE}
      selection={ALL_ACTIVITY}
      onSelection={noop}
      sources={options.sources ?? []}
      onRefresh={noop}
      loading={false}
    />,
  );
}

describe('Toolbar', () => {
  it('offers the four presets and marks the current one', () => {
    const markup = render({});

    expect(markup).toContain('Today');
    expect(markup).toContain('7 days');
    expect(markup).toContain('30 days');
    expect(markup).toContain('Custom');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('shows the date inputs only for a custom range', () => {
    expect(render({})).not.toContain('type="date"');
    expect(render({ preset: 'custom' })).toContain('type="date"');
  });

  it('lists the sources in the range under the three groupings', () => {
    const markup = render({ sources: [source('sdk', 26), source('compact', 6)] });

    expect(markup).toContain('All activity');
    expect(markup).toContain('Real work only');
    expect(markup).toContain('Overhead only');
    expect(markup).toContain('One source only');
    expect(markup).toContain('sdk · 26 req');
    expect(markup).toContain('value="s:sdk"');
  });

  it('gives the sourceless requests a name and a value of their own', () => {
    const markup = render({ sources: [source(null, 6)] });

    expect(markup).toContain('no source recorded');
    expect(markup).toContain('value="s:none"');
  });

  it('says so rather than fetching when the custom dates are unusable', () => {
    const markup = render({ preset: 'custom', range: undefined });
    expect(markup).toContain('Pick a start date on or before the end.');
  });
});
