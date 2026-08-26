/**
 * The calendar arithmetic, and the payload built on top of it.
 *
 * Most of these are about the two things a window boundary is easy to get
 * wrong: a day is not 86,400,000 milliseconds when a zone changes offset inside
 * it, and a week is not seven of those. The daylight-saving cases use real
 * transitions in real zones rather than a fixture, because the point of using
 * ICU is that the transitions are the ones that actually happened.
 */

import { describe, expect, it } from 'vitest';

import {
  ALERT_METRICS,
  ALERT_WINDOWS,
  addCivilDays,
  alertText,
  buildAlertPayload,
  civilDateAt,
  civilWeekday,
  formatMetricValue,
  isAlertMetric,
  isAlertWindow,
  isValidTimeZone,
  normaliseTimeZone,
  normaliseWebhookUrl,
  startOfCivilDay,
  systemTimeZone,
  windowBoundsAt,
} from './alerts.js';
import type { WindowBounds } from './alerts.js';

/** Hours in milliseconds, for asserting the length of a window. */
const HOUR = 60 * 60 * 1000;

/** An instant, from an ISO string, so the tests read as calendar facts. */
function at(iso: string): number {
  return Date.parse(iso);
}

describe('metric and window guards', () => {
  it('accepts exactly the three metrics and the two windows', () => {
    for (const metric of ALERT_METRICS) expect(isAlertMetric(metric)).toBe(true);
    for (const window of ALERT_WINDOWS) expect(isAlertWindow(window)).toBe(true);
    expect(isAlertMetric('cost')).toBe(false);
    expect(isAlertMetric(50)).toBe(false);
    expect(isAlertWindow('month')).toBe(false);
    expect(isAlertWindow(null)).toBe(false);
  });
});

describe('civil calendar helpers', () => {
  it('rolls a day past the end of its month into the next one', () => {
    expect(addCivilDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 1,
    });
    expect(addCivilDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(addCivilDays({ year: 2024, month: 3, day: 1 }, -1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });

  it('numbers weekdays from Sunday, as Date does', () => {
    // 2026-08-26 is a Wednesday.
    expect(civilWeekday({ year: 2026, month: 8, day: 26 })).toBe(3);
    expect(civilWeekday({ year: 2026, month: 8, day: 23 })).toBe(0);
  });

  it('reads the civil date a zone is on, not the one UTC is on', () => {
    // 22:30 UTC is already the next day in Tokyo and still the same one in UTC.
    const ts = at('2026-08-26T22:30:00Z');
    expect(civilDateAt(ts, 'UTC')).toEqual({ year: 2026, month: 8, day: 26 });
    expect(civilDateAt(ts, 'Asia/Tokyo')).toEqual({ year: 2026, month: 8, day: 27 });
  });
});

describe('startOfCivilDay', () => {
  it('is midnight UTC in UTC', () => {
    expect(startOfCivilDay({ year: 2026, month: 8, day: 26 }, 'UTC')).toBe(
      at('2026-08-26T00:00:00Z'),
    );
  });

  it('accounts for a half-hour offset', () => {
    expect(startOfCivilDay({ year: 2026, month: 8, day: 26 }, 'Asia/Kolkata')).toBe(
      at('2026-08-25T18:30:00Z'),
    );
  });

  it('lands on the transition when the zone has no local midnight', () => {
    // Chile springs forward across midnight: 2026-09-05 23:59:59 -04 is
    // followed by 2026-09-06 01:00:00 -03, so the sixth begins an hour late.
    expect(startOfCivilDay({ year: 2026, month: 9, day: 6 }, 'America/Santiago')).toBe(
      at('2026-09-06T04:00:00Z'),
    );
  });

  it('agrees with the zone about which day the instant it returns is on', () => {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
      for (const day of [1, 8, 15, 22, 28]) {
        const date = { year: 2026, month: 3, day };
        expect(civilDateAt(startOfCivilDay(date, zone), zone)).toEqual(date);
      }
    }
  });
});

describe('windowBoundsAt', () => {
  it('bounds a day by the zone calendar, not by UTC', () => {
    const bounds = windowBoundsAt('day', at('2026-08-26T22:30:00Z'), 'Asia/Tokyo');
    expect(bounds.start).toBe(at('2026-08-26T15:00:00Z'));
    expect(bounds.end).toBe(at('2026-08-27T15:00:00Z'));
    expect(bounds.timezone).toBe('Asia/Tokyo');
  });

  it('starts a week on Monday and runs it to the next Monday', () => {
    // 2026-08-26 is a Wednesday; its week starts on Monday the 24th.
    const bounds = windowBoundsAt('week', at('2026-08-26T12:00:00Z'), 'UTC');
    expect(bounds.start).toBe(at('2026-08-24T00:00:00Z'));
    expect(bounds.end).toBe(at('2026-08-31T00:00:00Z'));
  });

  it('treats Sunday as the last day of its week, not the first', () => {
    const sunday = windowBoundsAt('week', at('2026-08-30T23:00:00Z'), 'UTC');
    const wednesday = windowBoundsAt('week', at('2026-08-26T12:00:00Z'), 'UTC');
    expect(sunday.start).toBe(wednesday.start);
  });

  it('gives a spring-forward day 23 hours and a fall-back day 25', () => {
    const spring = windowBoundsAt('day', at('2026-03-08T12:00:00Z'), 'America/New_York');
    expect(spring.end - spring.start).toBe(23 * HOUR);

    const autumn = windowBoundsAt('day', at('2026-11-01T12:00:00Z'), 'America/New_York');
    expect(autumn.end - autumn.start).toBe(25 * HOUR);
  });

  it('gives the week containing a transition 167 hours, not 168', () => {
    // 2026-03-08 is the US spring-forward Sunday, which is the last day of the
    // week beginning Monday the 2nd — so that week, not the one after it, is
    // the short one.
    const bounds = windowBoundsAt('week', at('2026-03-04T12:00:00Z'), 'America/New_York');
    expect(bounds.start).toBe(at('2026-03-02T05:00:00Z'));
    expect(bounds.end - bounds.start).toBe(167 * HOUR);

    const after = windowBoundsAt('week', at('2026-03-10T12:00:00Z'), 'America/New_York');
    expect(after.end - after.start).toBe(168 * HOUR);
  });

  it('is stable across every instant inside the window it describes', () => {
    const zone = 'Europe/Berlin';
    const first = windowBoundsAt('week', at('2026-08-24T00:00:00Z') + 1, zone);
    for (const offset of [HOUR, 26 * HOUR, 100 * HOUR]) {
      const later = windowBoundsAt('week', first.start + offset, zone);
      expect(later.start).toBe(first.start);
      expect(later.end).toBe(first.end);
    }
    // One millisecond past the end is the next window, which is the property
    // the debounce depends on.
    expect(windowBoundsAt('week', first.end, zone).start).toBe(first.end);
  });
});

describe('timezone validation', () => {
  it('accepts real zones and rejects invented ones', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
  });

  it('trims what it accepts and returns undefined for what it does not', () => {
    expect(normaliseTimeZone('  Asia/Tokyo  ')).toBe('Asia/Tokyo');
    expect(normaliseTimeZone('nowhere')).toBeUndefined();
  });

  it('reports a zone this machine actually has', () => {
    expect(isValidTimeZone(systemTimeZone())).toBe(true);
  });
});

describe('normaliseWebhookUrl', () => {
  it('accepts http and https', () => {
    expect(normaliseWebhookUrl('https://hooks.slack.com/services/T/B/x')).toBe(
      'https://hooks.slack.com/services/T/B/x',
    );
    expect(normaliseWebhookUrl(' http://localhost:9000/hook ')).toBe('http://localhost:9000/hook');
  });

  it('refuses schemes a server-side fetch should never follow', () => {
    expect(normaliseWebhookUrl('file:///etc/passwd')).toBeUndefined();
    expect(normaliseWebhookUrl('data:text/plain,hello')).toBeUndefined();
    expect(normaliseWebhookUrl('ftp://example.invalid/x')).toBeUndefined();
  });

  it('refuses what is not a URL at all, and what is too long to be one', () => {
    expect(normaliseWebhookUrl('hooks.slack.com/services')).toBeUndefined();
    expect(normaliseWebhookUrl('')).toBeUndefined();
    expect(normaliseWebhookUrl(`https://e.invalid/${'x'.repeat(4000)}`)).toBeUndefined();
  });
});

describe('formatMetricValue', () => {
  it('carries the unit of the metric it is formatting', () => {
    expect(formatMetricValue('share_pct', 52.34)).toBe('52.3%');
    expect(formatMetricValue('cost_usd', 47.3)).toBe('$47.30');
    expect(formatMetricValue('tokens', 4_200_000)).toBe('4,200,000');
  });
});

describe('alertText', () => {
  const bounds: WindowBounds = {
    window: 'week',
    timezone: 'UTC',
    start: at('2026-08-24T00:00:00Z'),
    end: at('2026-08-31T00:00:00Z'),
  };

  it('leads with the share, the threshold and the person', () => {
    const text = alertText({
      memberName: 'Rahim',
      metric: 'share_pct',
      threshold: 50,
      value: 52.34,
      bounds,
    });
    expect(text).toContain('Rahim');
    expect(text).toContain('52.3%');
    expect(text).toContain('50.0%');
    expect(text).toContain("this week's");
  });

  it('names the calendar span and the zone on its own line', () => {
    const text = alertText({
      memberName: 'Rahim',
      metric: 'tokens',
      threshold: 1000,
      value: 2000,
      bounds,
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    // Monday to Sunday, not Monday to the following Monday.
    expect(lines[1]).toContain('Mon, 24 Aug 2026');
    expect(lines[1]).toContain('Sun, 30 Aug 2026');
    expect(lines[1]).toContain('UTC');
  });

  it('says today rather than this week for a daily window', () => {
    const text = alertText({
      memberName: 'Ana',
      metric: 'cost_usd',
      threshold: 10,
      value: 12.5,
      bounds: {
        window: 'day',
        timezone: 'UTC',
        start: at('2026-08-26T00:00:00Z'),
        end: at('2026-08-27T00:00:00Z'),
      },
    });
    expect(text).toContain('today');
    expect(text).toContain('$12.50');
    expect(text).not.toContain('this week');
  });
});

describe('buildAlertPayload', () => {
  const payload = buildAlertPayload({
    ruleId: 'ar_1',
    memberId: 'm_1',
    memberName: 'Rahim',
    metric: 'share_pct',
    threshold: 50,
    value: 52.34,
    firedAt: at('2026-08-26T09:00:00Z'),
    bounds: {
      window: 'week',
      timezone: 'UTC',
      start: at('2026-08-24T00:00:00Z'),
      end: at('2026-08-31T00:00:00Z'),
    },
    usage: {
      total_tokens: 5234,
      cost_usd: 1.25,
      share_pct: 52.34,
      period_total_tokens: 10_000,
    },
  });

  it('carries the message under both names, so Slack and Discord both render it', () => {
    expect(payload.text).toContain('Rahim');
    expect(payload.content).toBe(payload.text);
  });

  it('carries the structured fields alongside, as ISO instants', () => {
    expect(payload.event).toBe('alert.fired');
    expect(payload.rule_id).toBe('ar_1');
    expect(payload.member_id).toBe('m_1');
    expect(payload.metric).toBe('share_pct');
    expect(payload.window).toBe('week');
    expect(payload.threshold).toBe(50);
    expect(payload.value).toBeCloseTo(52.34, 5);
    expect(payload.window_start).toBe('2026-08-24T00:00:00.000Z');
    expect(payload.window_end).toBe('2026-08-31T00:00:00.000Z');
    expect(payload.fired_at).toBe('2026-08-26T09:00:00.000Z');
    expect(payload.timezone).toBe('UTC');
    expect(payload.usage.period_total_tokens).toBe(10_000);
  });

  it('survives JSON, which is the only form anything else will see it in', () => {
    const round: unknown = JSON.parse(JSON.stringify(payload));
    expect(round).toEqual(payload);
  });
});
