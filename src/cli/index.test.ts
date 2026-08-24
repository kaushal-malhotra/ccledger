/**
 * CLI surface tests. `runServe` binds a socket and installs signal handlers, so
 * what is exercised here is the part that decides *what* it will bind and the
 * argument parsing that gets it there — a bad default or a silently accepted
 * `--port 0` is the kind of thing nobody notices until a teammate cannot report.
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProgram } from './index.js';
import { VERSION } from '../shared/version.js';

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

/** A path in the temp directory that is cleaned up after the test. */
function tempDbPath(): string {
  const path = join(tmpdir(), `ccledger-cli-${randomUUID()}.db`);
  tempPaths.push(path);
  return path;
}

/**
 * Parses argv without running the action, and returns the serve options
 * Commander resolved. `exitOverride` turns Commander's `process.exit` into a
 * throw, so a parse failure fails the test instead of killing the runner.
 */
function parseServe(argv: readonly string[]): Record<string, unknown> {
  const program = buildProgram();
  program.exitOverride();
  const serve = program.commands.find((command) => command.name() === 'serve');
  if (serve === undefined) throw new Error('no serve command');
  serve.exitOverride();
  // Replace the action so parsing does not start a server.
  serve.action(() => undefined);
  program.parse(['node', 'ccledger', ...argv]);
  return serve.opts();
}

describe('buildProgram', () => {
  it('is named ccledger and reports the package version', () => {
    const program = buildProgram();

    expect(program.name()).toBe('ccledger');
    expect(program.version()).toBe(VERSION);
    expect(VERSION).not.toBe('0.0.0');
  });

  it('exposes serve, and does not stub the stage 2 and 3 commands', () => {
    const names = buildProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(names).toContain('serve');
    for (const later of ['invite', 'setup', 'doctor', 'uninstall']) {
      expect(names).not.toContain(later);
    }
  });
});

describe('serve options', () => {
  it('defaults to the OTLP port, loopback, and a database in the working directory', () => {
    const options = parseServe(['serve']);

    expect(options['port']).toBe(4318);
    expect(options['host']).toBe('127.0.0.1');
    expect(options['db']).toBe('./ccledger.db');
  });

  it('takes the flags it is given', () => {
    const path = tempDbPath();

    const options = parseServe(['serve', '--port', '4399', '--host', '0.0.0.0', '--db', path]);

    expect(options['port']).toBe(4399);
    expect(options['host']).toBe('0.0.0.0');
    expect(options['db']).toBe(path);
  });

  it('parses the port to a number, not a string', () => {
    const options = parseServe(['serve', '--port', '4399']);

    expect(typeof options['port']).toBe('number');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['above the 16-bit range', '65536'],
    ['fractional', '4318.5'],
    ['not a number', 'http'],
    ['empty', ''],
  ])('rejects a %s port rather than binding something unintended', (_label, port) => {
    expect(() => parseServe(['serve', '--port', port])).toThrow();
  });
});
