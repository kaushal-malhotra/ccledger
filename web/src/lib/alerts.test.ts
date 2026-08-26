/**
 * The dashboard's alert vocabulary.
 *
 * The first test here is the one that earns its place. This module declares its
 * own metric and window lists rather than importing the shared ones, so that
 * the browser bundle does not pull in a calendar library to render three
 * dropdown labels — and the cost of that decision is a list that could silently
 * fall behind the server's. This is where it cannot.
 */

import { describe, expect, it } from 'vitest';

import { ALERT_METRICS, ALERT_WINDOWS } from '../../../src/shared/alerts.js';
import type { AlertFire, AlertRule, AlertState } from '../../../src/shared/api.js';

import {
  METRIC_CHOICES,
  WINDOW_CHOICES,
  activeByMember,
  badgeLabel,
  badgeTitle,
  deliveryLabel,
  deliveryTone,
  describeRule,
  fireValue,
  formatMetric,
  metricLabel,
  thresholdUnit,
  windowLabel,
} from './alerts.js';

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
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

/** An active state with everything defaulted but what a test cares about. */
function state(overrides: Partial<AlertState> = {}): AlertState {
  return {
    rule_id: 'ar_1',
    member_id: 'm_1',
    member_name: 'Rahim',
    metric: 'share_pct',
    window: 'week',
    threshold: 50,
    value: 60,
    window_start: 0,
    window_end: 1,
    fired: false,
    ...overrides,
  };
}

describe('the option lists', () => {
  it('offers exactly the metrics and windows the server accepts', () => {
    expect(METRIC_CHOICES.map((choice) => choice.value).sort()).toEqual([...ALERT_METRICS].sort());
    expect(WINDOW_CHOICES.map((choice) => choice.value).sort()).toEqual([...ALERT_WINDOWS].sort());
  });

  it('opens on share, which is the metric a shared plan argues about', () => {
    expect(METRIC_CHOICES[0]?.value).toBe('share_pct');
  });

  it('explains every option it offers', () => {
    for (const choice of [...METRIC_CHOICES, ...WINDOW_CHOICES]) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('units', () => {
  it('names the unit a threshold is typed in', () => {
    expect(thresholdUnit('share_pct')).toBe('%');
    expect(thresholdUnit('cost_usd')).toBe('USD');
    expect(thresholdUnit('tokens')).toBe('tokens');
  });

  it('formats a value in the unit of its metric', () => {
    expect(formatMetric('share_pct', 52.34)).toBe('52.3%');
    expect(formatMetric('cost_usd', 47.3)).toBe('$47.30');
    expect(formatMetric('tokens', 4_200_000)).toBe('4,200,000');
  });

  it('labels every metric and window', () => {
    for (const metric of ALERT_METRICS) expect(metricLabel(metric)).not.toBe(metric);
    for (const window of ALERT_WINDOWS) expect(windowLabel(window)).not.toBe(window);
  });
});

describe('describeRule', () => {
  it('says who, what and when', () => {
    expect(describeRule(rule({ member_name: 'Rahim', member_id: 'm_1' }))).toBe(
      'Rahim over 50.0% share of tokens in a week',
    );
  });

  it('calls a rule that names nobody "Anyone"', () => {
    expect(describeRule(rule())).toContain('Anyone');
  });

  it('falls back to the id when a rule names a member the list does not have', () => {
    expect(describeRule(rule({ member_id: 'm_ghost', member_name: null }))).toContain('m_ghost');
  });
});

describe('delivery status', () => {
  it('says what happened in the admin’s words', () => {
    expect(deliveryLabel('delivered')).toBe('sent');
    expect(deliveryLabel('failed')).toBe('failed');
    expect(deliveryLabel('skipped')).toBe('no webhook');
    expect(deliveryLabel('pending')).toBe('sending…');
  });

  it('reserves the danger tone for an actual failure', () => {
    expect(deliveryTone('delivered')).toContain('badge-active');
    expect(deliveryTone('failed')).toContain('badge-revoked');
    // Nothing went wrong with a rule that has no webhook, so nothing is red.
    expect(deliveryTone('skipped')).not.toContain('badge-revoked');
    expect(deliveryTone('pending')).not.toContain('badge-revoked');
  });
});

describe('activeByMember', () => {
  it('groups every state under the member it is about', () => {
    const grouped = activeByMember([
      state({ member_id: 'm_1', rule_id: 'ar_1' }),
      state({ member_id: 'm_1', rule_id: 'ar_2' }),
      state({ member_id: 'm_2', rule_id: 'ar_1' }),
    ]);
    expect(grouped.get('m_1')).toHaveLength(2);
    expect(grouped.get('m_2')).toHaveLength(1);
    expect(grouped.get('m_3')).toBeUndefined();
  });

  it('is empty when nobody is over anything', () => {
    expect(activeByMember([]).size).toBe(0);
  });
});

describe('the badge', () => {
  it('names the threshold, which is the number the rule was written with', () => {
    expect(badgeLabel(state())).toBe('over 50.0%');
    expect(badgeLabel(state({ metric: 'tokens', threshold: 4_000_000 }))).toBe('over 4,000,000');
  });

  it('says in its tooltip that it is about the window, not the range shown', () => {
    const title = badgeTitle(state(), 'Asia/Dhaka');
    expect(title).toContain('Rahim');
    expect(title).toContain('60.0%');
    expect(title).toContain('50.0%');
    expect(title).toContain('Asia/Dhaka');
    expect(title).toContain('not the range shown above');
  });
});

describe('fireValue', () => {
  it('shows what was reached against what was asked for', () => {
    const fire: AlertFire = {
      id: 'af_1',
      rule_id: 'ar_1',
      member_id: 'm_1',
      member_name: 'Rahim',
      fired_at: 0,
      value: 60,
      window_start: 0,
      metric: 'share_pct',
      window: 'week',
      threshold: 50,
      delivery_status: 'delivered',
      delivery_error: null,
      delivered_at: 0,
      attempts: 1,
    };
    expect(fireValue(fire)).toBe('60.0% of 50.0%');
  });
});
