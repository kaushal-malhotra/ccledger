/**
 * The model bars, rendered.
 *
 * The assertion with a decision behind it is the absence of a legend. Every bar
 * is the same colour on purpose — the categorical palette on this dashboard
 * means "which teammate", and spending it again on models would give one page
 * two colour conventions. Identity here is the axis label, in text, so a legend
 * of identical swatches would point at a distinction that is not being drawn.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ModelUsage } from '../../../src/shared/api.js';

import { ModelBars } from './ModelBars.js';

/** A model row with everything defaulted but the fields a test cares about. */
function model(overrides: Partial<ModelUsage> & Pick<ModelUsage, 'model'>): ModelUsage {
  return {
    model_family: null,
    share_pct: 0,
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

/** Two models, one of them a dated release. */
const MODELS: readonly ModelUsage[] = [
  model({ model: 'claude-opus-5', total_tokens: 1_234_567, share_pct: 75, requests: 40 }),
  model({
    model: 'claude-haiku-4-5-20251001',
    total_tokens: 411_522,
    share_pct: 25,
    requests: 12,
  }),
];

/** Renders the chart over a model list. */
function render(
  models: readonly ModelUsage[] | null,
  totalTokens: number,
  loading = false,
): string {
  return renderToStaticMarkup(
    <ModelBars models={models} totalTokens={totalTokens} loading={loading} />,
  );
}

describe('ModelBars', () => {
  it('summarises the bars in text, with separated thousands', () => {
    const markup = render(MODELS, 1_646_089);

    expect(markup).toContain('role="img"');
    expect(markup).toContain('Bar chart of tokens by model');
    expect(markup).toContain('claude-opus-5 1,234,567 (75.0%)');
  });

  it('carries no legend, because no bar is identified by its colour', () => {
    const markup = render(MODELS, 1_646_089);
    expect(markup).not.toContain('class="legend"');
  });

  it('draws a skeleton before the first response', () => {
    const markup = render(null, 0, true);
    expect(markup).toContain('skeleton');
    expect(markup).not.toContain('recharts');
  });

  it('has its own empty state when no model reported anything', () => {
    const markup = render([], 0);
    expect(markup).toContain('No model reported any tokens in this range.');
  });

  it('takes its own heading on a member page', () => {
    const markup = renderToStaticMarkup(
      <ModelBars models={MODELS} totalTokens={1_646_089} loading={false} title="Their models" />,
    );
    expect(markup).toContain('Their models');
  });

  it('grows with the number of bars rather than squeezing them', () => {
    const one = render([MODELS[0] ?? model({ model: 'x' })], 1);
    const many = render(
      Array.from({ length: 6 }, (_unused, index) =>
        model({ model: `model-${String(index)}`, total_tokens: 10 }),
      ),
      60,
    );

    const heightOf = (markup: string): number => Number(/height:(\d+)px/.exec(markup)?.[1] ?? '0');
    expect(heightOf(many)).toBeGreaterThan(heightOf(one));
  });
});
