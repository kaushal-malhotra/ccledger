import type { JSX } from 'react';
import { Area, AreaChart, YAxis } from 'recharts';

/** What one row's sparkline draws. */
export interface SparklineProps {
  /** Tokens per bucket, in order, one entry per bucket in the range. */
  readonly values: readonly number[];
  /** A `var(--series-n)` reference: the same colour as this member's band. */
  readonly color: string;
  /** What a screen reader is told in place of the picture. */
  readonly label: string;
}

/** Fixed, because it sits in a table cell that must not change width. */
const WIDTH = 84;

/** Tall enough to have a shape, short enough not to stretch the row. */
const HEIGHT = 22;

/**
 * One member's trend, at table-row size.
 *
 * Given an explicit width and height rather than a responsive container: this
 * renders once per row, and a chart that measures its own box would put a
 * resize observer behind every line of the table for no visible gain.
 *
 * **Each sparkline is scaled to its own peak, not to the table's.** That is the
 * usual thing to get wrong in both directions. On a shared scale the lightest
 * user is a flat line on the floor and their trend — which is the entire point
 * of the column — is unreadable. Scaled individually, two identical shapes can
 * mean wildly different quantities, so the magnitude has to be legible
 * elsewhere: it is in the tokens column immediately to the left, and the chart
 * above the table is the one drawn on a common scale.
 *
 * The baseline is pinned at zero all the same, so a member whose usage merely
 * dips never reads as one who stopped.
 */
export function Sparkline({ values, color, label }: SparklineProps): JSX.Element {
  if (values.length === 0 || values.every((value) => value === 0)) {
    return (
      <div className="spark spark-flat" role="img" aria-label={label}>
        <span aria-hidden="true">—</span>
      </div>
    );
  }

  const data = values.map((value, index) => ({ index, value }));

  return (
    <div className="spark" role="img" aria-label={label}>
      <AreaChart
        width={WIDTH}
        height={HEIGHT}
        data={data}
        margin={{ top: 2, right: 1, bottom: 0, left: 1 }}
      >
        <YAxis hide domain={[0, 'dataMax']} />
        <Area
          dataKey="value"
          type="linear"
          stroke={color}
          strokeWidth={1.5}
          fill={color}
          fillOpacity={0.18}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </div>
  );
}
