/**
 * The HTTP surface: OTLP ingest, enrolment, a health probe, and the status-code
 * mapping that keeps them apart.
 *
 * Two rules shape this file. The first is that a body which will never parse
 * gets a 4xx: OTLP exporters retry on 5xx and drop on 4xx, so one 500 on a
 * permanently malformed payload turns a misconfigured client into an unbounded
 * retry loop against this server. Every decode step therefore happens inside the
 * handler, where the status code is ours to choose, rather than in a content
 * type parser, where a throw becomes a 500.
 *
 * The second is that ingest reads raw bytes and nothing else does. The raw
 * parser lives inside its own plugin scope so `/join` and everything under
 * `/api` keep Fastify's ordinary JSON parsing and schema validation, rather than
 * every route having to re-implement the decoding the ingest path needs.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

import { runAlertEvaluation } from './alerts.js';
import { registerApiRoutes } from './api.js';
import { requireAdmin, requireMember, revokeMember } from './auth.js';
import { registerDashboard } from './dashboard.js';
import { ingestEvents } from './ingest.js';
import { joinWithCode } from './join.js';
import { parseOtlpLogsPayload } from './otlp.js';
import { JSON_CONTENT_TYPE, fail } from './reply.js';
import { createJoinCodeStore } from '../db/joincodes.js';
import {
  ADMIN_API_PREFIX,
  HEALTH_PATH,
  JOIN_PATH,
  LEAVE_PATH,
  VERSION_PATH,
} from '../shared/constants.js';
import type { JoinRequestBody, LeaveResponseBody } from '../shared/types.js';
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

/** OTLP also defines a protobuf encoding; ccledger implements only the JSON one. */
const PROTOBUF_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/x-protobuf',
  'application/protobuf',
]);

/** Body schema for `POST /join`. Lengths are bounds, not validation of meaning. */
const JOIN_BODY_SCHEMA = {
  type: 'object',
  required: ['code', 'display_name'],
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 64 },
    display_name: { type: 'string', minLength: 1, maxLength: 128 },
    hostname: { type: 'string', maxLength: 255 },
    os: { type: 'string', maxLength: 64 },
  },
} as const;

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

/**
 * Builds the ccledger HTTP app. Nothing is listened on and no migration is run;
 * the caller owns both.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const db = options.db;
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const serverOptions: FastifyServerOptions = {
    bodyLimit,
    logger: options.logger ?? false,
  };
  const app: FastifyInstance = Fastify(serverOptions);
  const startedAtMs = Date.now();
  // One store per app, because the cache inside it is this process's memory.
  const joinCodes = createJoinCodeStore(db);

  // `null` rather than a shape: Fastify v5 refuses a reference type as a request
  // decorator default, and every route has to see the same starting value.
  app.decorateRequest('member', null);

  // `unknown` rather than `FastifyError`: anything reachable by `throw` lands
  // here, and a thrown non-Error must not crash the handler that exists to keep
  // this route from ever answering 500 by accident.
  app.setErrorHandler((error: unknown, request, reply) => {
    const statusCode =
      isRecordObject(error) && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      // Fastify raises these itself — oversize body, unparseable media type,
      // truncated stream, a body that failed its schema. They are already the
      // right answer, and a client error is not an incident, so it must not be
      // logged at error level.
      request.log.warn({ err: error, statusCode }, 'rejected request');
      fail(reply, statusCode, error instanceof Error ? error.message : 'bad request');
      return;
    }
    // Anything else is ours: a SQLite failure, a bug. The exporter should retry.
    request.log.error({ err: error }, 'unhandled error serving request');
    fail(reply, 500, 'internal server error');
  });

  // Before any route, so that the guard covers paths no route has claimed too.
  // An `/api` request without the admin token gets 401 whether or not the route
  // exists, which is both the right answer and one that tells a prober nothing.
  const admin = requireAdmin(db);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (path === ADMIN_API_PREFIX || path.startsWith(`${ADMIN_API_PREFIX}/`)) {
      await admin(request, reply);
    }
  });

  // Registered after the guard above and in the same scope as it, so every
  // route in there is behind the admin token without saying so route by route.
  registerApiRoutes(app, db);

  app.get(HEALTH_PATH, (_request, reply) => {
    reply.code(200).send({
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
    });
  });

  // Unauthenticated, like `/health`. It discloses a version number to anyone
  // who can reach the port, which is the trade being made knowingly: an
  // operator who cannot check which build is running has no way to tell a
  // finished deploy from a container that silently kept serving the old image,
  // and the same number is already in `/health` and in the banner.
  app.get(VERSION_PATH, (_request, reply) => {
    reply.code(200).send({ version: VERSION });
  });

  // Unauthenticated by design: the join code is the credential, and a teammate
  // has nothing else yet. Everything that makes that safe — single use, 24 hour
  // expiry, 60 bits of code — is enforced in `joinWithCode`.
  app.post<{ Body: JoinRequestBody }>(
    JOIN_PATH,
    { schema: { body: JOIN_BODY_SCHEMA } },
    (request, reply) => {
      const result = joinWithCode(db, joinCodes, request.body);
      if (!result.ok) {
        request.log.warn({ status: result.status }, 'join refused');
        fail(reply, result.status, result.error);
        return;
      }
      request.log.info({ memberId: result.member.id }, 'member joined');
      reply.code(200).type(JSON_CONTENT_TYPE).send(result.body);
    },
  );

  // Authenticated by the member's own token, which is the whole design: the one
  // person who can prove they hold a token is the one person who may throw it
  // away. Nothing here can revoke anyone else, so it needs no admin and no
  // confirmation — and `requireMember` has already answered 403 if the token was
  // revoked before this request, which is why the handler cannot see that case.
  app.post(LEAVE_PATH, { onRequest: [requireMember(db)] }, (request, reply) => {
    const member = request.member;
    if (member === null) {
      // Unreachable for the same reason as on the ingest route; kept so the
      // member is a checked fact rather than a non-null assertion.
      fail(reply, 401, 'unauthenticated');
      return;
    }
    const revoked = revokeMember(db, member.id);
    request.log.info({ memberId: member.id, revoked }, 'member left');
    const body: LeaveResponseBody = { member_id: member.id, revoked };
    reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  });

  // The ingest route and nothing else reads raw bytes. Its own plugin scope, so
  // replacing the content type parsers here cannot reach `/join` or `/api`.
  void app.register(async (ingest) => {
    // The default JSON parser throws a 400 of its own making and hands us an
    // already-parsed object, which leaves no place to handle Content-Encoding.
    // Clearing the table and re-registering as `parseAs: 'buffer'` means the
    // handler receives exactly the bytes that arrived.
    ingest.removeAllContentTypeParsers();
    const keepRawBuffer = (
      _request: unknown,
      body: Buffer,
      done: (error: Error | null, body?: Buffer) => void,
    ): void => {
      done(null, body);
    };
    ingest.addContentTypeParser('application/json', { parseAs: 'buffer' }, keepRawBuffer);
    // The catch-all exists so a missing or unusual Content-Type reaches the
    // handler and is judged on its bytes, rather than being refused with a 415
    // that an exporter cannot act on.
    ingest.addContentTypeParser('*', { parseAs: 'buffer' }, keepRawBuffer);

    ingest.post(
      '/v1/logs',
      {
        // `onRequest`, not `preHandler`: both of these run before Fastify reads
        // the body, so an unauthenticated caller cannot make this process
        // buffer eight megabytes, and a body encoded in a format there is no
        // decoder for is refused before it is spooled.
        onRequest: [
          requireMember(db),
          async (request, reply) => {
            if (PROTOBUF_MEDIA_TYPES.has(mediaType(request.headers['content-type']))) {
              // 415 is terminal for an exporter, unlike a 5xx: it stops rather
              // than retrying a payload this server will never understand.
              return fail(reply, 415, 'only OTLP/HTTP with JSON encoding is accepted');
            }
          },
        ],
      },
      (request, reply) => {
        const member = request.member;
        if (member === null) {
          // Unreachable: `requireMember` answers before the handler runs. Kept
          // so attribution is a checked fact rather than a non-null assertion.
          fail(reply, 401, 'unauthenticated');
          return;
        }

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
        const result = ingestEvents(db, parsed.events, {
          memberId: member.id,
          logger: request.log,
        });

        if (parsed.issues.length > 0) {
          // Issue reasons name paths and attribute keys, never attribute values.
          request.log.debug(
            { issues: parsed.issues.slice(0, 20) },
            'OTLP payload had unusable parts',
          );
        }
        request.log.debug(
          { counts: parsed.counts, result, memberId: member.id },
          'ingested OTLP batch',
        );

        // After the insert transaction and outside this response. Two things
        // are load-bearing about that ordering. Alert evaluation must see the
        // rows this batch wrote, so it cannot run before the commit; and it
        // must never decide the status code, so it is not awaited — a webhook
        // has five seconds an attempt and three attempts, which is not time an
        // exporter waiting on a 200 can be asked to spend. `runAlertEvaluation`
        // absorbs its own failures, so `void` here discards a promise that
        // cannot reject rather than one whose rejection is being ignored.
        //
        // Only when something was actually stored: a batch that was entirely a
        // redelivery moves no number, so nothing in it can have newly crossed.
        if (result.inserted > 0) {
          void runAlertEvaluation(db, { memberId: member.id, logger: request.log });
        }

        reply.code(200).type(JSON_CONTENT_TYPE).send(EXPORT_SUCCESS_BODY);
      },
    );
  });

  // Last, because it claims a wildcard. Every route above is an exact path and
  // wins against it in the router regardless of order, but registering the
  // catch-all after the things it must not catch keeps that visible.
  registerDashboard(app);

  return app;
}
