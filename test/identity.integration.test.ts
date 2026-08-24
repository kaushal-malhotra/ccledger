/**
 * Stage 2 acceptance, clause by clause.
 *
 * The brief's acceptance test is a sentence: `ccledger invite alice` gives a
 * string, a manual `POST /join` with it returns a token, ingest with that token
 * attributes rows to Alice, and reusing the code fails. This file is that
 * sentence, run against the real command, the real HTTP surface, and a real
 * SQLite file — no stubs between the invite being printed and the row landing.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type Database from 'better-sqlite3';

import { runInvite } from '../src/cli/invite.js';
import { setConfig } from '../src/db/config.js';
import { migratedDatabase } from '../src/db/index.js';
import { createJoinCodeStore } from '../src/db/joincodes.js';
import { buildApp } from '../src/server/app.js';
import { revokeMember } from '../src/server/auth.js';
import {
  CONFIG_PUBLIC_URL,
  CONFIG_SERVER_NAME,
  JOIN_CODE_TTL_MS,
} from '../src/shared/constants.js';
import { decodeInvite } from '../src/shared/invite.js';
import type { JoinResponseBody } from '../src/shared/types.js';

/** The endpoint the invites in this file point at. */
const ENDPOINT = 'http://desk-01.local:4318';

/** The two captures, as raw JSON text. Each carries one distinct api_request. */
const FIXTURES = {
  alice: readFileSync(new URL('./fixtures/001.json', import.meta.url), 'utf8'),
  rahim: readFileSync(new URL('./fixtures/002.json', import.meta.url), 'utf8'),
} as const;

const openApps: FastifyInstance[] = [];
const openHandles: Database.Database[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
  for (const db of openHandles.splice(0)) {
    if (db.open) db.close();
  }
  for (const path of tempPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
  vi.restoreAllMocks();
});

/** A migrated database in a real file — `invite` and `serve` are two processes. */
function freshDatabase(): { db: Database.Database; path: string } {
  const path = join(tmpdir(), `ccledger-identity-${randomUUID()}.db`);
  tempPaths.push(path);
  const db = migratedDatabase(path);
  openHandles.push(db);
  setConfig(db, CONFIG_SERVER_NAME, 'desk-01');
  return { db, path };
}

/** An app over an existing database, with logging off. */
function appOver(db: Database.Database): FastifyInstance {
  const app = buildApp({ db });
  openApps.push(app);
  return app;
}

/** Runs `ccledger invite` and returns everything it wrote to stdout. */
function invite(name: string, path: string, endpoint?: string): string {
  const written: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  try {
    runInvite(name, endpoint === undefined ? { db: path } : { db: path, endpoint });
  } finally {
    spy.mockRestore();
  }
  return written.join('');
}

/** The invite blob out of what `ccledger invite` printed. */
function blobFrom(output: string): string {
  const match = /--code (\S+)/.exec(output);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

/** POSTs a join body. No credentials: the code is the credential. */
async function postJoin(app: FastifyInstance, body: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/join',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

/** POSTs a capture to the ingest route, with a token if one is given. */
async function postLogs(
  app: FastifyInstance,
  token?: string,
  payload: string = FIXTURES.alice,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/logs',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    payload,
  });
}

/** Display names owning rows in `requests`, resolved through `members`. */
function owners(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT DISTINCT members.display_name AS name
         FROM requests JOIN members ON members.id = requests.member_id`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('ccledger invite <display-name> prints a paste-able string', () => {
  it('prints one blob that decodes to this endpoint and a live code', () => {
    const { db, path } = freshDatabase();

    const output = invite('Alice', path, ENDPOINT);

    const decoded = decodeInvite(blobFrom(output));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.invite).toEqual({
      v: 1,
      endpoint: ENDPOINT,
      code: expect.any(String),
      name: 'Alice',
    });
    expect(createJoinCodeStore(db).inspect(decoded.invite.code).status).toBe('open');
  });

  it('prints the code on its own too, for a teammate who has to type it', () => {
    const { path } = freshDatabase();

    const output = invite('Alice', path, ENDPOINT);

    const decoded = decodeInvite(blobFrom(output));
    expect(decoded.ok && output).toContain(decoded.ok ? decoded.invite.code : '');
    expect(output).toContain(ENDPOINT);
  });

  it('takes the endpoint from the database when serve has already recorded one', () => {
    const { db, path } = freshDatabase();
    setConfig(db, CONFIG_PUBLIC_URL, 'https://meter.example.com');

    const output = invite('Alice', path);

    const decoded = decodeInvite(blobFrom(output));
    expect(decoded.ok && decoded.invite.endpoint).toBe('https://meter.example.com');
  });

  it('refuses, rather than guessing, when no server has ever advertised a URL', () => {
    const { path } = freshDatabase();
    // `fail` exits the process; turn that into a throw so the runner survives.
    vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('exited');
    });

    expect(() => invite('Alice', path)).toThrow('exited');
  });

  it('reminds the admin which earlier invites are still unclaimed', () => {
    const { path } = freshDatabase();

    const first = invite('Alice', path, ENDPOINT);
    const second = invite('Rahim', path, ENDPOINT);

    // Nothing else can tell them: the code itself is not recoverable, so an
    // admin who has forgotten whether they already invited Alice is stuck.
    expect(first).not.toContain('Still unclaimed');
    expect(second).toContain('Still unclaimed from earlier: 1 (Alice)');
  });

  it('gives two teammates two different codes', () => {
    const { path } = freshDatabase();

    const first = decodeInvite(blobFrom(invite('Alice', path, ENDPOINT)));
    const second = decodeInvite(blobFrom(invite('Rahim', path, ENDPOINT)));

    expect(first.ok && second.ok && first.invite.code).not.toBe(
      second.ok ? second.invite.code : '',
    );
  });
});

describe('a manual POST /join with the invite returns a token', () => {
  it('returns the token, the member id, and the name of the server joined', async () => {
    const { db, path } = freshDatabase();
    const decoded = decodeInvite(blobFrom(invite('Alice', path, ENDPOINT)));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const response = await postJoin(appOver(db), {
      code: decoded.invite.code,
      display_name: decoded.invite.name,
      hostname: 'alice-mbp',
      os: 'darwin',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<JoinResponseBody>();
    expect(body.token).toMatch(/^ccm_[A-Za-z0-9_-]{32}$/);
    expect(body.server_name).toBe('desk-01');
    expect(body.member_id).toMatch(/^m_/);
  });

  it('stores the member hashed, so the token exists only on the teammate side', async () => {
    const { db, path } = freshDatabase();
    const decoded = decodeInvite(blobFrom(invite('Alice', path, ENDPOINT)));
    if (!decoded.ok) throw new Error('invite did not decode');

    const body = (
      await postJoin(appOver(db), { code: decoded.invite.code, display_name: 'Alice' })
    ).json<JoinResponseBody>();
    db.pragma('wal_checkpoint(TRUNCATE)');

    expect(readFileSync(path, 'latin1')).not.toContain(body.token);
  });
});

describe('ingest with that token attributes rows to Alice', () => {
  it('writes every row under the member the token belongs to', async () => {
    const { db, path } = freshDatabase();
    const decoded = decodeInvite(blobFrom(invite('Alice', path, ENDPOINT)));
    if (!decoded.ok) throw new Error('invite did not decode');
    const app = appOver(db);
    const body = (
      await postJoin(app, { code: decoded.invite.code, display_name: 'Alice' })
    ).json<JoinResponseBody>();

    const ingested = await postLogs(app, body.token);

    expect(ingested.statusCode).toBe(200);
    expect(owners(db)).toEqual(['Alice']);
    const install = db.prepare('SELECT member_id AS id FROM installs').get() as { id: string };
    expect(install.id).toBe(body.member_id);
  });

  it('keeps two teammates apart on the same server', async () => {
    const { db, path } = freshDatabase();
    const app = appOver(db);

    /** Runs one teammate end to end: invite, join, then send their capture. */
    async function enrol(name: string, payload: string): Promise<string> {
      const decoded = decodeInvite(blobFrom(invite(name, path, ENDPOINT)));
      if (!decoded.ok) throw new Error('invite did not decode');
      const body = (
        await postJoin(app, { code: decoded.invite.code, display_name: name })
      ).json<JoinResponseBody>();
      expect((await postLogs(app, body.token, payload)).statusCode).toBe(200);
      return body.member_id;
    }

    const alice = await enrol('Alice', FIXTURES.alice);
    const rahim = await enrol('Rahim', FIXTURES.rahim);

    expect(alice).not.toBe(rahim);
    expect(owners(db).sort()).toEqual(['Alice', 'Rahim']);
    // One row each, under the member whose token carried it — the whole point
    // of stage 2, and what every per-person number on the dashboard rests on.
    const byMember = db
      .prepare('SELECT member_id AS id, count(*) AS n FROM requests GROUP BY member_id')
      .all() as { id: string; n: number }[];
    expect(byMember.map((row) => row.n)).toEqual([1, 1]);
    expect(new Set(byMember.map((row) => row.id))).toEqual(new Set([alice, rahim]));
  });

  it('refuses ingest with no token at all', async () => {
    const { db } = freshDatabase();

    const response = await postLogs(appOver(db));

    expect(response.statusCode).toBe(401);
    expect(db.prepare('SELECT count(*) AS n FROM requests').get()).toEqual({ n: 0 });
  });

  it('refuses ingest once the member is revoked, and keeps their old rows', async () => {
    const { db, path } = freshDatabase();
    const decoded = decodeInvite(blobFrom(invite('Alice', path, ENDPOINT)));
    if (!decoded.ok) throw new Error('invite did not decode');
    const app = appOver(db);
    const body = (
      await postJoin(app, { code: decoded.invite.code, display_name: 'Alice' })
    ).json<JoinResponseBody>();
    expect((await postLogs(app, body.token)).statusCode).toBe(200);
    const before = db.prepare('SELECT count(*) AS n FROM requests').get();

    revokeMember(db, body.member_id);

    expect((await postLogs(app, body.token)).statusCode).toBe(403);
    // Revoking stops the future, not the past: the dashboard still has to show
    // what they used while they were a member.
    expect(db.prepare('SELECT count(*) AS n FROM requests').get()).toEqual(before);
  });
});

describe('reusing the code fails', () => {
  it('answers 409 and issues no second token', async () => {
    const { db, path } = freshDatabase();
    const decoded = decodeInvite(blobFrom(invite('Alice', path, ENDPOINT)));
    if (!decoded.ok) throw new Error('invite did not decode');
    const app = appOver(db);
    const first = await postJoin(app, { code: decoded.invite.code, display_name: 'Alice' });
    expect(first.statusCode).toBe(200);

    const second = await postJoin(app, { code: decoded.invite.code, display_name: 'Mallory' });

    expect(second.statusCode).toBe(409);
    expect(second.body).not.toContain('ccm_');
    expect(
      db.prepare("SELECT count(*) AS n FROM members WHERE display_name = 'Mallory'").get(),
    ).toEqual({ n: 0 });
  });

  it('answers 410 for a code that sat unused for more than a day', async () => {
    const { db } = freshDatabase();
    const code = createJoinCodeStore(db).create('Alice', {
      now: Date.now() - JOIN_CODE_TTL_MS - 1000,
    }).code;

    const response = await postJoin(appOver(db), { code, display_name: 'Alice' });

    expect(response.statusCode).toBe(410);
    expect(
      db.prepare("SELECT count(*) AS n FROM members WHERE display_name = 'Alice'").get(),
    ).toEqual({ n: 0 });
  });

  it('answers 404 for a code from another server', async () => {
    const { db } = freshDatabase();
    const elsewhere = freshDatabase();
    const code = createJoinCodeStore(elsewhere.db).create('Alice').code;

    expect((await postJoin(appOver(db), { code, display_name: 'Alice' })).statusCode).toBe(404);
  });
});
