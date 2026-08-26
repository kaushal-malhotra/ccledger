/**
 * Reading the token `ccledger serve` prints in the dashboard link, and deciding
 * how long it is kept afterwards.
 */

import { describe, expect, it } from 'vitest';

import type { TokenStore, TokenStores } from './token.js';
import { forgetToken, isRemembered, rememberToken, storedToken, tokenFromHash } from './token.js';

/** A `Storage` that lives in a Map, which is all this module asks of one. */
function fakeStore(): TokenStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** A store that throws on every access, the way a blocked browser does. */
function hostileStore(): TokenStore {
  return {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
}

/** Both tiers, backed by maps. */
function fakeStores(): TokenStores {
  return { session: fakeStore(), durable: fakeStore() };
}

describe('tokenFromHash', () => {
  it('reads the fragment serve prints', () => {
    expect(tokenFromHash('#token=cca_AbCd0123456789_-XyZabcdefgh')).toBe(
      'cca_AbCd0123456789_-XyZabcdefgh',
    );
  });

  it('finds the token among other fragment parameters', () => {
    expect(tokenFromHash('#view=members&token=cca_one&range=7d')).toBe('cca_one');
  });

  it('decodes a percent-encoded value', () => {
    expect(tokenFromHash('#token=cca_a%2Bb')).toBe('cca_a+b');
  });

  it('returns nothing for a fragment that carries no token', () => {
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#')).toBeNull();
    expect(tokenFromHash('#view=members')).toBeNull();
    expect(tokenFromHash('#token=')).toBeNull();
  });
});

describe('token storage', () => {
  it('keeps a token for the tab so a reload does not ask again', () => {
    const stores = fakeStores();
    rememberToken('cca_one', false, stores);

    expect(storedToken(stores)).toBe('cca_one');
    // Not remembered: closing the browser has to lose it.
    expect(isRemembered(stores)).toBe(false);
  });

  it('keeps it on the device only when asked', () => {
    const stores = fakeStores();
    rememberToken('cca_one', true, stores);

    expect(isRemembered(stores)).toBe(true);
    // A new tab has an empty session store and should still find it.
    expect(storedToken({ session: fakeStore(), durable: stores.durable })).toBe('cca_one');
  });

  it('unticking remember takes the durable copy away', () => {
    const stores = fakeStores();
    rememberToken('cca_one', true, stores);
    rememberToken('cca_one', false, stores);

    expect(isRemembered(stores)).toBe(false);
    expect(storedToken({ session: fakeStore(), durable: stores.durable })).toBeNull();
  });

  it('forgetting erases both tiers, which is what Lock has to mean', () => {
    const stores = fakeStores();
    rememberToken('cca_one', true, stores);
    forgetToken(stores);

    expect(storedToken(stores)).toBeNull();
    expect(isRemembered(stores)).toBe(false);
  });

  it('prefers the tab copy, so locking one tab does not read around itself', () => {
    const stores = fakeStores();
    rememberToken('cca_durable', true, stores);
    stores.session?.setItem('ccledger.admin-token', 'cca_session');

    expect(storedToken(stores)).toBe('cca_session');
  });

  it('survives a browser that refuses storage entirely', () => {
    const blocked: TokenStores = { session: hostileStore(), durable: hostileStore() };

    // None of these may throw: a dashboard that cannot remember a token still
    // has to open.
    expect(() => {
      rememberToken('cca_one', true, blocked);
    }).not.toThrow();
    expect(storedToken(blocked)).toBeNull();
    expect(isRemembered(blocked)).toBe(false);
    expect(() => {
      forgetToken(blocked);
    }).not.toThrow();
  });

  it('survives a browser with no storage objects at all', () => {
    const absent: TokenStores = { session: undefined, durable: undefined };

    expect(storedToken(absent)).toBeNull();
    expect(() => {
      rememberToken('cca_one', true, absent);
    }).not.toThrow();
  });
});
