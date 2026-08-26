/**
 * Model labels and bars.
 *
 * The label trim is the part with a real failure mode: it has to shorten a
 * dated release without touching a model string that has no date, and without
 * ever returning an empty axis label.
 */

import { describe, expect, it } from 'vitest';

import type { ModelUsage } from '../../../src/shared/api.js';

import { MAX_BARS, OTHER_MODEL_KEY, buildModelBars, describeModels, modelLabel } from './models.js';

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

describe('modelLabel', () => {
  it('drops the release date, which is the only part that repeats', () => {
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('leaves a model with no date alone', () => {
    expect(modelLabel('claude-opus-5')).toBe('claude-opus-5');
  });

  it('does not mistake a version for a date', () => {
    expect(modelLabel('claude-opus-5-1234567')).toBe('claude-opus-5-1234567');
    expect(modelLabel('claude-opus-5-123456789')).toBe('claude-opus-5-123456789');
  });

  it('never returns an empty label', () => {
    expect(modelLabel('-20250929')).toBe('-20250929');
    expect(modelLabel(null)).toBe('no model recorded');
  });
});

describe('buildModelBars', () => {
  it('orders them heaviest first', () => {
    const bars = buildModelBars([
      model({ model: 'claude-haiku-4-5-20251001', total_tokens: 100 }),
      model({ model: 'claude-opus-5', total_tokens: 900 }),
      model({ model: 'claude-sonnet-4-5-20250929', total_tokens: 400 }),
    ]);

    expect(bars.map((bar) => bar.label)).toEqual([
      'claude-opus-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]);
  });

  it('keeps the full model string for the tooltip', () => {
    const bars = buildModelBars([model({ model: 'claude-sonnet-4-5-20250929', total_tokens: 1 })]);
    expect(bars[0]?.full).toBe('claude-sonnet-4-5-20250929');
    expect(bars[0]?.label).toBe('claude-sonnet-4-5');
  });

  it('sums an unreasonable number of models rather than truncating them', () => {
    const many = Array.from({ length: MAX_BARS + 4 }, (_unused, index) =>
      model({ model: `model-${String(index)}`, total_tokens: 100 }),
    );
    const bars = buildModelBars(many);
    const tail = bars.at(-1);

    expect(bars).toHaveLength(MAX_BARS);
    expect(tail?.key).toBe(OTHER_MODEL_KEY);
    expect(tail?.total_tokens).toBe(500);
    // Nothing is dropped: the bars still add to what came in.
    expect(bars.reduce((sum, bar) => sum + bar.total_tokens, 0)).toBe(many.length * 100);
  });

  it('names the requests that carried no model at all', () => {
    const bars = buildModelBars([model({ model: null, total_tokens: 5 })]);
    expect(bars[0]?.label).toBe('no model recorded');
  });
});

describe('describeModels', () => {
  it('lists every bar with a separated number and its share', () => {
    const bars = buildModelBars([
      model({ model: 'claude-opus-5', total_tokens: 1_234_567, share_pct: 75 }),
      model({ model: 'claude-haiku-4-5-20251001', total_tokens: 411_522, share_pct: 25 }),
    ]);
    const summary = describeModels(bars, 1_646_089);

    expect(summary).toContain('claude-opus-5 1,234,567 (75.0%)');
    expect(summary).toContain('claude-haiku-4-5 411,522 (25.0%)');
    expect(summary).toContain('2 models');
  });

  it('says an empty range is empty', () => {
    expect(describeModels([], 0)).toContain('No usage in this range');
  });
});
