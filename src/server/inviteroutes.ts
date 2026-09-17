/**
 * Issuing invitations from the dashboard.
 *
 * `ccledger invite` already does this from a terminal on the server, which is
 * fine while the person running the server is the person adding teammates and
 * stops being fine the moment those are different people — or the same person
 * on a different machine. An admin who has the dashboard open should not have
 * to find an SSH session to add somebody.
 *
 * These routes are registered onto the app's own scope, so the `/api` guard
 * `buildApp` installs covers them: issuing an invitation is an admin action and
 * needs the admin token, not a member's.
 *
 * The `command` field is built here rather than in the browser. It carries the
 * package name this build was published under, read from the manifest, and the
 * one thing worse than a wrong version in that line is a wrong package name —
 * it is pasted into somebody's terminal unread.
 */

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { getConfig } from '../db/config.js';
import { createJoinCodeStore } from '../db/joincodes.js';
import { ADMIN_API_PREFIX, CONFIG_PUBLIC_URL } from '../shared/constants.js';
import type { InviteBody, InviteResponse, InvitesResponse, OpenInvite } from '../shared/api.js';
import {
  MAX_DISPLAY_NAME_LENGTH,
  encodeInvite,
  normaliseDisplayName,
  normaliseEndpoint,
} from '../shared/invite.js';
import { NPX_TARGET } from '../shared/version.js';
import { JSON_CONTENT_TYPE, fail } from './reply.js';

/** Body schema for `POST /api/invites`. */
const CREATE_INVITE_SCHEMA = {
  type: 'object',
  required: ['display_name'],
  additionalProperties: false,
  properties: {
    display_name: { type: 'string', minLength: 1, maxLength: MAX_DISPLAY_NAME_LENGTH },
  },
} as const;

/** A stored join code as the wire shape. */
function openInvite(code: {
  readonly code: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}): OpenInvite {
  return {
    code: code.code,
    display_name: code.displayName,
    created_at: code.createdAt,
    expires_at: code.expiresAt,
  };
}

/**
 * The base URL invites should carry, or `undefined` when this server has never
 * recorded one. `serve` writes it on every boot; a database that has only ever
 * been used by `invite` has nothing to offer here.
 */
function publicEndpoint(db: Database.Database): string | undefined {
  const stored = getConfig(db, CONFIG_PUBLIC_URL);
  return stored === undefined ? undefined : normaliseEndpoint(stored);
}

/** Registers the invitation routes on an app whose `/api` prefix is guarded. */
export function registerInviteRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get(`${ADMIN_API_PREFIX}/invites`, (_request, reply) => {
    const store = createJoinCodeStore(db);
    // Issuing is the natural moment to clear the ones that aged out, and so is
    // looking at the list; nothing here runs on a schedule.
    store.prune();
    const body: InvitesResponse = {
      endpoint: publicEndpoint(db) ?? null,
      invites: store.listOpen().map(openInvite),
    };
    reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  });

  app.post<{ Body: InviteBody }>(
    `${ADMIN_API_PREFIX}/invites`,
    { schema: { body: CREATE_INVITE_SCHEMA } },
    (request, reply) => {
      const displayName = normaliseDisplayName(request.body.display_name);
      if (displayName === undefined) {
        fail(
          reply,
          400,
          `the display name must be 1 to ${String(MAX_DISPLAY_NAME_LENGTH)} printable characters`,
        );
        return;
      }

      const endpoint = publicEndpoint(db);
      if (endpoint === undefined) {
        // 409 rather than 400: the request is fine and the server is not ready
        // to answer it. Nothing the browser can send would help, so the message
        // names the flag that would.
        fail(
          reply,
          409,
          'this server has no public URL recorded, so an invite would have nowhere to point. ' +
            'Restart it with --public-url https://your.domain and try again.',
        );
        return;
      }

      const store = createJoinCodeStore(db);
      store.prune();
      const joinCode = store.create(displayName);
      const invite = encodeInvite({
        v: 1,
        endpoint,
        code: joinCode.code,
        name: displayName,
      });

      request.log.info({ displayName, code: joinCode.code }, 'invite issued from the dashboard');

      const body: InviteResponse = {
        code: joinCode.code,
        display_name: displayName,
        expires_at: joinCode.expiresAt,
        endpoint,
        invite,
        command: `npx ${NPX_TARGET} setup --code ${invite}`,
      };
      reply.code(201).type(JSON_CONTENT_TYPE).send(body);
    },
  );
}
