import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { FastifyBaseLogger } from 'fastify';

import { migratedDatabase } from '../db/index.js';
import type { Database } from '../db/index.js';
import { UNATTRIBUTED_MEMBER_ID } from '../shared/constants.js';
import type { ApiRequestEvent, ClaudeCodeEvent, RequestRow } from '../shared/types.js';
import { ingestEvents, requestRowId } from './ingest.js';
import { isApiRequest, parseOtlpLogsPayload } from './otlp.js';

/** The `installs` row shape, mirroring `schema.sql`. Local: no other file needs it. */
interface InstallRow {
  readonly id: string;
  readonly member_id: string;
  readonly hostname: string | null;
  readonly os_type: string | null;
  readonly os_version: string | null;
  readonly arch: string | null;
  readonly cc_version: string | null;
  readonly terminal_type: string | null;
  readonly first_seen: number;
  readonly last_seen: number;
}

/**
 * Owner of every row these tests write. Ingest takes the member the bearer
 * token resolved to; which member that is changes nothing below, so the
 * placeholder the migrations seed stands in for one.
 */
const OWNER = { memberId: UNATTRIBUTED_MEMBER_ID } as const;

/** Handles to close after each test; `:memory:` still leaks a native handle. */
const openHandles: Database.Database[] = [];

afterEach(() => {
  for (const db of openHandles.splice(0)) {
    db.close();
  }
});

/** A migrated in-memory database, registered for teardown. */
function freshDb(): Database.Database {
  const db = migratedDatabase(':memory:');
  openHandles.push(db);
  return db;
}

/**
 * Events from a checked-in capture, taken through the real parser. Resolved
 * against this file so the test does not depend on `cwd`.
 */
function fixtureEvents(name: string): readonly ClaudeCodeEvent[] {
  const text = readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');
  const result = parseOtlpLogsPayload(JSON.parse(text));
  expect(result.ok).toBe(true);
  return result.events;
}

/** One OTLP attribute entry. */
function attr(key: string, value: unknown): Record<string, unknown> {
  return { key, value };
}

/** A `{stringValue}` wrapper, the form Claude Code uses for every id. */
function str(value: string): Record<string, unknown> {
  return { stringValue: value };
}

/** An `{intValue}` wrapper. The fixtures carry these as bare JSON numbers. */
function int(value: number): Record<string, unknown> {
  return { intValue: value };
}

/** The resource attributes both captures carry, verbatim. */
const RESOURCE_ATTRIBUTES: readonly unknown[] = [
  attr('host.arch', str('amd64')),
  attr('os.type', str('windows')),
  attr('os.version', str('10.0.26200')),
  attr('service.name', str('claude-code')),
  attr('service.version', str('2.1.241')),
];

/**
 * Synthetic events, built by parsing a hand-written envelope rather than by
 * constructing typed objects, so the tests exercise the same path ingest sees
 * in production.
 */
function syntheticEvents(
  records: readonly unknown[],
  resourceAttributes: readonly unknown[] = RESOURCE_ATTRIBUTES,
): readonly ClaudeCodeEvent[] {
  const result = parseOtlpLogsPayload({
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes, droppedAttributesCount: 0 },
        scopeLogs: [{ scope: { name: 'test', version: '0' }, logRecords: records }],
      },
    ],
  });
  expect(result.ok).toBe(true);
  return result.events;
}

/** One log record from its attribute entries. */
function record(attributes: readonly unknown[]): Record<string, unknown> {
  return { body: str('claude_code.event'), attributes, droppedAttributesCount: 0 };
}

/** Every `requests` row, oldest first. */
function requestRows(db: Database.Database): readonly RequestRow[] {
  return db.prepare<[], RequestRow>('SELECT * FROM requests ORDER BY ts, id').all();
}

/** Every `installs` row. */
function installRows(db: Database.Database): readonly InstallRow[] {
  return db.prepare<[], InstallRow>('SELECT * FROM installs ORDER BY id').all();
}

/** Narrows away `undefined` so tests index without a non-null assertion. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

/** The single api_request event in a parsed batch. */
function onlyApiRequest(events: readonly ClaudeCodeEvent[]): ApiRequestEvent {
  const found = events.filter(isApiRequest);
  expect(found).toHaveLength(1);
  return must(found[0], 'an api_request event');
}

/** One captured log call: the arguments the logger was handed. */
interface LogCall {
  readonly args: readonly unknown[];
}

/** A logger that records instead of writing, so assertions need no spy. */
interface RecordingLogger {
  readonly logger: Pick<FastifyBaseLogger, 'debug' | 'warn'>;
  readonly debug: readonly LogCall[];
  readonly warn: readonly LogCall[];
}

/** Builds a `RecordingLogger`; the arrays fill as ingest logs. */
function recordingLogger(): RecordingLogger {
  const debug: LogCall[] = [];
  const warn: LogCall[] = [];
  return {
    logger: {
      debug: (...args: unknown[]): void => {
        debug.push({ args });
      },
      warn: (...args: unknown[]): void => {
        warn.push({ args });
      },
    },
    debug,
    warn,
  };
}

/** The `user.id` both captures carry — an install id, not an account id. */
const FIXTURE_USER_ID = 'aa83f64c6c308f626d85d6deae05eaecdba5eb615a4eea59c16587dd417a6396';

/** The `session.id` both captures carry. */
const FIXTURE_SESSION_ID = 'bc697788-f3f4-493b-80cc-2a03174c8861';

/** Earliest and latest `event.timestamp` across the two captures. */
const FIRST_FIXTURE_TS = 1787503989413;
const LAST_FIXTURE_TS = 1787503997178;

/** The api_request row `001.json` must produce, column for column. */
const ROW_001: RequestRow = {
  id: 'f1f6314c-4ac2-4e04-afc4-6e2b7b477bd6',
  ts: 1787503991194,
  member_id: UNATTRIBUTED_MEMBER_ID,
  install_id: FIXTURE_USER_ID,
  session_id: FIXTURE_SESSION_ID,
  prompt_id: null,
  model: 'claude-haiku-4-5-20251001',
  model_family: 'haiku',
  input_tokens: 898,
  output_tokens: 13,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_micros: 963,
  duration_ms: 1014,
  query_source: 'generate_session_title',
  speed: 'normal',
  effort: null,
};

/** The api_request row `002.json` must produce, column for column. */
const ROW_002: RequestRow = {
  id: '4c5693d6-70ad-4503-bc26-47b1816fd1f9',
  ts: 1787503997172,
  member_id: UNATTRIBUTED_MEMBER_ID,
  install_id: FIXTURE_USER_ID,
  session_id: FIXTURE_SESSION_ID,
  prompt_id: '4fc4bb31-78d6-48ed-8d5c-13c3417a6f4f',
  model: 'claude-opus-5',
  model_family: 'opus',
  input_tokens: 2,
  output_tokens: 317,
  cache_read_tokens: 21360,
  cache_creation_tokens: 8097,
  cost_micros: 99585,
  duration_ms: 4919,
  query_source: 'sdk',
  speed: 'normal',
  effort: 'xhigh',
};

describe('ingestEvents on the real captures', () => {
  it('writes exactly one row per api_request, every column as captured', () => {
    const db = freshDb();

    const first = ingestEvents(db, fixtureEvents('001.json'), OWNER);
    const second = ingestEvents(db, fixtureEvents('002.json'), OWNER);

    expect(first.received).toBe(6);
    expect(first.apiRequests).toBe(1);
    expect(first.inserted).toBe(1);
    expect(second.received).toBe(4);
    expect(second.apiRequests).toBe(1);
    expect(second.inserted).toBe(1);

    // Object equality, not field-by-field: a column added to the row shape
    // without a test update fails here rather than shipping unasserted.
    expect(requestRows(db)).toEqual([ROW_001, ROW_002]);
  });

  it('takes cost_micros from the integer, not from the cost_usd float', () => {
    const db = freshDb();
    ingestEvents(db, fixtureEvents('002.json'), OWNER);

    // 0.099585 * 1e6 is 99584.99999999999 in binary floating point, so a row
    // reading 99585 could only have come from `cost_usd_micros`.
    expect(must(requestRows(db)[0], 'the 002 row').cost_micros).toBe(99585);
  });

  it('stores neither PII nor content anywhere in a row', () => {
    const db = freshDb();
    ingestEvents(db, fixtureEvents('001.json'), OWNER);
    ingestEvents(db, fixtureEvents('002.json'), OWNER);

    const sentinels = [
      'teammate@example.invalid',
      '22222222-2222-4222-8222-222222222222',
      'user_012FIXTUREACCOUNTID000',
      '11111111-1111-4111-8111-111111111111',
      '<REDACTED>',
    ];
    const dump = JSON.stringify([requestRows(db), installRows(db)]);
    for (const sentinel of sentinels) {
      expect(dump).not.toContain(sentinel);
    }
  });
});

describe('idempotency', () => {
  it('reports the whole second delivery as duplicates and writes nothing', () => {
    const db = freshDb();
    ingestEvents(db, fixtureEvents('001.json'), OWNER);
    ingestEvents(db, fixtureEvents('002.json'), OWNER);
    const afterFirstPass = requestRows(db);

    const replay001 = ingestEvents(db, fixtureEvents('001.json'), OWNER);
    const replay002 = ingestEvents(db, fixtureEvents('002.json'), OWNER);

    expect(replay001.inserted).toBe(0);
    expect(replay001.duplicates).toBe(1);
    expect(replay002.inserted).toBe(0);
    expect(replay002.duplicates).toBe(1);
    expect(replay001.inserted + replay002.inserted).toBe(0);
    expect(replay001.duplicates + replay002.duplicates).toBe(2);

    // Not just the count: a redelivery must not have rewritten a single column.
    expect(requestRows(db)).toEqual(afterFirstPass);
  });

  it('deduplicates within a single call, not just across calls', () => {
    const db = freshDb();
    const events = [...fixtureEvents('001.json'), ...fixtureEvents('001.json')];

    const result = ingestEvents(db, events, OWNER);

    expect(result.received).toBe(12);
    expect(result.apiRequests).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(requestRows(db)).toEqual([ROW_001]);
  });
});

describe('requestRowId', () => {
  /** An api_request record with the given id attributes, and nothing else optional. */
  function apiRequestRecord(attributes: readonly unknown[]): Record<string, unknown> {
    return record([
      attr('event.name', str('api_request')),
      attr('event.timestamp', str('2026-08-23T16:53:11.194Z')),
      attr('input_tokens', int(11)),
      attr('output_tokens', int(22)),
      ...attributes,
    ]);
  }

  it('prefers client_request_id, then request_id', () => {
    const both = onlyApiRequest(
      syntheticEvents([
        apiRequestRecord([
          attr('session.id', str(FIXTURE_SESSION_ID)),
          attr('request_id', str('req_server')),
          attr('client_request_id', str('cid_client')),
        ]),
      ]),
    );
    expect(requestRowId(both)).toBe('cid_client');

    const serverOnly = onlyApiRequest(
      syntheticEvents([
        apiRequestRecord([
          attr('session.id', str(FIXTURE_SESSION_ID)),
          attr('request_id', str('req_server')),
        ]),
      ]),
    );
    expect(requestRowId(serverOnly)).toBe('req_server');
  });

  it('falls back to a sha256 of session, ts and token counts', () => {
    const db = freshDb();
    const records = [apiRequestRecord([attr('session.id', str(FIXTURE_SESSION_ID))])];

    const first = ingestEvents(db, syntheticEvents(records), OWNER);
    const event = onlyApiRequest(syntheticEvents(records));
    const expected = createHash('sha256')
      .update(`${FIXTURE_SESSION_ID}|1787503991194|11|22`, 'utf8')
      .digest('hex');

    expect(first.inserted).toBe(1);
    expect(first.skipped).toBe(0);
    expect(requestRowId(event)).toBe(expected);
    expect(must(requestRows(db)[0], 'the hashed row').id).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);

    // Redelivery of the identical record must hash to the identical key.
    const replay = ingestEvents(db, syntheticEvents(records), OWNER);
    expect(replay.inserted).toBe(0);
    expect(replay.duplicates).toBe(1);
    expect(requestRows(db)).toHaveLength(1);
  });

  it('gives two genuinely different id-less requests two different rows', () => {
    const db = freshDb();
    const base = [attr('session.id', str(FIXTURE_SESSION_ID))];

    const result = ingestEvents(
      db,
      syntheticEvents([
        apiRequestRecord(base),
        // Same session and timestamp, one more output token: a different call.
        record([
          attr('event.name', str('api_request')),
          attr('event.timestamp', str('2026-08-23T16:53:11.194Z')),
          attr('input_tokens', int(11)),
          attr('output_tokens', int(23)),
          ...base,
        ]),
      ]),
      OWNER,
    );

    expect(result.inserted).toBe(2);
    expect(result.duplicates).toBe(0);
    const ids = requestRows(db).map((row) => row.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('skips an api_request with no ids and no session rather than guessing a key', () => {
    const db = freshDb();
    const events = syntheticEvents([apiRequestRecord([])]);

    expect(requestRowId(onlyApiRequest(events))).toBeUndefined();

    const result = ingestEvents(db, events, OWNER);

    expect(result.apiRequests).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(requestRows(db)).toHaveLength(0);
  });
});

describe('installs upsert', () => {
  /** A non-api_request record carrying `user.id` and the given extra attributes. */
  function pingRecord(isoTimestamp: string, attributes: readonly unknown[] = []): unknown {
    return record([
      attr('event.name', str('mcp_server_connection')),
      attr('event.timestamp', str(isoTimestamp)),
      attr('user.id', str(FIXTURE_USER_ID)),
      ...attributes,
    ]);
  }

  it('creates one row for the capture install, hostname null and member the placeholder', () => {
    const db = freshDb();

    const first = ingestEvents(db, fixtureEvents('001.json'), OWNER);
    const second = ingestEvents(db, fixtureEvents('002.json'), OWNER);

    // Every record in both captures carries the same user.id, so one install.
    expect(first.installsTouched).toBe(1);
    expect(second.installsTouched).toBe(1);
    expect(installRows(db)).toEqual([
      {
        id: FIXTURE_USER_ID,
        member_id: UNATTRIBUTED_MEMBER_ID,
        hostname: null,
        os_type: 'windows',
        os_version: '10.0.26200',
        arch: 'amd64',
        cc_version: '2.1.241',
        terminal_type: 'vscode',
        first_seen: FIRST_FIXTURE_TS,
        last_seen: LAST_FIXTURE_TS,
      },
    ]);
    const install = must(installRows(db)[0], 'the install row');
    expect(install.first_seen).toBeLessThanOrEqual(install.last_seen);
  });

  it('widens last_seen forward and first_seen backward, never the other way', () => {
    const db = freshDb();
    ingestEvents(db, fixtureEvents('001.json'), OWNER);
    ingestEvents(db, fixtureEvents('002.json'), OWNER);

    ingestEvents(db, syntheticEvents([pingRecord('2026-08-24T09:00:00.000Z')]), OWNER);
    const afterNewer = must(installRows(db)[0], 'the install row');
    expect(afterNewer.first_seen).toBe(FIRST_FIXTURE_TS);
    expect(afterNewer.last_seen).toBe(Date.parse('2026-08-24T09:00:00.000Z'));

    ingestEvents(db, syntheticEvents([pingRecord('2026-08-22T09:00:00.000Z')]), OWNER);
    const afterOlder = must(installRows(db)[0], 'the install row');
    expect(afterOlder.first_seen).toBe(Date.parse('2026-08-22T09:00:00.000Z'));
    // The older batch must not have dragged last_seen back with it.
    expect(afterOlder.last_seen).toBe(Date.parse('2026-08-24T09:00:00.000Z'));
  });

  it('does not blank a known column when a later batch omits it', () => {
    const db = freshDb();
    ingestEvents(db, fixtureEvents('001.json'), OWNER);

    // No resource attributes and no terminal.type: everything descriptive is
    // absent, which must read as "no news", not as "now unknown".
    ingestEvents(db, syntheticEvents([pingRecord('2026-08-24T09:00:00.000Z')], []), OWNER);

    const install = must(installRows(db)[0], 'the install row');
    expect(install.os_type).toBe('windows');
    expect(install.os_version).toBe('10.0.26200');
    expect(install.arch).toBe('amd64');
    expect(install.cc_version).toBe('2.1.241');
    expect(install.terminal_type).toBe('vscode');
    expect(install.hostname).toBeNull();
    expect(install.last_seen).toBe(Date.parse('2026-08-24T09:00:00.000Z'));
  });

  it('anchors an install with no usable timestamp to the injected clock', () => {
    const db = freshDb();
    const events = syntheticEvents([
      record([attr('event.name', str('plugin_loaded')), attr('user.id', str(FIXTURE_USER_ID))]),
    ]);

    ingestEvents(db, events, { ...OWNER, now: 1_700_000_000_000 });

    const install = must(installRows(db)[0], 'the install row');
    expect(install.first_seen).toBe(1_700_000_000_000);
    expect(install.last_seen).toBe(1_700_000_000_000);
  });

  it('writes no install for an event without a user.id', () => {
    const db = freshDb();

    const result = ingestEvents(
      db,
      syntheticEvents([record([attr('event.name', str('tool_result'))])]),
      OWNER,
    );

    expect(result.installsTouched).toBe(0);
    expect(installRows(db)).toHaveLength(0);
  });

  it('reassigns an install to whoever is reporting from it now', () => {
    const db = freshDb();
    db.prepare(
      'INSERT INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run('m_rahim', 'Rahim', 'sha256:rahim', 1_700_000_000_000);
    const events = syntheticEvents([pingRecord('2026-08-23T09:00:00.000Z')]);

    ingestEvents(db, events, OWNER);
    // The same machine, a new token: someone who rejoined after their old one
    // was revoked. `user.id` comes from ~/.claude.json and does not change, so
    // the install has to follow the token rather than stranding under the
    // identity it replaced.
    ingestEvents(db, events, { memberId: 'm_rahim' });

    const install = must(installRows(db)[0], 'the install row');
    expect(installRows(db)).toHaveLength(1);
    expect(install.member_id).toBe('m_rahim');
    // Everything else still only ever widens.
    expect(install.first_seen).toBe(Date.parse('2026-08-23T09:00:00.000Z'));
  });
});

describe('event routing', () => {
  it('writes no request row for non-api_request events', () => {
    const db = freshDb();
    const events = fixtureEvents('001.json').filter((event) => !isApiRequest(event));

    const result = ingestEvents(db, events, OWNER);

    expect(events).toHaveLength(5);
    expect(result.received).toBe(5);
    expect(result.apiRequests).toBe(0);
    expect(result.inserted).toBe(0);
    expect(requestRows(db)).toHaveLength(0);
  });

  it('counts unknown event names and logs each name exactly once', () => {
    const db = freshDb();
    const { logger, debug, warn } = recordingLogger();
    const events = syntheticEvents([
      record([attr('event.name', str('teleport_completed'))]),
      record([attr('event.name', str('teleport_completed'))]),
      record([attr('event.name', str('flux_capacitor_charged'))]),
      record([attr('event.name', str('api_request'))]),
      record([attr('event.name', str('user_prompt'))]),
    ]);

    const result = ingestEvents(db, events, { ...OWNER, logger });

    expect(result.unknownEvents).toEqual({ teleport_completed: 2, flux_capacitor_charged: 1 });
    expect(debug).toHaveLength(2);
    const logged = debug.map((call) => JSON.stringify(call.args));
    expect(logged.filter((line) => line.includes('teleport_completed'))).toHaveLength(1);
    expect(logged.filter((line) => line.includes('flux_capacitor_charged'))).toHaveLength(1);
    // The api_request had no session and no ids, so it was skipped, not stored.
    expect(result.skipped).toBe(1);
    expect(warn).toHaveLength(1);
  });

  it('logs nothing when every event name is recognised', () => {
    const db = freshDb();
    const { logger, debug, warn } = recordingLogger();

    const result = ingestEvents(db, fixtureEvents('001.json'), { ...OWNER, logger });

    expect(result.unknownEvents).toEqual({});
    expect(debug).toHaveLength(0);
    expect(warn).toHaveLength(0);
  });
});

describe('odd but well-formed events', () => {
  it('stores an event with no timestamp, no model and zero tokens without throwing', () => {
    const db = freshDb();
    const events = syntheticEvents([
      // No timeUnixNano, no event.timestamp: the parser reports ts 0.
      record([
        attr('event.name', str('api_request')),
        attr('session.id', str(FIXTURE_SESSION_ID)),
        attr('client_request_id', str('cid_bare')),
      ]),
    ]);
    expect(onlyApiRequest(events).ts).toBe(0);

    const result = ingestEvents(db, events, OWNER);

    expect(result.inserted).toBe(1);
    expect(requestRows(db)).toEqual([
      {
        id: 'cid_bare',
        ts: 0,
        member_id: UNATTRIBUTED_MEMBER_ID,
        install_id: null,
        session_id: FIXTURE_SESSION_ID,
        prompt_id: null,
        model: null,
        model_family: 'other',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_micros: 0,
        duration_ms: null,
        query_source: null,
        speed: null,
        effort: null,
      },
    ]);
  });

  it('clamps negative counters to zero rather than subtracting from a total', () => {
    const db = freshDb();

    ingestEvents(
      db,
      syntheticEvents([
        record([
          attr('event.name', str('api_request')),
          attr('client_request_id', str('cid_negative')),
          attr('input_tokens', int(-5)),
          attr('output_tokens', int(-1)),
          attr('cost_usd_micros', int(-963)),
          attr('duration_ms', int(-4)),
        ]),
      ]),
      OWNER,
    );

    const row = must(requestRows(db)[0], 'the clamped row');
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cost_micros).toBe(0);
    expect(row.duration_ms).toBe(0);
  });

  it('writes nothing and reports zeroes for an empty batch', () => {
    const db = freshDb();

    const result = ingestEvents(db, [], OWNER);

    expect(result).toEqual({
      received: 0,
      apiRequests: 0,
      inserted: 0,
      duplicates: 0,
      skipped: 0,
      installsTouched: 0,
      unknownEvents: {},
    });
    expect(requestRows(db)).toHaveLength(0);
    expect(installRows(db)).toHaveLength(0);
  });

  it('attributes rows to an explicit member when one is given', () => {
    const db = freshDb();
    db.prepare(
      'INSERT INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run('m_rahim', 'Rahim', 'sha256:rahim', 1_700_000_000_000);

    ingestEvents(db, fixtureEvents('001.json'), { memberId: 'm_rahim' });

    expect(must(requestRows(db)[0], 'the row').member_id).toBe('m_rahim');
    expect(must(installRows(db)[0], 'the install row').member_id).toBe('m_rahim');
  });
});
