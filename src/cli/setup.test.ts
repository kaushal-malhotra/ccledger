/**
 * Tests for the parts of `ccledger setup` that happen before the network does.
 *
 * That is deliberately most of them. Everything which decides whether a
 * teammate's machine is changed — a bad invite, a key that is already set, a
 * confirmation that was never given — is settled before the join code is spent,
 * so it can all be exercised without a server, and each of these cases has to
 * leave the settings file exactly as it found it. The successful path, which
 * needs a real `/join`, is in `test/client.integration.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeInvite } from '../shared/invite.js';
import { generateJoinCode } from '../shared/joincode.js';
import type { ClientPaths } from './paths.js';
import { resolveClientPaths } from './paths.js';
import { runSetup } from './setup.js';

/** The endpoint every invite in this file points at. Nothing listens there. */
const ENDPOINT = 'http://ccledger-test.invalid:4318';

/** A settings file with things in it that must survive untouched. */
const EXISTING = `{
  "model": "opus",
  "permissions": { "allow": ["Bash(npm run test:*)"] },
  "env": {
    "EDITOR": "vim"
  }
}
`;

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
  /** The exit code, or `undefined` when the command returned normally. */
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
  const home = mkdtempSync(join(tmpdir(), 'ccledger-setup-'));
  homes.push(home);
  const paths = resolveClientPaths(home);
  if (settings !== undefined) {
    mkdirSync(paths.claudeDir, { recursive: true });
    writeFileSync(paths.settingsPath, settings, 'utf8');
  }
  return paths;
}

/** An invite blob for `ENDPOINT`, with a fresh code. */
function invite(name?: string): string {
  return encodeInvite({
    v: 1,
    endpoint: ENDPOINT,
    code: generateJoinCode(),
    ...(name === undefined ? {} : { name }),
  });
}

/** A stream of scripted answers, which is also what marks the run interactive. */
function answers(...lines: readonly string[]): Readable {
  return Readable.from([lines.map((line) => `${line}\n`).join('')]);
}

describe('runSetup', () => {
  it('refuses an invite that is not one, and touches nothing', async () => {
    const paths = tempHome(EXISTING);

    const run = await capture(() =>
      runSetup({ code: 'not-an-invite!!', yes: true, home: paths.home }),
    );

    expect(run.code).toBe(1);
    expect(run.err).toContain('base64url');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(EXISTING);
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it('stops on a malformed settings file rather than replacing it', async () => {
    const paths = tempHome('{ "model": "opus", }\n');

    const run = await capture(() =>
      runSetup({ code: invite('Alice'), yes: true, home: paths.home }),
    );

    expect(run.code).toBe(1);
    expect(run.err).toContain('not valid JSON');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ "model": "opus", }\n');
  });

  it('refuses to clobber a key another exporter is using, before spending the code', async () => {
    const settings = `{
  "env": {
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://someone-else.example.com/v1/logs"
  }
}
`;
    const paths = tempHome(settings);

    const run = await capture(() =>
      runSetup({ code: invite('Alice'), yes: true, home: paths.home }),
    );

    expect(run.code).toBe(1);
    expect(run.out).toContain('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
    expect(run.out).toContain('someone-else.example.com');
    expect(run.out).toContain('will not overwrite');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(settings);
  });

  it('recognises its own earlier install and points at uninstall', async () => {
    const settings = `{
  "env": {
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://old-server.local:4318/v1/logs",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS": "Authorization=Bearer ccm_OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOL"
  }
}
`;
    const paths = tempHome(settings);

    const run = await capture(() =>
      runSetup({ code: invite('Alice'), yes: true, home: paths.home }),
    );

    expect(run.code).toBe(1);
    expect(run.out).toContain('already set up for ccledger');
    expect(run.out).toContain('ccledger uninstall');
    // The old token is quoted back as evidence, but not in a usable form.
    expect(run.out).not.toContain('OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOL');
    expect(run.out).toContain('ccm_OLD');
  });

  it('will not change anything without a confirmation it cannot ask for', async () => {
    const paths = tempHome(EXISTING);

    const run = await capture(() => runSetup({ code: invite('Alice'), home: paths.home }));

    expect(run.code).toBe(1);
    expect(run.err).toContain('--yes');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(EXISTING);
  });

  it('shows the disclosure before asking, and stops when the answer is no', async () => {
    const paths = tempHome(EXISTING);

    const run = await capture(() =>
      runSetup({ code: invite('Alice'), home: paths.home, input: answers('', 'n') }),
    );

    expect(run.code).toBe(1);
    // The disclosure is quoted verbatim and has to arrive intact.
    expect(run.out).toContain('ccledger will send, per API request:');
    expect(run.out).toContain('  model name, token counts, duration, timestamp, session id');
    expect(run.out).toContain('It will NOT send:');
    expect(run.out).toContain('  prompts, responses, file contents, file paths,');
    expect(run.out).toContain('  command text, or repository names');
    expect(run.out).toContain('Config written to: ~/.claude/settings.json');
    expect(run.out).toContain('Remove any time with: npx ccledger uninstall');
    expect(run.err).toContain('cancelled');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(EXISTING);
  });

  it('offers the name from the invite as the default answer', async () => {
    const paths = tempHome(EXISTING);

    const run = await capture(() =>
      runSetup({ code: invite('Rahim'), home: paths.home, input: answers('', 'n') }),
    );

    expect(run.out).toContain('[Rahim]');
  });

  it('needs a name when the invite carries none and nobody can be asked', async () => {
    const paths = tempHome(EXISTING);

    const run = await capture(() => runSetup({ code: invite(), yes: true, home: paths.home }));

    expect(run.code).toBe(1);
    expect(run.err).toContain('--name');
  });

  it('rejects a display name that is not printable', async () => {
    const paths = tempHome(EXISTING);
    // A name is echoed in CLI output and rendered on the dashboard, so an escape
    // sequence in one is a name that can misrepresent the row next to it. Written
    // as an escape here, because a raw control byte in source is invisible.
    const name = 'Al\u001b[31mice';

    const run = await capture(() =>
      runSetup({ code: invite('Alice'), yes: true, name, home: paths.home }),
    );

    expect(run.code).toBe(1);
    expect(run.err).toContain('printable');
  });
});
