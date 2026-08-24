/**
 * Join-code format.
 *
 * The code exists to survive a channel the invite blob will not: read aloud,
 * written down, retyped. So the two things worth testing are that it never
 * contains a character someone can mistake for another, and that it is
 * recognised however the person retyping it decided to space and case it.
 */

import { describe, expect, it } from 'vitest';

import { JOIN_CODE_ALPHABET, JOIN_CODE_GROUPS, JOIN_CODE_GROUP_LENGTH } from './constants.js';
import { JOIN_CODE_LENGTH, generateJoinCode, normaliseJoinCode } from './joincode.js';

/** Characters the alphabet exists to exclude, per the stage 2 brief. */
const CONFUSABLE = ['0', 'O', '1', 'I', 'L'];

/** The canonical shape: three groups of four, hyphen separated. */
const CANONICAL = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

describe('the alphabet', () => {
  it('is uppercase alphanumerics with every confusable character removed', () => {
    for (const character of CONFUSABLE) {
      expect(JOIN_CODE_ALPHABET).not.toContain(character);
    }
    expect(JOIN_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
    // 36 alphanumerics less the five above.
    expect(JOIN_CODE_ALPHABET).toHaveLength(31);
    expect(new Set(JOIN_CODE_ALPHABET).size).toBe(JOIN_CODE_ALPHABET.length);
  });

  it('carries enough entropy that guessing is not a threat model', () => {
    const bits = JOIN_CODE_LENGTH * Math.log2(JOIN_CODE_ALPHABET.length);

    expect(JOIN_CODE_LENGTH).toBe(JOIN_CODE_GROUPS * JOIN_CODE_GROUP_LENGTH);
    expect(bits).toBeGreaterThan(55);
  });
});

describe('generateJoinCode', () => {
  it('produces the canonical three-by-four shape', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateJoinCode()).toMatch(CANONICAL);
    }
  });

  it('draws only from the alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      for (const character of generateJoinCode().replaceAll('-', '')) {
        expect(JOIN_CODE_ALPHABET).toContain(character);
      }
    }
  });

  it('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateJoinCode()));

    expect(codes.size).toBe(500);
  });

  it('spreads across the alphabet rather than favouring the low characters', () => {
    // What a `randomBytes % 31` would get wrong: 256 is not a multiple of 31,
    // so the first nine characters would come up about a third more often. Over
    // this many draws that bias is far outside the noise.
    const seen = new Map<string, number>();
    const draws = 20_000;
    for (let i = 0; i < draws / JOIN_CODE_LENGTH; i += 1) {
      for (const character of generateJoinCode().replaceAll('-', '')) {
        seen.set(character, (seen.get(character) ?? 0) + 1);
      }
    }

    expect(seen.size).toBe(JOIN_CODE_ALPHABET.length);
    const expected = draws / JOIN_CODE_ALPHABET.length;
    for (const [character, count] of seen) {
      expect({ character, ratio: count / expected > 0.7 && count / expected < 1.3 }).toEqual({
        character,
        ratio: true,
      });
    }
  });
});

describe('normaliseJoinCode', () => {
  it('round-trips a generated code unchanged', () => {
    const code = generateJoinCode();

    expect(normaliseJoinCode(code)).toBe(code);
  });

  it('forgives everything about how it was written down', () => {
    const code = generateJoinCode();
    const bare = code.replaceAll('-', '');

    for (const written of [
      bare,
      bare.toLowerCase(),
      code.toLowerCase(),
      `  ${code}  `,
      bare.replace(/(.{4})/g, '$1 ').trim(),
      bare.replace(/(.{4})(?!$)/g, '$1.'),
      bare.replace(/(.{4})(?!$)/g, '$1_'),
    ]) {
      expect({ written, normalised: normaliseJoinCode(written) }).toEqual({
        written,
        normalised: code,
      });
    }
  });

  it.each([
    ['empty', ''],
    ['too short', 'ABCD-EFGH'],
    ['too long', 'ABCD-EFGH-JKMN-PQRS'],
    ['contains a zero', '0BCD-EFGH-JKMN'],
    ['contains an O', 'OBCD-EFGH-JKMN'],
    ['contains a one', '1BCD-EFGH-JKMN'],
    ['contains an I', 'IBCD-EFGH-JKMN'],
    ['contains an L', 'LBCD-EFGH-JKMN'],
    ['contains punctuation', 'AB!D-EFGH-JKMN'],
    ['is a sentence', 'the code is ABCD-EFGH-JKMN'],
  ])('rejects a code that is %s', (_label, written) => {
    expect(normaliseJoinCode(written)).toBeUndefined();
  });

  it('does not guess which character a confusable was meant to be', () => {
    // `0` and `O` are both absent from the alphabet, so there is no partner to
    // map either onto. Accepting one would mean accepting a code nobody issued.
    expect(normaliseJoinCode('23450BCD-EFGH')).toBeUndefined();
  });
});
