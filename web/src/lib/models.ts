/**
 * Shaping `/api/models` into bars.
 *
 * The one judgement call here is the label. Claude Code reports a model as
 * `claude-sonnet-4-5-20250929`, and a bar chart of four of those is four labels
 * that differ in their last eight characters — the axis reads as one repeated
 * string, and the thing the reader wants (which model, and how much) is the
 * part that got squeezed. The release date is dropped from the label and kept
 * in the tooltip, where there is room for it and where someone comparing two
 * releases of the same model will go looking.
 */

import type { ModelUsage } from '../../../src/shared/api.js';

import { formatCount, formatPercent } from './format.js';

/** A model release date at the end of a model string: `-20250929`. */
const RELEASE_SUFFIX = /-\d{8}$/;

/** How many bars the chart draws before the tail is summed into one. */
export const MAX_BARS = 10;

/** The key the folded tail is drawn under. */
export const OTHER_MODEL_KEY = '__other';

/** One bar: a model, or the folded tail. */
export interface ModelBar {
  readonly key: string;
  /** What the axis shows. */
  readonly label: string;
  /** What the tooltip shows: the model exactly as Claude Code reported it. */
  readonly full: string;
  readonly total_tokens: number;
  readonly requests: number;
  readonly cost_micros: number;
  readonly share_pct: number;
}

/**
 * A model as an axis label: the release date trimmed off, and the requests that
 * carried no model at all named rather than left blank.
 */
export function modelLabel(model: string | null): string {
  if (model === null) return 'no model recorded';
  const trimmed = model.replace(RELEASE_SUFFIX, '');
  return trimmed === '' ? model : trimmed;
}

/** One model row as a bar. */
function toBar(model: ModelUsage): ModelBar {
  return {
    key: model.model ?? OTHER_MODEL_KEY.concat('-none'),
    label: modelLabel(model.model),
    full: model.model ?? 'no model recorded',
    total_tokens: model.total_tokens,
    requests: model.requests,
    cost_micros: model.cost_micros,
    share_pct: model.share_pct,
  };
}

/**
 * The bars a models response gets, heaviest first.
 *
 * A team uses a handful of models, so the cap is a guard rather than a shape:
 * it only fires if Claude Code starts reporting a great many distinct model
 * strings, and it sums rather than truncates so the bars still add to the total.
 */
export function buildModelBars(models: readonly ModelUsage[]): ModelBar[] {
  const sorted = [...models].sort((a, b) => b.total_tokens - a.total_tokens);
  if (sorted.length <= MAX_BARS) return sorted.map(toBar);

  const named = sorted.slice(0, MAX_BARS - 1).map(toBar);
  const folded = sorted.slice(MAX_BARS - 1);
  named.push({
    key: OTHER_MODEL_KEY,
    label: `${String(folded.length)} other models`,
    full: `${String(folded.length)} other models`,
    total_tokens: folded.reduce((sum, model) => sum + model.total_tokens, 0),
    requests: folded.reduce((sum, model) => sum + model.requests, 0),
    cost_micros: folded.reduce((sum, model) => sum + model.cost_micros, 0),
    share_pct: folded.reduce((sum, model) => sum + model.share_pct, 0),
  });
  return named;
}

/**
 * What a screen reader is told instead of the bars. `totalTokens` is passed in
 * rather than summed from the bars: on a member's page the shares are that
 * member's share of the whole team, so the two do not agree and the response's
 * own total is the one that matches what is drawn.
 */
export function describeModels(bars: readonly ModelBar[], totalTokens: number): string {
  if (bars.length === 0 || totalTokens === 0) {
    return 'Bar chart of tokens by model. No usage in this range.';
  }

  const listed = bars
    .map((bar) => `${bar.label} ${formatCount(bar.total_tokens)} (${formatPercent(bar.share_pct)})`)
    .join(', ');

  return (
    `Bar chart of tokens by model, largest first. ` +
    `${formatCount(totalTokens)} tokens across ${String(bars.length)} ` +
    `${bars.length === 1 ? 'model' : 'models'}: ${listed}.`
  );
}
