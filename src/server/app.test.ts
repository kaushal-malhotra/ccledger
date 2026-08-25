/**
 * HTTP-level tests for the ingest app, driven through `app.inject()` so no
 * socket is ever opened.
 *
 * Most of this file is one assertion written many ways: a body that will never
 * parse must come back 4xx. OTLP exporters treat 5xx as "try again" and 4xx as
 * "give up", so a single 500 on a permanently broken payload is not a cosmetic
 * bug — it is an unbounded retry loop pointed at this server. Every shape below
 * is therefore a shape someone's exporter could actually send.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { migratedDatabase } from '../db/index.js';
import type { Database } from '../db/index.js';
import { DROPPED_ATTRIBUTE_KEYS } from '../shared/constants.js';
import { buildApp } from './app.js';
import {
  ensureAdminToken,
  generateAdminToken,
  generateMemberToken,
  hashToken,
  revokeMember,
} from './auth.js';
import { createJoinCodeStore } from '../db/joincodes.js';
import { JOIN_CODE_TTL_MS } from '../shared/constants.js';
import type { JoinResponseBody } from '../shared/types.js';

/** The exact bytes an OTLP exporter must see for a fully accepted batch. */
const SUCCESS_BODY = '{"partialSuccess":{}}';

/** The default `Content-Type` an OTLP/HTTP JSON exporter sends. */
const JSON_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };

/**
 * The ingest token every request in this file carries. One per run rather than
 * one per app, so `postLogs` can attach it without threading a harness through
 * every call — what is under test here is the body handling, not who sent it.
 */
const MEMBER_TOKEN = generateMemberToken();

/** The member `MEMBER_TOKEN` belongs to. */
const MEMBER_ID = 'm_fixture_alice';

/** The header that makes a request authenticated. */
const AUTH_HEADER: Readonly<Record<string, string>> = {
  authorization: `Bearer ${MEMBER_TOKEN}`,
};

/**
 * The four values `test/fixtures/README.md` says were substituted for real PII.
 * They are in the fixture bodies, so any response that quotes a request would
 * quote one of them — which makes them a cheap detector for an echoing handler.
 */
const PII_SENTINELS: readonly string[] = [
  'teammate@example.invalid',
  '22222222-2222-4222-8222-222222222222',
  'user_012FIXTUREACCOUNTID000',
  '11111111-1111-4111-8111-111111111111',
];

/** The `/health` payload, per the contract. */
interface HealthBody {
  readonly status: string;
  readonly version: string;
  readonly uptimeSeconds: number;
}

/** The body every rejection uses. */
interface ErrorBody {
  readonly error: string;
}

/** One `COUNT(*)` result. */
interface CountRow {
  readonly n: number;
}

/** An app and the database behind it, both registered for teardown. */
interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database.Database;
}

const openApps: FastifyInstance[] = [];
const openHandles: Database.Database[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
  // `:memory:` still holds a native handle; closing it keeps the suite from
  // leaking one per test.
  for (const db of openHandles.splice(0)) {
    db.close();
  }
});

/** A migrated in-memory database with an app on top, torn down after the test. */
function freshApp(bodyLimit?: number): Harness {
  const db = migratedDatabase(':memory:');
  openHandles.push(db);
  seedMember(db, MEMBER_ID, MEMBER_TOKEN);
  // `exactOptionalPropertyTypes` forbids passing `bodyLimit: undefined`.
  const app = buildApp(bodyLimit === undefined ? { db } : { db, bodyLimit });
  openApps.push(app);
  return { app, db };
}

/** Inserts a member whose token is known, so requests can be authenticated. */
function seedMember(db: Database.Database, id: string, token: string, revokedAt?: number): void {
  db.prepare(
    'INSERT INTO members (id, display_name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, id, hashToken(token), 1_700_000_000_000, revokedAt ?? null);
}

/** A checked-in capture, read relative to this file so `cwd` cannot matter. */
function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');
}

/** A plain JSON object; `null` is not one. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The version `/health` should report, from the same file the app reads. */
function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  if (isRecordObject(parsed) && typeof parsed.version === 'string') return parsed.version;
  throw new Error('package.json has no version');
}

/**
 * POSTs one authenticated body to the ingest route. The bearer header is added
 * rather than taken from `headers`, so a test that overrides the content type
 * does not silently lose its credentials and start asserting against a 401.
 */
async function postLogs(
  app: FastifyInstance,
  payload: string | Buffer,
  headers: Readonly<Record<string, string>> = JSON_HEADERS,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/logs',
    headers: { ...AUTH_HEADER, ...headers },
    payload,
  });
}

/** Rows currently in `requests`. */
function requestCount(db: Database.Database): number {
  const row = db.prepare<[], CountRow>('SELECT COUNT(*) AS n FROM requests').get();
  return row?.n ?? 0;
}

/** One entry in the malformed-body table. */
interface MalformedCase {
  readonly name: string;
  readonly payload: string | Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Every way a body can be wrong that this app has an opinion about. Used both
 * for the no-500 sweep and, individually, for the exact status assertions.
 */
const MALFORMED_BODIES: readonly MalformedCase[] = [
  { name: 'empty string', payload: '', headers: JSON_HEADERS },
  { name: 'empty string, no content-type', payload: '', headers: {} },
  { name: 'whitespace only', payload: '   ', headers: JSON_HEADERS },
  { name: 'truncated JSON', payload: '{"resourceLogs": [', headers: JSON_HEADERS },
  { name: 'not JSON at all', payload: 'this is not json', headers: JSON_HEADERS },
  { name: 'NUL bytes', payload: Buffer.from([0, 1, 2, 3, 255]), headers: JSON_HEADERS },
  { name: 'JSON string literal', payload: '"x"', headers: JSON_HEADERS },
  { name: 'JSON number literal', payload: '42', headers: JSON_HEADERS },
  { name: 'JSON null literal', payload: 'null', headers: JSON_HEADERS },
  { name: 'JSON true literal', payload: 'true', headers: JSON_HEADERS },
  { name: 'JSON array', payload: '[]', headers: JSON_HEADERS },
  { name: 'unrelated object', payload: '{"hello":"world"}', headers: JSON_HEADERS },
  { name: 'resourceLogs is an object', payload: '{"resourceLogs":{}}', headers: JSON_HEADERS },
  { name: 'resourceLogs is a string', payload: '{"resourceLogs":"nope"}', headers: JSON_HEADERS },
  { name: 'resourceLogs is null', payload: '{"resourceLogs":null}', headers: JSON_HEADERS },
  {
    name: 'gzip header, plain body',
    payload: '{"resourceLogs":[]}',
    headers: { ...JSON_HEADERS, 'content-encoding': 'gzip' },
  },
  {
    name: 'gzip header, truncated gzip body',
    payload: gzipSync(Buffer.from('{"resourceLogs":[]}', 'utf8')).subarray(0, 6),
    headers: { ...JSON_HEADERS, 'content-encoding': 'gzip' },
  },
  {
    name: 'deflate header, plain body',
    payload: '{"resourceLogs":[]}',
    headers: { ...JSON_HEADERS, 'content-encoding': 'deflate' },
  },
  {
    name: 'br header, plain body',
    payload: '{"resourceLogs":[]}',
    headers: { ...JSON_HEADERS, 'content-encoding': 'br' },
  },
  {
    name: 'unknown content-encoding',
    payload: '{"resourceLogs":[]}',
    headers: { ...JSON_HEADERS, 'content-encoding': 'snappy' },
  },
  {
    name: 'stacked content-encoding',
    payload: gzipSync(Buffer.from('{"resourceLogs":[]}', 'utf8')),
    headers: { ...JSON_HEADERS, 'content-encoding': 'gzip, br' },
  },
  {
    name: 'protobuf',
    payload: Buffer.from([10, 0]),
    headers: { 'content-type': 'application/x-protobuf' },
  },
  { name: 'text/plain garbage', payload: 'nope', headers: { 'content-type': 'text/plain' } },
  {
    name: 'octet-stream garbage',
    payload: Buffer.from([200, 201, 202]),
    headers: { 'content-type': 'application/octet-stream' },
  },
  { name: 'no content-type, garbage', payload: 'nope', headers: {} },
  {
    name: 'JSON content-type with a bogus parameter',
    payload: 'nope',
    headers: { 'content-type': 'application/json; charset=iso-8859-99' },
  },
];

/**
 * Bodies whose envelope is usable but whose insides are junk. These are *not*
 * rejections: the parser turns a broken sub-tree into an issue and keeps the
 * records that survived, so an exporter that ships one bad record still gets
 * its good ones stored. They are here to prove they cannot reach a 500 either.
 */
const ODD_BUT_VALID_BODIES: readonly MalformedCase[] = [
  {
    name: 'null entries all the way down',
    payload: '{"resourceLogs":[null,{"scopeLogs":"x"},{"scopeLogs":[{"logRecords":[null,7]}]}]}',
    headers: JSON_HEADERS,
  },
  {
    name: 'attributes are not arrays',
    payload:
      '{"resourceLogs":[{"resource":{"attributes":"x"},"scopeLogs":[{"logRecords":[{"attributes":{}}]}]}]}',
    headers: JSON_HEADERS,
  },
  {
    name: 'an api_request with no usable field at all',
    payload:
      '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[{"key":"event.name","value":{"stringValue":"api_request"}}]}]}]}]}',
    headers: JSON_HEADERS,
  },
];

describe('GET /health', () => {
  it('returns 200 and the documented shape', async () => {
    const { app } = freshApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<HealthBody>();
    expect(Object.keys(body).sort()).toEqual(['status', 'uptimeSeconds', 'version']);
    expect(body.status).toBe('ok');
    expect(body.version).toBe(packageVersion());
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('resolves the version once at load, not per request', async () => {
    const { app } = freshApp();

    // A version read per request would pick this up; one resolved at module
    // load cannot. Restored before any assertion can throw.
    const packageJson = fileURLToPath(new URL('../../package.json', import.meta.url));
    const original = readFileSync(packageJson, 'utf8');
    const before = await app.inject({ method: 'GET', url: '/health' });
    try {
      writeFileSync(
        packageJson,
        JSON.stringify({ ...(JSON.parse(original) as object), version: '99.99.99' }, null, 2),
      );
      const after = await app.inject({ method: 'GET', url: '/health' });
      expect(after.json<HealthBody>().version).toBe(before.json<HealthBody>().version);
      expect(after.json<HealthBody>().version).not.toBe('99.99.99');
    } finally {
      writeFileSync(packageJson, original);
    }
  });
});

describe('POST /v1/logs — accepted bodies', () => {
  it('answers 200 with exactly the OTLP success envelope', async () => {
    const { app } = freshApp();

    const response = await postLogs(app, fixture('001.json'));

    expect(response.statusCode).toBe(200);
    // The serialised bytes, not a deep-equal on a parse: an exporter compares
    // the response against the proto3 JSON encoding, so key order and the
    // absence of extra fields are part of the contract.
    expect(response.body).toBe(SUCCESS_BODY);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('writes one row per api_request and nothing on redelivery', async () => {
    const { app, db } = freshApp();

    expect((await postLogs(app, fixture('001.json'))).statusCode).toBe(200);
    expect((await postLogs(app, fixture('002.json'))).statusCode).toBe(200);
    // Two api_request records across the two captures.
    expect(requestCount(db)).toBe(2);

    // OTLP delivery is at-least-once; the second delivery must cost nothing.
    const replayFirst = await postLogs(app, fixture('001.json'));
    const replaySecond = await postLogs(app, fixture('002.json'));

    expect(replayFirst.statusCode).toBe(200);
    expect(replaySecond.statusCode).toBe(200);
    expect(replayFirst.body).toBe(SUCCESS_BODY);
    expect(replaySecond.body).toBe(SUCCESS_BODY);
    expect(requestCount(db)).toBe(2);
  });

  it('accepts an empty batch', async () => {
    const { app, db } = freshApp();

    const response = await postLogs(app, '{"resourceLogs":[]}');

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(SUCCESS_BODY);
    expect(requestCount(db)).toBe(0);
  });

  it('handles a missing Content-Type rather than answering 415', async () => {
    const { app, db } = freshApp();

    const response = await postLogs(app, fixture('001.json'), {});

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(SUCCESS_BODY);
    expect(requestCount(db)).toBe(1);
  });

  it('accepts a Content-Type with parameters', async () => {
    const { app } = freshApp();

    const response = await postLogs(app, fixture('001.json'), {
      'content-type': 'application/json; charset=utf-8',
    });

    expect(response.statusCode).toBe(200);
  });

  it('accepts Content-Encoding: identity as unencoded', async () => {
    const { app, db } = freshApp();

    const response = await postLogs(app, fixture('001.json'), {
      ...JSON_HEADERS,
      'content-encoding': 'identity',
    });

    expect(response.statusCode).toBe(200);
    expect(requestCount(db)).toBe(1);
  });
});

describe('POST /v1/logs — compression', () => {
  const codecs: readonly {
    readonly name: string;
    readonly encode: (input: Buffer) => Buffer;
  }[] = [
    { name: 'gzip', encode: (input) => gzipSync(input) },
    { name: 'deflate', encode: (input) => deflateSync(input) },
    { name: 'br', encode: (input) => brotliCompressSync(input) },
  ];

  for (const codec of codecs) {
    it(`gives the identical result for a ${codec.name} body`, async () => {
      const { app, db } = freshApp();

      const first = await postLogs(app, codec.encode(Buffer.from(fixture('001.json'), 'utf8')), {
        ...JSON_HEADERS,
        'content-encoding': codec.name,
      });
      const second = await postLogs(app, codec.encode(Buffer.from(fixture('002.json'), 'utf8')), {
        ...JSON_HEADERS,
        'content-encoding': codec.name,
      });

      expect(first.statusCode).toBe(200);
      expect(first.body).toBe(SUCCESS_BODY);
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe(SUCCESS_BODY);
      expect(requestCount(db)).toBe(2);
    });

    it(`rejects a ${codec.name} header over a body that is not ${codec.name}`, async () => {
      const { app, db } = freshApp();

      const response = await postLogs(app, fixture('001.json'), {
        ...JSON_HEADERS,
        'content-encoding': codec.name,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error).toBe('request body could not be decompressed');
      expect(requestCount(db)).toBe(0);
    });
  }

  it('rejects an unknown Content-Encoding', async () => {
    const { app } = freshApp();

    const response = await postLogs(app, '{"resourceLogs":[]}', {
      ...JSON_HEADERS,
      'content-encoding': 'snappy',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error).toContain('unsupported Content-Encoding');
  });

  it('refuses a body that inflates past the ceiling instead of allocating it', async () => {
    // A zip bomb. Fastify caps the bytes on the wire, so the only guard on the
    // decompressed size is the one in the handler — and this body has to be
    // small enough on the wire that the wire cap is not what rejects it.
    const bodyLimit = 64 * 1024;
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(bodyLimit);
    const { app, db } = freshApp(bodyLimit);

    const response = await postLogs(app, bomb, { ...JSON_HEADERS, 'content-encoding': 'gzip' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error).toBe('request body could not be decompressed');
    expect(requestCount(db)).toBe(0);
  });
});

describe('POST /v1/logs — rejected bodies', () => {
  it('answers 400 for invalid JSON without echoing the submitted bytes', async () => {
    const { app } = freshApp();
    const submitted = '{"resourceLogs": [ teammate@example.invalid';

    const response = await postLogs(app, submitted);

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    const body = response.json<ErrorBody>();
    expect(typeof body.error).toBe('string');
    // `JSON.parse`'s own message quotes the offending input, so using it would
    // reflect the caller's payload straight back out.
    expect(response.body).not.toContain('teammate@example.invalid');
    expect(response.body).not.toContain('resourceLogs');
  });

  it('answers 400 for valid JSON that is not an OTLP envelope', async () => {
    const { app } = freshApp();
    const notEnvelopes = ['{"hello":"world"}', '[]', '"x"', '42', 'null', 'true'];

    for (const payload of notEnvelopes) {
      const response = await postLogs(app, payload);
      expect({ payload, statusCode: response.statusCode }).toEqual({ payload, statusCode: 400 });
      expect(typeof response.json<ErrorBody>().error).toBe('string');
    }
  });

  it('answers 400 for an envelope whose resourceLogs is not an array', async () => {
    const { app } = freshApp();

    for (const payload of [
      '{"resourceLogs":{}}',
      '{"resourceLogs":"nope"}',
      '{"resourceLogs":1}',
    ]) {
      expect((await postLogs(app, payload)).statusCode).toBe(400);
    }
  });

  it('answers 400 for an empty body, with or without a Content-Type', async () => {
    const { app } = freshApp();

    const withType = await postLogs(app, '');
    const withoutType = await postLogs(app, '', {});
    const noPayloadAtAll = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { ...AUTH_HEADER, ...JSON_HEADERS },
    });

    expect(withType.statusCode).toBe(400);
    expect(withoutType.statusCode).toBe(400);
    expect(noPayloadAtAll.statusCode).toBe(400);
    expect(withType.json<ErrorBody>().error).toBe('request body is empty');
  });

  it('answers 415 for protobuf, the OTLP encoding this server does not speak', async () => {
    const { app } = freshApp();

    const response = await postLogs(app, Buffer.from([10, 0]), {
      'content-type': 'application/x-protobuf',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<ErrorBody>().error).toContain('JSON');
  });

  it('answers 413 for a body over bodyLimit', async () => {
    const { app } = freshApp(1024);

    const response = await postLogs(app, 'x'.repeat(4096));

    expect(response.statusCode).toBe(413);
    expect(typeof response.json<ErrorBody>().error).toBe('string');
  });

  it('answers 404 for an unknown route', async () => {
    const { app } = freshApp();

    const response = await app.inject({ method: 'POST', url: '/v2/logs', payload: '{}' });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /v1/logs — never 500', () => {
  it('answers 4xx for every malformed body', async () => {
    const { app } = freshApp(1024 * 1024);

    const statuses: Record<string, number> = {};
    for (const testCase of MALFORMED_BODIES) {
      const response = await postLogs(app, testCase.payload, testCase.headers);
      statuses[testCase.name] = response.statusCode;
    }

    // Reported as a list of names so a regression says which body broke.
    const outsideClientErrorRange = Object.entries(statuses).filter(
      ([, code]) => code < 400 || code > 499,
    );
    expect(outsideClientErrorRange).toEqual([]);
  });

  it('never answers 5xx, for any body in the table', async () => {
    const { app } = freshApp(1024 * 1024);

    const statuses: Record<string, number> = {};
    for (const testCase of [...MALFORMED_BODIES, ...ODD_BUT_VALID_BODIES]) {
      const response = await postLogs(app, testCase.payload, testCase.headers);
      statuses[testCase.name] = response.statusCode;
    }

    // The whole point of the file: a 5xx tells an OTLP exporter to retry, and a
    // body in this table will fail identically forever.
    const serverErrors = Object.entries(statuses).filter(([, code]) => code >= 500);
    expect(serverErrors).toEqual([]);
  });

  it('stores nothing from any body in the table', async () => {
    const { app, db } = freshApp(1024 * 1024);

    for (const testCase of [...MALFORMED_BODIES, ...ODD_BUT_VALID_BODIES]) {
      await postLogs(app, testCase.payload, testCase.headers);
    }

    expect(requestCount(db)).toBe(0);
  });
});

describe('response bodies leak nothing', () => {
  it('returns none of the PII sentinels the fixtures carry', async () => {
    const { app } = freshApp();

    const accepted = await postLogs(app, fixture('001.json'));
    const alsoAccepted = await postLogs(app, fixture('002.json'));
    // The same records, wrapped so the envelope is unusable: the rejection path
    // sees the sentinels too, and must not repeat them either.
    const rejected = await postLogs(app, `{"notResourceLogs":${fixture('001.json')}}`);
    const truncated = await postLogs(app, fixture('002.json').slice(0, 900));

    for (const response of [accepted, alsoAccepted, rejected, truncated]) {
      expect(response.statusCode).toBeLessThan(500);
      for (const sentinel of PII_SENTINELS) {
        expect(response.body).not.toContain(sentinel);
      }
    }
  });

  it('never names a dropped attribute key', async () => {
    const { app } = freshApp();

    const responses: LightMyRequestResponse[] = [
      await app.inject({ method: 'GET', url: '/health' }),
      await postLogs(app, fixture('001.json')),
      await postLogs(app, '{"hello":"world"}'),
      await postLogs(app, 'not json'),
      await postLogs(app, '', {}),
    ];

    for (const response of responses) {
      for (const key of DROPPED_ATTRIBUTE_KEYS) {
        expect(response.body).not.toContain(key);
      }
    }
  });
});

describe('POST /v1/logs — authentication', () => {
  /** The ingest route with no `Authorization` header at all. */
  async function postWithout(
    app: FastifyInstance,
    payload: string | Buffer,
    headers: Readonly<Record<string, string>> = JSON_HEADERS,
  ): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url: '/v1/logs', headers: { ...headers }, payload });
  }

  it('answers 401 with a challenge when there is no token', async () => {
    const { app, db } = freshApp();

    const response = await postWithout(app, fixture('001.json'));

    expect(response.statusCode).toBe(401);
    // A 401 without this is a status code with no instruction attached.
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(requestCount(db)).toBe(0);
  });

  it.each([
    ['a token nobody was issued', generateMemberToken()],
    ['an admin token, which is a token for something else', generateAdminToken()],
    ['a hex digest, in case a hash was pasted in place of a token', hashToken('x')],
    ['something that is not a token', 'hunter2'],
    ['an empty token', ''],
  ])('answers 401 for %s', async (_label, token) => {
    const { app, db } = freshApp();

    const response = await postWithout(app, fixture('001.json'), {
      ...JSON_HEADERS,
      authorization: `Bearer ${token}`,
    });

    expect(response.statusCode).toBe(401);
    expect(requestCount(db)).toBe(0);
  });

  it('answers 401 for a header that is not a Bearer header', async () => {
    const { app } = freshApp();

    const response = await postWithout(app, fixture('001.json'), {
      ...JSON_HEADERS,
      authorization: `Basic ${MEMBER_TOKEN}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 403 for a revoked member, which is a different instruction', async () => {
    const { app, db } = freshApp();
    revokeMember(db, MEMBER_ID, 1_700_000_001_000);

    const response = await postLogs(app, fixture('001.json'));

    // 401 means "your config is wrong"; 403 means "ask your admin". Both are
    // 4xx, so an OTLP exporter drops the batch rather than retrying for ever.
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error).toMatch(/revoked/);
    expect(requestCount(db)).toBe(0);
  });

  it('attributes every row to the member the token resolved to', async () => {
    const { app, db } = freshApp();

    await postLogs(app, fixture('001.json'));

    const owners = db
      .prepare('SELECT DISTINCT member_id AS id FROM requests')
      .all()
      .map((row) => (row as { id: string }).id);
    const installOwners = db
      .prepare('SELECT DISTINCT member_id AS id FROM installs')
      .all()
      .map((row) => (row as { id: string }).id);

    expect(owners).toEqual([MEMBER_ID]);
    expect(installOwners).toEqual([MEMBER_ID]);
  });

  it('refuses before the body is read, not after', async () => {
    // 4 KiB against a 1 KiB limit. With authentication after parsing this would
    // be a 413, which means the process spooled a body for a caller it had no
    // reason to trust.
    const { app } = freshApp(1024);

    const response = await postWithout(app, 'x'.repeat(4096));

    expect(response.statusCode).toBe(401);
  });

  it('never answers 5xx for any way the credentials can be wrong', async () => {
    const { app, db } = freshApp();
    revokeMember(db, MEMBER_ID, 1_700_000_001_000);

    const statuses: number[] = [];
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      `Bearer ${generateMemberToken()}`,
      `Bearer ${MEMBER_TOKEN}`,
      'Basic abc',
      'Bearer a b',
    ]) {
      const response = await postWithout(
        app,
        fixture('001.json'),
        header === undefined ? JSON_HEADERS : { ...JSON_HEADERS, authorization: header },
      );
      statuses.push(response.statusCode);
    }

    expect(statuses.filter((code) => code >= 500)).toEqual([]);
    expect(statuses.every((code) => code === 401 || code === 403)).toBe(true);
  });
});

describe('POST /join', () => {
  /** POSTs a join body as JSON. No credentials: the code is the credential. */
  async function postJoin(
    app: FastifyInstance,
    body: unknown,
    headers: Readonly<Record<string, string>> = JSON_HEADERS,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/join',
      headers: { ...headers },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('spends a code and returns a token that can ingest immediately', async () => {
    const { app, db } = freshApp();
    const code = createJoinCodeStore(db).create('Rahim').code;

    const response = await postJoin(app, {
      code,
      display_name: 'Rahim',
      hostname: 'rahim-desktop',
      os: 'linux',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<JoinResponseBody>();
    expect(Object.keys(body).sort()).toEqual(['member_id', 'server_name', 'token']);
    expect(body.token).toMatch(/^ccm_[A-Za-z0-9_-]{32}$/);

    const ingested = await app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${body.token}` },
      payload: fixture('001.json'),
    });
    expect(ingested.statusCode).toBe(200);
    const owner = db.prepare('SELECT member_id AS id FROM requests').get() as { id: string };
    expect(owner.id).toBe(body.member_id);
  });

  it('accepts a code retyped in any spacing or case', async () => {
    const { app, db } = freshApp();
    const code = createJoinCodeStore(db).create('Rahim').code;

    const response = await postJoin(app, {
      code: code.replaceAll('-', ' ').toLowerCase(),
      display_name: 'Rahim',
    });

    expect(response.statusCode).toBe(200);
  });

  it('answers 409 the second time the same code is presented', async () => {
    const { app, db } = freshApp();
    const code = createJoinCodeStore(db).create('Rahim').code;
    expect((await postJoin(app, { code, display_name: 'Rahim' })).statusCode).toBe(200);

    const second = await postJoin(app, { code, display_name: 'Mallory' });

    expect(second.statusCode).toBe(409);
    expect(second.json<ErrorBody>().error).toMatch(/already been used/);
    expect(second.body).not.toContain('ccm_');
  });

  it('answers 410 for a code that has expired', async () => {
    const { app, db } = freshApp();
    const code = createJoinCodeStore(db).create('Rahim', {
      now: Date.now() - JOIN_CODE_TTL_MS - 1000,
    }).code;

    const response = await postJoin(app, { code, display_name: 'Rahim' });

    expect(response.statusCode).toBe(410);
    expect(response.json<ErrorBody>().error).toMatch(/expired/);
  });

  it('answers 404 for a code nobody issued', async () => {
    const { app } = freshApp();

    const response = await postJoin(app, { code: 'ABCD-EFGH-JKMN', display_name: 'Rahim' });

    expect(response.statusCode).toBe(404);
  });

  it.each([
    ['no code', { display_name: 'Rahim' }],
    ['no display name', { code: 'ABCD-EFGH-JKMN' }],
    ['a code that is not a string', { code: 42, display_name: 'Rahim' }],
    ['an empty display name', { code: 'ABCD-EFGH-JKMN', display_name: '' }],
    ['nothing at all', {}],
  ])('answers 400 for a body with %s', async (_label, body) => {
    const { app } = freshApp();

    expect((await postJoin(app, body)).statusCode).toBe(400);
  });

  it('answers 400 rather than 500 for a body that is not JSON', async () => {
    const { app } = freshApp();

    // The ingest route reads raw bytes; this one must still get Fastify's own
    // JSON parsing, which is only true because that parser swap is scoped.
    const response = await postJoin(app, 'not json at all');

    expect(response.statusCode).toBe(400);
    expect(typeof response.json<ErrorBody>().error).toBe('string');
  });

  it('issues a different token to each joiner', async () => {
    const { app, db } = freshApp();
    const store = createJoinCodeStore(db);
    const first = store.create('Rahim').code;
    const second = store.create('Alice').code;

    const one = await postJoin(app, { code: first, display_name: 'Rahim' });
    const two = await postJoin(app, { code: second, display_name: 'Alice' });

    expect(one.json<JoinResponseBody>().token).not.toBe(two.json<JoinResponseBody>().token);
    expect(one.json<JoinResponseBody>().member_id).not.toBe(two.json<JoinResponseBody>().member_id);
  });

  it('never leaks a token in a rejection', async () => {
    const { app, db } = freshApp();
    const code = createJoinCodeStore(db).create('Rahim').code;
    await postJoin(app, { code, display_name: 'Rahim' });

    for (const body of [{ code, display_name: 'Mallory' }, { code: 'ABCD-EFGH-JKMN' }, {}]) {
      const response = await postJoin(app, body);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain('ccm_');
      expect(response.body).not.toContain('cca_');
    }
  });
});

describe('POST /leave', () => {
  /** A leave request with whatever credentials the test wants to try. */
  async function postLeave(app: FastifyInstance, token?: string): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/leave',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      payload: '{}',
    });
  }

  /** An empty batch: a valid OTLP payload that stores nothing. */
  const EMPTY_BATCH = '{"resourceLogs":[]}';

  /** Posts an empty batch as whoever holds `token`. */
  async function ingestAs(app: FastifyInstance, token: string): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      payload: EMPTY_BATCH,
    });
  }

  it('revokes the token it was sent, and nothing else', async () => {
    const { app, db } = freshApp();
    const otherToken = generateMemberToken();
    seedMember(db, 'm_fixture_rahim', otherToken);

    const response = await postLeave(app, MEMBER_TOKEN);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ member_id: MEMBER_ID, revoked: true });
    expect((await ingestAs(app, MEMBER_TOKEN)).statusCode).toBe(403);
    // The teammate who did not leave keeps reporting.
    expect((await ingestAs(app, otherToken)).statusCode).toBe(200);
  });

  it('refuses a caller with no token, so nobody can revoke by guessing an id', async () => {
    const { app } = freshApp();

    const response = await postLeave(app);

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('answers 403 to a token that has already been given up', async () => {
    const { app, db } = freshApp();
    revokeMember(db, MEMBER_ID);

    expect((await postLeave(app, MEMBER_TOKEN)).statusCode).toBe(403);
  });

  it('answers 401 to a token this server has never issued', async () => {
    const { app } = freshApp();

    expect((await postLeave(app, generateMemberToken())).statusCode).toBe(401);
  });

  it('does not take the admin token as a member token', async () => {
    const { app, db } = freshApp();
    const admin = ensureAdminToken(db).token ?? '';

    expect((await postLeave(app, admin)).statusCode).toBe(401);
  });
});

describe('the admin guard on /api', () => {
  /** A GET with whatever credentials the test wants to try. */
  async function get(
    app: FastifyInstance,
    url: string,
    token?: string,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'GET',
      url,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  it.each(['/api', '/api/summary', '/api/members/m_1/anything', '/api/not-a-route'])(
    'answers 401 for %s without the admin token',
    async (url) => {
      const { app, db } = freshApp();
      ensureAdminToken(db);

      const response = await get(app, url);

      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    },
  );

  it('answers 404 once the token is right, which proves the guard ran first', async () => {
    const { app, db } = freshApp();
    const admin = ensureAdminToken(db).token ?? '';

    const guarded = await get(app, '/api/not-a-route');
    const authorised = await get(app, '/api/not-a-route', admin);

    // Same path, two answers. An unauthenticated caller cannot tell which
    // `/api` routes exist by comparing 401s against 404s.
    expect(guarded.statusCode).toBe(401);
    expect(authorised.statusCode).toBe(404);
  });

  it('refuses a member token, which is a credential for the other half', async () => {
    const { app, db } = freshApp();
    ensureAdminToken(db);

    expect((await get(app, '/api/summary', MEMBER_TOKEN)).statusCode).toBe(401);
    expect((await get(app, '/api/summary', generateAdminToken())).statusCode).toBe(401);
  });

  it('refuses everything on a server that has issued no admin token', async () => {
    const { app } = freshApp();

    expect((await get(app, '/api/summary', generateAdminToken())).statusCode).toBe(401);
  });

  it('leaves the routes that are not /api alone', async () => {
    const { app, db } = freshApp();
    ensureAdminToken(db);

    // A path that merely starts with the same letters is not under the prefix.
    expect((await get(app, '/health')).statusCode).toBe(200);
    expect((await get(app, '/apiary')).statusCode).toBe(404);
    expect((await postLogs(app, '{"resourceLogs":[]}')).statusCode).toBe(200);
  });

  it('is not fooled by a query string on the path', async () => {
    const { app, db } = freshApp();
    ensureAdminToken(db);

    expect((await get(app, '/api/summary?from=2026-08-01')).statusCode).toBe(401);
  });
});
