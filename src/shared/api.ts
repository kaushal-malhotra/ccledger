/**
 * The wire shapes of the read API under `/api`.
 *
 * Types only, deliberately: this module is imported by `src/server/api.ts` for
 * its return types and by the dashboard in `web/` as an `import type`, which the
 * bundler erases. That is what lets one file be the contract for both sides
 * without the dashboard bundle reaching into `src/` at runtime.
 *
 * Every field is snake_case, like the columns it comes from and like the join
 * bodies in `types.ts` — the same names appear in `curl` output, in the SQL and
 * in the table headers, so there is one spelling to remember rather than three.
 *
 * Every instant is epoch milliseconds, because that is what the database stores
 * and what a chart axis wants. The one exception is `RangeInfo`, which echoes
 * the ISO strings the caller sent so a response can be read without a converter.
 */

import type { ModelFamily } from './types.js';

/** Bucket widths `GET /api/timeseries` can aggregate into. */
export type BucketSize = 'hour' | 'day';

/**
 * How a query treats requests Claude Code makes on its own behalf. `work` keeps
 * everything that is not known overhead — an unrecognised `query_source` counts
 * as work, so a source this build has never heard of is never quietly dropped
 * from the numbers.
 */
export type SourceGroup = 'all' | 'work' | 'overhead';

/** The classification a single `query_source` value falls into. */
export type SourceClass = 'work' | 'overhead';

/** The half-open range `[from, to)` an endpoint actually aggregated over. */
export interface RangeInfo {
  /** ISO-8601, normalised to UTC. Inclusive. */
  readonly from: string;
  /** ISO-8601, normalised to UTC. Exclusive. */
  readonly to: string;
  /** Epoch milliseconds, inclusive. */
  readonly from_ms: number;
  /** Epoch milliseconds, exclusive. */
  readonly to_ms: number;
}

/**
 * The `query_source` narrowing a response was computed under. Both predicates
 * apply at once, so `group` and `source` compose rather than one overriding the
 * other; each echoes what the request asked for.
 */
export interface FilterInfo {
  readonly group: SourceGroup;
  /**
   * The exact `query_source` asked for, the literal `none` for the requests
   * carrying no source at all, or `null` when no exact source was asked for.
   */
  readonly source: string | null;
}

/**
 * One set of aggregates. `total_tokens` is the sum of all four token columns:
 * cache reads are cheap, but they are tokens, and the four components are
 * carried alongside so a reader can see the composition rather than infer it.
 *
 * `cost_micros` is an integer count of millionths of a dollar, summed as an
 * integer and divided only at the point of display. Nothing here is a float.
 */
export interface TokenTotals {
  readonly total_tokens: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  /** Rows in `requests`, which is one per API call Claude Code reported. */
  readonly requests: number;
  /** Integer millionths of a dollar. Divide by 1e6 for display. */
  readonly cost_micros: number;
}

/**
 * `TokenTotals` plus the distinct session count, for every grouping where that
 * count means something. A per-session row is the one place it does not.
 */
export interface UsageTotals extends TokenTotals {
  /** Distinct non-null `session_id` values. */
  readonly sessions: number;
}

/** One member's aggregates over the range, and their share of it. */
export interface MemberUsage extends UsageTotals {
  readonly member_id: string;
  readonly display_name: string;
  /** Epoch milliseconds, or `null` while the member is active. */
  readonly revoked_at: number | null;
  /** Percentage of the range's `total_tokens`. 0 when the range is empty. */
  readonly share_pct: number;
  /** Latest request inside the range, or `null` if they made none. */
  readonly last_request: number | null;
}

/** One `query_source` value's aggregates over the range. */
export interface SourceUsage extends UsageTotals {
  /** `null` for requests that carried no `query_source`. */
  readonly query_source: string | null;
  readonly group: SourceClass;
  readonly share_pct: number;
}

/** One model's aggregates over the range. */
export interface ModelUsage extends UsageTotals {
  /** The raw model string as Claude Code reported it. */
  readonly model: string | null;
  readonly model_family: ModelFamily | null;
  readonly share_pct: number;
}

/**
 * `GET /api/summary`. `sources` is deliberately computed without the source
 * filter applied: it is what populates the filter control, so narrowing it by
 * the current selection would leave nothing to switch back to.
 */
export interface SummaryResponse {
  readonly range: RangeInfo;
  readonly filter: FilterInfo;
  readonly totals: UsageTotals;
  readonly members: readonly MemberUsage[];
  readonly sources: readonly SourceUsage[];
}

/** One member's tokens in one bucket. Buckets with no rows are not emitted. */
export interface TimeseriesPoint {
  /** Epoch milliseconds at the start of the bucket. */
  readonly bucket_start: number;
  readonly member_id: string;
  readonly total_tokens: number;
  readonly requests: number;
  readonly cost_micros: number;
}

/** A member that appears in a timeseries, for the legend and the stack order. */
export interface TimeseriesMember {
  readonly member_id: string;
  readonly display_name: string;
  readonly total_tokens: number;
}

/** `GET /api/timeseries`. */
export interface TimeseriesResponse {
  readonly range: RangeInfo;
  readonly filter: FilterInfo;
  /** The bucket actually used, which may have been chosen from the range span. */
  readonly bucket: BucketSize;
  /** Bucket width in milliseconds. */
  readonly bucket_ms: number;
  /** Minutes east of UTC that bucket boundaries were aligned to. */
  readonly tz_offset_minutes: number;
  /** Members with data in the range, heaviest first. */
  readonly members: readonly TimeseriesMember[];
  readonly points: readonly TimeseriesPoint[];
}

/** `GET /api/models`. */
export interface ModelsResponse {
  readonly range: RangeInfo;
  readonly filter: FilterInfo;
  readonly totals: UsageTotals;
  readonly models: readonly ModelUsage[];
}

/** A member as the members list shows them: identity and liveness, no usage. */
export interface MemberListEntry {
  readonly member_id: string;
  readonly display_name: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
  /** Machine the token was issued for, if the joiner sent one. */
  readonly join_hostname: string | null;
  readonly join_os: string | null;
  /** Latest activity of any kind, over all time, or `null` if there is none. */
  readonly last_seen: number | null;
  /** Distinct Claude Code installations reporting under this member. */
  readonly installs: number;
}

/** `GET /api/members`. */
export interface MembersResponse {
  readonly members: readonly MemberListEntry[];
}

/**
 * One session's aggregates inside the range. `TokenTotals` rather than
 * `UsageTotals`: a distinct-session count inside a single session is always 1,
 * which is a field that would only ever be read by mistake.
 */
export interface SessionUsage extends TokenTotals {
  /** `null` for requests that carried no `session.id`. */
  readonly session_id: string | null;
  /** First request of the session inside the range. */
  readonly started_at: number;
  /** Last request of the session inside the range. */
  readonly ended_at: number;
}

/** One Claude Code installation reporting under a member. */
export interface InstallInfo {
  readonly install_id: string;
  readonly hostname: string | null;
  readonly os_type: string | null;
  readonly os_version: string | null;
  readonly arch: string | null;
  readonly cc_version: string | null;
  readonly terminal_type: string | null;
  readonly first_seen: number;
  readonly last_seen: number;
}

/** `GET /api/members/:id`. */
export interface MemberDetailResponse {
  readonly range: RangeInfo;
  readonly filter: FilterInfo;
  readonly member: MemberListEntry;
  readonly totals: UsageTotals;
  /** Percentage of the range's `total_tokens` across every member. */
  readonly share_pct: number;
  /** Heaviest first, capped at `sessions_limit`. */
  readonly sessions: readonly SessionUsage[];
  /** How many sessions the range holds in all; compare against `sessions`. */
  readonly sessions_total: number;
  /** The cap `sessions` was truncated to. */
  readonly sessions_limit: number;
  readonly models: readonly ModelUsage[];
  readonly installs: readonly InstallInfo[];
}

/** `POST /api/members/:id/revoke`. */
export interface RevokeResponse {
  readonly member_id: string;
  /** False when the token was already revoked, which is not an error. */
  readonly revoked: boolean;
  /** When access actually stopped — the original time on a repeat call. */
  readonly revoked_at: number | null;
}
