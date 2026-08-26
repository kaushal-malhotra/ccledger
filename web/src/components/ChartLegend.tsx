import type { JSX } from 'react';

/** One row of a legend: a swatch, a name, and optionally the figure behind it. */
export interface LegendEntry {
  readonly key: string;
  readonly label: string;
  /** A `var(--series-n)` reference, resolved by the theme. */
  readonly color: string;
  /** Already formatted. Rendered after the label when present. */
  readonly value?: string;
}

/** What the legend renders. */
export interface ChartLegendProps {
  readonly entries: readonly LegendEntry[];
  /** Names the list for a screen reader that reaches it out of context. */
  readonly label: string;
}

/**
 * The legend, which is never hidden and never behind a hover.
 *
 * Three of this dashboard's eight hues sit under 3:1 against the light
 * background — unavoidable for a palette that also has to stay separable under
 * colour-blindness, and the reason the swatch is never the only thing carrying
 * a band's identity. The name is right beside it in ordinary ink, and the same
 * numbers are in the table below, so a reader who cannot separate two hues has
 * two other ways to read the chart rather than none.
 *
 * The swatch is the only thing wearing the series colour. Colouring the label
 * to match would put a 2:1 hue on text, which is the version of this that fails
 * for everybody rather than for a few.
 */
export function ChartLegend({ entries, label }: ChartLegendProps): JSX.Element | null {
  if (entries.length === 0) return null;

  return (
    <ul className="legend" aria-label={label}>
      {entries.map((entry) => (
        <li key={entry.key} className="legend-item">
          <span className="legend-swatch" style={{ background: entry.color }} aria-hidden="true" />
          <span className="legend-label">{entry.label}</span>
          {entry.value !== undefined && <span className="legend-value">{entry.value}</span>}
        </li>
      ))}
    </ul>
  );
}
