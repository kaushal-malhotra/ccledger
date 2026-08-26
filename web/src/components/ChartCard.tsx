import type { JSX, ReactNode } from 'react';

import { ChartLegend } from './ChartLegend.js';
import type { LegendEntry } from './ChartLegend.js';

/** What a chart card draws around its plot. */
export interface ChartCardProps {
  readonly title: string;
  /** The line beside the heading: what the range is, what the buckets are. */
  readonly note?: string | undefined;
  /**
   * The chart in words. This is what a screen reader is given in place of the
   * picture, so it carries the numbers rather than describing the drawing.
   */
  readonly summary: string;
  readonly legend: readonly LegendEntry[];
  /** Names the legend list. */
  readonly legendLabel: string;
  /** No response yet. Draws a skeleton the size of the plot. */
  readonly loading: boolean;
  /** A refetch over a plot that already has data. Dims rather than clearing. */
  readonly stale: boolean;
  /** The range holds nothing. Replaces the plot with a sentence. */
  readonly empty: boolean;
  readonly emptyNote?: string | undefined;
  /** Plot height in pixels, axis labels included. */
  readonly height: number;
  readonly children: ReactNode;
}

/**
 * The frame every chart on this dashboard sits in.
 *
 * It exists to make three states impossible to get wrong per chart, because
 * each has a rule that is easy to state and easy to forget.
 *
 * A first load draws a **skeleton**, not a spinner: the card keeps the size it
 * will have, so the page does not jump when the numbers land. A *refetch* draws
 * neither — the previous render stays where it is at reduced opacity, since
 * replacing a chart the reader is looking at with a grey box every time the
 * range control is nudged is worse than a moment of slightly stale data.
 *
 * An **empty range** gets its own sentence inside the card rather than an
 * absent chart, so a range with usage in one chart and none in another still
 * reads as two charts rather than as a layout that broke.
 *
 * The plot is a single `role="img"` labelled with the summary. Screen readers
 * are otherwise handed several hundred `<path>` and `<tspan>` nodes with no
 * meaning in them; one labelled image and a visible legend is the trade that
 * actually reads.
 */
export function ChartCard(props: ChartCardProps): JSX.Element {
  const { title, note, summary, legend, legendLabel, loading, stale, empty, height } = props;

  return (
    <section className="chart-card">
      <div className="chart-head">
        <h3>{title}</h3>
        {note !== undefined && <span className="chart-note">{note}</span>}
      </div>

      {loading ? (
        <div className="chart-plot" style={{ height: `${String(height)}px` }}>
          <span className="skeleton chart-skeleton" />
          <span className="visually-hidden">Loading {title}</span>
        </div>
      ) : empty ? (
        <div className="chart-plot chart-empty" style={{ height: `${String(height)}px` }}>
          <p>{props.emptyNote ?? 'No usage in this range.'}</p>
        </div>
      ) : (
        <>
          <div
            className={stale ? 'chart-plot is-stale' : 'chart-plot'}
            style={{ height: `${String(height)}px` }}
            role="img"
            aria-label={summary}
          >
            {props.children}
          </div>
          <ChartLegend entries={legend} label={legendLabel} />
        </>
      )}
    </section>
  );
}
