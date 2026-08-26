/**
 * One member's page.
 *
 * The two tables are the reason this page exists rather than a tooltip: the
 * session list answers "what were they doing" and the install list answers "is
 * this the machine I think it is". Both have a shape a chart cannot carry, so
 * both are asserted on their content rather than on their layout.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  InstallInfo,
  MemberDetailResponse,
  SessionUsage,
  TimeseriesResponse,
} from '../../../src/shared/api.js';
import { assignSlots } from '../lib/colors.js';

import { MemberDetail } from './MemberDetail.js';

/** A day, in milliseconds. */
const DAY = 86_400_000;

/** A round UTC midnight to build ranges from. */
const START = Date.UTC(2026, 7, 20);

/** The instant relative times are measured from. */
const NOW = START + 3 * DAY;

const SLOTS = assignSlots([
  { member_id: 'm_alice', created_at: 1 },
  { member_id: 'm_bob', created_at: 2 },
]);

/** A session with everything defaulted but the fields a test cares about. */
function session(
  overrides: Partial<SessionUsage> & Pick<SessionUsage, 'session_id'>,
): SessionUsage {
  return {
    started_at: START,
    ended_at: START + 3_600_000,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    requests: 0,
    cost_micros: 0,
    ...overrides,
  };
}

/** An install with everything defaulted but the fields a test cares about. */
function install(overrides: Partial<InstallInfo> & Pick<InstallInfo, 'install_id'>): InstallInfo {
  return {
    hostname: null,
    os_type: null,
    os_version: null,
    arch: null,
    cc_version: null,
    terminal_type: null,
    first_seen: START,
    last_seen: START + DAY,
    ...overrides,
  };
}

/** The team timeseries the member's own chart is filtered out of. */
function timeseries(): TimeseriesResponse {
  return {
    range: {
      from: new Date(START).toISOString(),
      to: new Date(START + 3 * DAY).toISOString(),
      from_ms: START,
      to_ms: START + 3 * DAY,
    },
    filter: { group: 'all', source: null },
    bucket: 'day',
    bucket_ms: DAY,
    tz_offset_minutes: 0,
    members: [
      { member_id: 'm_alice', display_name: 'Alice', total_tokens: 900 },
      { member_id: 'm_bob', display_name: 'Bob', total_tokens: 100 },
    ],
    points: [
      { bucket_start: START, member_id: 'm_alice', total_tokens: 400, requests: 2, cost_micros: 4 },
      {
        bucket_start: START + DAY,
        member_id: 'm_alice',
        total_tokens: 500,
        requests: 3,
        cost_micros: 5,
      },
      { bucket_start: START, member_id: 'm_bob', total_tokens: 100, requests: 1, cost_micros: 1 },
    ],
  };
}

/** A full detail response for Alice. */
function detail(overrides: Partial<MemberDetailResponse> = {}): MemberDetailResponse {
  return {
    range: timeseries().range,
    filter: { group: 'all', source: null },
    member: {
      member_id: 'm_alice',
      display_name: 'Alice',
      created_at: START - DAY,
      revoked_at: null,
      join_hostname: 'alice-box',
      join_os: 'darwin',
      last_seen: START + DAY,
      installs: 2,
    },
    totals: {
      total_tokens: 900,
      input_tokens: 300,
      output_tokens: 100,
      cache_read_tokens: 400,
      cache_creation_tokens: 100,
      requests: 5,
      sessions: 2,
      cost_micros: 1_500_000,
    },
    share_pct: 90,
    sessions: [
      session({
        session_id: 'bc697788-f3f4-493b-80cc-2a03174c8861',
        total_tokens: 700,
        input_tokens: 250,
        output_tokens: 80,
        requests: 3,
        cost_micros: 1_200_000,
        ended_at: START + 2 * 3_600_000,
      }),
      session({ session_id: null, total_tokens: 200, requests: 2, cost_micros: 300_000 }),
    ],
    sessions_total: 2,
    sessions_limit: 50,
    models: [
      {
        model: 'claude-opus-5',
        model_family: 'opus',
        share_pct: 90,
        total_tokens: 900,
        input_tokens: 300,
        output_tokens: 100,
        cache_read_tokens: 400,
        cache_creation_tokens: 100,
        requests: 5,
        sessions: 2,
        cost_micros: 1_500_000,
      },
    ],
    installs: [
      install({
        install_id: 'i_one',
        hostname: 'alice-box',
        os_type: 'darwin',
        os_version: '24.0',
        arch: 'arm64',
        cc_version: '2.1.241',
        terminal_type: 'vscode',
      }),
    ],
    ...overrides,
  };
}

/** Renders the page. */
function render(
  body: MemberDetailResponse | null,
  options: { readonly loading?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <MemberDetail
      detail={body}
      timeseries={timeseries()}
      memberId="m_alice"
      fallbackName="Alice"
      slots={SLOTS}
      loading={options.loading ?? false}
      now={NOW}
      onBack={() => undefined}
    />,
  );
}

describe('MemberDetail', () => {
  it('charts only this member, on the colour they wear everywhere else', () => {
    const markup = render(detail());

    expect(markup).toContain('Alice over time');
    expect(markup).toContain('Area chart of tokens per day');
    expect(markup).toContain('Alice 100.0%');
    // Bob is in the same response and must not be in this chart.
    expect(markup).not.toContain('Bob');
  });

  it('shows their model split rather than the team s', () => {
    const markup = render(detail());
    expect(markup).toContain('Their models');
    expect(markup).toContain('claude-opus-5 900 (90.0%)');
  });

  it('lists sessions with their token totals', () => {
    const markup = render(detail());

    expect(markup).toContain('bc697788');
    expect(markup).toContain('700');
    expect(markup).toContain('$1.20');
    // A session that carried no id is named rather than left blank.
    expect(markup).toContain('no session id');
  });

  it('says when the session list has been cut short', () => {
    const markup = render(detail({ sessions_total: 400 }));
    expect(markup).toContain('showing 2 of 400');
  });

  it('lists installs with terminal type and last seen', () => {
    const markup = render(detail());

    expect(markup).toContain('alice-box');
    expect(markup).toContain('vscode');
    expect(markup).toContain('2.1.241');
    expect(markup).toContain('darwin 24.0');
    // Last seen a day into a range that ends three days later.
    expect(markup).toContain('2d ago');
  });

  it('names the fields an install did not report instead of showing a blank', () => {
    const markup = render(detail({ installs: [install({ install_id: 'i_bare' })] }));

    expect(markup).toContain('unknown host');
    expect(markup).toContain('unreported');
  });

  it('says so when a member has no sessions or installs in the range', () => {
    const markup = render(detail({ sessions: [], sessions_total: 0, installs: [] }));

    expect(markup).toContain('No sessions in this range.');
    expect(markup).toContain('Nothing has reported under this member yet.');
  });

  it('shows their share of the team, not of themselves', () => {
    // The apostrophe is escaped on its way through the renderer.
    expect(render(detail())).toContain('90.0% of the team&#x27;s tokens in this range');
  });

  it('marks a revoked member as revoked', () => {
    const body = detail();
    const markup = render({
      ...body,
      member: { ...body.member, revoked_at: NOW - 2 * DAY },
    });
    expect(markup).toContain('revoked 2d ago');
  });

  it('keeps the name and a skeleton while the response is still in flight', () => {
    const markup = render(null, { loading: true });

    expect(markup).toContain('Alice');
    expect(markup).toContain('skeleton');
    expect(markup).toContain('loading sessions');
    expect(markup).toContain('loading installs');
  });
});
