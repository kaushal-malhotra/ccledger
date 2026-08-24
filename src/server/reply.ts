/**
 * The one shape every rejection this server sends uses.
 *
 * Its own file because the ingest route, the auth hooks and the join route all
 * answer the same way, and because a rejection body is the easiest place to
 * accidentally reflect a caller's own bytes back at them: everything here takes
 * a message the server wrote, never a value the request carried.
 */

import type { FastifyReply } from 'fastify';

/** Set explicitly because `reply.send(string)` otherwise defaults to text/plain. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Sends `{"error": ...}` with the given status. Never carries request content. */
export function fail(reply: FastifyReply, statusCode: number, error: string): void {
  reply.code(statusCode).type(JSON_CONTENT_TYPE).send({ error });
}

/**
 * Sends a 401 with the `WWW-Authenticate` challenge that makes it a real one.
 * A 401 without it is a status code with no instruction attached.
 */
export function failUnauthorized(reply: FastifyReply, error: string): void {
  reply.header('WWW-Authenticate', 'Bearer');
  fail(reply, 401, error);
}
