/**
 * Reading the token `ccledger serve` prints in the dashboard link.
 */

import { describe, expect, it } from 'vitest';

import { tokenFromHash } from './token.js';

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
