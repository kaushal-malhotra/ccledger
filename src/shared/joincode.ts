/**
 * Join-code format: generating one, and recognising one someone typed.
 *
 * The code is the fallback path for when the invite blob will not survive the
 * channel it is sent over — read aloud, written on a whiteboard, retyped from a
 * phone. That is the whole reason for the shape: three groups of four, from an
 * alphabet with no character that can be confused for another. Everything here
 * is pure; the table that decides whether a given code is still claimable lives
 * in `src/db/joincodes.ts`.
 */

import { randomInt } from 'node:crypto';

import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_GROUPS,
  JOIN_CODE_GROUP_LENGTH,
  JOIN_CODE_SEPARATOR,
} from './constants.js';

/** Characters in a code, separators excluded. */
export const JOIN_CODE_LENGTH = JOIN_CODE_GROUPS * JOIN_CODE_GROUP_LENGTH;

/** Everything a normaliser throws away before looking at the characters. */
const SEPARATORS = /[\s._-]+/g;

/** Inserts the group separators into an already-validated run of characters. */
function group(characters: string): string {
  const groups: string[] = [];
  for (let i = 0; i < characters.length; i += JOIN_CODE_GROUP_LENGTH) {
    groups.push(characters.slice(i, i + JOIN_CODE_GROUP_LENGTH));
  }
  return groups.join(JOIN_CODE_SEPARATOR);
}

/**
 * A fresh join code in canonical form, e.g. `H4KM-9TQZ-BXD3`.
 *
 * `randomInt` rather than `randomBytes` and a modulo: the alphabet is 31
 * characters, which does not divide 256, so reducing a random byte would make
 * the first nine characters measurably likelier than the rest. `randomInt`
 * rejection-samples for us.
 */
export function generateJoinCode(): string {
  let characters = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) {
    characters += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  }
  return group(characters);
}

/**
 * The canonical form of a code someone typed, or `undefined` if it is not one.
 *
 * Forgiving about everything that is presentation — case, spaces, hyphens,
 * underscores, dots — and unforgiving about the characters themselves. There is
 * nothing to be forgiving about there: `0`, `O`, `1`, `I` and `L` are all
 * absent from the alphabet, so a code containing one was mistyped from a
 * character that is not any of them, and guessing which would be an invitation
 * to accept the wrong code.
 */
export function normaliseJoinCode(raw: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const characters = raw.trim().replace(SEPARATORS, '').toUpperCase();
  if (characters.length !== JOIN_CODE_LENGTH) return undefined;
  for (const character of characters) {
    if (!JOIN_CODE_ALPHABET.includes(character)) return undefined;
  }
  return group(characters);
}
