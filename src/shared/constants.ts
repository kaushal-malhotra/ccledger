/** Constants shared between the CLI and the server. */

/**
 * Attributes dropped at parse time and never persisted (PRD sections 9 and 11).
 * They are identical across everyone on a shared account, so they carry no
 * attribution value — and not storing them is what makes `privacy.md` true by
 * construction.
 */
export const PII_ATTRIBUTE_KEYS: readonly string[] = [
  'user.email',
  'user.account_uuid',
  'user.account_id',
  'organization.id',
];

/**
 * Content-bearing attributes, also dropped at parse time. Claude Code ships
 * these keys with the value `<REDACTED>` while content logging is off, but the
 * keys arrive regardless — so ccledger drops them by name rather than trusting
 * an exporter it does not control.
 */
export const CONTENT_ATTRIBUTE_KEYS: readonly string[] = ['prompt', 'response'];

/** Every attribute key the parser strips before returning an event. */
export const DROPPED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  ...PII_ATTRIBUTE_KEYS,
  ...CONTENT_ATTRIBUTE_KEYS,
]);

/**
 * Event names ccledger knows about, from the 2.1.241 capture plus documented
 * siblings. Anything else is counted and debug-logged, never dropped silently.
 */
export const KNOWN_EVENT_NAMES: ReadonlySet<string> = new Set([
  'api_request',
  'api_error',
  'api_refusal',
  'assistant_response',
  'user_prompt',
  'plugin_loaded',
  'mcp_server_connection',
  'tool_result',
  'tool_decision',
  'subagent_start',
  'subagent_stop',
  'quota_exceeded',
]);

/**
 * Placeholder member seeded by migration 2, back when ingest was unauthenticated.
 * Nothing writes rows against it any more — `ingestEvents` takes the member id
 * the bearer token resolved to — but the row stays because migrations are
 * forward-only and stage 1 rows still point at it.
 */
export const UNATTRIBUTED_MEMBER_ID = 'unattributed';

/** The `members.display_name` for the placeholder member. */
export const UNATTRIBUTED_MEMBER_NAME = 'Unattributed';

/**
 * The `members.token_hash` for the placeholder member. That column is NOT NULL
 * UNIQUE; this value is not a hex sha256 digest, so no real token can hash to
 * it and no bearer token can ever authenticate as the placeholder.
 */
export const UNATTRIBUTED_TOKEN_HASH = 'none:unattributed';

/**
 * Prefix on a member's ingest token. A teammate pastes this into a Claude Code
 * settings file, so it is worth being able to recognise one on sight.
 */
export const MEMBER_TOKEN_PREFIX = 'ccm_';

/**
 * Prefix on the single admin token. Deliberately different from the member
 * prefix: the two are stored in different places and grant different things,
 * and the failure mode worth designing against is an admin pasting their own
 * token into a teammate's config. A different prefix makes that visible.
 */
export const ADMIN_TOKEN_PREFIX = 'cca_';

/**
 * Random characters after the prefix. 24 random bytes render as exactly 32
 * base64url characters with no padding, which is 192 bits of entropy.
 */
export const TOKEN_BODY_LENGTH = 32;

/** Bytes of randomness behind `TOKEN_BODY_LENGTH` base64url characters. */
export const TOKEN_ENTROPY_BYTES = 24;

/** The `server_config` key holding the sha256 of the current admin token. */
export const CONFIG_ADMIN_TOKEN_HASH = 'admin_token_hash';

/** The `server_config` key holding when the admin token was last issued. */
export const CONFIG_ADMIN_TOKEN_SET_AT = 'admin_token_set_at';

/** The `server_config` key holding the label shown to a joining teammate. */
export const CONFIG_SERVER_NAME = 'server_name';

/**
 * The `server_config` key holding the base URL teammates reach this server on.
 * `serve` writes it; `invite` reads it, which is what lets `ccledger invite`
 * bundle an endpoint without being told one every time.
 */
export const CONFIG_PUBLIC_URL = 'public_url';

/**
 * Join-code alphabet: uppercase alphanumerics minus `0`, `O`, `1`, `I` and `L`.
 * 31 characters, so a twelve-character code carries just under 60 bits — far
 * past guessing, while staying readable over a desk or a phone call.
 */
export const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Groups a join code is printed in. */
export const JOIN_CODE_GROUPS = 3;

/** Characters per group. */
export const JOIN_CODE_GROUP_LENGTH = 4;

/** Separator between groups in the canonical form. */
export const JOIN_CODE_SEPARATOR = '-';

/** How long a join code stays claimable. PRD section 11: single use, 24 hours. */
export const JOIN_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Path prefix the admin token guards. Enforced as a prefix rather than per
 * route so a route added later is guarded by default rather than on remembering.
 */
export const ADMIN_API_PREFIX = '/api';

/**
 * Path an OTLP/HTTP exporter appends to the base endpoint. It is part of the
 * config contract in PRD section 7 — `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is
 * written with this suffix already on it — so it lives here rather than being
 * spelled out again in every command that has to build or recognise that value.
 */
export const OTLP_LOGS_PATH = '/v1/logs';

/** Unauthenticated liveness probe. `doctor` asks this before blaming the token. */
export const HEALTH_PATH = '/health';

/**
 * `query_source` values for calls Claude Code makes on its own behalf rather
 * than because someone asked for something: naming a session, compacting a
 * transcript. They are real tokens and real cost, so they are stored and
 * counted like everything else — but an admin comparing two teammates wants to
 * know how much of a total is work and how much is housekeeping.
 *
 * The list is what stage 0 observed plus the compaction source. It is a
 * denylist rather than an allowlist on purpose: a `query_source` this build has
 * never heard of counts as work, so a new one appearing in a future Claude Code
 * shows up in the numbers instead of quietly vanishing from them.
 */
export const OVERHEAD_QUERY_SOURCES: readonly string[] = ['generate_session_title', 'compact'];

/**
 * The `source` value that selects requests carrying no `query_source` at all.
 * A literal is needed because an empty query parameter cannot be told apart
 * from an absent one, and `NULL` is a real category here rather than an
 * oversight — the early Claude Code records simply do not carry the attribute.
 */
export const SOURCE_NONE = 'none';

/** Sessions returned by `GET /api/members/:id`. The response says when it capped. */
export const MEMBER_SESSIONS_LIMIT = 200;

/** Where a join code is spent for a token. */
export const JOIN_PATH = '/join';

/** Where a member gives its own token up, so the admin can see it is gone. */
export const LEAVE_PATH = '/leave';
