/**
 * Stage 3 acceptance, clause by clause.
 *
 * The brief's acceptance test is a sentence: on a machine with an existing
 * `~/.claude/settings.json` containing custom permissions and hooks, setup adds
 * five keys and touches nothing else, and uninstall returns the file to its
 * original state. This file is that sentence, run against a real server on a
 * real socket, a real SQLite file and a real settings file in a temporary home —
 * the invite comes out of `ccledger invite`, the token comes out of `/join`, and
 * the telemetry that follows is a captured Claude Code payload.
 *
 * Nothing here is stubbed between the invite being printed and the row landing,
 * and nothing here can reach the machine it runs on: every path is resolved from
 * a `mkdtemp` home that is deleted afterwards.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctor } from '../src/cli/doctor.js';
import { runInvite } from '../src/cli/invite.js';
import type { ClientPaths } from '../src/cli/paths.js';
import { resolveClientPaths } from '../src/cli/paths.js';
import { OWNED_ENV_KEYS, tokenOfHeaders } from '../src/cli/settings.js';
import { runSetup } from '../src/cli/setup.js';
import { readState } from '../src/cli/state.js';
import { runUninstall } from '../src/cli/uninstall.js';
import { setConfig } from '../src/db/config.js';
import { migratedDatabase } from '../src/db/index.js';
import { buildApp } from '../src/server/app.js';
import { CONFIG_SERVER_NAME } from '../src/shared/constants.js';

/**
 * The settings file the acceptance criterion describes: permissions, hooks, and
 * an `env` a teammate already put something in. Every byte outside `env` has to
 * survive setup, and every byte of it has to come back after uninstall.
 */
const EXISTING_SETTINGS = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(npm run test:*)", "Read(~/.zshrc)"],
    "deny": ["Bash(curl:*)"]
  },
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "notify-send done" }] }
    ]
  },
  "env": {
    "EDITOR": "vim"
  },
  "statusLine": { "type": "command", "command": "ccstatus" }
}
`;

/** A sanitised capture, carrying one `api_request`. */
const CAPTURE = readFileSync(new URL('./fixtures/001.json', import.meta.url), 'utf8');

const openApps: FastifyInstance[] = [];
const openHandles: Database.Database[] = [];
const tempPaths: string[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  for (const db of openHandles.splice(0)) if (db.open) db.close();
  for (const path of tempPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A ccledger server on a loopback port, with the database behind it. */
async function startServer(): Promise<{
  readonly db: Database.Database;
  readonly app: FastifyInstance;
  readonly endpoint: string;
  readonly dbPath: string;
}> {
  const dbPath = join(tmpdir(), `ccledger-client-${randomUUID()}.db`);
  tempPaths.push(dbPath);
  const db = migratedDatabase(dbPath);
  openHandles.push(db);
  setConfig(db, CONFIG_SERVER_NAME, 'desk-01');

  const app = buildApp({ db });
  openApps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { db, app, endpoint: `http://127.0.0.1:${String(port)}`, dbPath };
}

/** A temporary home directory with a settings file already in it. */
function tempHome(settings?: string): ClientPaths {
  const home = mkdtempSync(join(tmpdir(), 'ccledger-client-home-'));
  tempDirs.push(home);
  const paths = resolveClientPaths(home);
  if (settings !== undefined) {
    mkdirSync(paths.claudeDir, { recursive: true });
    writeFileSync(paths.settingsPath, settings, 'utf8');
  }
  return paths;
}

/** Runs something with stdout and stderr captured. */
async function capture(action: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);
  try {
    await action();
  } finally {
    vi.restoreAllMocks();
  }
  return chunks.join('');
}

/** Issues an invite for `name` and returns the blob out of what was printed. */
async function invite(dbPath: string, endpoint: string, name: string): Promise<string> {
  const output = await capture(() => {
    runInvite(name, { db: dbPath, endpoint });
  });
  const match = /--code (\S+)/.exec(output);
  expect(match, 'invite printed no code').not.toBeNull();
  return match?.[1] ?? '';
}

/** The `env` object of a settings file. */
function envOf(path: string): Record<string, string> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { env: Record<string, string> }).env;
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

describe('a teammate joining, reporting and leaving', () => {
  it('adds five keys, reports under them, and gives the file back byte for byte', async () => {
    const server = await startServer();
    const paths = tempHome(EXISTING_SETTINGS);
    const code = await invite(server.dbPath, server.endpoint, 'Alice');

    // --- setup -------------------------------------------------------------
    const setupOutput = await capture(() => runSetup({ code, yes: true, home: paths.home }));

    expect(setupOutput).toContain('Joined desk-01 as Alice.');
    expect(setupOutput).toContain('the server accepted a test batch');
    expect(setupOutput).toContain('RESTART CLAUDE CODE');

    const installed = readFileSync(paths.settingsPath, 'utf8');
    const env = envOf(paths.settingsPath);
    expect(Object.keys(env)).toEqual(['EDITOR', ...OWNED_ENV_KEYS]);
    expect(env.EDITOR).toBe('vim');
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe('http/json');
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(`${server.endpoint}/v1/logs`);

    // Everything before `env` is untouched, character for character.
    const untouched = EXISTING_SETTINGS.slice(0, EXISTING_SETTINGS.indexOf('"env"'));
    expect(installed.startsWith(untouched)).toBe(true);
    const parsed = JSON.parse(installed) as Record<string, unknown>;
    const original = JSON.parse(EXISTING_SETTINGS) as Record<string, unknown>;
    for (const key of ['model', 'permissions', 'hooks', 'statusLine']) {
      expect(parsed[key]).toEqual(original[key]);
    }

    const state = readState(paths.statePath);
    expect(state.ok).toBe(true);
    if (!state.ok || state.state === undefined) throw new Error('no state was written');
    expect(state.state.serverUrl).toBe(server.endpoint);
    expect(state.state.displayName).toBe('Alice');
    expect(state.state.addedKeys).toEqual(OWNED_ENV_KEYS);
    // The token is in the settings file and nowhere else ccledger wrote.
    const token = tokenOfHeaders(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS);
    expect(token).toBeDefined();
    expect(readFileSync(paths.statePath, 'utf8')).not.toContain(token ?? 'unset');

    // --- telemetry ---------------------------------------------------------
    const ingest = await server.app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      payload: CAPTURE,
    });
    expect(ingest.statusCode).toBe(200);
    expect(owners(server.db)).toEqual(['Alice']);

    // --- doctor ------------------------------------------------------------
    // A transcript written now is newer than the config, which is what check 2
    // is looking for: Claude Code has run since the config changed.
    mkdirSync(join(paths.projectsDir, 'a-project'), { recursive: true });
    writeFileSync(join(paths.projectsDir, 'a-project', 'session.jsonl'), '{}\n', 'utf8');

    const previousExitCode = process.exitCode;
    const doctorOutput = await capture(() => runDoctor({ json: true, home: paths.home, env: {} }));
    expect(process.exitCode).toBeUndefined();
    process.exitCode = previousExitCode;

    const report = JSON.parse(doctorOutput) as {
      ok: boolean;
      endpoint: string;
      checks: { id: string; status: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.endpoint).toBe(server.endpoint);
    expect(report.checks.map((entry) => `${entry.id}:${entry.status}`)).toEqual([
      'config:pass',
      'restart:pass',
      'endpoint:pass',
      'token:pass',
      'environment:pass',
      'content-logging:pass',
    ]);
    expect(doctorOutput).not.toContain(token ?? 'unset');

    // --- uninstall ---------------------------------------------------------
    const uninstallOutput = await capture(() =>
      runUninstall({ yes: true, notify: true, home: paths.home }),
    );

    expect(uninstallOutput).toContain('The server has revoked this token.');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(EXISTING_SETTINGS);
    expect(existsSync(paths.stateDir)).toBe(false);

    const revoked = server.db
      .prepare('SELECT revoked_at FROM members WHERE id = ?')
      .get(state.state.memberId) as { revoked_at: number | null } | undefined;
    expect(revoked?.revoked_at).toBeGreaterThan(0);

    // The revoked token is refused, and with a 4xx so an exporter gives up
    // rather than retrying a batch this server will never accept.
    const afterLeaving = await server.app.inject({
      method: 'POST',
      url: '/v1/logs',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
      payload: CAPTURE,
    });
    expect(afterLeaving.statusCode).toBe(403);
  });

  it('sets up a machine that has never opened Claude Code', async () => {
    const server = await startServer();
    const paths = tempHome();
    const code = await invite(server.dbPath, server.endpoint, 'Rahim');

    await capture(() => runSetup({ code, yes: true, home: paths.home }));

    const env = envOf(paths.settingsPath);
    expect(Object.keys(env)).toEqual([...OWNED_ENV_KEYS]);
    const state = readState(paths.statePath);
    if (!state.ok || state.state === undefined) throw new Error('no state was written');
    expect(state.state.createdSettingsFile).toBe(true);
    expect(state.state.backupPath).toBeUndefined();

    // With no config and no transcripts, the restart check has nothing to
    // compare and says so rather than guessing.
    const report = JSON.parse(
      await capture(() => runDoctor({ json: true, home: paths.home, env: {} })),
    ) as { checks: { id: string; status: string }[] };
    expect(report.checks.find((entry) => entry.id === 'restart')?.status).toBe('skip');
  });

  it('spends the join code once, so a second machine cannot use the same invite', async () => {
    const server = await startServer();
    const first = tempHome();
    const second = tempHome();
    const code = await invite(server.dbPath, server.endpoint, 'Alice');

    await capture(() => runSetup({ code, yes: true, home: first.home }));

    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exited');
    }) as never);
    const output = await capture(async () => {
      await expect(runSetup({ code, yes: true, home: second.home })).rejects.toThrow('exited');
    });
    exit.mockRestore();

    expect(output).toContain('already been used');
    expect(existsSync(second.settingsPath)).toBe(false);
  });

  it('reports a revoked token as something the admin has to undo', async () => {
    const server = await startServer();
    const paths = tempHome();
    const code = await invite(server.dbPath, server.endpoint, 'Alice');
    await capture(() => runSetup({ code, yes: true, home: paths.home }));

    // The teammate leaves, but their settings file stays as it was — which is
    // the shape of "my admin revoked me and I do not know why".
    const installed = readFileSync(paths.settingsPath, 'utf8');
    await capture(() => runUninstall({ yes: true, notify: true, home: paths.home }));
    writeFileSync(paths.settingsPath, installed, 'utf8');

    const report = JSON.parse(
      await capture(() => runDoctor({ json: true, home: paths.home, env: {} })),
    ) as { ok: boolean; checks: { id: string; status: string; remedy?: string }[] };

    const token = report.checks.find((entry) => entry.id === 'token');
    expect(token?.status).toBe('fail');
    expect(token?.remedy).toContain('new invite');
    expect(report.ok).toBe(false);
  });
});
