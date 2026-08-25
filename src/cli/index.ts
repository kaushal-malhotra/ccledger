#!/usr/bin/env node
/**
 * The `ccledger` command line: argument parsing and nothing else.
 *
 * Each command's work lives in its own module, so importing this one parses no
 * arguments, opens no database and starts no server. That is what lets the
 * tests drive Commander directly and assert on what it resolved.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command, InvalidArgumentError } from 'commander';

import type { ServerMode } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import type { DoctorOptions } from './doctor.js';
import { runDoctor } from './doctor.js';
import type { InviteOptions } from './invite.js';
import { runInvite } from './invite.js';
import { fail, messageOf } from './io.js';
import type { ServeOptions } from './serve.js';
import { DEFAULT_DB_PATH, DEFAULT_HOST, DEFAULT_MODE, DEFAULT_PORT, runServe } from './serve.js';
import type { SetupOptions } from './setup.js';
import { runSetup } from './setup.js';

/** Deployment shapes `--mode` accepts. */
const MODES: readonly ServerMode[] = ['laptop', 'vps'];

/** Commander argument parser for `--port`; rejects anything a socket cannot bind. */
export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('expected an integer between 1 and 65535.');
  }
  return port;
}

/** Commander argument parser for `--mode`. */
export function parseMode(value: string): ServerMode {
  const mode = value.trim().toLowerCase();
  if (mode !== 'laptop' && mode !== 'vps') {
    throw new InvalidArgumentError(`expected one of ${MODES.join(', ')}.`);
  }
  return mode;
}

/**
 * Builds the Commander program. Separate from `main` so importing this module
 * parses no arguments and starts no server.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('ccledger')
    .description('Self-hosted Claude Code usage dashboard: OTLP ingest into SQLite.')
    .version(VERSION, '-v, --version', 'print the ccledger version')
    .showHelpAfterError();

  const serve = program
    .command('serve')
    .description('receive OTLP log events from Claude Code and store them in SQLite');
  serve
    .option('-p, --port <number>', 'port to listen on', parsePort, DEFAULT_PORT)
    .option('-d, --db <path>', 'SQLite database file', DEFAULT_DB_PATH)
    .option('-H, --host <address>', 'interface to bind', DEFAULT_HOST)
    .option('-m, --mode <mode>', `deployment shape: ${MODES.join(' | ')}`, parseMode, DEFAULT_MODE)
    .option('--public-url <url>', 'base URL teammates reach this server on')
    .option('--name <label>', 'name shown to a teammate when they join')
    .option('--rotate-admin-token', 'issue a new admin token, invalidating the current one')
    .action(async () => {
      await runServe(serve.opts<ServeOptions>());
    });

  const invite = program
    .command('invite')
    .description('generate a single-use join code and print the invite to send a teammate')
    .argument('<display-name>', 'the teammate this invite is for');
  invite
    .option('-d, --db <path>', 'SQLite database file', DEFAULT_DB_PATH)
    .option('--endpoint <url>', 'base URL to bundle; defaults to what serve last advertised')
    .action((displayName: string) => {
      runInvite(displayName, invite.opts<InviteOptions>());
    });

  const setup = program
    .command('setup')
    .description('join a ccledger server and configure Claude Code to report to it');
  setup
    .requiredOption('--code <invite>', 'the invite string your admin sent you')
    .option('--name <display-name>', 'name to show on the dashboard; defaults to the invite')
    .option('-y, --yes', 'accept the disclosure without being asked, for scripted installs')
    .action(async () => {
      await runSetup(setup.opts<SetupOptions>());
    });

  const doctor = program
    .command('doctor')
    .description('find out why Claude Code is or is not reporting to ccledger');
  doctor
    .option('--json', 'print the report as JSON, for a bug report or a script')
    .action(async () => {
      await runDoctor(doctor.opts<DoctorOptions>());
    });

  // Stage 3's `uninstall` follows. It is absent rather than stubbed so
  // `ccledger --help` never advertises a no-op.
  return program;
}

/** Parses `process.argv` and runs the selected command. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync([...argv]);
  } catch (error) {
    // Commander exits itself for --help/--version and for usage errors; this is
    // an action that threw, which must not surface as an unhandled rejection.
    fail(messageOf(error));
  }
}

/**
 * True when this module is the process entry point. `realpathSync` because npm
 * bin shims and pnpm stores resolve through symlinks, while `import.meta.url`
 * is already the real path.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void main();
}
