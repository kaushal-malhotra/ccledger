/**
 * The HTTP surface: OTLP ingest, a health probe, and the status-code mapping
 * that keeps the two apart.
 *
 * The single rule this file exists to enforce is that a body which will never
 * parse gets a 4xx. OTLP exporters retry on 5xx and drop on 4xx, so one 500 on
 * a permanently malformed payload turns a misconfigured client into an
 * unbounded retry loop against this server. Every decode step below therefore
 * happens inside the handler, where the status code is ours to choose, rather
 * than in a Fastify content-type parser, where a throw becomes a 500.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyServerOptions } from 'fastify';

import { ingestEvents } from './ingest.js';
import { parseOtlpLogsPayload } from './otlp.js';
import { VERSION } from '../shared/version.js';

/** Claude Code batches are kilobytes; 8 MiB is headroom for a backlog flush. */
const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024;

/**
 * Ceiling on a decompressed body, as a multiple of `bodyLimit`. Fastify caps
 * the bytes on the wire, but this file does the inflating, so without a cap a
 * few kilobytes of crafted gzip could ask for gigabytes of heap.
 */
const MAX_INFLATION_FACTOR = 16;

/** Sent verbatim so the success body is byte-exact, whatever a serializer would do. */
const EXPORT_SUCCESS_BODY = '{"partialSuccess":{}}';

/** Set explicitly because `reply.send(string)` otherwise defaults to text/plain. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** OTLP also defines a protobuf encoding; ccledger implements only the JSON one. */
const PROTOBUF_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/x-protobuf',
  'application/protobuf',
]);

/** A plain JSON object. Arrays and `null` are not records — same rule as otlp.ts. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Everything `buildApp` needs; only `db` is required. */
export interface AppOptions {
  /** Already migrated. The app never runs migrations itself. */
  readonly db: Database.Database;
  /** Passed straight to Fastify. Omitted means no logging, which is what tests want. */
  readonly logger?: FastifyServerOptions['logger'];
  /** Maximum bytes on the wire for one request. Defaults to 8 MiB. */
  readonly bodyLimit?: number;
}

/** Bytes ready to parse, or the message to answer 400 with. */
type DecodeResult =
  { readonly ok: true; readonly body: Buffer } | { readonly ok: false; readonly error: string };

/** The media type alone, lowercased, with any `;charset=` parameters removed. */
function mediaType(header: string | undefined): string {
  if (header === undefined) return '';
  const separator = header.indexOf(';');
  return (separator === -1 ? header : header.slice(0, separator)).trim().toLowerCase();
}

/**
 * Reverses `Content-Encoding`. Failures are values, not exceptions, because the
 * caller has to turn every one of them into a 400 — a corrupt gzip frame is a
 * body that will never parse, however many times the exporter re-sends it.
 *
 * No message here quotes the header or the body: an error body that reflects
 * caller-controlled bytes is how a malformed payload ends up in a log line
 * someone later reads as ccledger's own output.
 */
function decodeBody(raw: Buffer, header: string | undefined, bodyLimit: number): DecodeResult {
  const encodings = (header ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    // `identity` is the explicit spelling of "not encoded", so it carries no work.
    .filter((part) => part !== '' && part !== 'identity');

  if (encodings.length === 0) return { ok: true, body: raw };
  if (encodings.length > 1) {
    return { ok: false, error: 'stacked Content-Encoding values are not supported' };
  }

  const encoding = encodings[0];
  const options = { maxOutputLength: bodyLimit * MAX_INFLATION_FACTOR };
  try {
    switch (encoding) {
      case 'gzip':
        return { ok: true, body: gunzipSync(raw, options) };
      case 'deflate':
        return { ok: true, body: inflateSync(raw, options) };
      case 'br':
        return { ok: true, body: brotliDecompressSync(raw, options) };
      default:
        return {
          ok: false,
          error: 'unsupported Content-Encoding; expected gzip, deflate, br or identity',
        };
    }
  } catch {
    // Covers a corrupt frame and a body that inflates past the ceiling alike;
    // both are refusals to spend more work on this request.
    return { ok: false, error: 'request body could not be decompressed' };
  }
}

/** The one shape every rejection uses. Never carries any part of the request. */
function fail(reply: FastifyReply, statusCode: number, error: string): void {
  reply.code(statusCode).type(JSON_CONTENT_TYPE).send({ error });
}

/**
 * Builds the ccledger HTTP app. Nothing is listened on and no migration is run;
 * the caller owns both.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const serverOptions: FastifyServerOptions = {
    bodyLimit,
    logger: options.logger ?? false,
  };
  const app: FastifyInstance = Fastify(serverOptions);
  const startedAtMs = Date.now();

  // The default JSON parser throws a 400 of its own making and hands us an
  // already-parsed object, which leaves no place to handle Content-Encoding.
  // Clearing the table and re-registering as `parseAs: 'buffer'` means the
  // handler receives exactly the bytes that arrived.
  app.removeAllContentTypeParsers();
  const keepRawBuffer = (
    _request: unknown,
    body: Buffer,
    done: (error: Error | null, body?: Buffer) => void,
  ): void => {
    done(null, body);
  };
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, keepRawBuffer);
  // The catch-all exists so a missing or unusual Content-Type reaches the
  // handler and is judged on its bytes, rather than being refused with a 415
  // that an exporter cannot act on.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, keepRawBuffer);

  // `unknown` rather than `FastifyError`: anything reachable by `throw` lands
  // here, and a thrown non-Error must not crash the handler that exists to keep
  // this route from ever answering 500 by accident.
  app.setErrorHandler((error: unknown, request, reply) => {
    const statusCode =
      isRecordObject(error) && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      // Fastify raises these itself — oversize body, unparseable media type,
      // truncated stream. They are already the right answer, and a client
      // error is not an incident, so it must not be logged at error level.
      request.log.warn({ err: error, statusCode }, 'rejected request');
      fail(reply, statusCode, error instanceof Error ? error.message : 'bad request');
      return;
    }
    // Anything else is ours: a SQLite failure, a bug. The exporter should retry.
    request.log.error({ err: error }, 'unhandled error serving request');
    fail(reply, 500, 'internal server error');
  });

  app.get('/health', (_request, reply) => {
    reply.code(200).send({
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
    });
  });

  // TODO(stage 2): bearer-token auth guards this route; for now every request is accepted.
  app.post(
    '/v1/logs',
    {
      onRequest: async (request, reply) => {
        if (PROTOBUF_MEDIA_TYPES.has(mediaType(request.headers['content-type']))) {
          // Refused before the body is read: buffering megabytes we have no
          // decoder for is work an unauthenticated caller should not be able
          // to ask for. 415 is terminal for an exporter, unlike a 5xx.
          return fail(reply, 415, 'only OTLP/HTTP with JSON encoding is accepted');
        }
      },
    },
    (request, reply) => {
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        fail(reply, 400, 'request body is empty');
        return;
      }

      const decoded = decodeBody(body, request.headers['content-encoding'], bodyLimit);
      if (!decoded.ok) {
        fail(reply, 400, decoded.error);
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(decoded.body.toString('utf8'));
      } catch {
        // Deliberately not the parser's own message: it quotes the offending
        // bytes, which would reflect the caller's payload back to them.
        fail(reply, 400, 'request body is not valid JSON');
        return;
      }

      const parsed = parseOtlpLogsPayload(payload);
      if (!parsed.ok) {
        fail(reply, 400, parsed.error ?? 'body is not an OTLP logs payload');
        return;
      }

      // Only a genuine storage failure can throw from here, and that is the one
      // case where a 500 is the honest answer and a retry is the right response.
      const result = ingestEvents(options.db, parsed.events, { logger: request.log });

      if (parsed.issues.length > 0) {
        // Issue reasons name paths and attribute keys, never attribute values.
        request.log.debug(
          { issues: parsed.issues.slice(0, 20) },
          'OTLP payload had unusable parts',
        );
      }
      request.log.debug({ counts: parsed.counts, result }, 'ingested OTLP batch');

      reply.code(200).type(JSON_CONTENT_TYPE).send(EXPORT_SUCCESS_BODY);
    },
  );

  return app;
}
