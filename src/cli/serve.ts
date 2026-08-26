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
import { normaliseTimeZone, systemTimeZone } from '../shared/alerts.js';
import { CONFIG_PUBLIC_URL, CONFIG_SERVER_NAME, CONFIG_TIMEZONE } from '../shared/constants.js';
import { normaliseDisplayName, normaliseEndpoint } from '../shared/invite.js';
import type { ServerMode } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import { openMigratedDatabase } from './database.js';
import { errnoCodeOf, fail, messageOf, say, warn } from './io.js';
import type { Advertisement } from './mdns.js';
import { MDNS_HOSTNAME, advertise } from './mdns.js';

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
  /**
   * IANA zone alert windows are calendar-aligned to. Defaults to the stored
   * one, then to this machine's — a "weekly" budget that resets at a surprising
   * hour is worse than one that resets at an inconvenient but predictable one.
   */
  readonly timezone?: string;
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
 * The base URL an explicit `--public-url` asks for, normalised, or `undefined`
 * when the flag was not passed — and also when it was passed something that is
 * not an absolute http(s) URL, which the caller reports rather than guessing at.
 *
 * An explicit flag always wins, in both modes. VPS mode has nothing else: the
 * server sits behind a proxy that knows the domain and it does not, and an
 * invite carrying a container's own address is an invite that cannot work.
 */
export function explicitPublicUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return normaliseEndpoint(raw);
}

/**
 * The base URL laptop mode hands teammates when no `--public-url` was given.
 *
 * The advertised mDNS name first, because it survives the server changing
 * address. A LAN address second, but only when there is exactly one, and that
 * restraint is the point: a developer machine usually has WSL, Docker or
 * Hyper-V adapters alongside the real network, and `172.19.144.1` is as likely
 * to come first as the address teammates can actually reach. Guessing wrong
 * there does not fail loudly — it mints invites that every teammate accepts and
 * none of them can deliver to. So where the answer is ambiguous this returns
 * `undefined` and the banner asks for `--public-url`, listing the candidates.
 */
export function laptopPublicUrl(
  advertisedHost: string | undefined,
  port: number,
  addresses: readonly string[] = lanAddresses(),
): string | undefined {
  if (advertisedHost !== undefined) return `http://${advertisedHost}:${String(port)}`;
  if (addresses.length !== 1) return undefined;
  return `http://${String(addresses[0])}:${String(port)}`;
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

/**
 * The zone alert windows will be aligned to, and whether this boot chose it.
 *
 * An explicit flag always wins and is written down. Otherwise whatever a
 * previous boot recorded stands: the zone is half of the debounce key, so a
 * server that moved machines, or started under a different `TZ`, would
 * otherwise redraw every window boundary and let this week's alerts fire a
 * second time. Only a database that has never seen a `serve` falls back to the
 * machine.
 */
export function resolveTimeZoneChoice(
  stored: string | undefined,
  requested: string | undefined,
): { readonly timezone: string; readonly source: 'flag' | 'stored' | 'system' } {
  if (requested !== undefined) {
    const normalised = normaliseTimeZone(requested);
    if (normalised === undefined) {
      fail(`--timezone is not a zone this Node build knows: ${requested}`);
    }
    return { timezone: normalised, source: 'flag' };
  }
  if (stored !== undefined) return { timezone: stored, source: 'stored' };
  return { timezone: systemTimeZone(), source: 'system' };
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
  /** The mDNS name this boot published, or `undefined` if it could not publish. */
  readonly mdnsHost: string | undefined;
  readonly databasePath: string;
  readonly port: number;
  /** The zone alert windows reset on. */
  readonly timezone: string;
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
  // Printed unprompted because it is the one setting whose wrong value is
  // invisible: everything works, and the weekly budget resets on a day nobody
  // expected.
  say(`  alert reset ${options.timezone}  (calendar day and week boundaries)`);
  say();

  if (options.mode === 'laptop') {
    if (options.mdnsHost !== undefined) {
      say(`  Advertised over mDNS as ${options.mdnsHost} — teammates need no setup for it.`);
    } else {
      // Said plainly, because the symptom otherwise is a teammate reporting
      // that a hostname the admin never saw fail does not resolve.
      say(`  mDNS is not available here, so ${MDNS_HOSTNAME} was not advertised.`);
    }
    const candidates = lanAddresses().map((address) => `http://${address}:${String(options.port)}`);
    if (options.advertised !== undefined) {
      say(`  Teammates on this network reach ccledger at ${endpointBase}`);
      const alternatives = candidates.filter((url) => url !== endpointBase);
      if (alternatives.length > 0) {
        say(`  If that does not reach them, try ${alternatives.join('  or  ')}`);
      }
    } else if (candidates.length === 0) {
      say('  This machine is on no network ccledger can see, so there is no address');
      say('  to give a teammate. Connect to a network and restart, or pass');
      say('  --public-url if you are reachable by some route this cannot detect.');
    } else {
      // Several addresses and no way to tell which one teammates share a
      // network with. Choosing would mint invites that fail silently, so this
      // asks rather than guesses.
      say('  This machine has more than one address and ccledger cannot tell which of');
      say('  them teammates can reach, so invites carry none of them. Restart with the');
      say('  one that is on their network:');
      say();
      for (const candidate of candidates) {
        say(`      ccledger serve --public-url ${candidate}`);
      }
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
  const explicit = explicitPublicUrl(options.publicUrl);
  if (options.publicUrl !== undefined && explicit === undefined) {
    fail(`--public-url is not an absolute http(s) URL: ${options.publicUrl}`);
  }
  const serverName = options.name === undefined ? undefined : normaliseDisplayName(options.name);
  if (options.name !== undefined && serverName === undefined) {
    fail('--name must be 1 to 64 printable characters');
  }
  // Checked here as well as in `resolveTimeZoneChoice`, which cannot run until
  // the database is open: a mistyped zone should cost one line of output rather
  // than a socket that binds and a token that is issued.
  if (options.timezone !== undefined && normaliseTimeZone(options.timezone) === undefined) {
    fail(`--timezone is not a zone this Node build knows: ${options.timezone}`);
  }

  const databasePath = resolve(options.db);
  const db: Database.Database = openMigratedDatabase(options.db);
  const app: FastifyInstance = buildApp({ db, logger: { level: resolveLogLevel() } });

  // Assigned after `listen`, but the shutdown handler below closes over it and
  // is installed first, so a Ctrl+C during the advertisement still tears down
  // whatever exists by then.
  let advertisement: Advertisement | undefined;

  let closing = false;
  const shutdown = (signal: string): void => {
    // Two Ctrl+Cs in a row must not race two closes against the same handle.
    if (closing) return;
    closing = true;
    say();
    warn(`${signal} received, shutting down`);
    // Goodbye packets before the socket goes away, so teammates' resolvers stop
    // handing out a name that no longer answers. `stop` never rejects.
    void (advertisement?.stop() ?? Promise.resolve())
      .then(() => app.close())
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

  // Only once the socket is ours, for the same reason the admin token is only
  // issued below: advertising a port that failed to bind would point every
  // teammate on the network at nothing.
  //
  // Skipped when `--public-url` was given, because the operator has already
  // said where teammates should look and a second, different name would only
  // make the invite ambiguous. Skipped in VPS mode because multicast does not
  // leave the container it would be published from.
  if (options.mode === 'laptop' && explicit === undefined) {
    advertisement = await advertise({ port: options.port });
  }

  const publicUrl =
    options.mode === 'laptop' && explicit === undefined
      ? laptopPublicUrl(advertisement?.host, options.port)
      : explicit;

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

  // Written on every boot, like the public URL: an explicit flag is a decision
  // and a stored value is a previous one, and either way the database is where
  // evaluation reads it from.
  const zone = resolveTimeZoneChoice(getConfig(db, CONFIG_TIMEZONE), options.timezone);
  setConfig(db, CONFIG_TIMEZONE, zone.timezone, now);

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
    mdnsHost: advertisement?.host,
    databasePath,
    port: options.port,
    timezone: zone.timezone,
  });

  const admin = ensureAdminToken(db, { rotate: options.rotateAdminToken ?? false, now });
  if (admin.token !== undefined) {
    printAdminToken(admin.token, localUrl, admin.rotated);
  }
}
