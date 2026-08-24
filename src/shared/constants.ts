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
 * Placeholder member owning every row until bearer-token auth lands in stage 2.
 * Seeded by the migrations so the `requests.member_id` foreign key holds.
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
