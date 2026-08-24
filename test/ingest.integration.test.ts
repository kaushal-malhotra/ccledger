/**
 * Stage 1 acceptance, clause by clause.
 *
 * Each test here is named after one clause of the stage 1 brief and drives the
 * real HTTP surface against a real SQLite file. The colocated unit tests cover
 * the parts in isolation; this file exists to prove the assembled path does
 * what was promised, and is written against the specification rather than
 * against what the implementation happens to do.
 */

import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

import { buildApp } from '../src/server/app.js';
import { generateMemberToken, hashToken } from '../src/server/auth.js';
import { parseOtlpLogsPayload, isApiRequest } from '../src/server/otlp.js';
import { migratedDatabase } from '../src/db/index.js';

/** The two stage 0 captures, as raw JSON text. */
const FIXTURES = {
  '001': readFileSync(new URL('./fixtures/001.json', import.meta.url), 'utf8'),
  '002': readFileSync(new URL('./fixtures/002.json', import.meta.url), 'utf8'),
} as const;

/**
 * Values that exist in the fixtures and must never survive into storage: the
 * four PII attributes, plus the placeholder Claude Code ships in the content
 * attributes it sends whether or not content logging is on.
 */
const MUST_NOT_PERSIST = [
  'teammate@example.invalid',
  '22222222-2222-4222-8222-222222222222',
  'user_012FIXTUREACCOUNTID000',
  '11111111-1111-4111-8111-111111111111',
  '<REDACTED>',
] as const;

/** Bodies that can never parse. None of them may produce a 5xx. */
const MALFORMED_BODIES: ReadonlyArray<readonly [string, string]> = [
  ['empty', ''],
  ['truncated json', '{"resourceLogs": ['],
  ['not json at all', 'resourceLogs'],
  ['json but not an envelope', '{"hello":"world"}'],
  ['json array', '[]'],
  ['json string', '"resourceLogs"'],
  ['json number', '42'],
  ['json null', 'null'],
  ['resourceLogs of the wrong type', '{"resourceLogs":"nope"}'],
];

const openHandles: Database.Database[] = [];
const openApps: FastifyInstance[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
  for (const db of openHandles.splice(0)) {
    if (db.open) {
      db.close();
    }
  }
  for (const path of tempPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

/** A migrated database in a real file, so the PII check can read its bytes. */
function freshDatabase(): { db: Database.Database; path: string } {
  const path = join(tmpdir(), `ccledger-acceptance-${randomUUID()}.db`);
  tempPaths.push(path);
  const db = migratedDatabase(path);
  openHandles.push(db);
  return { db, path };
}

/**
 * The ingest token every request in this file carries, and the member it
 * belongs to. Stage 2 made a token mandatory on the ingest route; what this
 * file is about is the payload, so one member stands in for the whole team.
 */
const MEMBER_TOKEN = generateMemberToken();
const MEMBER_ID = 'm_acceptance';

/** An app over a fresh database, with logging off and one member enrolled. */
function freshApp(): { app: FastifyInstance; db: Database.Database; path: string } {
  const { db, path } = freshDatabase();
  db.prepare(
    'INSERT INTO members (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(MEMBER_ID, 'Acceptance', hashToken(MEMBER_TOKEN), 1_700_000_000_000);
  const app = buildApp({ db });
  openApps.push(app);
  return { app, db, path };
}

/** POSTs a raw, authenticated body to the ingest route. */
async function post(
  app: FastifyInstance,
  payload: string | Buffer,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/logs',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${MEMBER_TOKEN}`,
      ...headers,
    },
    payload,
  });
}

/** Row count of a table. */
function rowCount(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  if (typeof row === 'object' && row !== null && typeof (row as { n?: unknown }).n === 'number') {
    return (row as { n: number }).n;
  }
  throw new Error(`no count from ${table}`);
}

/** Every user table in the database. */
function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => {
      if (typeof row === 'object' && row !== null) {
        const name = (row as { name?: unknown }).name;
        if (typeof name === 'string') {
          return name;
        }
      }
      throw new Error('table row has no name');
    });
}

describe('both fixture files parse', () => {
  it.each(['001', '002'] as const)('%s parses without an envelope error', (fixture) => {
    const result = parseOtlpLogsPayload(JSON.parse(FIXTURES[fixture]));

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.issues).toEqual([]);
  });
});

describe('001 yields 6 records and 002 yields 4', () => {
  it('counts six log records in 001', () => {
    const result = parseOtlpLogsPayload(JSON.parse(FIXTURES['001']));

    expect(result.counts.logRecords).toBe(6);
    expect(result.events).toHaveLength(6);
  });

  it('counts four log records in 002', () => {
    const result = parseOtlpLogsPayload(JSON.parse(FIXTURES['002']));

    expect(result.counts.logRecords).toBe(4);
    expect(result.events).toHaveLength(4);
  });
});

describe('exactly 2 api_request rows total across both', () => {
  it('writes two rows and no more, whichever order the payloads arrive in', async () => {
    const { app, db } = freshApp();

    expect((await post(app, FIXTURES['002'])).statusCode).toBe(200);
    expect((await post(app, FIXTURES['001'])).statusCode).toBe(200);

    expect(rowCount(db, 'requests')).toBe(2);

    // The other eight records are not api_request and must not have become rows.
    const parsed = [FIXTURES['001'], FIXTURES['002']].flatMap(
      (text) => parseOtlpLogsPayload(JSON.parse(text)).events,
    );
    expect(parsed).toHaveLength(10);
    expect(parsed.filter(isApiRequest)).toHaveLength(2);
  });

  it('stores the two requests with the values the capture carried', async () => {
    const { app, db } = freshApp();

    await post(app, FIXTURES['001']);
    await post(app, FIXTURES['002']);

    const rows = db
      .prepare(
        'SELECT id, ts, model, model_family, input_tokens, output_tokens, cost_micros FROM requests ORDER BY ts',
      )
      .all();

    expect(rows).toEqual([
      {
        id: 'f1f6314c-4ac2-4e04-afc4-6e2b7b477bd6',
        ts: 1787503991194,
        model: 'claude-haiku-4-5-20251001',
        model_family: 'haiku',
        input_tokens: 898,
        output_tokens: 13,
        cost_micros: 963,
      },
      {
        id: '4c5693d6-70ad-4503-bc26-47b1816fd1f9',
        ts: 1787503997172,
        model: 'claude-opus-5',
        model_family: 'opus',
        input_tokens: 2,
        output_tokens: 317,
        cost_micros: 99585,
      },
    ]);
  });
});

describe('numeric coercion works for both bare-number and quoted forms', () => {
  it('stores a bare intValue as a number', async () => {
    const { app, db } = freshApp();

    // input_tokens arrives as {"intValue": 898} — a bare JSON number.
    await post(app, FIXTURES['001']);

    const row = db.prepare('SELECT input_tokens, cost_micros FROM requests').get() as {
      input_tokens: unknown;
      cost_micros: unknown;
    };

    expect(typeof row.input_tokens).toBe('number');
    expect(row.input_tokens).toBe(898);
    expect(typeof row.cost_micros).toBe('number');
    expect(row.cost_micros).toBe(963);
  });

  it('stores a quoted nanosecond timestamp as a number of milliseconds', () => {
    // timeUnixNano arrives as "1787503991194000000" — a quoted string past
    // Number.MAX_SAFE_INTEGER, and event.timestamp is the ISO form of the same
    // instant. Both must land on the same millisecond.
    const payload = JSON.parse(FIXTURES['001']) as {
      resourceLogs: [{ scopeLogs: [{ logRecords: Array<Record<string, unknown>> }] }];
    };
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    const apiRequest = records.find((record) => {
      const attributes = record['attributes'];
      return (
        Array.isArray(attributes) &&
        attributes.some(
          (attribute: unknown) =>
            typeof attribute === 'object' &&
            attribute !== null &&
            (attribute as { key?: unknown }).key === 'event.name' &&
            (attribute as { value?: { stringValue?: unknown } }).value?.stringValue ===
              'api_request',
        )
      );
    });
    expect(apiRequest).toBeDefined();
    expect(typeof apiRequest?.['timeUnixNano']).toBe('string');

    // Drop event.timestamp so the quoted nanosecond field is the only source.
    const attributes = apiRequest?.['attributes'];
    expect(Array.isArray(attributes)).toBe(true);
    apiRequest!['attributes'] = (attributes as unknown[]).filter(
      (attribute) =>
        !(
          typeof attribute === 'object' &&
          attribute !== null &&
          (attribute as { key?: unknown }).key === 'event.timestamp'
        ),
    );

    const event = parseOtlpLogsPayload(payload).events.filter(isApiRequest)[0];

    expect(event).toBeDefined();
    expect(typeof event?.ts).toBe('number');
    expect(event?.ts).toBe(1787503991194);
    expect(event?.timestampSource).toBe('timeUnixNano');
  });
});

describe('duplicate delivery of the same file inserts no new rows', () => {
  it('is a no-op on redelivery, which is what at-least-once demands', async () => {
    const { app, db } = freshApp();

    await post(app, FIXTURES['001']);
    await post(app, FIXTURES['002']);
    expect(rowCount(db, 'requests')).toBe(2);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = await post(app, FIXTURES['001']);
      const second = await post(app, FIXTURES['002']);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
    }

    expect(rowCount(db, 'requests')).toBe(2);
    expect(rowCount(db, 'installs')).toBe(1);
  });

  it('is a no-op when the redelivery is gzipped instead of plain', async () => {
    const { app, db } = freshApp();

    await post(app, FIXTURES['001']);
    const gzipped = await post(app, gzipSync(Buffer.from(FIXTURES['001'], 'utf8')), {
      'content-encoding': 'gzip',
    });

    expect(gzipped.statusCode).toBe(200);
    expect(rowCount(db, 'requests')).toBe(1);
  });
});

describe('malformed payload returns 400 not 500', () => {
  it.each(MALFORMED_BODIES)('%s is rejected with 400', async (_name, body) => {
    const { app } = freshApp();

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(500);
  });

  it('never answers 5xx to anything unparseable, including bad gzip', async () => {
    const { app, db } = freshApp();

    const statuses: number[] = [];
    for (const [, body] of MALFORMED_BODIES) {
      statuses.push((await post(app, body)).statusCode);
    }
    statuses.push((await post(app, 'not gzip at all', { 'content-encoding': 'gzip' })).statusCode);

    for (const status of statuses) {
      expect(status).toBeLessThan(500);
    }
    expect(rowCount(db, 'requests')).toBe(0);
  });

  it('does not echo the rejected body back to the sender', async () => {
    const { app } = freshApp();

    const response = await post(app, '{"secret-marker-do-not-echo": [');

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('secret-marker-do-not-echo');
  });
});

describe("missing optional attributes don't throw", () => {
  it('parses the api_request that carries neither prompt.id nor effort', () => {
    const event = parseOtlpLogsPayload(JSON.parse(FIXTURES['001'])).events.filter(isApiRequest)[0];

    expect(event).toBeDefined();
    expect(event?.promptId).toBeUndefined();
    expect(event?.effort).toBeUndefined();
    expect(event?.querySource).toBe('generate_session_title');
  });

  it('stores nulls for the absent optional columns rather than failing', async () => {
    const { app, db } = freshApp();

    await post(app, FIXTURES['001']);

    const row = db.prepare('SELECT prompt_id, effort, duration_ms FROM requests').get() as Record<
      string,
      unknown
    >;

    expect(row['prompt_id']).toBeNull();
    expect(row['effort']).toBeNull();
    expect(row['duration_ms']).toBe(1014);
  });

  it('accepts a record stripped of every optional attribute', async () => {
    const { app } = freshApp();

    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'api_request' } },
                    { key: 'session.id', value: { stringValue: 'bare-session' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await post(app, JSON.stringify(payload));

    expect(response.statusCode).toBe(200);
  });
});

describe('no PII field reaches the database', () => {
  it('has no column that could hold an identity or content attribute', () => {
    const { db } = freshDatabase();

    const forbidden = ['email', 'account', 'organization', 'prompt_text', 'response'];
    for (const table of tableNames(db)) {
      const columns = db
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all(table)
        .map((row) => String((row as { name: unknown }).name).toLowerCase());

      for (const column of columns) {
        for (const term of forbidden) {
          expect(`${table}.${column}`).not.toContain(term);
        }
      }
    }
  });

  it('has no cell in any table containing a sentinel value', async () => {
    const { app, db } = freshApp();

    await post(app, FIXTURES['001']);
    await post(app, FIXTURES['002']);

    for (const table of tableNames(db)) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      const serialised = JSON.stringify(rows);

      for (const sentinel of MUST_NOT_PERSIST) {
        expect(serialised).not.toContain(sentinel);
      }
    }
  });

  it('has no sentinel anywhere in the database file on disk', async () => {
    const { app, db, path } = freshApp();

    await post(app, FIXTURES['001']);
    await post(app, FIXTURES['002']);

    // Fold the WAL back in and close, or the assertion reads a stale main file
    // while the rows it is looking for sit in the sidecar.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();

    const bytes = readFileSync(path).toString('latin1');

    expect(bytes.length).toBeGreaterThan(0);
    for (const sentinel of MUST_NOT_PERSIST) {
      expect(bytes).not.toContain(sentinel);
    }
    // The row that should be there, proving the file is the one just written.
    expect(bytes).toContain('f1f6314c-4ac2-4e04-afc4-6e2b7b477bd6');
  });

  it('does not return a sentinel in the ingest response', async () => {
    const { app } = freshApp();

    const response = await post(app, FIXTURES['001']);

    expect(response.body).toBe('{"partialSuccess":{}}');
    for (const sentinel of MUST_NOT_PERSIST) {
      expect(response.body).not.toContain(sentinel);
    }
  });
});
