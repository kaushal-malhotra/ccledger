/**
 * The invite string.
 *
 * This blob arrives on a teammate's command line and tells stage 3 where to
 * send their telemetry, so decoding is a trust boundary rather than a parsing
 * convenience. Most of the file is therefore about what `decodeInvite` refuses:
 * a scheme that is not HTTP, credentials smuggled into the authority, a code
 * that is not a code, and blobs mangled by whatever chat client carried them.
 */

import { describe, expect, it } from 'vitest';

import { decodeInvite, encodeInvite, normaliseDisplayName, normaliseEndpoint } from './invite.js';
import { generateJoinCode } from './joincode.js';
import type { InvitePayload } from './types.js';

/** A valid payload, with only the named field replaced. */
function invite(overrides: Partial<InvitePayload> = {}): InvitePayload {
  return {
    v: 1,
    endpoint: 'https://meter.example.com',
    code: generateJoinCode(),
    name: 'Alice',
    ...overrides,
  };
}

/** Re-encodes an arbitrary object the way `encodeInvite` would, bypassing its checks. */
function blobOf(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('normaliseEndpoint', () => {
  it('accepts absolute http and https URLs and strips a trailing slash', () => {
    expect(normaliseEndpoint('https://meter.example.com/')).toBe('https://meter.example.com');
    expect(normaliseEndpoint('http://desk-01.local:4318')).toBe('http://desk-01.local:4318');
    expect(normaliseEndpoint('  https://meter.example.com  ')).toBe('https://meter.example.com');
  });

  it('keeps a path prefix, which is how a reverse proxy subpath survives', () => {
    expect(normaliseEndpoint('https://example.com/ccledger/')).toBe('https://example.com/ccledger');
  });

  it('drops a query string and fragment rather than carrying them into a POST', () => {
    expect(normaliseEndpoint('https://example.com/?a=1#b')).toBe('https://example.com');
  });

  it.each([
    ['a relative path', '/v1/logs'],
    ['a bare hostname', 'meter.example.com'],
    ['a file URL', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/plain,hello'],
    ['embedded credentials', 'https://user:pass@example.com'],
    ['nothing', ''],
    ['a sentence', 'ask alice for the url'],
  ])('rejects %s', (_label, raw) => {
    expect(normaliseEndpoint(raw)).toBeUndefined();
  });
});

describe('normaliseDisplayName', () => {
  it('trims and keeps ordinary names, including non-Latin ones', () => {
    expect(normaliseDisplayName('  Alice  ')).toBe('Alice');
    expect(normaliseDisplayName('Rahim Chowdhury')).toBe('Rahim Chowdhury');
    expect(normaliseDisplayName('宮本')).toBe('宮本');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'x'.repeat(65)],
    ['carrying a newline', 'Alice\nBob'],
    ['carrying an ANSI escape', '[31mAlice'],
    ['carrying a bidi override', 'Alice‮eciLA'],
    ['carrying a zero-width joiner', 'Al‍ice'],
  ])('rejects a name that is %s', (_label, raw) => {
    expect(normaliseDisplayName(raw)).toBeUndefined();
  });
});

describe('encodeInvite and decodeInvite', () => {
  it('round-trips every field', () => {
    const payload = invite();

    const decoded = decodeInvite(encodeInvite(payload));

    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.invite).toEqual(payload);
  });

  it('produces one base64url token with nothing to trip a chat client', () => {
    const blob = encodeInvite(invite());

    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(blob).not.toContain('=');
  });

  it('normalises the endpoint as it encodes, so the blob carries one form', () => {
    const blob = encodeInvite(invite({ endpoint: 'https://meter.example.com/' }));

    expect(decodeInvite(blob).ok && decodeInvite(blob)).toMatchObject({
      invite: { endpoint: 'https://meter.example.com' },
    });
  });

  it('survives a name being absent', () => {
    const { name: _name, ...withoutName } = invite();

    const decoded = decodeInvite(encodeInvite(withoutName as InvitePayload));

    expect(decoded.ok && 'name' in decoded.invite).toBe(false);
  });

  it('refuses to encode a payload it could not decode', () => {
    expect(() => encodeInvite(invite({ endpoint: 'not a url' }))).toThrow(/endpoint/);
    expect(() => encodeInvite(invite({ code: 'NOPE' }))).toThrow(/code/);
  });
});

describe('decodeInvite refuses', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['characters base64url does not use', 'abc!def'],
    ['a blob that decodes to nothing useful', blobOf('hello')],
    ['a blob that decodes to an array', blobOf([1, 2, 3])],
    ['a blob that decodes to null', blobOf(null)],
    ['an object with no endpoint', blobOf({ v: 1, code: 'ABCD-EFGH-JKMN' })],
    ['an object with no code', blobOf({ v: 1, endpoint: 'https://example.com' })],
    ['a future version', blobOf({ v: 2, endpoint: 'https://example.com', code: 'A' })],
    ['a version that is a string', blobOf({ v: '1', endpoint: 'https://example.com', code: 'A' })],
  ])('%s', (_label, blob) => {
    const decoded = decodeInvite(blob);

    expect(decoded.ok).toBe(false);
    expect(!decoded.ok && decoded.error).toBeTruthy();
  });

  it('a truncated blob, with a message that says what probably happened', () => {
    const blob = encodeInvite(invite());

    const decoded = decodeInvite(blob.slice(0, blob.length - 4));

    expect(decoded.ok).toBe(false);
    expect(!decoded.ok && decoded.error).toMatch(/invite/);
  });

  it('an endpoint that is not http, however well formed the rest is', () => {
    const decoded = decodeInvite(
      blobOf({ v: 1, endpoint: 'file:///etc/passwd', code: generateJoinCode() }),
    );

    expect(decoded.ok).toBe(false);
    expect(!decoded.ok && decoded.error).toMatch(/http/);
  });

  it('a blob far larger than an invite, before spending a base64 pass on it', () => {
    const decoded = decodeInvite('A'.repeat(10_000));

    expect(decoded.ok).toBe(false);
    expect(!decoded.ok && decoded.error).toMatch(/too long/);
  });

  it('but tolerates a name it cannot use, rather than losing the whole invite', () => {
    const code = generateJoinCode();

    const decoded = decodeInvite(
      blobOf({ v: 1, endpoint: 'https://example.com', code, name: 'x'.repeat(200) }),
    );

    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.invite).toEqual({ v: 1, endpoint: 'https://example.com', code });
  });
});
