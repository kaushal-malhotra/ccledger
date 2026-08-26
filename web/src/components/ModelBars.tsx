import type { JSX } from 'react';
import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { ModelUsage } from '../../../src/shared/api.js';
import { formatCompact, formatCostMicros, formatCount, formatPercent } from '../lib/format.js';
import type { ModelBar } from '../lib/models.js';
import { buildModelBars, describeModels } from '../lib/models.js';

import { ChartCard } from './ChartCard.js';

/** What the model chart reads. */
export interface ModelBarsProps {
  /** `null` until the first response lands. */
  readonly models: readonly ModelUsage[] | null;
  /** The token total the bars are drawn against, for the empty test. */
  readonly totalTokens: number;
  readonly loading: boolean;
  /** Overridden on a member's page, where the split is theirs and not the team's. */
  readonly title?: string | undefined;
}

/** Height of one bar's band, including the air around it. */
const BAND_HEIGHT = 38;

/** Height of the axis and the padding under the last bar. */
const PLOT_CHROME = 44;

/** Room on the right for the value at the tip of the longest bar. */
const LABEL_GUTTER = 64;

/** The readout for one bar. */
function ModelTooltip(props: {
  readonly active: boolean;
  readonly label: string | number | undefined;
  readonly bars: readonly ModelBar[];
}): JSX.Element | null {
  if (!props.active || props.label === undefined) return null;

  const bar = props.bars.find((entry) => entry.label === String(props.label));
  if (bar === undefined) return null;

  return (
    <div className="tip">
      <div className="tip-head">{bar.full}</div>
      <ul className="tip-rows">
        <li>
          <span className="tip-label">Tokens</span>
          <span className="tip-value">{formatCount(bar.total_tokens)}</span>
        </li>
        <li>
          <span className="tip-label">Share</span>
          <span className="tip-value">{formatPercent(bar.share_pct)}</span>
        </li>
        <li>
          <span className="tip-label">Requests</span>
          <span className="tip-value">{formatCount(bar.requests)}</span>
        </li>
        <li>
          <span className="tip-label">Cost, est.</span>
          <span className="tip-value">{formatCostMicros(bar.cost_micros)}</span>
        </li>
      </ul>
    </div>
  );
}

/**
 * Tokens by model, as horizontal bars.
 *
 * Every bar is the same colour, and that is the point. This dashboard spends
 * its categorical palette on one thing — which teammate — and a chart that
 * painted Opus blue directly under a chart where blue means Alex would make the
 * page's only colour convention mean two things at once. Here the model names
 * are the y-axis, in text, and the token counts are printed at the tips, so
 * nothing is carried by hue and there is no legend to read: a legend of
 * identical swatches would be an instruction to look for a distinction that
 * isn't being drawn.
 *
 * Horizontal rather than vertical because the categories are long strings.
 * Model names as rotated x-axis labels are the standard way to make a bar chart
 * unreadable.
 */
export function ModelBars({ models, totalTokens, loading, title }: ModelBarsProps): JSX.Element {
  const bars = useMemo(() => (models === null ? null : buildModelBars(models)), [models]);

  const summary = bars === null ? '' : describeModels(bars, totalTokens);
  const height = bars === null ? 200 : Math.max(bars.length, 1) * BAND_HEIGHT + PLOT_CHROME;

  return (
    <ChartCard
      title={title ?? 'Tokens by model'}
      note={bars === null ? undefined : `${String(bars.length)} in range`}
      summary={summary}
      legend={[]}
      legendLabel="Models in this chart"
      loading={loading && bars === null}
      stale={loading && bars !== null}
      empty={bars !== null && totalTokens === 0}
      emptyNote="No model reported any tokens in this range."
      height={height}
    >
      {bars !== null && (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={bars}
            layout="vertical"
            margin={{ top: 4, right: LABEL_GUTTER, bottom: 0, left: 0 }}
          >
            <CartesianGrid horizontal={false} stroke="var(--line)" />
            <XAxis
              type="number"
              tickFormatter={(value: string | number) => formatCompact(Number(value))}
              tick={{ fill: 'var(--ink-faint)', fontSize: 12 }}
              stroke="var(--line-strong)"
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={150}
              tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: 'var(--surface-sunken)' }}
              isAnimationActive={false}
              content={(tooltip) => (
                <ModelTooltip active={tooltip.active} label={tooltip.label} bars={bars} />
              )}
            />
            <Bar
              dataKey="total_tokens"
              name="Tokens"
              // Square where it leaves the baseline, rounded at the end that
              // carries the value.
              radius={[0, 4, 4, 0]}
              maxBarSize={24}
              isAnimationActive={false}
            >
              {bars.map((bar) => (
                <Cell key={bar.key} fill="var(--series-1)" />
              ))}
              <LabelList
                dataKey="total_tokens"
                position="right"
                className="bar-label"
                formatter={(value: string | number | boolean | null | undefined) =>
                  formatCompact(Number(value))
                }
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
