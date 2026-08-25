/**
 * The members list. Nearly every column here is nullable — a member may have
 * never reported, may have joined without sending a hostname, may be revoked —
 * so the test that matters is that each of those renders a word rather than an
 * empty cell.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { MemberListEntry } from '../../../src/shared/api.js';

import { MembersView } from './MembersView.js';

/** A fixed present, so a relative time is the same on every machine. */
const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

/** A member with everything absent unless a test says otherwise. */
function entry(overrides: Partial<MemberListEntry> & Pick<MemberListEntry, 'member_id'>) {
  return {
    display_name: overrides.member_id,
    created_at: NOW - 40 * 24 * 3_600_000,
    revoked_at: null,
    join_hostname: null,
    join_os: null,
    last_seen: null,
    installs: 0,
    ...overrides,
  } satisfies MemberListEntry;
}

/** Renders the list. The revoke callback is never fired by static rendering. */
function render(members: readonly MemberListEntry[]): string {
  return renderToStaticMarkup(
    <MembersView members={members} onRevoke={() => Promise.resolve()} now={NOW} loading={false} />,
  );
}

describe('MembersView', () => {
  it('shows an active member with a machine and a recent heartbeat', () => {
    const markup = render([
      entry({
        member_id: 'm_alice',
        display_name: 'Alice',
        last_seen: NOW - 3 * 3_600_000,
        installs: 2,
        join_hostname: 'alice-mbp',
        join_os: 'darwin',
      }),
    ]);

    expect(markup).toContain('Alice');
    expect(markup).toContain('3h ago');
    expect(markup).toContain('alice-mbp');
    expect(markup).toContain('darwin');
    expect(markup).toContain('active');
    expect(markup).toContain('Revoke');
  });

  it('says never and unknown rather than leaving cells blank', () => {
    const markup = render([entry({ member_id: 'm_new', display_name: 'Newcomer' })]);

    expect(markup).toContain('never');
    expect(markup).toContain('unknown');
  });

  it('marks a revoked member and offers nothing further to do to them', () => {
    const markup = render([
      entry({
        member_id: 'm_gone',
        display_name: 'Gone',
        revoked_at: NOW - 2 * 24 * 3_600_000,
        last_seen: NOW - 9 * 24 * 3_600_000,
      }),
    ]);

    expect(markup).toContain('revoked 2d ago');
    expect(markup).not.toContain('>Revoke<');
  });
});
