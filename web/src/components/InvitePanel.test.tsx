/**
 * Adding a teammate from the dashboard.
 *
 * Rendered statically, like the other component tests, so what is asserted is
 * what the markup says rather than what clicking it does. That covers the part
 * worth covering: an admin with no public URL must be told why the form is dead
 * instead of being left with a button that does nothing.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { InviteResponse, OpenInvite } from '../../../src/shared/api.js';
import { InvitePanel } from './InvitePanel.js';

/** A fixed instant, so relative times in the markup do not move. */
const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

/** An invite issued an hour ago and good for another 23. */
function openInvite(name: string, code: string): OpenInvite {
  return {
    code,
    display_name: name,
    created_at: NOW - 60 * 60 * 1000,
    expires_at: NOW + 23 * 60 * 60 * 1000,
  };
}

/**
 * The name field's own tag. Asserting on the whole markup would catch the
 * submit button, which is correctly disabled until a name is typed and says
 * nothing about whether the panel is usable.
 */
function nameInput(markup: string): string {
  return /<input id="invite-name"[^>]*>/.exec(markup)?.[0] ?? '';
}

/** Renders the panel. The create callback never fires during static rendering. */
function render(options: {
  readonly endpoint: string | null;
  readonly invites?: readonly OpenInvite[];
}): string {
  return renderToStaticMarkup(
    <InvitePanel
      endpoint={options.endpoint}
      invites={options.invites ?? []}
      now={NOW}
      onCreate={() => Promise.reject(new Error('not exercised by static rendering'))}
    />,
  );
}

describe('InvitePanel', () => {
  it('offers the form when the server knows where it lives', () => {
    const markup = render({ endpoint: 'https://ccledger.example.com' });

    expect(markup).toContain('Invite a teammate');
    expect(markup).toContain('Create invite');
    expect(nameInput(markup)).not.toContain('disabled');
  });

  it('explains itself instead of offering a dead form with no public URL', () => {
    const markup = render({ endpoint: null });

    // The fix is a serve flag, so the message names it. Nothing a browser can
    // send would help here.
    expect(markup).toContain('--public-url');
    expect(nameInput(markup)).toContain('disabled');
  });

  it('lists what is still unclaimed, which is the question an admin asks', () => {
    const markup = render({
      endpoint: 'https://ccledger.example.com',
      invites: [
        openInvite('Alice Chen', 'EPZP-QHDH-8QGB'),
        openInvite('Marco Ruiz', 'BWHW-5F3V-BRXN'),
      ],
    });

    expect(markup).toContain('Not claimed yet');
    expect(markup).toContain('Alice Chen');
    expect(markup).toContain('EPZP-QHDH-8QGB');
    expect(markup).toContain('Marco Ruiz');
  });

  it('says nothing about unclaimed invites when there are none', () => {
    expect(render({ endpoint: 'https://ccledger.example.com' })).not.toContain('Not claimed yet');
  });

  it('shows no command until one has been issued', () => {
    // The command only exists once the server has minted a code; there is no
    // client-side guess at what it will be.
    expect(render({ endpoint: 'https://ccledger.example.com' })).not.toContain('npx ');
  });
});

describe('InviteResponse', () => {
  it('carries everything the panel renders', () => {
    // A compile-time check that the panel is written against the wire shape
    // rather than a convenient subset of it.
    const response: InviteResponse = {
      code: 'EPZP-QHDH-8QGB',
      display_name: 'Alice Chen',
      expires_at: NOW,
      endpoint: 'https://ccledger.example.com',
      invite: 'eyJ2IjoxfQ',
      command: 'npx @thisissbk/ccledger setup --code eyJ2IjoxfQ',
    };
    expect(response.command).toContain(response.invite);
  });
});
