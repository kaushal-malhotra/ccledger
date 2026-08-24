#!/usr/bin/env node
/**
 * The `ccledger` command line. Stage 1 ships one subcommand: `serve`.
 *
 * Everything here is about the first thirty seconds of someone's experience —
 * a wrong port or an unwritable database path is the most likely way this
 * program fails, so both end as one line and exit code 1 rather than a stack
 * trace. A running server prints the exact URL a teammate points Claude Code
 * at, because that is the next thing they need and it is not guessable.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Command, InvalidArgumentError } from 'commander';

import type { Database } from '../db/index.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { buildApp } from '../server/app.js';
import { VERSION } from '../shared/version.js';

/** Claude Code's own OTLP/HTTP default, so `OTEL_EXPORTER_OTLP_ENDPOINT` can stay short. */
const DEFAULT_PORT = 4318;

/** Loopback by default: stage 1 has no auth, so binding wider must be a choice. */
const DEFAULT_HOST = '127.0.0.1';

/** Relative on purpose — the database belongs to the directory the operator runs in. */
const DEFAULT_DB_PATH = './ccledger.db';

/** The path OTLP exporters append to the endpoint; printed so it can be verified by hand. */
const INGEST_PATH = '/v1/logs';

/** Pino's levels. An unrecognised `CCLEDGER_LOG_LEVEL` would otherwise throw at boot. */
const LOG_LEVELS: ReadonlySet<string> = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

/** Options for `ccledger serve`, as Commander hands them over. */
export type ServeOptions = {
  /** TCP port to bind. */
  readonly port: number;
  /** SQLite file path; created if absent, migrated on every boot. */
  readonly db: string;
  /** Interface to bind. */
  readonly host: string;
};

/** Prints one line to stderr and exits non-zero. Never returns. */
function fail(message: string): never {
  process.stderr.write(`ccledger: ${message}\n`);
  process.exit(1);
}

/** The message of an unknown throw, without assuming it is an `Error`. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The `errno` string of a Node system error, e.g. `EADDRINUSE`. */
function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

/** Commander argument parser for `--port`; rejects anything a socket cannot bind. */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('expected an integer between 1 and 65535.');
  }
  return port;
}

/** Formats a base URL, bracketing a bare IPv6 literal so the result is clickable. */
function baseUrl(host: string, port: number): string {
  // 0.0.0.0 and :: are bind addresses, not destinations; print something a
  // teammate can actually paste.
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const authority = display.includes(':') ? `[${display}]` : display;
  return `http://${authority}:${port}`;
}

/** Fastify's log level, from `CCLEDGER_LOG_LEVEL`, falling back to `info`. */
function resolveLogLevel(): string {
  const requested = process.env.CCLEDGER_LOG_LEVEL;
  if (requested === undefined || requested === '') return 'info';
  const level = requested.toLowerCase();
  if (LOG_LEVELS.has(level)) return level;
  process.stderr.write(`ccledger: ignoring CCLEDGER_LOG_LEVEL='${requested}'; using info\n`);
  return 'info';
}

/**
 * Opens and migrates the database, or exits 1 with the reason. A bad `--db`
 * path is the single most common startup failure and better-sqlite3's own
 * "unable to open database file" does not say which file.
 */
function openMigratedDatabase(path: string): Database.Database {
  const absolute = resolve(path);
  let db: Database.Database;
  try {
    db = openDatabase(path);
  } catch (error) {
    fail(`cannot open database at ${absolute}: ${messageOf(error)}`);
  }

  try {
    const applied = runMigrations(db);
    if (applied > 0) {
      process.stdout.write(`ccledger: applied ${applied} migration${applied === 1 ? '' : 's'}\n`);
    }
  } catch (error) {
    // A half-applied migration is rolled back by the runner; the file is still
    // the user's, so close the handle rather than leaving a WAL behind.
    db.close();
    fail(`cannot migrate database at ${absolute}: ${messageOf(error)}`);
  }
  return db;
}

/** Runs the OTLP ingest server until a signal arrives. Resolves only on shutdown. */
export async function runServe(options: ServeOptions): Promise<void> {
  const databasePath = resolve(options.db);
  const db = openMigratedDatabase(options.db);
  const app = buildApp({ db, logger: { level: resolveLogLevel() } });

  let closing = false;
  const shutdown = (signal: string): void => {
    // Two Ctrl+Cs in a row must not race two closes against the same handle.
    if (closing) return;
    closing = true;
    process.stdout.write(`\nccledger: ${signal} received, shutting down\n`);
    void app
      .close()
      .catch((error: unknown) => {
        process.stderr.write(`ccledger: error closing server: ${messageOf(error)}\n`);
      })
      .finally(() => {
        db.close();
        process.exit(0);
      });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  try {
    await app.listen({ port: options.port, host: options.host });
  } catch (error) {
    db.close();
    const code = errnoCodeOf(error);
    if (code === 'EADDRINUSE') {
      fail(`port ${options.port} is already in use; pass --port to choose another`);
    }
    if (code === 'EACCES') {
      fail(`not permitted to bind ${options.host}:${options.port}; try a port above 1023`);
    }
    if (code === 'EADDRNOTAVAIL') {
      fail(`host ${options.host} is not an address on this machine`);
    }
    fail(`could not listen on ${options.host}:${options.port}: ${messageOf(error)}`);
  }

  const url = baseUrl(options.host, options.port);
  // TODO(stage 2): print the teammate's invite command and bearer token here —
  // until auth lands, anything that can reach this endpoint can write to it.
  process.stdout.write(
    [
      `ccledger listening on ${url}`,
      `  ingest      ${url}${INGEST_PATH}  (teammates set OTEL_EXPORTER_OTLP_ENDPOINT=${url})`,
      `  health      ${url}/health`,
      `  database    ${databasePath}`,
      '',
    ].join('\n'),
  );
  if (options.host !== '127.0.0.1' && options.host !== 'localhost' && options.host !== '::1') {
    process.stdout.write(
      `ccledger: warning — bound to ${options.host} and ingest is unauthenticated until stage 2\n`,
    );
  }
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
    .action(async () => {
      await runServe(serve.opts<ServeOptions>());
    });

  // Stage 2 adds `invite`, `setup`, `doctor` and `uninstall`. They are absent
  // rather than stubbed so `ccledger --help` never advertises a no-op.
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
