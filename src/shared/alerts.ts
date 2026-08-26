/**
 * Alerting, as far as it can be expressed without a database or a socket: the
 * metrics a rule can watch, the calendar window it watches them over, and the
 * shape of the JSON a fire posts to a webhook.
 *
 * It lives in `shared/` because both halves need it. The server evaluates rules
 * with it; `ccledger serve` validates `--timezone` with it before anything
 * binds. Nothing here reads a database, opens a connection, or knows what a
 * Fastify request is.
 *
 * The hard part is the windows. "This week" is a calendar fact, not an
 * arithmetic one: it is not `now - 7 days`, and it is not seven multiples of
 * 86,400,000 milliseconds either, because a week containing a daylight-saving
 * transition is 167 or 169 hours long. Every boundary here is therefore
 * computed from a civil date in a named IANA zone and converted back to an
 * instant, never by adding a fixed number of milliseconds to a previous one.
 */

/** Metrics a rule can watch, in the order the dashboard offers them. */
export const ALERT_METRICS = ['share_pct', 'tokens', 'cost_usd'] as const;

/**
 * What a rule compares against its threshold.
 *
 * `share_pct` is the primary one and the default the UI opens on. On a shared
 * subscription nobody is really spending dollars — they are consuming a slice
 * of a flat plan — so "Rahim is at 52% of this week's tokens" is the sentence a
 * team actually argues about, while "$47.30" is a number they would have to
 * mentally translate first. The other two are for teams on API billing, where
 * the dollars are real.
 */
export type AlertMetric = (typeof ALERT_METRICS)[number];

/** Calendar windows a rule can be measured over. */
export const ALERT_WINDOWS = ['day', 'week'] as const;

/** How much calendar one evaluation looks back over. */
export type AlertWindow = (typeof ALERT_WINDOWS)[number];

/** What happened to the webhook a fire tried to send. */
export const ALERT_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'skipped'] as const;

/**
 * The life of one fire's webhook. `skipped` is a rule with no URL — a fire that
 * exists only to raise the badge on the dashboard — and is deliberately not
 * `failed`, because nothing went wrong.
 */
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];

/** Percent is the unit of `share_pct`, so a threshold above this means nothing. */
export const MAX_SHARE_PCT = 100;

/**
 * Members who must have used something in a window before a `share_pct` rule
 * will fire in it.
 *
 * Without this, every share rule fires on the first request of every window.
 * Whoever opens Claude Code first on a Monday is, at that instant, 100% of the
 * week's tokens — which is arithmetically true and tells nobody anything, and
 * would arrive as an alert every week until somebody turned the rule off.
 *
 * Two rather than a token floor, because the problem is not that the numbers
 * are small. A share is a comparison, and there is nothing to compare against
 * until a second person has used something. The absolute metrics — `tokens` and
 * `cost_usd` — are the ones that still mean something for a team of one, and
 * they are unaffected by this.
 */
export const SHARE_MIN_CONTRIBUTORS = 2;

/** Bound on a webhook URL, so a rule cannot be used as somewhere to put a payload. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/**
 * Which weekday a `week` window starts on, as `Date#getUTCDay` numbers it.
 * Monday, per ISO 8601 — a working week that reset mid-weekend would put two
 * halves of the same Saturday in different budgets.
 */
export const WEEK_STARTS_ON = 1;

/** Milliseconds in an hour. */
const HOUR_MS = 60 * 60 * 1000;

/** How far past a missing local midnight the transition is looked for. */
const MIDNIGHT_GAP_SEARCH_MS = 6 * HOUR_MS;

/** True when `value` is one of the three metrics a rule may watch. */
export function isAlertMetric(value: unknown): value is AlertMetric {
  return typeof value === 'string' && (ALERT_METRICS as readonly string[]).includes(value);
}

/** True when `value` is one of the two windows a rule may be measured over. */
export function isAlertWindow(value: unknown): value is AlertWindow {
  return typeof value === 'string' && (ALERT_WINDOWS as readonly string[]).includes(value);
}

/**
 * Formatters are cached because building one costs far more than using it, and
 * this map is keyed by a value that comes from `server_config` — one zone per
 * server, so the cache has one entry in every real deployment.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter that renders an instant as civil time in `timeZone`. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const made = Intl.DateTimeFormat('en-US', {
    timeZone,
    // `h23`, not `hour12: false`: some ICU builds render midnight as hour 24
    // under the latter, which would put the first second of a day in the
    // previous one.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, made);
  return made;
}

/** A date on the civil calendar, with no zone and no time attached. */
export interface CivilDate {
  readonly year: number;
  /** 1-12, as people write months rather than as `Date` numbers them. */
  readonly month: number;
  readonly day: number;
}

/** A civil date and the wall-clock time on it. */
interface CivilTime extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Epoch milliseconds for a civil date and time read as UTC.
 *
 * `setUTCFullYear` rather than `Date.UTC`, which maps a two-digit year into the
 * 1900s — the same trap `src/server/api.ts` avoids when it range-checks a
 * caller's date.
 */
function utcMs(date: CivilDate, hour = 0, minute = 0, second = 0): number {
  const probe = new Date(0);
  probe.setUTCFullYear(date.year, date.month - 1, date.day);
  probe.setUTCHours(hour, minute, second, 0);
  return probe.getTime();
}

/** The wall-clock reading a zone shows at an instant. */
function civilTimeAt(ts: number, timeZone: string): CivilTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(ts));
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Belt and braces against an ICU build that ignores `hourCycle`.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The civil date a zone is on at an instant.
 *
 * Projected down to the three fields rather than returned as the wider reading
 * it comes from: callers compare these objects, and a wall-clock time riding
 * along inside one would make two readings of the same day compare unequal.
 */
export function civilDateAt(ts: number, timeZone: string): CivilDate {
  const civil = civilTimeAt(ts, timeZone);
  return { year: civil.year, month: civil.month, day: civil.day };
}

/** Negative, zero or positive as `a` is before, on, or after `b`. */
function compareCivil(a: CivilDate, b: CivilDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** `date` moved by whole days on the civil calendar, rolling months and years. */
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const probe = new Date(0);
  probe.setUTCFullYear(date.year, date.month - 1, date.day + days);
  return {
    year: probe.getUTCFullYear(),
    month: probe.getUTCMonth() + 1,
    day: probe.getUTCDate(),
  };
}

/** Weekday of a civil date, 0 for Sunday, as `Date#getUTCDay` numbers it. */
export function civilWeekday(date: CivilDate): number {
  return new Date(utcMs(date)).getUTCDay();
}

/**
 * Milliseconds `timeZone` is ahead of UTC at an instant.
 *
 * Read by formatting the instant as civil time and asking what that reading
 * would have been worth as UTC. The instant is floored to the second first,
 * because the formatter does not report milliseconds and every real offset is a
 * whole number of minutes.
 */
function offsetAt(ts: number, timeZone: string): number {
  const civil = civilTimeAt(ts, timeZone);
  return utcMs(civil, civil.hour, civil.minute, civil.second) - Math.floor(ts / 1000) * 1000;
}

/**
 * The first instant of a civil date in a zone.
 *
 * Two passes, because the offset has to be read at an instant to be known and
 * the instant is what is being solved for: the first pass reads the offset near
 * the answer, the second reads it at a moment inside the right day. That
 * settles every ordinary day and every transition that does not happen at
 * midnight.
 *
 * A zone that springs forward at 00:00 has no local midnight at all, and there
 * the second pass lands on the previous day. The day then begins at the
 * transition, which is found by bisecting for the first instant whose civil
 * date is the one asked for.
 *
 * The mirror case — a zone that falls back across midnight, so that one civil
 * midnight happens twice — resolves to whichever of the two the offset passes
 * settle on. That is at most an hour from the ideal boundary, on at most one
 * day a year, in the few zones that transition at midnight; it is deterministic
 * either way, which is what the debounce key actually needs of it.
 */
export function startOfCivilDay(date: CivilDate, timeZone: string): number {
  const wall = utcMs(date);
  let start = wall - offsetAt(wall, timeZone);
  start = wall - offsetAt(start, timeZone);

  if (compareCivil(civilDateAt(start, timeZone), date) >= 0) return start;

  let low = start;
  let high = start + MIDNIGHT_GAP_SEARCH_MS;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareCivil(civilDateAt(middle, timeZone), date) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The half-open span `[start, end)` one evaluation measures over. */
export interface WindowBounds {
  readonly window: AlertWindow;
  /** The IANA zone the boundaries are calendar-aligned to. */
  readonly timezone: string;
  /** Epoch milliseconds, inclusive. Also the debounce key for a fire. */
  readonly start: number;
  /** Epoch milliseconds, exclusive. */
  readonly end: number;
}

/**
 * The window of the given kind containing `ts`, aligned to the calendar of
 * `timeZone`. Both boundaries come from civil dates, so a window spanning a
 * daylight-saving transition is the 23 or 25 hours it really is.
 */
export function windowBoundsAt(window: AlertWindow, ts: number, timeZone: string): WindowBounds {
  const today = civilDateAt(ts, timeZone);
  const back = window === 'day' ? 0 : (((civilWeekday(today) - WEEK_STARTS_ON) % 7) + 7) % 7;
  const first = addCivilDays(today, -back);
  const next = addCivilDays(first, window === 'day' ? 1 : 7);
  return {
    window,
    timezone: timeZone,
    start: startOfCivilDay(first, timeZone),
    end: startOfCivilDay(next, timeZone),
  };
}

/** The zone this machine is set to, e.g. `Europe/Berlin`. */
export function systemTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Every Node 20 build ships full ICU, so this fallback is for an environment
  // that reports no zone at all rather than for a case anyone will hit.
  return resolved === '' ? 'UTC' : resolved;
}

/** True when `zone` is a zone name this Node build's ICU data recognises. */
export function isValidTimeZone(zone: string): boolean {
  if (zone.trim() === '') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    // RangeError for an unknown zone. Nothing else throws from a format call.
    return false;
  }
}

/** A trimmed zone name, or `undefined` if ICU does not know it. */
export function normaliseTimeZone(zone: string): string | undefined {
  const trimmed = zone.trim();
  return isValidTimeZone(trimmed) ? trimmed : undefined;
}

/**
 * A webhook URL as it will be stored, or `undefined` if it is not one.
 *
 * `http` and `https` only. The other schemes a URL parser accepts — `file:`,
 * `data:` — name things a server-side fetch should never be pointed at, and no
 * incoming-webhook endpoint has ever used one.
 */
export function normaliseWebhookUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_WEBHOOK_URL_LENGTH) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.toString();
}

/** Counts in webhook text are grouped the way the dashboard groups them. */
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

/** Notional dollars, always to the cent. */
const MONEY_FORMAT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** A metric's value with its unit attached: `52.3%`, `$47.30`, `4,200,000`. */
export function formatMetricValue(metric: AlertMetric, value: number): string {
  if (metric === 'share_pct') return `${value.toFixed(1)}%`;
  if (metric === 'cost_usd') return MONEY_FORMAT.format(value);
  return COUNT_FORMAT.format(Math.round(value));
}

/** Everything a fire's message needs in order to name what happened. */
export interface AlertFireContext {
  readonly memberName: string;
  readonly metric: AlertMetric;
  readonly threshold: number;
  readonly value: number;
  readonly bounds: WindowBounds;
}

/** `today` / `this week`, for a sentence about when. */
function whenPhrase(window: AlertWindow): string {
  return window === 'day' ? 'today' : 'this week';
}

/** The calendar span a window covers, written the way a person would read it. */
export function formatWindowRange(bounds: WindowBounds): string {
  const format = Intl.DateTimeFormat('en-GB', {
    timeZone: bounds.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const first = format.format(new Date(bounds.start));
  if (bounds.window === 'day') return first;
  // The last instant of the window rather than its exclusive end, so a week
  // reads as Monday to Sunday instead of Monday to the following Monday.
  return `${first} to ${format.format(new Date(bounds.end - 1))}`;
}

/**
 * The sentence a webhook leads with. Written to stand on its own in a Slack
 * channel, where it will be read without any of the structured fields beside it
 * and usually without the dashboard open.
 */
export function alertText(context: AlertFireContext): string {
  const value = formatMetricValue(context.metric, context.value);
  const threshold = formatMetricValue(context.metric, context.threshold);
  const when = whenPhrase(context.bounds.window);
  const name = context.memberName;
  const headline =
    context.metric === 'share_pct'
      ? `${name} is at ${value} of ${when}'s Claude Code tokens, over the ${threshold} alert.`
      : context.metric === 'tokens'
        ? `${name} has used ${value} Claude Code tokens ${when}, over the ${threshold} alert.`
        : `${name} is at ${value} of notional Claude Code cost ${when}, over the ${threshold} alert.`;
  return `${headline}\n${formatWindowRange(context.bounds)} · ${context.bounds.timezone}`;
}

/** Usage figures carried alongside the metric that fired, for context. */
export interface AlertUsageContext {
  /** The member's tokens in the window. */
  readonly total_tokens: number;
  /** The member's notional cost in the window, in dollars. */
  readonly cost_usd: number;
  /** The member's share of the window, as a percentage. */
  readonly share_pct: number;
  /** Everyone's tokens in the window — the denominator behind `share_pct`. */
  readonly period_total_tokens: number;
}

/**
 * The JSON one fire posts.
 *
 * `text` is first and is the whole reason the payload is shaped like this: a
 * Slack incoming webhook renders a body carrying nothing but `text`, so this
 * works pasted into Slack with no transformation at all. `content` is the same
 * string under the name Discord's webhooks read, which is the one difference
 * between the two products that would otherwise make an admin choose. Both
 * ignore fields they do not recognise, which is what leaves room for the
 * structured ones underneath — those are for anything else on the far end.
 */
export interface AlertWebhookPayload {
  /** The message, for Slack and for a human. */
  readonly text: string;
  /** The same message under Discord's field name. */
  readonly content: string;
  /** Discriminator, for a receiver that handles more than one kind of hook. */
  readonly event: 'alert.fired';
  readonly rule_id: string;
  readonly member_id: string;
  readonly member_name: string;
  readonly metric: AlertMetric;
  readonly window: AlertWindow;
  readonly threshold: number;
  readonly value: number;
  /** ISO-8601, inclusive. */
  readonly window_start: string;
  /** ISO-8601, exclusive. */
  readonly window_end: string;
  /** The IANA zone the window is aligned to. */
  readonly timezone: string;
  /** ISO-8601. */
  readonly fired_at: string;
  readonly usage: AlertUsageContext;
}

/** Everything `buildAlertPayload` needs that the fire context does not carry. */
export interface AlertPayloadInput extends AlertFireContext {
  readonly ruleId: string;
  readonly memberId: string;
  readonly firedAt: number;
  readonly usage: AlertUsageContext;
}

/** Builds the JSON body one fire posts to its rule's webhook. */
export function buildAlertPayload(input: AlertPayloadInput): AlertWebhookPayload {
  const text = alertText(input);
  return {
    text,
    content: text,
    event: 'alert.fired',
    rule_id: input.ruleId,
    member_id: input.memberId,
    member_name: input.memberName,
    metric: input.metric,
    window: input.bounds.window,
    threshold: input.threshold,
    value: input.value,
    window_start: new Date(input.bounds.start).toISOString(),
    window_end: new Date(input.bounds.end).toISOString(),
    timezone: input.bounds.timezone,
    fired_at: new Date(input.firedAt).toISOString(),
    usage: input.usage,
  };
}
