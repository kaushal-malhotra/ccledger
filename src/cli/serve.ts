/**
 * `ccledger serve`.
 *
 * Most of this file is output, and that is the right proportion. Starting the
 * server is four lines; what decides whether the thing gets used is whether the
 * person who ran it can see, without reading any documentation, the URL their
 * teammates need, the fact that laptop mode is unencrypted, and an admin token
 * that will never be shown again.
 */

import { hostname, networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { getConfig, setConfig, setConfigIfAbsent } from '../db/config.js';
import type { Database } from '../db/index.js';
import { createJoinCodeStore } from '../db/joincodes.js';
import { ensureAdminToken } from '../server/auth.js';
import { buildApp } from '../server/app.js';
import { CONFIG_PUBLIC_URL, CONFIG_SERVER_NAME } from '../shared/constants.js';
import { normaliseDisplayName, normaliseEndpoint } from '../shared/invite.js';
import type { ServerMode } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import { openMigratedDatabase } from './database.js';
import { errnoCodeOf, fail, messageOf, say, warn } from './io.js';

/** Claude Code's own OTLP/HTTP default, so a teammate's endpoint can stay short. */
export const DEFAULT_PORT = 4318;

/**
 * Every interface, in both modes. Laptop mode exists so teammates on the LAN
 * can reach the server, and VPS mode runs inside a container whose only route
 * in is the proxy in front of it — a loopback default would make the flag that
 * fixes it the first thing every operator has to discover. Every route except
 * `/health` and `/join` needs a token, and `/join` needs a live code.
 */
export const DEFAULT_HOST = '0.0.0.0';

/** Relative on purpose — the database belongs to the directory the operator runs in. */
export const DEFAULT_DB_PATH = './ccledger.db';

/** How a server is deployed, when the operator does not say. */
export const DEFAULT_MODE: ServerMode = 'laptop';

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
export interface ServeOptions {
  /** TCP port to bind. */
  readonly port: number;
  /** SQLite file path; created if absent, migrated on every boot. */
  readonly db: string;
  /** Interface to bind. */
  readonly host: string;
  /** Deployment shape, which decides the warnings and the default public URL. */
  readonly mode: ServerMode;
  /** Base URL teammates reach this server on. Guessed in laptop mode. */
  readonly publicUrl?: string;
  /** Label shown to a teammate when they join. Defaults to the machine name. */
  readonly name?: string;
  /** Issue a new admin token, invalidating the current one. */
  readonly rotateAdminToken?: boolean;
}

/** Formats a base URL, bracketing a bare IPv6 literal so the result is clickable. */
export function baseUrl(host: string, port: number): string {
  // 0.0.0.0 and :: are bind addresses, not destinations; print something a
  // teammate can actually paste.
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const authority = display.includes(':') ? `[${display}]` : display;
  return `http://${authority}:${String(port)}`;
}

/**
 * Every non-internal IPv4 address on this machine. Printed as the fallback for
 * a teammate whose resolver does not do mDNS — an IP that works today beats a
 * hostname that works in principle.
 *
 * All of them, not the first one: a developer machine usually has WSL, Docker
 * or Hyper-V adapters alongside the real network, and picking one would print a
 * plausible address that nothing on the LAN can reach. A short list the admin
 * can choose from is honest about what this process actually knows.
 */
export function lanAddresses(): readonly string[] {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address);
    }
  }
  return found;
}

/** This machine's name with any domain suffix removed, lowercased. */
export function shortHostname(machineName: string = hostname()): string {
  const name = machineName.trim().toLowerCase().split('.')[0] ?? '';
  return name === '' ? 'localhost' : name;
}

/**
 * The mDNS name this machine answers to. Most operating systems publish their
 * own hostname over mDNS, so `<hostname>.local` resolves on a LAN today —
 * unlike the `ccledger.local` alias, which needs an advertisement of our own.
 */
export function mdnsHost(machineName: string = hostname()): string {
  const name = shortHostname(machineName);
  return name === 'localhost' ? name : `${name}.local`;
}

/**
 * The base URL to hand teammates. An explicit `--public-url` always wins. In
 * laptop mode the mDNS name is guessed, because a guess that is usually right
 * beats making every admin discover a flag. In VPS mode nothing is guessed:
 * the server sits behind a proxy that knows the domain and it does not, and an
 * invite carrying a container's own address is an invite that cannot work.
 */
export function resolvePublicUrl(options: {
  readonly mode: ServerMode;
  readonly publicUrl?: string;
  readonly port: number;
}): string | undefined {
  if (options.publicUrl !== undefined) return normaliseEndpoint(options.publicUrl);
  if (options.mode === 'vps') return undefined;
  return `http://${mdnsHost()}:${String(options.port)}`;
}

/** Fastify's log level, from `CCLEDGER_LOG_LEVEL`, falling back to `info`. */
function resolveLogLevel(): string {
  const requested = process.env.CCLEDGER_LOG_LEVEL;
  if (requested === undefined || requested === '') return 'info';
  const level = requested.toLowerCase();
  if (LOG_LEVELS.has(level)) return level;
  warn(`ignoring CCLEDGER_LOG_LEVEL='${requested}'; using info`);
  return 'info';
}

/** What `printBanner` needs to say where teammates should point Claude Code. */
interface BannerOptions {
  readonly mode: ServerMode;
  /** The URL that reaches this process from the machine it runs on. */
  readonly localUrl: string;
  /** The URL teammates should use, whether resolved now or recorded earlier. */
  readonly advertised: string | undefined;
  /** True when `advertised` is left over from a previous run rather than this one. */
  readonly advertisedIsStored: boolean;
  readonly databasePath: string;
  readonly port: number;
}

/** Prints the endpoints, the database, and whatever the mode has to warn about. */
function printBanner(options: BannerOptions): void {
  const endpointBase = options.advertised ?? options.localUrl;
  say();
  say(`ccledger ${VERSION} · ${options.mode} mode · listening on ${options.localUrl}`);
  say();
  say(`  ingest      ${endpointBase}${INGEST_PATH}`);
  say(`  health      ${endpointBase}/health`);
  say(`  database    ${options.databasePath}`);
  say();

  if (options.mode === 'laptop') {
    say(`  Teammates on this network reach ccledger at ${endpointBase}`);
    const addresses = lanAddresses();
    if (addresses.length > 0) {
      const list = addresses.map((address) => `http://${address}:${String(options.port)}`);
      say(`  If that name does not resolve for them, try ${list.join('  or  ')}`);
    }
    say();
    say('  WARNING  laptop mode serves plain HTTP. Tokens and telemetry cross the');
    say('           network unencrypted and anyone on it can read them. Use this');
    say('           mode only on a network you trust; run --mode=vps behind TLS');
    say('           for anything else.');
    say();
  } else if (options.advertised === undefined) {
    say('  No public URL is set, so ccledger cannot tell teammates where to find it.');
    say('  Pass --public-url https://your.domain here, or --endpoint to each invite.');
    say();
  } else {
    if (options.advertisedIsStored) {
      // The stored URL is what `ccledger invite` will hand out, and a server
      // that has moved since it was written is exactly how a whole team stops
      // reporting without anyone noticing.
      say(`  Invites will carry ${options.advertised}, recorded by an earlier run.`);
      say('  Pass --public-url to change it.');
      say();
    }
    say('  VPS mode assumes TLS is terminated in front of this process. If nothing');
    say('  is, tokens cross the internet in plain text.');
    say();
  }

  say('  Invite a teammate:  ccledger invite <name>');
  say();
}

/** Prints a freshly issued admin token, once, with the URL that uses it. */
function printAdminToken(token: string, localUrl: string, rotated: boolean): void {
  say(
    rotated
      ? '  Admin token rotated — the previous one stopped working just now.'
      : '  Admin token created.',
  );
  say('  Only its hash is stored, so this is the one and only time it is shown.');
  say('  Save it somewhere before closing this terminal.');
  say();
  say(`      ${token}`);
  say();
  // The fragment, not the query string: a fragment is never sent to the server,
  // so the admin token stays out of access logs and out of Referer headers.
  say(`  Dashboard   ${localUrl}/#token=${token}`);
  say();
}

/** Runs the OTLP ingest server until a signal arrives. Resolves only on shutdown. */
export async function runServe(options: ServeOptions): Promise<void> {
  // Validated before anything binds or is written: a typo in a URL should cost
  // one line of output, not a half-configured server.
  const publicUrl = resolvePublicUrl(options);
  if (options.publicUrl !== undefined && publicUrl === undefined) {
    fail(`--public-url is not an absolute http(s) URL: ${options.publicUrl}`);
  }
  const serverName = options.name === undefined ? undefined : normaliseDisplayName(options.name);
  if (options.name !== undefined && serverName === undefined) {
    fail('--name must be 1 to 64 printable characters');
  }

  const databasePath = resolve(options.db);
  const db: Database.Database = openMigratedDatabase(options.db);
  const app: FastifyInstance = buildApp({ db, logger: { level: resolveLogLevel() } });

  let closing = false;
  const shutdown = (signal: string): void => {
    // Two Ctrl+Cs in a row must not race two closes against the same handle.
    if (closing) return;
    closing = true;
    say();
    warn(`${signal} received, shutting down`);
    void app
      .close()
      .catch((error: unknown) => {
        warn(`error closing server: ${messageOf(error)}`);
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
      fail(`port ${String(options.port)} is already in use; pass --port to choose another`);
    }
    if (code === 'EACCES') {
      fail(`not permitted to bind ${options.host}:${String(options.port)}; try a port above 1023`);
    }
    if (code === 'EADDRNOTAVAIL') {
      fail(`host ${options.host} is not an address on this machine`);
    }
    fail(`could not listen on ${options.host}:${String(options.port)}: ${messageOf(error)}`);
  }

  // Only once the socket is ours. An admin token issued before a failed bind
  // would be stored, never printed, and recoverable only by rotating it.
  const now = Date.now();
  if (serverName !== undefined) {
    setConfig(db, CONFIG_SERVER_NAME, serverName, now);
  } else {
    setConfigIfAbsent(db, CONFIG_SERVER_NAME, shortHostname(), now);
  }
  // What `ccledger invite` will bundle: this boot's answer if there is one, and
  // otherwise whatever the last boot recorded.
  const storedPublicUrl = getConfig(db, CONFIG_PUBLIC_URL);
  if (publicUrl !== undefined) {
    // Rewritten every boot, not just the first: the port or the mode may have
    // changed, and an invite carrying last week's URL is worse than no invite.
    setConfig(db, CONFIG_PUBLIC_URL, publicUrl, now);
  }
  const advertised = publicUrl ?? storedPublicUrl;

  const pruned = createJoinCodeStore(db).prune(now);
  if (pruned > 0) {
    warn(`pruned ${String(pruned)} expired join code${pruned === 1 ? '' : 's'}`);
  }

  const localUrl = baseUrl(options.host, options.port);
  printBanner({
    mode: options.mode,
    localUrl,
    advertised,
    advertisedIsStored: publicUrl === undefined && storedPublicUrl !== undefined,
    databasePath,
    port: options.port,
  });

  const admin = ensureAdminToken(db, { rotate: options.rotateAdminToken ?? false, now });
  if (admin.token !== undefined) {
    printAdminToken(admin.token, localUrl, admin.rotated);
  }
}
