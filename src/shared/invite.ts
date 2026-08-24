/**
 * The invite string: endpoint and join code in one base64url blob.
 *
 * A teammate is asked to paste one thing, once. Two things — a URL and a code —
 * is where the support burden starts, because half of them will paste the code
 * into the URL field. So both travel together, and decoding validates every
 * field before anything acts on it: the blob arrives on a teammate's command
 * line, and an endpoint taken on trust is an endpoint their telemetry goes to.
 */

import { normaliseJoinCode } from './joincode.js';
import type { InvitePayload } from './types.js';

/**
 * Ceiling on a blob before it is even decoded. A real invite is around 120
 * characters; anything past this is not a mistyped invite and does not deserve
 * a base64 pass over it.
 */
const MAX_BLOB_LENGTH = 4096;

/** Longest display name an invite may suggest; the same bound `/join` applies. */
export const MAX_DISPLAY_NAME_LENGTH = 64;

/** base64url is the URL-safe alphabet with no padding. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A decoded invite, or the reason it could not be used. */
export type InviteDecodeResult =
  | { readonly ok: true; readonly invite: InvitePayload }
  | { readonly ok: false; readonly error: string };

/** A plain JSON object. Arrays and `null` are not records. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The canonical endpoint form: an absolute `http`/`https` URL with no trailing
 * slash, no query and no fragment. `undefined` when the input is none of that.
 *
 * Only those two schemes: an invite naming `file:` or `javascript:` is not a
 * server, and stage 3 hands this value straight to a client that will fetch it.
 */
export function normaliseEndpoint(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.hostname === '') return undefined;
  url.search = '';
  url.hash = '';
  const text = url.toString();
  return text.endsWith('/') ? text.slice(0, -1) : text;
}

/**
 * A display name that is safe to print and store: trimmed, non-empty, bounded,
 * and free of control and formatting characters. `undefined` if it is not.
 *
 * Control characters are rejected rather than stripped: this value is echoed
 * back in CLI output and rendered on the dashboard, and a name carrying an
 * escape sequence or a bidi override is a name that can misrepresent the row
 * next to it.
 */
export function normaliseDisplayName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_DISPLAY_NAME_LENGTH) return undefined;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) return undefined;
  return trimmed;
}

/** Encodes an invite. The payload is validated first; an invalid one throws. */
export function encodeInvite(payload: InvitePayload): string {
  const endpoint = normaliseEndpoint(payload.endpoint);
  if (endpoint === undefined) {
    throw new Error(`invite endpoint is not an absolute http(s) URL: ${payload.endpoint}`);
  }
  const code = normaliseJoinCode(payload.code);
  if (code === undefined) {
    throw new Error('invite code is not a join code');
  }
  const name = payload.name === undefined ? undefined : normaliseDisplayName(payload.name);
  const body: InvitePayload = {
    v: 1,
    endpoint,
    code,
    ...(name !== undefined ? { name } : {}),
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/**
 * Decodes an invite. Never throws: every rejection is a message a teammate can
 * act on, because the most likely cause is a blob that lost a character on its
 * way through a chat client.
 */
export function decodeInvite(blob: string): InviteDecodeResult {
  const text = blob.trim();
  if (text === '') return { ok: false, error: 'invite string is empty' };
  if (text.length > MAX_BLOB_LENGTH) return { ok: false, error: 'invite string is too long' };
  if (!BASE64URL.test(text)) {
    return {
      ok: false,
      error: 'invite string is not base64url; it may have been truncated or reformatted in transit',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'invite string does not decode to an invite' };
  }
  if (!isRecordObject(parsed))
    return { ok: false, error: 'invite string does not decode to an invite' };
  if (parsed.v !== 1) {
    return { ok: false, error: 'invite was made by a different version of ccledger' };
  }

  const rawEndpoint = parsed.endpoint;
  if (typeof rawEndpoint !== 'string') return { ok: false, error: 'invite has no endpoint' };
  const endpoint = normaliseEndpoint(rawEndpoint);
  if (endpoint === undefined) {
    return { ok: false, error: 'invite endpoint is not an absolute http(s) URL' };
  }

  const rawCode = parsed.code;
  if (typeof rawCode !== 'string') return { ok: false, error: 'invite has no join code' };
  const code = normaliseJoinCode(rawCode);
  if (code === undefined) return { ok: false, error: 'invite join code is malformed' };

  const rawName = parsed.name;
  const name = typeof rawName === 'string' ? normaliseDisplayName(rawName) : undefined;

  return {
    ok: true,
    invite: { v: 1, endpoint, code, ...(name !== undefined ? { name } : {}) },
  };
}
