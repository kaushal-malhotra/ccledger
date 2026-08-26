/**
 * Types shared between the CLI and the server. Neither side imports from the
 * other; anything crossing that boundary lives here.
 */

/** Normalised model grouping used by the dashboard's by-model views. */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'other';

/** A flattened OTLP attribute value. Structured values are JSON-stringified. */
export type AttributeValue = string | number | boolean;

/** Resource-level attributes; Claude Code puts no identity here. */
export interface ResourceInfo {
  /** `host.arch`, e.g. `amd64`. */
  readonly hostArch?: string;
  /** `os.type`, e.g. `windows`. */
  readonly osType?: string;
  /** `os.version`, e.g. `10.0.26200`. */
  readonly osVersion?: string;
  /** `service.name`, always `claude-code` in observed payloads. */
  readonly serviceName?: string;
  /** `service.version` — the Claude Code version. Schema-drift early warning. */
  readonly serviceVersion?: string;
}

/** Which field the event timestamp was taken from, most trusted first. */
export type TimestampSource =
  'event.timestamp' | 'timeUnixNano' | 'observedTimeUnixNano' | 'missing';

/** Fields every parsed Claude Code event carries, whatever its type. */
export interface BaseEvent {
  /** Bare `event.name` attribute, e.g. `api_request` — never the prefixed body. */
  readonly eventName: string;
  /** Epoch milliseconds. */
  readonly ts: number;
  /** Where `ts` came from. `missing` means nothing usable was present. */
  readonly timestampSource: TimestampSource;
  /** `user.id` — per-installation random id from `~/.claude.json`, not an account. */
  readonly userId?: string;
  /** `session.id`. */
  readonly sessionId?: string;
  /** `terminal.type`, e.g. `vscode`. */
  readonly terminalType?: string;
  /** `prompt.id`. Absent on some records. */
  readonly promptId?: string;
  /** `event.sequence`. */
  readonly eventSequence?: number;
  /** Resource attributes for the batch this record arrived in. */
  readonly resource: ResourceInfo;
  /** Merged resource + record attributes, PII and content keys removed. */
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  /** Record body, the prefixed form, e.g. `claude_code.api_request`. */
  readonly body?: string;
}

/** A `claude_code.api_request` event — the only one ccledger persists today. */
export interface ApiRequestEvent extends BaseEvent {
  readonly kind: 'api_request';
  readonly eventName: 'api_request';
  /** Raw model string; mixes dated and alias forms. */
  readonly model?: string;
  /** Derived from the raw model string. */
  readonly modelFamily: ModelFamily;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** `cost_usd_micros` — the integer, never the `cost_usd` float. */
  readonly costMicros: number;
  readonly durationMs?: number;
  /** Anthropic-side request id, e.g. `req_011C...`. */
  readonly requestId?: string;
  /** Client-generated request id; present in 2.1.241 and the preferred row key. */
  readonly clientRequestId?: string;
  /** Free-form subsystem string, e.g. `sdk`, `generate_session_title`. */
  readonly querySource?: string;
  readonly speed?: string;
  /** Absent on some records. */
  readonly effort?: string;
}

/** Any other event type — kept for counting, not persisted in stage 1. */
export interface GenericEvent extends BaseEvent {
  readonly kind: 'other';
}

/** Discriminated union of everything the parser produces. */
export type ClaudeCodeEvent = ApiRequestEvent | GenericEvent;

/** One record or sub-tree the parser could not use, with where it was. */
export interface ParseIssue {
  /** JSON path of the offending node, e.g. `resourceLogs[0].scopeLogs[0].logRecords[2]`. */
  readonly path: string;
  /** Human-readable reason, safe to log — never contains attribute values. */
  readonly reason: string;
}

/** Counts describing what a single payload contained. */
export interface ParseCounts {
  readonly resourceLogs: number;
  readonly scopeLogs: number;
  /** Log records encountered, including ones that failed to parse. */
  readonly logRecords: number;
  readonly parsed: number;
  readonly skipped: number;
  /** Record count per bare `event.name`; the empty string keys records with none. */
  readonly byEventName: Readonly<Record<string, number>>;
}

/** Result of parsing one OTLP/HTTP JSON logs payload. Parsing never throws. */
export interface ParseResult {
  /**
   * `false` when the envelope itself is unusable (not an object, or no
   * `resourceLogs` array). Callers must answer 400, never 500.
   */
  readonly ok: boolean;
  /** Why the envelope was rejected. Only set when `ok` is false. */
  readonly error?: string;
  readonly events: readonly ClaudeCodeEvent[];
  readonly counts: ParseCounts;
  readonly issues: readonly ParseIssue[];
}

/** A row of the `requests` table, column names as in `schema.sql`. */
export interface RequestRow {
  readonly id: string;
  readonly ts: number;
  readonly member_id: string;
  readonly install_id: string | null;
  readonly session_id: string | null;
  readonly prompt_id: string | null;
  readonly model: string | null;
  readonly model_family: ModelFamily | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cost_micros: number;
  readonly duration_ms: number | null;
  readonly query_source: string | null;
  readonly speed: string | null;
  readonly effort: string | null;
}

/** What one ingest call did, for the response body and for logging. */
export interface IngestResult {
  /** Events handed to ingest, all types. */
  readonly received: number;
  /** Events that were `api_request`. */
  readonly apiRequests: number;
  /** Rows actually written; redeliveries do not count. */
  readonly inserted: number;
  /** `api_request` events whose row id was already present. */
  readonly duplicates: number;
  /** `api_request` events skipped because no usable row id could be derived. */
  readonly skipped: number;
  /** Installs inserted or refreshed. */
  readonly installsTouched: number;
  /** Count per event name that ccledger does not recognise. */
  readonly unknownEvents: Readonly<Record<string, number>>;
}

/** How a server is deployed, which decides its defaults and its warnings. */
export type ServerMode = 'laptop' | 'vps';

/** A member row as the rest of the program sees it, camel-cased. */
export interface Member {
  readonly id: string;
  readonly displayName: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds, or `null` while the member is active. */
  readonly revokedAt: number | null;
  /** Machine name the token was first issued for. Informational only. */
  readonly joinHostname: string | null;
  /** OS the token was first issued on. Informational only. */
  readonly joinOs: string | null;
}

/** The body `POST /join` accepts. Snake case, because a shell client types it. */
export interface JoinRequestBody {
  /** A join code in any spacing or case; normalised server-side. */
  readonly code: string;
  readonly display_name: string;
  readonly hostname?: string;
  readonly os?: string;
}

/** The body `POST /join` returns. The token is shown here and never again. */
export interface JoinResponseBody {
  readonly token: string;
  readonly member_id: string;
  readonly server_name: string;
}

/**
 * What an invite string carries. Encoded as one base64url blob so a teammate
 * has exactly one thing to paste.
 */
export interface InvitePayload {
  /** Format version. Bumped if the shape ever changes. */
  readonly v: 1;
  /** Base URL of the server, with no trailing slash and no `/v1/logs`. */
  readonly endpoint: string;
  /** The join code, canonical form. */
  readonly code: string;
  /** Display name the admin suggested. The joiner may override it. */
  readonly name?: string;
}

/**
 * The body `POST /leave` returns. A member revoking its own token is the one
 * revocation that needs no admin, and `ccledger uninstall` sends it so the
 * dashboard shows a teammate as gone rather than merely silent.
 */
export interface LeaveResponseBody {
  readonly member_id: string;
  /** False when the token was already revoked, which is not an error. */
  readonly revoked: boolean;
}
