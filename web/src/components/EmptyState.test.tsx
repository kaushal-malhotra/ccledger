/**
 * The empty dashboard.
 *
 * A new ccledger's very first screen has no data on it, so these three
 * variants are the product's first impression as much as the table is. Each one
 * has to name the command that moves the reader forward — and the one for "the
 * range is empty" has to name `ccledger doctor`, which is the only thing that
 * can tell a teammate why their Claude Code is not reporting.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState.js';
import type { EmptyKind } from './EmptyState.js';

/** Renders one variant. The callbacks are never fired by static rendering. */
function render(kind: EmptyKind): string {
  return renderToStaticMarkup(
    <EmptyState
      kind={kind}
      onResetFilter={() => {
        /* not exercised by static rendering */
      }}
      onWidenRange={() => {
        /* not exercised by static rendering */
      }}
    />,
  );
}

describe('EmptyState', () => {
  it('points a range with no usage at the doctor command', () => {
    const markup = render('no-usage');

    expect(markup).toContain('ccledger doctor');
    // The failure that is nearly always the real one.
    expect(markup).toContain('restart');
  });

  it('points a server with no teammates at the invite command', () => {
    const markup = render('no-members');

    expect(markup).toContain('ccledger invite');
    expect(markup).toContain('ccledger setup');
  });

  it('offers a way out when the filter is what is hiding the data', () => {
    const markup = render('filtered-out');

    expect(markup).toContain('Show all activity');
    // Nothing is wrong with the server here, so it must not send anyone to
    // debug one.
    expect(markup).not.toContain('ccledger doctor');
  });
});
