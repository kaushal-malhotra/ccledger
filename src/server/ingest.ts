/**
 * Ingest writer: parsed events in, rows in SQLite out.
 *
 * OTLP delivery is at-least-once, so this file's whole job is to make the
 * second delivery of a batch cost nothing. Every write is either an
 * `INSERT OR IGNORE` against a primary key derived from the event itself, or an
 * upsert that only ever widens what is already stored. Nothing here deletes,
 * replaces, or overwrites a known value with an unknown one.
 */

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';

import { KNOWN_EVENT_NAMES, UNATTRIBUTED_MEMBER_ID } from '../shared/constants.js';
import type { ApiRequestEvent, ClaudeCodeEvent, IngestResult } from '../shared/types.js';
import { isApiRequest } from './otlp.js';

/** Knobs the HTTP layer sets per request; every one has a safe default. */
export interface IngestOptions {
  /** Owner of the rows written. Defaults to the placeholder member. */
  readonly memberId?: string;
  /** Clock for rows whose event carried no usable timestamp. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Only the two levels ingest uses; a plain object satisfies it in tests. */
  readonly logger?: Pick<FastifyBaseLogger, 'debug' | 'warn'>;
}

/**
 * `OR IGNORE`, never `OR REPLACE`: a redelivered row is identical to the stored
 * one, so rewriting it buys nothing and would let a truncated retry overwrite a
 * complete record. The primary key doing the work is `requestRowId`.
 */
const INSERT_REQUEST_SQL = `
INSERT OR IGNORE INTO requests (
  id, ts, member_id, install_id, session_id, prompt_id, model, model_family,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  cost_micros, duration_ms, query_source, speed, effort
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Installs accumulate knowledge and never lose it. `COALESCE(excluded.x, x)`
 * means an event that omits a field leaves the stored one alone — a record
 * without resource attributes must not blank the OS of an install we already
 * know. `min`/`max` widen the seen-window in whichever direction the batch
 * pushes, so out-of-order delivery is harmless.
 *
 * `member_id` is deliberately absent from the update list.
 * TODO(stage 2): claiming an install reassigns it; until then an unauthenticated
 * batch must not be able to reset an install back to the placeholder member.
 */
const UPSERT_INSTALL_SQL = `
INSERT INTO installs (
  id, member_id, hostname, os_type, os_version, arch, cc_version, terminal_type,
  first_seen, last_seen
) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  hostname      = COALESCE(excluded.hostname, installs.hostname),
  os_type       = COALESCE(excluded.os_type, installs.os_type),
  os_version    = COALESCE(excluded.os_version, installs.os_version),
  arch          = COALESCE(excluded.arch, installs.arch),
  cc_version    = COALESCE(excluded.cc_version, installs.cc_version),
  terminal_type = COALESCE(excluded.terminal_type, installs.terminal_type),
  first_seen    = min(installs.first_seen, excluded.first_seen),
  last_seen     = max(installs.last_seen, excluded.last_seen)
`;

/** SQLite binds `null`, not `undefined`; passing `undefined` throws at runtime. */
function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

/**
 * Token and cost counters are unsigned in reality. A negative one is upstream
 * corruption, and storing it would quietly subtract from every dashboard SUM.
 *
 * The upper bound matters as much as the lower one: better-sqlite3 binds a
 * number above 2^53 as REAL, so a single absurd value lands a float in an
 * INTEGER column and every later SUM() over that column comes back as a float
 * with drift. Clamp instead — the row still says "implausibly large" without
 * poisoning the aggregate.
 */
function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

/**
 * The row id for an api_request: `client_request_id`, else `request_id`, else a
 * sha256 of the fields that identify the call. `undefined` when there is no id
 * *and* no session to hash — such an event is skipped rather than stored under
 * a guessed key that a later redelivery could not reproduce.
 */
export function requestRowId(event: ApiRequestEvent): string | undefined {
  if (event.clientRequestId !== undefined) return event.clientRequestId;
  if (event.requestId !== undefined) return event.requestId;
  if (event.sessionId === undefined) return undefined;
  // The raw counts, not the clamped ones written to the row: clamping first
  // would give every negative-token event in a session the same digest.
  const material = `${event.sessionId}|${event.ts}|${event.inputTokens}|${event.outputTokens}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Writes one parsed batch. The whole batch is a single transaction, so a
 * SQLite failure leaves no partial batch behind; a failure here is a genuine
 * 5xx, unlike a malformed body, which never reaches this function.
 */
export function ingestEvents(
  db: Database.Database,
  events: readonly ClaudeCodeEvent[],
  options: IngestOptions = {},
): IngestResult {
  // TODO(stage 2): member comes from the bearer token, not the default.
  const memberId = options.memberId ?? UNATTRIBUTED_MEMBER_ID;
  const now = options.now ?? Date.now();
  const logger = options.logger;

  // Prepared once per call, not per row: a batch is ten-ish records today but
  // the shape of this loop is what has to survive a backlog flush.
  const insertRequest = db.prepare(INSERT_REQUEST_SQL);
  const upsertInstall = db.prepare(UPSERT_INSTALL_SQL);

  let apiRequests = 0;
  let inserted = 0;
  let duplicates = 0;
  let skipped = 0;
  const installsTouched = new Set<string>();
  // Null-prototype: the key is an exporter-supplied event name, so a record
  // named after an Object.prototype member must not read back an inherited one.
  const unknownEvents = Object.create(null) as Record<string, number>;

  const writeBatch = db.transaction((batch: readonly ClaudeCodeEvent[]): void => {
    for (const event of batch) {
      if (!KNOWN_EVENT_NAMES.has(event.eventName)) {
        unknownEvents[event.eventName] = (unknownEvents[event.eventName] ?? 0) + 1;
      }

      // Installs come off every event type, not just api_request: a session
      // that only loaded plugins still tells us the machine is alive.
      if (event.userId !== undefined) {
        // ts 0 means the parser found no usable timestamp. Anchoring the
        // seen-window at the epoch would make every install look ancient.
        const seenAt = event.ts > 0 ? event.ts : now;
        upsertInstall.run(
          event.userId,
          memberId,
          orNull(event.resource.osType),
          orNull(event.resource.osVersion),
          orNull(event.resource.hostArch),
          orNull(event.resource.serviceVersion),
          orNull(event.terminalType),
          seenAt,
          seenAt,
        );
        installsTouched.add(event.userId);
      }

      if (!isApiRequest(event)) continue;
      apiRequests += 1;

      const id = requestRowId(event);
      if (id === undefined) {
        skipped += 1;
        continue;
      }

      const info = insertRequest.run(
        id,
        event.ts,
        memberId,
        orNull(event.userId),
        orNull(event.sessionId),
        orNull(event.promptId),
        orNull(event.model),
        event.modelFamily,
        nonNegative(event.inputTokens),
        nonNegative(event.outputTokens),
        nonNegative(event.cacheReadTokens),
        nonNegative(event.cacheCreationTokens),
        // The integer Claude Code sent. `cost_usd` is a float this table has no
        // column for, and rounding it ourselves would drift from Anthropic's.
        nonNegative(event.costMicros),
        event.durationMs === undefined ? null : nonNegative(event.durationMs),
        orNull(event.querySource),
        orNull(event.speed),
        orNull(event.effort),
      );

      // 0 changes means the id was already present — a redelivery, not an error.
      if (info.changes === 1) {
        inserted += 1;
      } else {
        duplicates += 1;
      }
    }
  });

  writeBatch(events);

  // Once per name, never per record: an exporter on an unknown Claude Code
  // version would otherwise fill the log with one line per request.
  for (const [name, count] of Object.entries(unknownEvents)) {
    logger?.debug({ eventName: name, count }, 'unrecognised Claude Code event name');
  }

  if (skipped > 0) {
    logger?.warn({ skipped }, 'api_request events with no derivable row id were not stored');
  }

  return {
    received: events.length,
    apiRequests,
    inserted,
    duplicates,
    skipped,
    installsTouched: installsTouched.size,
    unknownEvents,
  };
}
