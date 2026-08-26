/**
 * Advertising a laptop-mode server as `ccledger.local` over mDNS.
 *
 * Laptop mode exists so a small team can point Claude Code at somebody's
 * machine without anyone provisioning a server, and the part of that which
 * actually costs an admin time is telling four teammates an IP address that
 * changes when they move rooms. A multicast DNS advertisement replaces it with
 * one name that every teammate can use and nobody has to be told twice.
 *
 * Two things about it are deliberate. The name is `ccledger.local` rather than
 * this machine's own hostname, because the invite carrying it should not have
 * to be reissued when the server moves to a different laptop. And the whole
 * thing is best-effort: mDNS needs UDP 5353 and a multicast route, and both are
 * routinely missing — inside a container, on a locked-down corporate network,
 * on a VPN, or where another responder already holds the port. None of that is
 * a reason to refuse to serve, so every failure here resolves to `undefined`
 * and the caller falls back to a LAN address that needs no resolver at all.
 */

import { VERSION } from '../shared/version.js';

/** The service instance name. Also what appears in a service browser. */
export const MDNS_SERVICE_NAME = 'ccledger';

/** The hostname advertised, and the SRV target teammates resolve. */
export const MDNS_HOSTNAME = 'ccledger.local';

/** Registered service type for HTTP, so the ordinary browsers find it. */
export const MDNS_SERVICE_TYPE = 'http';

/**
 * How long to wait for the first announcement before giving up on mDNS.
 *
 * The wait exists because a responder that will never work usually fails by
 * going quiet rather than by throwing: the socket binds, the packet goes
 * nowhere, and no error is ever raised. It is not instant even when it does
 * work — the library probes for a conflicting `ccledger` on the network before
 * it announces, which measured just under a second on a healthy LAN — so this
 * is set several times that. The cost of being wrong is asymmetric: too short
 * and a working advertisement is thrown away in favour of a LAN address, too
 * long and one startup pauses a few seconds before printing its banner.
 */
export const MDNS_PUBLISH_TIMEOUT_MS = 4000;

/** The part of a published service this module uses. */
export interface PublishedService {
  /** Emitted once the first announcement is on the wire. */
  on(event: 'up', listener: () => void): unknown;
}

/** The part of an mDNS responder this module uses. */
export interface MdnsResponder {
  publish(config: {
    readonly name: string;
    readonly type: string;
    readonly port: number;
    readonly host: string;
    readonly txt: Readonly<Record<string, string>>;
  }): PublishedService;
  /** Sends goodbye packets for everything published, then calls back. */
  unpublishAll(callback: () => void): void;
  /** Closes the socket. */
  destroy(callback?: () => void): void;
}

/**
 * Makes a responder, reporting failures that arrive after construction — a
 * socket that cannot bind, a network that drops multicast — to `onError`.
 * Injectable so the tests never open UDP 5353, which on a CI runner is either
 * unavailable or shared with every other job on the box.
 */
export type ResponderFactory = (onError: (error: Error) => void) => MdnsResponder;

/** A live advertisement. `stop` is idempotent and never rejects. */
export interface Advertisement {
  /** The advertised hostname, `ccledger.local`. */
  readonly host: string;
  /** Withdraws the advertisement, so stale names do not linger in caches. */
  stop(): Promise<void>;
}

/** What `advertise` needs. */
export interface AdvertiseOptions {
  /** The port teammates should reach, already listening. */
  readonly port: number;
  /** Overridden by tests. Defaults to `bonjour-service`. */
  readonly createResponder?: ResponderFactory;
  /** Overridden by tests. Defaults to {@link MDNS_PUBLISH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Loads `bonjour-service` and constructs a responder from it.
 *
 * Imported here rather than at the top of the file so that VPS mode, which
 * never advertises, never loads it — and so that an install whose optional
 * native pieces did not build degrades to "no mDNS" instead of a boot failure.
 */
async function defaultResponderFactory(): Promise<ResponderFactory> {
  const module = await import('bonjour-service');
  const Bonjour = module.default;
  return (onError) => new Bonjour(undefined, onError) as unknown as MdnsResponder;
}

/**
 * Publishes `ccledger.local` for a server already listening on `port`, or
 * resolves `undefined` when mDNS is not available on this machine.
 *
 * Never rejects. The caller has a running server either way, and losing name
 * resolution is a smaller problem than a server that refuses to start.
 */
export async function advertise(options: AdvertiseOptions): Promise<Advertisement | undefined> {
  let factory: ResponderFactory;
  try {
    factory = options.createResponder ?? (await defaultResponderFactory());
  } catch {
    return undefined;
  }

  const timeoutMs = options.timeoutMs ?? MDNS_PUBLISH_TIMEOUT_MS;

  return await new Promise<Advertisement | undefined>((resolve) => {
    let settled = false;
    let responder: MdnsResponder | undefined;

    // Started before the responder is constructed, so the wait also covers a
    // library that hangs on the way up rather than after it. `settle` is a
    // function declaration rather than an arrow so that the two can refer to
    // each other without either being assigned after the fact.
    //
    // The quiet failure this exists for: `bonjour-service` logs a conflicting
    // service name and simply never announces, so there is no event and no
    // error to wait on.
    const timer = setTimeout(() => {
      settle(undefined);
    }, timeoutMs);
    // Nothing should keep the process alive for an advertisement that has not
    // happened yet.
    timer.unref?.();

    /** Resolves once, clears the timer, and tears the responder down on failure. */
    function settle(advertisement: Advertisement | undefined): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (advertisement === undefined && responder !== undefined) {
        // A responder that never announced still holds a socket.
        try {
          responder.destroy();
        } catch {
          // Already torn down, or never fully constructed. Either way there is
          // nothing left to do and nothing worth telling the operator.
        }
      }
      resolve(advertisement);
    }

    try {
      responder = factory((_error) => {
        // A responder error is a failure to advertise, not a failure to serve.
        // Arriving after a successful announcement it is nothing to act on
        // either, because `settle` has already run and ignores this.
        settle(undefined);
      });

      const service = responder.publish({
        name: MDNS_SERVICE_NAME,
        type: MDNS_SERVICE_TYPE,
        port: options.port,
        host: MDNS_HOSTNAME,
        // Read by service browsers, not by ccledger. `path` is the convention
        // for `_http._tcp`, and the version answers "what is this?" without
        // anyone having to open it.
        txt: { path: '/', version: VERSION },
      });

      const live = responder;
      service.on('up', () => {
        settle({
          host: MDNS_HOSTNAME,
          stop: () =>
            new Promise<void>((done) => {
              // Goodbye packets first, so a teammate's resolver drops the name
              // now rather than at the end of a 120-second TTL.
              try {
                live.unpublishAll(() => {
                  try {
                    live.destroy(() => {
                      done();
                    });
                  } catch {
                    done();
                  }
                });
              } catch {
                done();
              }
            }),
        });
      });
    } catch {
      // A synchronous throw from the library: treat it like any other absence.
      settle(undefined);
    }
  });
}
