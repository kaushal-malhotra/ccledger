/**
 * The member table, rendered.
 *
 * `renderToStaticMarkup` rather than a DOM: the table has no effects and no
 * event handling worth asserting here, so rendering it to a string proves what
 * matters — that it renders at all, and that the numbers it prints are the ones
 * it was given — without pulling jsdom into the dependency tree for it.
 *
 * The assertion that carries stage 4's acceptance criterion is the footer:
 * whatever the per-member shares are, the column the reader adds up has to come
 * to 100.0%.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { MemberUsage, UsageTotals } from '../../../src/shared/api.js';

import { MemberTable } from './MemberTable.js';

/** A member row with everything defaulted but the fields a test cares about. */
function member(overrides: Partial<MemberUsage> & Pick<MemberUsage, 'member_id'>): MemberUsage {
  return {
    display_name: overrides.member_id,
    revoked_at: null,
    share_pct: 0,
    last_request: null,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    requests: 0,
    sessions: 0,
    cost_micros: 0,
    ...overrides,
  };
}

/** Totals matching a member list, summed the way the server would. */
function totalsOf(members: readonly MemberUsage[]): UsageTotals {
  return {
    total_tokens: members.reduce((sum, row) => sum + row.total_tokens, 0),
    input_tokens: members.reduce((sum, row) => sum + row.input_tokens, 0),
    output_tokens: members.reduce((sum, row) => sum + row.output_tokens, 0),
    cache_read_tokens: members.reduce((sum, row) => sum + row.cache_read_tokens, 0),
    cache_creation_tokens: members.reduce((sum, row) => sum + row.cache_creation_tokens, 0),
    requests: members.reduce((sum, row) => sum + row.requests, 0),
    sessions: members.reduce((sum, row) => sum + row.sessions, 0),
    cost_micros: members.reduce((sum, row) => sum + row.cost_micros, 0),
  };
}

/** Renders the table over a member list. */
function render(members: readonly MemberUsage[], loading = false): string {
  return renderToStaticMarkup(
    <MemberTable members={members} totals={totalsOf(members)} loading={loading} />,
  );
}

/** Three members whose true shares are thirds — the case rounding breaks. */
const THIRDS: readonly MemberUsage[] = [
  member({
    member_id: 'm_a',
    display_name: 'Alice',
    share_pct: 100 / 3,
    total_tokens: 1000,
    requests: 10,
    sessions: 2,
    cost_micros: 1_500_000,
  }),
  member({
    member_id: 'm_b',
    display_name: 'Bob',
    share_pct: 100 / 3,
    total_tokens: 1000,
    requests: 8,
    sessions: 3,
    cost_micros: 900_000,
  }),
  member({
    member_id: 'm_c',
    display_name: 'Carol',
    share_pct: 100 / 3,
    total_tokens: 1000,
    requests: 6,
    sessions: 1,
    cost_micros: 963,
  }),
];

/** The share percentages the rendered rows print, in row order. The footer
 *  prints its own total in a plain cell and is deliberately not matched here. */
function renderedShares(markup: string): string[] {
  return [...markup.matchAll(/class="share-value">([^<]+)</g)].map((match) => match[1] ?? '');
}

describe('MemberTable', () => {
  it('prints a share column that sums to exactly 100 percent', () => {
    const markup = render(THIRDS);
    const shares = renderedShares(markup).map((value) => Number.parseFloat(value));

    expect(shares.length).toBe(THIRDS.length);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 9);
    // And the footer, which prints the sum of exactly those values.
    expect(markup).toContain('<td class="num">100.0%</td>');
  });

  it('shows each member s own totals, with thousands separators', () => {
    const markup = render([
      member({
        member_id: 'm_a',
        display_name: 'Alice',
        share_pct: 100,
        total_tokens: 1_234_567,
        input_tokens: 4_000,
        output_tokens: 6_000,
        cache_read_tokens: 1_000_000,
        cache_creation_tokens: 224_567,
        requests: 42,
        sessions: 7,
        cost_micros: 12_340_000,
      }),
    ]);

    expect(markup).toContain('Alice');
    expect(markup).toContain('1,234,567');
    expect(markup).toContain('1,000,000');
    expect(markup).toContain('$12.34');
    expect(markup).toContain('100.0%');
  });

  it('keeps a cost under a cent from reading as free', () => {
    // 963 micros is what stage 0 captured for one session-title request.
    const markup = render(THIRDS);

    expect(markup).toContain('$0.0010');
    expect(markup).not.toContain('>$0.00<');
  });

  it('marks every cost column as an estimate, with the reason attached', () => {
    const markup = render(THIRDS);

    expect(markup).toContain('>est.<');
    expect(markup).toContain('notional');
    expect(markup).toContain('not real spend');
  });

  it('opens sorted by share, descending', () => {
    const markup = render([
      member({ member_id: 'm_small', display_name: 'Small', share_pct: 10, total_tokens: 10 }),
      member({ member_id: 'm_big', display_name: 'Big', share_pct: 90, total_tokens: 90 }),
    ]);

    expect(markup.indexOf('Big')).toBeLessThan(markup.indexOf('Small'));
    expect(markup).toContain('aria-sort="descending"');
  });

  it('says which members have been revoked', () => {
    const markup = render([
      member({ member_id: 'm_gone', display_name: 'Gone', share_pct: 100, revoked_at: 1_700_000 }),
    ]);
    expect(markup).toContain('revoked');
  });

  it('draws a skeleton rather than an empty table while loading', () => {
    const markup = render([], true);

    expect(markup).toContain('skeleton');
    // Nothing to total yet, so no footer claiming a total of nothing.
    expect(markup).not.toContain('<tfoot');
  });

  it('renders an empty member list without a footer or a crash', () => {
    const markup = render([]);
    expect(markup).toContain('<table');
    expect(markup).not.toContain('<tfoot');
  });
});
