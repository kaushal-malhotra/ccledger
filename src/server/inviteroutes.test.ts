/**
 * Issuing invitations over HTTP.
 *
 * The join-code store itself is covered in `src/db/joincodes.test.ts`. What is
 * under test here is the part a browser can reach: that the route is behind the
 * admin token like everything else under `/api`, that the invite it hands back
 * is the same blob `ccledger setup` decodes rather than a lookalike, and that a
 * server with no public URL says so instead of minting an invitation that
 * points nowhere.
 *
 * That last one is the failure worth a test. An invite carrying a wrong or
 * missing endpoint does not fail here — it fails on a teammate's machine,
 * minutes later, with a message about their network.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { ensureAdminToken, generateMemberToken, hashToken } from './auth.js';
import type { Database } from '../db/index.js';
import { migratedDatabase } from '../db/index.js';
import { setConfig } from '../db/config.js';
import { CONFIG_PUBLIC_URL } from '../shared/constants.js';
import { decodeInvite } from '../shared/invite.js';
import type { InviteResponse, InvitesResponse } from '../shared/api.js';
import { NPX_TARGET } from '../shared/version.js';

/** The endpoint a server that has booted once would have recorded. */
const ENDPOINT = 'https://ccledger.example.com';

/** The one error shape this server sends. */
interface ErrorBody {
  readonly error: string;
}

const openHandles: Database.Database[] = [];

afterEach(() => {
  while (openHandles.length > 0) openHandles.pop()?.close();
});

/**
 * A built app plus the admin token that opens it. Pass `null` for a server
 * that has never recorded a public URL — not `undefined`, which JavaScript
 * resolves to the default and would quietly give the endpoint back.
 */
function harness(endpoint: string | null = ENDPOINT): {
  readonly app: FastifyInstance;
  readonly db: Database.Database;
  readonly headers: Readonly<Record<string, string>>;
} {
  const db = migratedDatabase(':memory:');
  openHandles.push(db);
  if (endpoint !== null) setConfig(db, CONFIG_PUBLIC_URL, endpoint, Date.now());
  const admin = ensureAdminToken(db, { rotate: false, now: Date.now() });
  const token = admin.token;
  if (token === undefined) throw new Error('the first ensureAdminToken must issue a token');
  return {
    app: buildApp({ db, logger: false }),
    db,
    headers: { authorization: `Bearer ${token}` },
  };
}

describe('POST /api/invites', () => {
  it('issues an invite that decodes to this server and the code it minted', async () => {
    const { app, headers } = harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: 'Alice Chen' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as InviteResponse;
    expect(body.display_name).toBe('Alice Chen');
    expect(body.endpoint).toBe(ENDPOINT);

    // The blob is the contract with `ccledger setup`, so it is checked by
    // decoding it rather than by comparing strings.
    const decoded = decodeInvite(body.invite);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.invite.endpoint).toBe(ENDPOINT);
    expect(decoded.invite.code).toBe(body.code);
    expect(decoded.invite.name).toBe('Alice Chen');
  });

  it('puts the npx target in the command, not the binary name', async () => {
    const { app, headers } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: 'Alice Chen' },
    });
    const body = JSON.parse(response.body) as InviteResponse;

    // `npx ccledger` resolves to a different author's package. This line is
    // pasted into a terminal unread, so the name in it has to be
    // `NPX_TARGET` — the published package name, unless `package.json` points
    // `npx` at a git fork instead.
    expect(body.command).toContain(NPX_TARGET);
    expect(body.command).toContain(body.invite);
    expect(body.command.startsWith('npx ')).toBe(true);
  });

  it('the code it returns can be claimed exactly once', async () => {
    const { app, headers } = harness();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: 'Alice Chen' },
    });
    const body = JSON.parse(created.body) as InviteResponse;

    const join = {
      code: body.code,
      display_name: 'Alice Chen',
      hostname: 'alice-mbp',
      os: 'darwin 24.6.0',
    };
    const first = await app.inject({ method: 'POST', url: '/join', payload: join });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: '/join', payload: join });
    expect(second.statusCode).not.toBe(200);
  });

  it('refuses when the server has no public URL to point at', async () => {
    const { app, headers } = harness(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: 'Alice Chen' },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as ErrorBody;
    expect(body.error).toContain('--public-url');
  });

  it('rejects a blank display name', async () => {
    const { app, headers } = harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: '   ' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('needs the admin token, not a member token and not nothing', async () => {
    const { app, db } = harness();
    const memberToken = generateMemberToken();
    db.prepare(
      `INSERT INTO members (id, display_name, token_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).run('m_alice', 'Alice Chen', hashToken(memberToken), Date.now());

    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/invites',
      payload: { display_name: 'Alice Chen' },
    });
    expect(anonymous.statusCode).toBe(401);

    const asMember = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { display_name: 'Alice Chen' },
    });
    expect(asMember.statusCode).toBe(401);
  });
});

describe('GET /api/invites', () => {
  it('lists what has been issued and not claimed, and says where they point', async () => {
    const { app, headers } = harness();
    await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: 'Alice Chen' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: 'Marco Ruiz' },
    });

    const response = await app.inject({ method: 'GET', url: '/api/invites', headers });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as InvitesResponse;
    expect(body.endpoint).toBe(ENDPOINT);
    expect(body.invites.map((entry) => entry.display_name).sort()).toEqual([
      'Alice Chen',
      'Marco Ruiz',
    ]);
  });

  it('drops a code once it has been claimed', async () => {
    const { app, headers } = harness();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers,
      payload: { display_name: 'Alice Chen' },
    });
    const body = JSON.parse(created.body) as InviteResponse;

    await app.inject({
      method: 'POST',
      url: '/join',
      payload: {
        code: body.code,
        display_name: 'Alice Chen',
        hostname: 'alice-mbp',
        os: 'darwin 24.6.0',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/invites', headers });
    const after = JSON.parse(response.body) as InvitesResponse;
    expect(after.invites).toHaveLength(0);
  });

  it('reports a null endpoint rather than pretending it has one', async () => {
    const { app, headers } = harness(null);
    const response = await app.inject({ method: 'GET', url: '/api/invites', headers });
    const body = JSON.parse(response.body) as InvitesResponse;
    expect(body.endpoint).toBeNull();
  });
});
