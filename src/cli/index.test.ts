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
import {
  baseUrl,
  explicitPublicUrl,
  lanAddresses,
  laptopPublicUrl,
  shortHostname,
} from './serve.js';
import { MDNS_HOSTNAME } from './mdns.js';
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
 * Parses argv without running the action, and returns the options Commander
 * resolved for the named subcommand. `exitOverride` turns Commander's
 * `process.exit` into a throw, so a parse failure fails the test instead of
 * killing the runner.
 */
function parseCommand(name: string, argv: readonly string[]): Record<string, unknown> {
  const program = buildProgram();
  program.exitOverride();
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (command === undefined) throw new Error(`no ${name} command`);
  command.exitOverride();
  // Replace the action so parsing neither starts a server nor opens a database.
  command.action(() => undefined);
  program.parse(['node', 'ccledger', ...argv]);
  return command.opts();
}

/** `parseCommand` for `serve`, which most of this file is about. */
function parseServe(argv: readonly string[]): Record<string, unknown> {
  return parseCommand('serve', argv);
}

describe('buildProgram', () => {
  it('is named ccledger and reports the package version', () => {
    const program = buildProgram();

    expect(program.name()).toBe('ccledger');
    expect(program.version()).toBe(VERSION);
    expect(VERSION).not.toBe('0.0.0');
  });

  it('exposes the whole command surface and nothing else', () => {
    const names = buildProgram()
      .commands.map((command) => command.name())
      .sort();

    expect(names).toEqual(['backup', 'doctor', 'invite', 'serve', 'setup', 'uninstall']);
  });
});

describe('backup options', () => {
  it('defaults to the same database serve writes to', () => {
    const options = parseCommand('backup', ['backup', './snapshot.db']);

    // Same default as `serve` and `invite`: an admin who has never passed --db
    // should not have to start now, on the one command where naming the wrong
    // file means backing up something that is not the database.
    expect(options['db']).toBe('./ccledger.db');
    expect(options['force']).toBeUndefined();
  });

  it('takes the flags it is given', () => {
    const path = tempDbPath();

    const options = parseCommand('backup', ['backup', './snapshot.db', '--db', path, '--force']);

    expect(options['db']).toBe(path);
    expect(options['force']).toBe(true);
  });

  it('requires somewhere to write the backup', () => {
    // The destination is an argument rather than a flag, so leaving it out is a
    // usage error and not a snapshot written somewhere unstated.
    expect(() => parseCommand('backup', ['backup'])).toThrow();
  });
});

describe('serve options', () => {
  it('defaults to the OTLP port, every interface, laptop mode, and a local database', () => {
    const options = parseServe(['serve']);

    expect(options['port']).toBe(4318);
    // Every interface, not loopback: laptop mode exists so teammates on the LAN
    // can reach it, and every route but /health and /join now needs a token.
    expect(options['host']).toBe('0.0.0.0');
    expect(options['mode']).toBe('laptop');
    expect(options['db']).toBe('./ccledger.db');
    expect(options['publicUrl']).toBeUndefined();
    expect(options['rotateAdminToken']).toBeUndefined();
  });

  it('takes the flags it is given', () => {
    const path = tempDbPath();

    const options = parseServe([
      'serve',
      '--port',
      '4399',
      '--host',
      '127.0.0.1',
      '--db',
      path,
      '--mode',
      'vps',
      '--public-url',
      'https://meter.example.com',
      '--name',
      'Team server',
      '--rotate-admin-token',
    ]);

    expect(options['port']).toBe(4399);
    expect(options['host']).toBe('127.0.0.1');
    expect(options['db']).toBe(path);
    expect(options['mode']).toBe('vps');
    expect(options['publicUrl']).toBe('https://meter.example.com');
    expect(options['name']).toBe('Team server');
    expect(options['rotateAdminToken']).toBe(true);
  });

  it.each([
    ['unknown', 'cloud'],
    ['empty', ''],
  ])('rejects a %s mode rather than guessing one', (_label, mode) => {
    expect(() => parseServe(['serve', '--mode', mode])).toThrow();
  });

  it('accepts a mode in any case, because a flag is not a secret', () => {
    expect(parseServe(['serve', '--mode', 'VPS'])['mode']).toBe('vps');
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

describe('invite options', () => {
  it('defaults to the same database serve uses and no endpoint of its own', () => {
    const options = parseCommand('invite', ['invite', 'Alice']);

    expect(options['db']).toBe('./ccledger.db');
    expect(options['endpoint']).toBeUndefined();
  });

  it('takes an explicit endpoint, for a server it has never run beside', () => {
    const options = parseCommand('invite', [
      'invite',
      'Alice',
      '--endpoint',
      'https://meter.example.com',
    ]);

    expect(options['endpoint']).toBe('https://meter.example.com');
  });

  it('requires a display name', () => {
    expect(() => parseCommand('invite', ['invite'])).toThrow();
  });
});

describe('client command options', () => {
  it('requires an invite for setup, because there is nothing to join without one', () => {
    expect(() => parseCommand('setup', ['setup'])).toThrow();
  });

  it('takes the invite, a name and the non-interactive flag', () => {
    const options = parseCommand('setup', [
      'setup',
      '--code',
      'abc123',
      '--name',
      'Alice',
      '--yes',
    ]);

    expect(options['code']).toBe('abc123');
    expect(options['name']).toBe('Alice');
    expect(options['yes']).toBe(true);
  });

  it('defaults doctor to human output', () => {
    expect(parseCommand('doctor', ['doctor'])['json']).toBeUndefined();
    expect(parseCommand('doctor', ['doctor', '--json'])['json']).toBe(true);
  });

  it('leaves uninstall with no answer to any of its offers until one is given', () => {
    const options = parseCommand('uninstall', ['uninstall']);

    // Undefined rather than true: an absent flag has to mean "ask", or telling
    // the server stops being an offer and starts being a side effect.
    expect(options['notify']).toBeUndefined();
    expect(options['restoreBackup']).toBeUndefined();
    expect(options['yes']).toBeUndefined();
  });

  it('reads both spellings of the notify flag', () => {
    expect(parseCommand('uninstall', ['uninstall', '--notify'])['notify']).toBe(true);
    expect(parseCommand('uninstall', ['uninstall', '--no-notify'])['notify']).toBe(false);
  });

  it('takes the uninstall flags it is given', () => {
    const options = parseCommand('uninstall', ['uninstall', '--yes', '--restore-backup']);

    expect(options['yes']).toBe(true);
    expect(options['restoreBackup']).toBe(true);
  });
});

describe('the URLs serve prints', () => {
  it('turns a bind address into something a teammate can paste', () => {
    expect(baseUrl('0.0.0.0', 4318)).toBe('http://localhost:4318');
    expect(baseUrl('::', 4318)).toBe('http://localhost:4318');
    expect(baseUrl('192.168.1.20', 4318)).toBe('http://192.168.1.20:4318');
    // A bare IPv6 literal has to be bracketed or the port reads as another group.
    expect(baseUrl('fe80::1', 4318)).toBe('http://[fe80::1]:4318');
  });

  it('reduces the machine name to its short form for the server label', () => {
    expect(shortHostname('Desk-01')).toBe('desk-01');
    expect(shortHostname('desk-01.corp.example.com')).toBe('desk-01');
    expect(shortHostname('  ')).toBe('localhost');
  });

  it('advertises the mDNS name when it published and a LAN address when it did not', () => {
    // The mDNS name wins even where an address would also do: it survives the
    // laptop moving to a different network, and the invite carrying it does too.
    expect(laptopPublicUrl(MDNS_HOSTNAME, 4318, ['192.168.1.20', '10.0.0.4'])).toBe(
      'http://ccledger.local:4318',
    );
    // Without mDNS, one unambiguous address is the fallback.
    expect(laptopPublicUrl(undefined, 4318, ['192.168.1.20'])).toBe('http://192.168.1.20:4318');
    // Two addresses and no way to tell which one teammates share a network
    // with. A wrong guess here mints invites that fail silently on delivery, so
    // the banner asks for --public-url instead.
    expect(laptopPublicUrl(undefined, 4318, ['172.19.144.1', '192.168.1.20'])).toBeUndefined();
    // On no network at all there is nothing to tell a teammate, and `localhost`
    // would send every one of them to their own machine.
    expect(laptopPublicUrl(undefined, 4318, [])).toBeUndefined();
  });

  it('offers every real address rather than picking one that may be virtual', () => {
    const addresses = lanAddresses();

    for (const address of addresses) {
      expect(address).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
    // Loopback is internal, and printing it as the address teammates should
    // use would send every one of them to their own machine.
    expect(addresses).not.toContain('127.0.0.1');
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('normalises an explicit public URL and rejects one that is not a URL', () => {
    expect(explicitPublicUrl('https://meter.example.com/')).toBe('https://meter.example.com');
    // Reported by the caller as a usage error rather than guessed at. Behind a
    // proxy the process cannot know its own public name, so VPS mode has
    // nothing else to fall back to.
    expect(explicitPublicUrl('not a url')).toBeUndefined();
    expect(explicitPublicUrl(undefined)).toBeUndefined();
  });
});
