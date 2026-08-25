/**
 * Tests for `ccledger uninstall`.
 *
 * The promise being checked is narrow and absolute: it removes the keys the
 * record says it added, and nothing else — not a key someone has edited since,
 * not a key that was never ccledger's, and not one byte of the rest of the file.
 * Telling the server is a network call and lives in the integration suite; here
 * it is switched off so that every case below is decided on disk.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientPaths } from './paths.js';
import { resolveClientPaths } from './paths.js';
import type { JsonEntry } from './jsonedit.js';
import {
  LOGS_ENDPOINT_KEY,
  LOGS_EXPORTER_KEY,
  LOGS_HEADERS_KEY,
  LOGS_PROTOCOL_KEY,
  TELEMETRY_ENABLED_KEY,
  readSettings,
  writeEnvEntries,
} from './settings.js';
import { digestValue, writeState } from './state.js';
import { runUninstall } from './uninstall.js';

/** The server the fixture install points at. Nothing ever calls it. */
const ENDPOINT = 'http://ccledger-test.invalid:4318';

/** A member token, shaped like a real one so the inferred path recognises it. */
const TOKEN = 'ccm_TESTTESTTESTTESTTESTTESTTESTTE';

/** A settings file with unrelated things in it that have to survive. */
const EXISTING = `{
  "model": "opus",
  "permissions": { "allow": ["Bash(npm run test:*)"] },
  "hooks": { "Stop": [{ "matcher": "*", "hooks": [] }] },
  "env": {
    "EDITOR": "vim"
  }
}
`;

/** The five entries setup would have written. */
const ENTRIES: readonly JsonEntry[] = [
  { key: TELEMETRY_ENABLED_KEY, value: '1' },
  { key: LOGS_EXPORTER_KEY, value: 'otlp' },
  { key: LOGS_PROTOCOL_KEY, value: 'http/json' },
  { key: LOGS_ENDPOINT_KEY, value: `${ENDPOINT}/v1/logs` },
  { key: LOGS_HEADERS_KEY, value: `Authorization=Bearer ${TOKEN}` },
];

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Thrown in place of `process.exit`, so a refusal can be asserted on. */
class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
    this.name = 'Exited';
  }
}

/** What a captured run produced. */
interface Run {
  readonly out: string;
  readonly err: string;
  readonly code: number | undefined;
}

/** Runs a command with both streams captured and `process.exit` disarmed. */
async function capture(action: () => Promise<void>): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const write =
    (sink: string[]) =>
    (chunk: string | Uint8Array): boolean => {
      sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
  vi.spyOn(process.stdout, 'write').mockImplementation(write(out));
  vi.spyOn(process.stderr, 'write').mockImplementation(write(err));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
    throw new Exited(code ?? 0);
  }) as never);

  let code: number | undefined;
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Exited)) throw error;
    code = error.code;
  }
  return { out: out.join(''), err: err.join(''), code };
}

/** A temporary home directory, removed after the test. */
function tempHome(settings?: string): ClientPaths {
  const home = mkdtempSync(join(tmpdir(), 'ccledger-uninstall-'));
  homes.push(home);
  const paths = resolveClientPaths(home);
  if (settings !== undefined) {
    mkdirSync(paths.claudeDir, { recursive: true });
    writeFileSync(paths.settingsPath, settings, 'utf8');
  }
  return paths;
}

/** Does what a successful `setup` would have done, without needing a server. */
function install(paths: ClientPaths, options: { readonly writeRecord?: boolean } = {}): void {
  const read = readSettings(paths.settingsPath);
  if (!read.ok) throw new Error(read.error);
  const written = writeEnvEntries(read.settings, ENTRIES);
  if (options.writeRecord === false) return;
  writeState(paths.statePath, {
    version: 1,
    serverUrl: ENDPOINT,
    serverName: 'desk-01',
    memberId: 'm_test',
    displayName: 'Alice',
    settingsPath: written.path,
    createdSettingsFile: written.createdFile,
    createdEnvObject: written.createdEnv,
    addedKeys: ENTRIES.map((entry) => entry.key),
    valueDigests: Object.fromEntries(ENTRIES.map((e) => [e.key, digestValue(e.value)])),
    installedAt: Date.now(),
    ...(written.backupPath !== undefined ? { backupPath: written.backupPath } : {}),
  });
}

/** A stream of scripted answers, which is also what marks the run interactive. */
function answers(...lines: readonly string[]): Readable {
  return Readable.from([lines.map((line) => `${line}\n`).join('')]);
}

describe('runUninstall', () => {
  it('gives the settings file back exactly as setup found it', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    expect(readFileSync(paths.settingsPath, 'utf8')).not.toBe(EXISTING);

    const run = await capture(() => runUninstall({ yes: true, notify: false, home: paths.home }));

    expect(run.code).toBeUndefined();
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(EXISTING);
    expect(existsSync(paths.stateDir)).toBe(false);
  });

  it('leaves a key someone has edited since, and says which', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    writeFileSync(
      paths.settingsPath,
      readFileSync(paths.settingsPath, 'utf8').replace(ENDPOINT, 'http://moved.example'),
      'utf8',
    );

    const run = await capture(() => runUninstall({ yes: true, notify: false, home: paths.home }));

    expect(run.err).toContain(LOGS_ENDPOINT_KEY);
    expect(run.err).toContain('has changed');
    const env = (JSON.parse(readFileSync(paths.settingsPath, 'utf8')) as { env: object }).env;
    expect(env).toEqual({ EDITOR: 'vim', [LOGS_ENDPOINT_KEY]: 'http://moved.example/v1/logs' });
  });

  it('puts the backup back when asked to', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    // Something else edits the file after setup; restoring the backup is the
    // one path that deliberately undoes that too, which is why it is a choice.
    writeFileSync(
      paths.settingsPath,
      readFileSync(paths.settingsPath, 'utf8').replace('"opus"', '"sonnet"'),
      'utf8',
    );

    await capture(() =>
      runUninstall({ yes: true, restoreBackup: true, notify: false, home: paths.home }),
    );

    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(EXISTING);
  });

  it('says there is no backup rather than pretending to restore one', async () => {
    const paths = tempHome();
    install(paths);

    const run = await capture(() =>
      runUninstall({ yes: true, restoreBackup: true, notify: false, home: paths.home }),
    );

    expect(run.code).toBe(1);
    expect(run.err).toContain('no backup');
  });

  it('still works when the record has been deleted, from the five keys alone', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    rmSync(paths.stateDir, { recursive: true, force: true });

    const run = await capture(() => runUninstall({ yes: true, notify: false, home: paths.home }));

    expect(run.err).toContain('no record at');
    expect(run.out).toContain('because the record');
    const parsed = JSON.parse(readFileSync(paths.settingsPath, 'utf8')) as { env: object };
    expect(parsed.env).toEqual({ EDITOR: 'vim' });
  });

  it("touches nothing when there is no record and the keys are somebody else's", async () => {
    const settings = `{
  "env": {
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://someone-else.example.com/collect",
    "OTEL_LOGS_EXPORTER": "otlp"
  }
}
`;
    const paths = tempHome(settings);

    const run = await capture(() => runUninstall({ yes: true, notify: false, home: paths.home }));

    expect(run.out).toContain("Nothing of ccledger's is in");
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(settings);
  });

  it('will not change anything without a confirmation it cannot ask for', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    const installed = readFileSync(paths.settingsPath, 'utf8');

    const run = await capture(() => runUninstall({ notify: false, home: paths.home }));

    expect(run.code).toBe(1);
    expect(run.err).toContain('--yes');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(installed);
    expect(existsSync(paths.statePath)).toBe(true);
  });

  it('stops when the answer is no, leaving the record in place', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    const installed = readFileSync(paths.settingsPath, 'utf8');

    const run = await capture(() =>
      runUninstall({ notify: false, home: paths.home, input: answers('n') }),
    );

    expect(run.code).toBe(1);
    expect(run.err).toContain('cancelled');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(installed);
    expect(existsSync(paths.statePath)).toBe(true);
  });

  it('asks about each offer in turn, and takes no for an answer on each', async () => {
    const paths = tempHome(EXISTING);
    install(paths);

    // Remove the keys, do not restore the backup, do not tell the server. The
    // third answer is what keeps this test off the network.
    const run = await capture(() =>
      runUninstall({ home: paths.home, input: answers('y', 'n', 'n') }),
    );

    expect(run.code).toBeUndefined();
    expect(run.out).toContain('Put the backup at');
    expect(run.out).toContain('Tell the server');
    expect(run.out).toContain('The server was not told');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(EXISTING);
  });

  it('lists the keys before removing them', async () => {
    const paths = tempHome(EXISTING);
    install(paths);

    const run = await capture(() => runUninstall({ yes: true, notify: false, home: paths.home }));

    for (const entry of ENTRIES) expect(run.out).toContain(entry.key);
    expect(run.out).toContain('Restart Claude Code');
  });

  it('leaves ~/.ccledger alone when something else put a file in it', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    writeFileSync(join(paths.stateDir, 'notes.txt'), 'mine', 'utf8');

    const run = await capture(() => runUninstall({ yes: true, notify: false, home: paths.home }));

    expect(run.err).toContain('did not write');
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(join(paths.stateDir, 'notes.txt'))).toBe(true);
  });

  it('refuses to guess when the record itself is corrupt', async () => {
    const paths = tempHome(EXISTING);
    install(paths);
    writeFileSync(paths.statePath, 'not json', 'utf8');

    const run = await capture(() => runUninstall({ yes: true, notify: false, home: paths.home }));

    expect(run.code).toBe(1);
    expect(run.err).toContain('not valid JSON');
  });
});
