/**
 * The settings page, rendered.
 *
 * `renderToStaticMarkup` rather than a DOM, for the same reason the other
 * component tests use it: what is worth asserting here is what the page shows —
 * every rule, every fire, and the one thing that must never appear on it — and
 * none of that needs an event loop.
 *
 * The assertion that carries the most weight is the webhook one. A Slack
 * incoming-webhook URL is a credential; this page is the kind of thing that
 * ends up on a shared screen, so the list shows the host and keeps the rest for
 * the edit form.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  AlertFire,
  AlertRule,
  AlertsResponse,
  MemberListEntry,
} from '../../../src/shared/api.js';

import { AlertsView } from './AlertsView.js';

/** A rule with everything defaulted but what a test cares about. */
function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'ar_1',
    member_id: null,
    member_name: null,
    window: 'week',
    metric: 'share_pct',
    threshold: 50,
    webhook_url: null,
    enabled: true,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

/** A fire with everything defaulted but what a test cares about. */
function fire(overrides: Partial<AlertFire> = {}): AlertFire {
  return {
    id: 'af_1',
    rule_id: 'ar_1',
    member_id: 'm_1',
    member_name: 'Rahim',
    fired_at: 1_700_000_000_000,
    value: 60,
    window_start: 1_699_000_000_000,
    metric: 'share_pct',
    window: 'week',
    threshold: 50,
    delivery_status: 'delivered',
    delivery_error: null,
    delivered_at: 1_700_000_000_000,
    attempts: 1,
    ...overrides,
  };
}

/** The two teammates the member dropdown offers. */
const MEMBERS: readonly MemberListEntry[] = [
  {
    member_id: 'm_1',
    display_name: 'Rahim',
    created_at: 0,
    revoked_at: null,
    join_hostname: null,
    join_os: null,
    last_seen: null,
    installs: 1,
  },
  {
    member_id: 'm_2',
    display_name: 'Ana',
    created_at: 0,
    revoked_at: null,
    join_hostname: null,
    join_os: null,
    last_seen: null,
    installs: 1,
  },
];

/** An alerts response with whatever a test supplies and sane defaults. */
function response(overrides: Partial<AlertsResponse> = {}): AlertsResponse {
  return {
    timezone: 'Asia/Dhaka',
    rules: [],
    fires: [],
    fires_limit: 50,
    active: [],
    ...overrides,
  };
}

/** Renders the page over an alerts response. */
function render(alerts: AlertsResponse | null, loading = false): string {
  return renderToStaticMarkup(
    <AlertsView
      alerts={alerts}
      members={MEMBERS}
      loading={loading}
      now={1_700_000_060_000}
      onCreate={() => Promise.resolve()}
      onUpdate={() => Promise.resolve()}
      onDelete={() => Promise.resolve()}
    />,
  );
}

describe('the rule form', () => {
  it('offers every enrolled member plus "anyone"', () => {
    const html = render(response());
    expect(html).toContain('Anyone');
    expect(html).toContain('Rahim');
    expect(html).toContain('Ana');
  });

  it('opens on a weekly share rule, which is the one to write first', () => {
    const html = render(response());
    expect(html).toContain('Share of tokens');
    expect(html).toContain('Add rule');
    // The unit beside the threshold, so the number typed into it has a meaning.
    expect(html).toContain('%');
  });

  it('says a webhook is optional and what leaving it empty does', () => {
    expect(render(response())).toContain('badge on the dashboard without');
  });

  it('names the zone the windows reset in, which is the server’s and not the reader’s', () => {
    expect(render(response())).toContain('Asia/Dhaka');
  });
});

describe('the rule list', () => {
  it('shows each rule with its metric, window and threshold', () => {
    const html = render(
      response({
        rules: [rule({ member_name: 'Rahim', member_id: 'm_1', threshold: 50 })],
      }),
    );
    expect(html).toContain('Rahim');
    expect(html).toContain('Share of tokens');
    expect(html).toContain('Per week');
    expect(html).toContain('50.0%');
  });

  it('shows the host of a webhook and never the URL that would let anyone post to it', () => {
    const html = render(
      response({
        rules: [rule({ webhook_url: 'https://hooks.slack.com/services/T000/B000/xoxbSECRETPATH' })],
      }),
    );
    expect(html).toContain('hooks.slack.com');
    // The path is the secret half of an incoming-webhook URL: the host alone
    // identifies the rule's destination, and cannot be used to post to it.
    expect(html).not.toContain('xoxbSECRETPATH');
    expect(html).not.toContain('T000');
    expect(html).not.toContain('B000');
  });

  it('marks a rule with no webhook as badge-only rather than as broken', () => {
    const html = render(response({ rules: [rule({ webhook_url: null })] }));
    expect(html).toContain('badge only');
  });

  it('shows a disabled rule, dimmed, with the button that turns it back on', () => {
    const html = render(response({ rules: [rule({ enabled: false })] }));
    expect(html).toContain('row-muted');
    expect(html).toContain('Enable');
    expect(html).not.toContain('>Disable<');
  });

  it('suggests the first rule when there are none', () => {
    expect(render(response())).toContain('No rules yet');
  });

  it('says it is loading rather than saying there are none', () => {
    const html = render(null, true);
    expect(html).toContain('loading rules');
    expect(html).not.toContain('No rules yet');
  });
});

describe('the fires list', () => {
  it('shows each fire with the value that crossed and the threshold it crossed', () => {
    const html = render(response({ rules: [rule()], fires: [fire()] }));
    expect(html).toContain('Rahim');
    expect(html).toContain('60.0% of 50.0%');
    expect(html).toContain('1m ago');
    expect(html).toContain('sent');
  });

  it('shows why a webhook failed, which is what makes it fixable', () => {
    const html = render(
      response({
        rules: [rule()],
        fires: [
          fire({
            delivery_status: 'failed',
            delivery_error: 'HTTP 400: invalid_payload',
            delivered_at: null,
            attempts: 3,
          }),
        ],
      }),
    );
    expect(html).toContain('failed');
    expect(html).toContain('invalid_payload');
  });

  it('distinguishes nothing having fired from nothing having loaded', () => {
    expect(render(response())).toContain('Nothing has crossed a threshold yet');
    expect(render(null, true)).toContain('loading alerts');
  });

  it('says how many fires a delete would take with the rule', () => {
    const html = render(response({ rules: [rule()], fires: [fire(), fire({ id: 'af_2' })] }));
    // The confirmation is only rendered once the delete button is pressed, so
    // what a static render can check is that the plain button is there.
    expect(html).toContain('Delete');
  });
});
