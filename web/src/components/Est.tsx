import type { JSX } from 'react';

import { COST_DISCLAIMER } from '../lib/format.js';

/**
 * The marker every cost figure on this dashboard carries.
 *
 * Claude Code reports `cost_usd_micros` on every request, including for people
 * on a subscription plan where no per-request charge exists. The number is a
 * genuinely useful way to compare two teammates' usage and a genuinely
 * misleading way to predict an invoice, so it is never shown without saying so.
 * `<abbr title>` gets the explanation to a mouse and to a screen reader without
 * a tooltip library.
 */
export function Est(): JSX.Element {
  return (
    <abbr className="est" title={COST_DISCLAIMER}>
      est.
    </abbr>
  );
}
