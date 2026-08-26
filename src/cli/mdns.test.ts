/**
 * mDNS advertisement tests.
 *
 * The responder is injected rather than real, because a test that opened UDP
 * 5353 would be testing the CI runner's network stack: multicast is unavailable
 * in most containers, and where it is available the port is shared with every
 * other job on the box. What matters here is not that packets leave the
 * machine — that is `bonjour-service`'s problem — but that every way of failing
 * to advertise ends as `undefined` rather than as a thrown error, because the
 * caller has a listening server either way and must not be stopped by this.
 */

import { describe, expect, it } from 'vitest';

import type { MdnsResponder, PublishedService, ResponderFactory } from './mdns.js';
import { MDNS_HOSTNAME, MDNS_SERVICE_NAME, MDNS_SERVICE_TYPE, advertise } from './mdns.js';

/** One `publish` call, as the fake recorded it. */
interface PublishedConfig {
  readonly name: string;
  readonly type: string;
  readonly port: number;
  readonly host: string;
  readonly txt: Readonly<Record<string, string>>;
}

/** A responder that records what it was asked to do and announces on command. */
class FakeResponder implements MdnsResponder {
  readonly published: PublishedConfig[] = [];
  unpublishedAll = false;
  destroyed = 0;
  private listener: (() => void) | undefined;

  constructor(private readonly announce: 'immediately' | 'never') {}

  publish(config: PublishedConfig): PublishedService {
    this.published.push(config);
    return {
      on: (event: 'up', listener: () => void) => {
        if (event === 'up') this.listener = listener;
        // Announced on a later tick, as a real responder does: the caller has
        // to subscribe before the event can arrive.
        if (this.announce === 'immediately') queueMicrotask(() => this.listener?.());
        return this;
      },
    };
  }

  unpublishAll(callback: () => void): void {
    this.unpublishedAll = true;
    callback();
  }

  destroy(callback?: () => void): void {
    this.destroyed += 1;
    callback?.();
  }
}

/** A factory over one fake, plus a handle on the error callback it was given. */
function factoryFor(responder: MdnsResponder): {
  readonly create: ResponderFactory;
  fail: (error: Error) => void;
} {
  let report: (error: Error) => void = () => undefined;
  return {
    create: (onError) => {
      report = onError;
      return responder;
    },
    fail: (error) => {
      report(error);
    },
  };
}

describe('advertise', () => {
  it('publishes ccledger.local for the listening port and resolves once it is up', async () => {
    const responder = new FakeResponder('immediately');
    const advertisement = await advertise({
      port: 4318,
      createResponder: factoryFor(responder).create,
    });

    expect(advertisement?.host).toBe(MDNS_HOSTNAME);
    expect(responder.published).toHaveLength(1);
    expect(responder.published[0]).toMatchObject({
      name: MDNS_SERVICE_NAME,
      type: MDNS_SERVICE_TYPE,
      port: 4318,
      // The A record and the SRV target both take this value, which is the
      // whole reason the name is set explicitly instead of left to the
      // machine's own hostname.
      host: MDNS_HOSTNAME,
    });
    expect(responder.published[0]?.txt.path).toBe('/');
    // Nothing was torn down on the way to a working advertisement.
    expect(responder.destroyed).toBe(0);
  });

  it('sends goodbye packets before closing the socket on stop', async () => {
    const responder = new FakeResponder('immediately');
    const advertisement = await advertise({
      port: 4318,
      createResponder: factoryFor(responder).create,
    });

    await advertisement?.stop();

    // Order matters: a socket closed first would have nothing left to send the
    // goodbye on, and the name would sit in teammates' caches for its full TTL.
    expect(responder.unpublishedAll).toBe(true);
    expect(responder.destroyed).toBe(1);
  });

  it('gives up when the responder never announces, and closes its socket', async () => {
    // How a name conflict actually presents: `bonjour-service` logs the clash
    // and simply stops, so there is no event and no error to wait for.
    const responder = new FakeResponder('never');
    const advertisement = await advertise({
      port: 4318,
      createResponder: factoryFor(responder).create,
      timeoutMs: 5,
    });

    expect(advertisement).toBeUndefined();
    expect(responder.destroyed).toBe(1);
  });

  it('gives up when the responder reports an error instead of coming up', async () => {
    const responder = new FakeResponder('never');
    const factory = factoryFor(responder);
    const pending = advertise({
      port: 4318,
      createResponder: (onError) => {
        const created = factory.create(onError);
        // A socket that cannot bind: raised after construction returns, which
        // is why the factory takes a callback rather than throwing.
        queueMicrotask(() => {
          factory.fail(new Error('EADDRINUSE 0.0.0.0:5353'));
        });
        return created;
      },
      timeoutMs: 60_000,
    });

    expect(await pending).toBeUndefined();
    expect(responder.destroyed).toBe(1);
  });

  it('gives up when constructing the responder throws', async () => {
    const advertisement = await advertise({
      port: 4318,
      createResponder: () => {
        throw new Error('no multicast route');
      },
    });

    expect(advertisement).toBeUndefined();
  });

  it('ignores a responder error that arrives after it is already up', async () => {
    const responder = new FakeResponder('immediately');
    const factory = factoryFor(responder);
    const advertisement = await advertise({ port: 4318, createResponder: factory.create });
    expect(advertisement?.host).toBe(MDNS_HOSTNAME);

    // A late error must not retract an advertisement the caller has already
    // printed, and must not close a socket `stop` is still responsible for.
    factory.fail(new Error('interface went away'));
    expect(responder.destroyed).toBe(0);

    await advertisement?.stop();
    expect(responder.destroyed).toBe(1);
  });
});
