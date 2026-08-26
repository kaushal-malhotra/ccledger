/**
 * The read API: the routes that turn a date range into numbers, plus the alert
 * routes registered from `alertroutes.ts` onto the same guarded scope.
 *
 * Everything here is guarded, but not by anything in this file. `buildApp`
 * installs one `onRequest` hook over the whole `/api` prefix, so a route added
 * below is authenticated whether or not whoever adds it remembers to — and an
 * unauthenticated caller gets the same 401 for a path that exists and a path
 * that does not, which is the only answer that tells a prober nothing.
 *
 * What this file does own is the boundary between a query string and a query.
 * Two rules:
 *
 * - A range is validated twice. The Fastify schema rejects anything that is not
 *   shaped like an ISO-8601 instant, and the handler then rejects anything
 *   `Date.parse` will not accept — the schema cannot know that 2026-02-30 is
 *   not a day. Both failures are 400s, because both describe a request that
 *   will never be answerable.
 * - A date-time must carry a zone. `2026-08-20T09:00:00` means one instant on
 *   the machine that typed it and another on the machine that serves it, and
 *   silently choosing the server's clock is how a dashboard ends up an hour
 *   wrong for exactly the people who are not in the server's timezone.
 *
 * None of these handlers add anything up. They resolve a range, hand it to
 * `src/db/queries.ts`, and shape the answer for the wire.
 */

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { registerAlertRoutes } from './alertroutes.js';
import { findMember, revokeMember } from './auth.js';
import { JSON_CONTENT_TYPE, fail } from './reply.js';
import {
  BUCKET_MS,
  EMPTY_TOTALS,
  installsOfMember,
  memberEntry,
  memberList,
  memberUsageInRange,
  modelUsageInRange,
  sessionUsageInRange,
  sourceUsageInRange,
  timeseriesInRange,
  timeseriesMembers,
  totalsInRange,
} from '../db/queries.js';
import type { SourceFilter, UsageRange } from '../db/queries.js';
import type {
  BucketSize,
  FilterInfo,
  MemberDetailResponse,
  MembersResponse,
  ModelsResponse,
  RangeInfo,
  RevokeResponse,
  SourceGroup,
  SummaryResponse,
  TimeseriesResponse,
  UsageTotals,
} from '../shared/api.js';
import { ADMIN_API_PREFIX, MEMBER_SESSIONS_LIMIT } from '../shared/constants.js';

/** Milliseconds in a day, for the default range and the bucket heuristic. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back `from` reaches when a caller gives only `to`, or neither. */
const DEFAULT_RANGE_MS = 7 * DAY_MS;

/** Ranges shorter than this get hourly buckets when the caller does not choose. */
const HOURLY_UNDER_MS = 3 * DAY_MS;

/** Minutes east of UTC that any real timezone falls within, inclusive. */
const MAX_TZ_OFFSET_MINUTES = 840;

/**
 * A calendar date, or a date-time carrying an explicit zone. This is the
 * ECMAScript Date Time String Format narrowed by one rule: the zone is not
 * optional on the date-time form. A bare date stays legal and means midnight
 * UTC, which is what `Date.parse` already does with it.
 */
const ISO_INSTANT_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?(Z|[+-]\\d{2}:\\d{2}))?$';

/** What every ranged endpoint accepts. `from`/`to` default; the rest narrow. */
const RANGE_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', pattern: ISO_INSTANT_PATTERN },
    to: { type: 'string', pattern: ISO_INSTANT_PATTERN },
    group: { type: 'string', enum: ['all', 'work', 'overhead'] },
    source: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/** `RANGE_QUERY_SCHEMA` plus the two knobs only the timeseries has. */
const TIMESERIES_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...RANGE_QUERY_SCHEMA.properties,
    bucket: { type: 'string', enum: ['hour', 'day'] },
    tz_offset: {
      type: 'integer',
      minimum: -MAX_TZ_OFFSET_MINUTES,
      maximum: MAX_TZ_OFFSET_MINUTES,
    },
  },
} as const;

/** The `:id` of a member route. Bounded, not interpreted. */
const MEMBER_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

/** The query string every ranged endpoint reads, after schema validation. */
interface RangeQuery {
  readonly from?: string;
  readonly to?: string;
  readonly group?: SourceGroup;
  readonly source?: string;
}

/** `RangeQuery` plus the timeseries knobs. */
interface TimeseriesQuery extends RangeQuery {
  readonly bucket?: BucketSize;
  readonly tz_offset?: number;
}

/** The `:id` route parameter. */
interface MemberParams {
  readonly id: string;
}

/** A resolved range, or the sentence to answer 400 with. */
type RangeResult =
  | { readonly ok: true; readonly range: UsageRange; readonly info: RangeInfo }
  | { readonly ok: false; readonly error: string };

/**
 * Epoch milliseconds for an ISO string that has already matched
 * `ISO_INSTANT_PATTERN`, or `undefined` if it names no instant.
 *
 * The calendar check is not redundant. `Date.parse` rejects a thirteenth month
 * but rolls a day past the end of its month into the next one, so `2026-02-30`
 * comes back as `2026-03-02` and a range that was mistyped by one character
 * quietly answers about two different days. Every other component — hour,
 * minute, second — is range-checked by the parser itself.
 */
function parseInstant(value: string): number | undefined {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  // `setUTCFullYear` rather than `Date.UTC`, which maps a two-digit year into
  // the 1900s and would reject year 0026 as a mismatch against 1926.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  const rolledOver =
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day;

  return rolledOver ? undefined : ms;
}

/**
 * Resolves `from`/`to` into a half-open range. Both are optional: `to` defaults
 * to now and `from` to a week before it, so `curl`ing an endpoint with no
 * arguments answers a useful question rather than a validation error.
 */
export function resolveRange(query: RangeQuery, now: number): RangeResult {
  const to = query.to === undefined ? now : parseInstant(query.to);
  if (to === undefined) {
    return { ok: false, error: 'to is not a date this calendar has' };
  }
  const from = query.from === undefined ? to - DEFAULT_RANGE_MS : parseInstant(query.from);
  if (from === undefined) {
    return { ok: false, error: 'from is not a date this calendar has' };
  }
  if (from >= to) {
    return { ok: false, error: 'from must be earlier than to' };
  }
  return {
    ok: true,
    range: { from, to },
    info: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      from_ms: from,
      to_ms: to,
    },
  };
}

/** The source narrowing a query asked for, in both the SQL and the wire shape. */
export function resolveFilter(query: RangeQuery): {
  readonly filter: SourceFilter;
  readonly info: FilterInfo;
} {
  const group = query.group ?? 'all';
  if (query.source === undefined) {
    return { filter: { group }, info: { group, source: null } };
  }
  return { filter: { group, source: query.source }, info: { group, source: query.source } };
}

/**
 * The bucket to aggregate into. An explicit `bucket` always wins; otherwise a
 * range short enough to read hour by hour gets hours, and anything longer gets
 * days — 30 days of hourly buckets is 720 points nobody can see.
 */
export function resolveBucket(query: TimeseriesQuery, range: UsageRange): BucketSize {
  if (query.bucket !== undefined) return query.bucket;
  return range.to - range.from < HOURLY_UNDER_MS ? 'hour' : 'day';
}

/**
 * The eight aggregate fields alone. Every row type in `queries.ts` widens
 * `UsageTotals` with its own identity columns, and sending the row as-is would
 * put a `member_id` and a `share_pct` inside a `totals` object.
 */
function pickTotals(row: UsageTotals): UsageTotals {
  return {
    total_tokens: row.total_tokens,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    requests: row.requests,
    sessions: row.sessions,
    cost_micros: row.cost_micros,
  };
}

/**
 * Registers the read API on an app whose `/api` prefix is already guarded.
 * Takes the instance rather than being a plugin so the routes share the app's
 * scope: the admin hook is installed there, and a child scope would need it
 * installed again.
 */
export function registerApiRoutes(app: FastifyInstance, db: Database.Database): void {
  // Same scope, same guard. Alerting is enough routes to be its own file and
  // not enough to be its own prefix.
  registerAlertRoutes(app, db);

  app.get<{ Querystring: RangeQuery }>(
    `${ADMIN_API_PREFIX}/summary`,
    { schema: { querystring: RANGE_QUERY_SCHEMA } },
    (request, reply) => {
      const resolved = resolveRange(request.query, Date.now());
      if (!resolved.ok) {
        fail(reply, 400, resolved.error);
        return;
      }
      const { filter, info } = resolveFilter(request.query);
      const body: SummaryResponse = {
        range: resolved.info,
        filter: info,
        totals: totalsInRange(db, resolved.range, filter),
        members: memberUsageInRange(db, resolved.range, filter),
        // Unfiltered on purpose: this is what the filter control is built from.
        sources: sourceUsageInRange(db, resolved.range),
      };
      reply.code(200).type(JSON_CONTENT_TYPE).send(body);
    },
  );

  app.get<{ Querystring: TimeseriesQuery }>(
    `${ADMIN_API_PREFIX}/timeseries`,
    { schema: { querystring: TIMESERIES_QUERY_SCHEMA } },
    (request, reply) => {
      const resolved = resolveRange(request.query, Date.now());
      if (!resolved.ok) {
        fail(reply, 400, resolved.error);
        return;
      }
      const { filter, info } = resolveFilter(request.query);
      const bucket = resolveBucket(request.query, resolved.range);
      const offset = request.query.tz_offset ?? 0;
      const body: TimeseriesResponse = {
        range: resolved.info,
        filter: info,
        bucket,
        bucket_ms: BUCKET_MS[bucket],
        tz_offset_minutes: offset,
        members: timeseriesMembers(db, resolved.range, filter),
        points: timeseriesInRange(db, resolved.range, filter, BUCKET_MS[bucket], offset),
      };
      reply.code(200).type(JSON_CONTENT_TYPE).send(body);
    },
  );

  app.get<{ Querystring: RangeQuery }>(
    `${ADMIN_API_PREFIX}/models`,
    { schema: { querystring: RANGE_QUERY_SCHEMA } },
    (request, reply) => {
      const resolved = resolveRange(request.query, Date.now());
      if (!resolved.ok) {
        fail(reply, 400, resolved.error);
        return;
      }
      const { filter, info } = resolveFilter(request.query);
      const body: ModelsResponse = {
        range: resolved.info,
        filter: info,
        totals: totalsInRange(db, resolved.range, filter),
        models: modelUsageInRange(db, resolved.range, filter),
      };
      reply.code(200).type(JSON_CONTENT_TYPE).send(body);
    },
  );

  // Unranged: who is enrolled and when each of them was last heard from. An
  // admin asking "is Bob reporting?" is asking about all of time, not about
  // whatever range the dashboard happens to be showing.
  app.get(`${ADMIN_API_PREFIX}/members`, (_request, reply) => {
    const body: MembersResponse = { members: memberList(db) };
    reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  });

  app.get<{ Params: MemberParams; Querystring: RangeQuery }>(
    `${ADMIN_API_PREFIX}/members/:id`,
    { schema: { params: MEMBER_PARAMS_SCHEMA, querystring: RANGE_QUERY_SCHEMA } },
    (request, reply) => {
      const member = memberEntry(db, request.params.id);
      if (member === undefined) {
        fail(reply, 404, 'no such member');
        return;
      }
      const resolved = resolveRange(request.query, Date.now());
      if (!resolved.ok) {
        fail(reply, 400, resolved.error);
        return;
      }
      const { filter, info } = resolveFilter(request.query);

      // Taken from the same query the summary table is drawn from, so a
      // member's share here and their share there cannot disagree. A member
      // the range holds nothing for is absent from it, which is zero usage.
      const usage = memberUsageInRange(db, resolved.range, filter).find(
        (row) => row.member_id === member.member_id,
      );
      const sessions = sessionUsageInRange(
        db,
        member.member_id,
        resolved.range,
        filter,
        MEMBER_SESSIONS_LIMIT,
      );

      const body: MemberDetailResponse = {
        range: resolved.info,
        filter: info,
        member,
        totals: usage === undefined ? EMPTY_TOTALS : pickTotals(usage),
        share_pct: usage?.share_pct ?? 0,
        sessions,
        sessions_total: usage?.sessions ?? 0,
        sessions_limit: MEMBER_SESSIONS_LIMIT,
        models: modelUsageInRange(db, resolved.range, filter, member.member_id),
        installs: installsOfMember(db, member.member_id),
      };
      reply.code(200).type(JSON_CONTENT_TYPE).send(body);
    },
  );

  // Revocation is idempotent and says so. A second call answers 200 with
  // `revoked: false` and the original timestamp, because the moment access
  // actually stopped is a fact about the past and must not be rewritten by
  // someone clicking twice.
  app.post<{ Params: MemberParams }>(
    `${ADMIN_API_PREFIX}/members/:id/revoke`,
    { schema: { params: MEMBER_PARAMS_SCHEMA } },
    (request, reply) => {
      const id = request.params.id;
      if (findMember(db, id) === undefined) {
        fail(reply, 404, 'no such member');
        return;
      }
      const revoked = revokeMember(db, id);
      const after = findMember(db, id);
      request.log.info({ memberId: id, revoked }, 'member revoked by admin');
      const body: RevokeResponse = {
        member_id: id,
        revoked,
        revoked_at: after?.revokedAt ?? null,
      };
      reply.code(200).type(JSON_CONTENT_TYPE).send(body);
    },
  );
}
