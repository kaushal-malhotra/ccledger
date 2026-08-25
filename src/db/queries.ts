/**
 * Every read the dashboard makes, as SQL aggregates.
 *
 * The rule this file exists to keep is that no query here returns rows to be
 * added up in JavaScript. A month of a busy team is hundreds of thousands of
 * `requests` rows; summing them in the server means holding all of them in
 * memory to produce eight numbers, and it means the numbers on the dashboard
 * are only as correct as the loop that made them. SQLite already has `SUM`,
 * `COUNT(DISTINCT ...)` and window-free CTEs, and it is in-process, so the
 * aggregate costs one statement and no allocation per row.
 *
 * Two consequences follow, and both are deliberate:
 *
 * - Shares are computed in SQL against the period total, so they sum to 100 by
 *   construction rather than by a second pass that could disagree with the
 *   first. The `CASE` guarding the divisor is what keeps an empty range from
 *   producing `NULL` shares.
 * - `cost_micros` is summed as an integer and never divided. A dashboard that
 *   divides by a million to draw a dollar figure is doing display; a query that
 *   divides before summing is losing money to floating point.
 *
 * Nothing user-supplied is ever concatenated into a statement. The only text
 * this file interpolates is chosen from closed sets defined above it — the
 * predicate for a validated `group`, the placeholder names for a compile-time
 * constant list — and every value binds as a named parameter.
 */

import type Database from 'better-sqlite3';

import type {
  InstallInfo,
  MemberListEntry,
  MemberUsage,
  ModelUsage,
  SessionUsage,
  SourceGroup,
  SourceUsage,
  TimeseriesMember,
  TimeseriesPoint,
  UsageTotals,
} from '../shared/api.js';
import {
  OVERHEAD_QUERY_SOURCES,
  SOURCE_NONE,
  UNATTRIBUTED_MEMBER_ID,
} from '../shared/constants.js';

/** Milliseconds in the two bucket widths `GET /api/timeseries` offers. */
export const BUCKET_MS: Readonly<Record<'hour' | 'day', number>> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/** Named parameters as better-sqlite3 takes them. */
type Params = Record<string, string | number>;

/** A half-open range of epoch milliseconds, `[from, to)`. */
export interface UsageRange {
  /** Inclusive. */
  readonly from: number;
  /** Exclusive. */
  readonly to: number;
}

/**
 * Which requests a query counts. `group` and `source` are ANDed: asking for
 * overhead and for a source that is not overhead returns nothing, which is the
 * honest answer rather than a precedence rule to remember.
 */
export interface SourceFilter {
  readonly group: SourceGroup;
  /** An exact `query_source`, or `SOURCE_NONE` for the rows carrying none. */
  readonly source?: string;
}

/** Counts nothing out. */
export const ALL_SOURCES: SourceFilter = { group: 'all' };

/** A fragment to append to a `WHERE`, and the values it binds. */
interface Predicate {
  /** Begins with ` AND ` when non-empty, so it appends to any `WHERE`. */
  readonly sql: string;
  readonly params: Params;
}

/**
 * The eight aggregates every grouping returns. Written against a `requests`
 * aliased `r`, and `COUNT(r.id)` rather than `COUNT(*)` so the same text is
 * correct on the outer side of a `LEFT JOIN`, where a member with no requests
 * in the range must count zero rather than one.
 */
const TOKEN_AGGREGATES = `
    COALESCE(SUM(
      r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens
    ), 0) AS total_tokens,
    COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(r.cache_creation_tokens), 0) AS cache_creation_tokens,
    COUNT(r.id) AS requests,
    COALESCE(SUM(r.cost_micros), 0) AS cost_micros`;

/** `TOKEN_AGGREGATES` plus the distinct session count. */
const USAGE_AGGREGATES = `${TOKEN_AGGREGATES},
    COUNT(DISTINCT r.session_id) AS sessions`;

/**
 * Which bucket a timestamp falls in: shift by the timezone offset, floor to the
 * bucket width, shift back.
 *
 * The `CAST`s are load-bearing. better-sqlite3 binds every JavaScript number as
 * a SQLite REAL — JavaScript has no other numeric type to bind — so without
 * them `r.ts / @bucketMs` is floating-point division, nothing is floored, and
 * every row comes back in a bucket of its own starting at its own timestamp.
 * It is the same shape of bug as OTLP's stringified 64-bit integers: the value
 * reads correctly and the type is quietly wrong.
 */
const BUCKET_START_SQL =
  '((r.ts + CAST(@offsetMs AS INTEGER)) / CAST(@bucketMs AS INTEGER))' +
  ' * CAST(@bucketMs AS INTEGER) - CAST(@offsetMs AS INTEGER)';

/** The identity columns `GET /api/members` returns, and the two derived ones. */
const MEMBER_ENTRY_COLUMNS = `
    m.id AS member_id,
    m.display_name AS display_name,
    m.created_at AS created_at,
    m.revoked_at AS revoked_at,
    m.join_hostname AS join_hostname,
    m.join_os AS join_os,
    (SELECT COUNT(*) FROM installs i WHERE i.member_id = m.id) AS installs,
    NULLIF(
      max(
        COALESCE((SELECT max(i.last_seen) FROM installs i WHERE i.member_id = m.id), 0),
        COALESCE((SELECT max(r.ts) FROM requests r WHERE r.member_id = m.id), 0)
      ),
      0
    ) AS last_seen`;

/**
 * The share column, as a percentage of `period.total`. A `CASE` rather than
 * `NULLIF`: an empty range must give every row 0, not `NULL`, because the
 * dashboard renders the number and `null` is not a number.
 */
function sharePct(table: string): string {
  return `CASE WHEN period.total > 0
      THEN 100.0 * ${table}.total_tokens / period.total
      ELSE 0.0 END AS share_pct`;
}

/**
 * Turns a validated filter into SQL. The overhead list is a compile-time
 * constant, so its placeholders are generated rather than typed out, and the
 * values still bind — the SQL text depends only on how many there are.
 *
 * `work` keeps rows whose source is NULL: a request that carried no
 * `query_source` is not known overhead, and dropping it would make the filtered
 * totals smaller than the unfiltered ones for no reason a reader could see.
 */
export function sourcePredicate(filter: SourceFilter): Predicate {
  const params: Params = {};
  const clauses: string[] = [];

  if (filter.group !== 'all') {
    const placeholders = OVERHEAD_QUERY_SOURCES.map((value, index) => {
      const name = `ovh${String(index)}`;
      params[name] = value;
      return `@${name}`;
    }).join(', ');
    clauses.push(
      filter.group === 'overhead'
        ? `r.query_source IN (${placeholders})`
        : `(r.query_source IS NULL OR r.query_source NOT IN (${placeholders}))`,
    );
  }

  if (filter.source !== undefined) {
    if (filter.source === SOURCE_NONE) {
      clauses.push('r.query_source IS NULL');
    } else {
      params.source = filter.source;
      clauses.push('r.query_source = @source');
    }
  }

  return { sql: clauses.map((clause) => `\n      AND ${clause}`).join(''), params };
}

/** The range predicate and its parameters, which every read starts from. */
function rangeParams(range: UsageRange): Params {
  return { from: range.from, to: range.to };
}

/** What an aggregate over no rows at all looks like. */
export const EMPTY_TOTALS: UsageTotals = {
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  requests: 0,
  sessions: 0,
  cost_micros: 0,
};

/** Aggregates over the whole range, ignoring who or what produced them. */
export function totalsInRange(
  db: Database.Database,
  range: UsageRange,
  filter: SourceFilter,
): UsageTotals {
  const predicate = sourcePredicate(filter);
  const row = db
    .prepare<Params, UsageTotals>(
      `SELECT${USAGE_AGGREGATES}
       FROM requests r
       WHERE r.ts >= @from AND r.ts < @to${predicate.sql}`,
    )
    .get({ ...rangeParams(range), ...predicate.params });
  // `SELECT SUM(...)` over an empty table still returns one row, so this is
  // unreachable; the fallback keeps the return type honest without an assertion.
  return row ?? EMPTY_TOTALS;
}

/**
 * Per-member aggregates, heaviest first, with each member's share of the
 * period.
 *
 * The join is a `LEFT JOIN` from `members` so that a teammate who reported
 * nothing this week is still a row — "Bob is at zero" and "Bob is missing" are
 * different facts, and the second is what an admin needs to see. The `HAVING`
 * then drops the two kinds of row that would be noise: a revoked member with no
 * activity in the range, and the placeholder member that migration 2 seeded for
 * stage 1's unauthenticated rows, which has no owner to attribute anything to.
 */
export function memberUsageInRange(
  db: Database.Database,
  range: UsageRange,
  filter: SourceFilter,
): MemberUsage[] {
  const predicate = sourcePredicate(filter);
  return db
    .prepare<Params, MemberUsage>(
      `WITH per_member AS (
         SELECT
           m.id AS member_id,
           m.display_name AS display_name,
           m.revoked_at AS revoked_at,
           max(r.ts) AS last_request,${USAGE_AGGREGATES}
         FROM members m
         LEFT JOIN requests r
           ON r.member_id = m.id
          AND r.ts >= @from AND r.ts < @to${predicate.sql}
         GROUP BY m.id, m.display_name, m.revoked_at
         HAVING COUNT(r.id) > 0
             OR (m.revoked_at IS NULL AND m.id <> @placeholder)
       ),
       period AS (SELECT COALESCE(SUM(total_tokens), 0) AS total FROM per_member)
       SELECT per_member.*, ${sharePct('per_member')}
       FROM per_member, period
       ORDER BY per_member.total_tokens DESC, per_member.display_name COLLATE NOCASE ASC`,
    )
    .all({ ...rangeParams(range), ...predicate.params, placeholder: UNATTRIBUTED_MEMBER_ID });
}

/**
 * Per-`query_source` aggregates for the range, unfiltered by source on purpose:
 * this is what the dashboard's source control is built from, so narrowing it by
 * the current selection would leave one option and no way back.
 */
export function sourceUsageInRange(db: Database.Database, range: UsageRange): SourceUsage[] {
  // The overhead list is bound here to classify each row, not to filter any
  // out: `IN (...)` feeds a `CASE`, and there is no `WHERE` clause for it.
  const overhead = OVERHEAD_QUERY_SOURCES.map((value, index) => {
    const name = `ovh${String(index)}`;
    return { name, value };
  });
  const placeholders = overhead.map((entry) => `@${entry.name}`).join(', ');
  const params: Params = { ...rangeParams(range) };
  for (const entry of overhead) params[entry.name] = entry.value;

  return db
    .prepare<Params, SourceUsage>(
      `WITH per_source AS (
         SELECT
           r.query_source AS query_source,
           CASE WHEN r.query_source IN (${placeholders}) THEN 'overhead' ELSE 'work' END
             AS "group",${USAGE_AGGREGATES}
         FROM requests r
         WHERE r.ts >= @from AND r.ts < @to
         GROUP BY r.query_source, "group"
       ),
       period AS (SELECT COALESCE(SUM(total_tokens), 0) AS total FROM per_source)
       SELECT per_source.*, ${sharePct('per_source')}
       FROM per_source, period
       ORDER BY per_source.total_tokens DESC, per_source.query_source IS NULL,
                per_source.query_source ASC`,
    )
    .all(params);
}

/**
 * Per-model aggregates for the range, optionally for one member. Grouped by the
 * raw model string rather than the family, because "which of the two Sonnets"
 * is a question about cost and the family column cannot answer it.
 */
export function modelUsageInRange(
  db: Database.Database,
  range: UsageRange,
  filter: SourceFilter,
  memberId?: string,
): ModelUsage[] {
  const predicate = sourcePredicate(filter);
  const params: Params = { ...rangeParams(range), ...predicate.params };
  let scope = '';
  if (memberId !== undefined) {
    params.memberId = memberId;
    scope = '\n      AND r.member_id = @memberId';
  }

  return db
    .prepare<Params, ModelUsage>(
      `WITH per_model AS (
         SELECT
           r.model AS model,
           r.model_family AS model_family,${USAGE_AGGREGATES}
         FROM requests r
         WHERE r.ts >= @from AND r.ts < @to${predicate.sql}${scope}
         GROUP BY r.model, r.model_family
       ),
       period AS (SELECT COALESCE(SUM(total_tokens), 0) AS total FROM per_model)
       SELECT per_model.*, ${sharePct('per_model')}
       FROM per_model, period
       ORDER BY per_model.total_tokens DESC, per_model.model IS NULL, per_model.model ASC`,
    )
    .all(params);
}

/**
 * Tokens per member per bucket. Buckets with no rows are not emitted — a
 * consumer that needs a dense series knows the width and the range and can fill
 * the gaps, while the query does not have to generate a calendar to do it.
 *
 * `tzOffsetMinutes` shifts the boundary before the division and back after, so
 * a daily bucket starts at the viewer's midnight rather than at UTC's. That
 * division truncates toward zero rather than flooring, which would misplace an
 * instant that the shift pushes before 1970; ccledger has no such rows, and the
 * range validation would have to be defeated to produce one.
 */
export function timeseriesInRange(
  db: Database.Database,
  range: UsageRange,
  filter: SourceFilter,
  bucketMs: number,
  tzOffsetMinutes: number,
): TimeseriesPoint[] {
  const predicate = sourcePredicate(filter);
  return db
    .prepare<Params, TimeseriesPoint>(
      `SELECT
         ${BUCKET_START_SQL} AS bucket_start,
         r.member_id AS member_id,
         COALESCE(SUM(
           r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens
         ), 0) AS total_tokens,
         COUNT(r.id) AS requests,
         COALESCE(SUM(r.cost_micros), 0) AS cost_micros
       FROM requests r
       WHERE r.ts >= @from AND r.ts < @to${predicate.sql}
       GROUP BY bucket_start, r.member_id
       ORDER BY bucket_start ASC, r.member_id ASC`,
    )
    .all({
      ...rangeParams(range),
      ...predicate.params,
      bucketMs,
      offsetMs: tzOffsetMinutes * 60 * 1000,
    });
}

/**
 * The members a timeseries covers, heaviest first. Separate from the points so
 * a legend and a stack order exist even for a member whose every bucket is
 * empty except one, and so the order does not depend on which bucket sorted
 * first.
 */
export function timeseriesMembers(
  db: Database.Database,
  range: UsageRange,
  filter: SourceFilter,
): TimeseriesMember[] {
  const predicate = sourcePredicate(filter);
  return db
    .prepare<Params, TimeseriesMember>(
      `SELECT
         m.id AS member_id,
         m.display_name AS display_name,
         COALESCE(SUM(
           r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens
         ), 0) AS total_tokens
       FROM requests r
       JOIN members m ON m.id = r.member_id
       WHERE r.ts >= @from AND r.ts < @to${predicate.sql}
       GROUP BY m.id, m.display_name
       ORDER BY total_tokens DESC, m.display_name COLLATE NOCASE ASC`,
    )
    .all({ ...rangeParams(range), ...predicate.params });
}

/**
 * Every member worth listing, most recently seen first. `last_seen` is the
 * later of their newest request and their newest install heartbeat: installs
 * are touched by every event type, so a teammate whose Claude Code is running
 * but idle still looks alive rather than gone.
 */
export function memberList(db: Database.Database): MemberListEntry[] {
  return db
    .prepare<Params, MemberListEntry>(
      `SELECT${MEMBER_ENTRY_COLUMNS}
       FROM members m
       WHERE m.id <> @placeholder
          OR EXISTS (SELECT 1 FROM requests r WHERE r.member_id = m.id)
       ORDER BY last_seen IS NULL, last_seen DESC, m.display_name COLLATE NOCASE ASC`,
    )
    .all({ placeholder: UNATTRIBUTED_MEMBER_ID });
}

/** One member as the list shows them, or `undefined` if there is no such id. */
export function memberEntry(db: Database.Database, memberId: string): MemberListEntry | undefined {
  return db
    .prepare<Params, MemberListEntry>(
      `SELECT${MEMBER_ENTRY_COLUMNS}
       FROM members m
       WHERE m.id = @memberId`,
    )
    .get({ memberId });
}

/**
 * One member's sessions inside the range, heaviest first and capped. The cap is
 * why `GET /api/members/:id` also reports the total session count: a truncated
 * list that does not say it was truncated reads as a complete one.
 */
export function sessionUsageInRange(
  db: Database.Database,
  memberId: string,
  range: UsageRange,
  filter: SourceFilter,
  limit: number,
): SessionUsage[] {
  const predicate = sourcePredicate(filter);
  return db
    .prepare<Params, SessionUsage>(
      `SELECT
         r.session_id AS session_id,
         min(r.ts) AS started_at,
         max(r.ts) AS ended_at,${TOKEN_AGGREGATES}
       FROM requests r
       WHERE r.member_id = @memberId
         AND r.ts >= @from AND r.ts < @to${predicate.sql}
       GROUP BY r.session_id
       ORDER BY total_tokens DESC, ended_at DESC
       LIMIT @limit`,
    )
    .all({ ...rangeParams(range), ...predicate.params, memberId, limit });
}

/** Every Claude Code installation reporting under a member, freshest first. */
export function installsOfMember(db: Database.Database, memberId: string): InstallInfo[] {
  return db
    .prepare<Params, InstallInfo>(
      `SELECT
         id AS install_id,
         hostname, os_type, os_version, arch, cc_version, terminal_type,
         first_seen, last_seen
       FROM installs
       WHERE member_id = @memberId
       ORDER BY last_seen DESC, id ASC`,
    )
    .all({ memberId });
}
