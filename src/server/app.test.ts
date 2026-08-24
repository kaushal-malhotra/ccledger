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

/** The exact bytes an OTLP exporter must see for a fully accepted batch. */
const SUCCESS_BODY = '{"partialSuccess":{}}';

/** The default `Content-Type` an OTLP/HTTP JSON exporter sends. */
const JSON_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };

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
  // `exactOptionalPropertyTypes` forbids passing `bodyLimit: undefined`.
  const app = buildApp(bodyLimit === undefined ? { db } : { db, bodyLimit });
  openApps.push(app);
  return { app, db };
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

/** POSTs one body to the ingest route. */
async function postLogs(
  app: FastifyInstance,
  payload: string | Buffer,
  headers: Readonly<Record<string, string>> = JSON_HEADERS,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/v1/logs', headers: { ...headers }, payload });
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
      headers: { ...JSON_HEADERS },
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
