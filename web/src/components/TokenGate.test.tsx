/**
 * The first screen anyone sees. It has one job beyond taking a token: telling a
 * new admin where the token came from and what happens to it, because neither
 * is guessable and the second is the reason a reload asks again.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TokenGate } from './TokenGate.js';

/** Renders the gate. The submit callback never fires during static rendering. */
function render(error: string | null): string {
  return renderToStaticMarkup(
    <TokenGate
      error={error}
      onSubmit={() => {
        /* not exercised by static rendering */
      }}
    />,
  );
}

describe('TokenGate', () => {
  it('says where the token comes from and that it is not stored', () => {
    const markup = render(null);

    expect(markup).toContain('ccledger serve');
    expect(markup).toContain('never written to storage');
    expect(markup).toContain('--rotate-admin-token');
  });

  it('masks what is typed', () => {
    expect(render(null)).toContain('type="password"');
  });

  it('shows why the last attempt failed', () => {
    expect(render('unknown admin token')).toContain('unknown admin token');
  });
});
