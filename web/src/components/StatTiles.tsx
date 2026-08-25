import type { JSX, ReactNode } from 'react';

import type { UsageTotals } from '../../../src/shared/api.js';
import { formatCompact, formatCostMicros, formatCount } from '../lib/format.js';

import { Est } from './Est.js';

/** What the four tiles read from. */
export interface StatTilesProps {
  /** `null` while the first load is still in flight. */
  readonly totals: UsageTotals | null;
  /**
   * Members who actually reported in the range. Not the number of rows in the
   * table: that includes teammates sitting at zero, and "4,210 requests across
   * 5 people" would be wrong if only three of them made any.
   */
  readonly reporting: number;
}

/** One tile: a label, a big number, and a line of context under it. */
function Tile(props: {
  readonly label: ReactNode;
  readonly value: string;
  readonly title?: string;
  readonly sub: string;
  readonly loading: boolean;
}): JSX.Element {
  return (
    <div className="tile">
      <div className="tile-label">{props.label}</div>
      <div className={props.loading ? 'tile-value skeleton' : 'tile-value'} title={props.title}>
        {props.value}
      </div>
      <div className={props.loading ? 'tile-sub skeleton' : 'tile-sub'}>{props.sub}</div>
    </div>
  );
}

/**
 * The range at a glance. Compact numbers here and full ones in the table: a
 * tile answers "roughly how much", and the exact figure is one `title` away for
 * anyone who wants it.
 */
export function StatTiles({ totals, reporting }: StatTilesProps): JSX.Element {
  const loading = totals === null;
  const value = totals ?? {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    requests: 0,
    sessions: 0,
    cost_micros: 0,
  };
  const cached = value.cache_read_tokens + value.cache_creation_tokens;
  const cachedShare =
    value.total_tokens === 0 ? 0 : Math.round((cached / value.total_tokens) * 100);

  return (
    <div className="tiles">
      <Tile
        label="Tokens"
        value={formatCompact(value.total_tokens)}
        title={`${formatCount(value.total_tokens)} tokens`}
        sub={`${String(cachedShare)}% of them cache`}
        loading={loading}
      />
      <Tile
        label="Requests"
        value={formatCompact(value.requests)}
        title={`${formatCount(value.requests)} requests`}
        sub={`across ${formatCount(reporting)} ${reporting === 1 ? 'person' : 'people'}`}
        loading={loading}
      />
      <Tile
        label="Sessions"
        value={formatCompact(value.sessions)}
        title={`${formatCount(value.sessions)} sessions`}
        sub="distinct Claude Code sessions"
        loading={loading}
      />
      <Tile
        label={<>Cost, {<Est />}</>}
        value={formatCostMicros(value.cost_micros)}
        title={`${formatCount(value.cost_micros)} micros`}
        sub="API-equivalent, not billed"
        loading={loading}
      />
    </div>
  );
}
