/**
 * The first screen anyone sees. It has one job beyond taking a token: telling a
 * new admin where the token came from and what happens to it, because neither
 * is guessable and the second decides whether they are about to leave a
 * credential on a machine that is not theirs.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TokenGate } from './TokenGate.js';

/** Renders the gate. The submit callback never fires during static rendering. */
function render(error: string | null, rememberInitially = false): string {
  return renderToStaticMarkup(
    <TokenGate
      error={error}
      rememberInitially={rememberInitially}
      onSubmit={() => {
        /* not exercised by static rendering */
      }}
    />,
  );
}

describe('TokenGate', () => {
  it('says where the token comes from and how long it is kept', () => {
    const markup = render(null);

    expect(markup).toContain('ccledger serve');
    expect(markup).toContain('kept for this tab');
    expect(markup).toContain('--rotate-admin-token');
  });

  it('offers to remember the token, unticked, and says what that costs', () => {
    const markup = render(null);

    expect(markup).toContain('Remember me on this device');
    // Unticked by default: somebody opening this on a machine that is not
    // theirs must not have to notice a box in order to decline.
    expect(markup).not.toContain('checked=""');
    expect(markup).toContain('Not on a shared machine');
  });

  it('comes back ticked where a previous visit asked for it', () => {
    expect(render(null, true)).toContain('checked=""');
  });

  it('masks what is typed', () => {
    expect(render(null)).toContain('type="password"');
  });

  it('shows why the last attempt failed', () => {
    expect(render('unknown admin token')).toContain('unknown admin token');
  });
});
