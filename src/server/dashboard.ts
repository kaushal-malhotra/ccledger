/**
 * Serving the built dashboard.
 *
 * `web/` compiles to `src/server/public`, which the build then copies to
 * `dist/server/public`. Both live directly beside this module, so one relative
 * URL resolves in the source tree under vitest and in the published package
 * after `npm run build` — the same trick `migrate.ts` uses to find `schema.sql`,
 * and for the same reason: this package is ESM and has no `__dirname`.
 *
 * The bundle is genuinely optional. A checkout that has never run `vite build`
 * still has a working ingest server and a working API, and answering `/` with a
 * sentence saying which command is missing is more use than a 404 that leaves
 * the reader wondering whether the server is broken.
 *
 * The headers here matter more than they look. This page holds an admin token
 * in memory, so it is worth being explicit that it may not be framed, may not
 * load code from anywhere but itself, and may not leak its URL in a `Referer` —
 * `serve` prints the token in a URL fragment, and fragments are one bad
 * navigation away from somewhere they should not be.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * A page that may not be framed, may not run code it did not ship with, and
 * talks only to the origin it came from. `'unsafe-inline'` appears for styles
 * and nowhere else: React writes `style` attributes for the one bar width the
 * table draws, and a style attribute is inline by definition. No script
 * directive is relaxed, which is the one that matters.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Vite fingerprints everything under `assets/`, so it can be cached forever. */
const IMMUTABLE_ASSETS = /[\\/]assets[\\/]/;

/** What to say when the server has an API but no dashboard to draw it with. */
const NOT_BUILT_MESSAGE =
  'The ccledger dashboard is not part of this build.\n\n' +
  'Run `npm run build` in a checkout to compile web/ into src/server/public,\n' +
  'or install a published ccledger, which ships the dashboard already built.\n\n' +
  'The API under /api and OTLP ingest at /v1/logs are unaffected.\n';

/**
 * The directory holding the built dashboard, or `undefined` when this build has
 * none. Presence is decided by `index.html` rather than by the directory, so a
 * `public/` left behind by a half-finished build is not mistaken for a bundle.
 */
export function dashboardRoot(): string | undefined {
  const index = fileURLToPath(new URL('./public/index.html', import.meta.url));
  return existsSync(index) ? fileURLToPath(new URL('./public/', import.meta.url)) : undefined;
}

/**
 * Sets caching and the security headers on one static response. Anything set
 * here survives: `@fastify/static` treats a header a `setHeaders` callback
 * wrote as the final answer and does not overwrite it with its own.
 */
function setStaticHeaders(reply: FastifyReply, path: string): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  if (IMMUTABLE_ASSETS.test(path)) {
    // The filename contains a hash of the contents, so a changed file is a
    // different URL and this can never serve a stale one.
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return;
  }
  // `index.html` names the hashed assets, so it is the one file that must be
  // revalidated — cache it and an upgraded server keeps serving the old app.
  reply.header('cache-control', 'no-cache');
  reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
}

/**
 * Serves the dashboard at `/`, or explains its absence there. Never touches
 * `/api`, `/join`, `/leave`, `/health` or `/v1/logs`: those are registered as
 * exact paths and beat the wildcard this installs.
 */
export function registerDashboard(app: FastifyInstance): void {
  const root = dashboardRoot();

  if (root === undefined) {
    app.get('/', (_request, reply) => {
      reply.code(503).type('text/plain; charset=utf-8').send(NOT_BUILT_MESSAGE);
    });
    return;
  }

  void app.register(fastifyStatic, {
    root,
    index: ['index.html'],
    // Directory listings would expose the shape of the bundle and answer a
    // question nobody using the dashboard is asking.
    list: false,
    dotfiles: 'deny',
    setHeaders: setStaticHeaders,
  });
}
