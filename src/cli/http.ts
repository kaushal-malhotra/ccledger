/**
 * The client commands' half of the HTTP conversation.
 *
 * Three commands talk to the server and all three are talking to a teammate's
 * own laptop, a box on the office LAN, or a domain behind a proxy — so the
 * failures are the boring network ones, and the difference between "nothing is
 * listening on that port" and "that name does not resolve" is the difference
 * between a fixed setup and a support thread. `fetch` reports both as
 * `TypeError: fetch failed`, so this module unwraps the cause and says which.
 *
 * Every request carries a timeout. A teammate running `ccledger doctor` on a
 * VPN that is half up should get an answer in five seconds, not a hung terminal.
 */

import { VERSION } from '../shared/version.js';

/** How long any one request may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Ceiling on a response body kept in memory. Ours are a few hundred bytes; a
 * captive portal or a misdirected proxy can answer with a whole web page.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** What came back. */
export interface HttpResponse {
  readonly status: number;
  /** True for 2xx. */
  readonly ok: boolean;
  /** The body as text, truncated at 64 KiB. */
  readonly body: string;
  /** Round trip in milliseconds, for a `doctor` line that says how slow it was. */
  readonly durationMs: number;
}

/** A response, or a finished sentence about why there was not one. */
export type HttpResult =
  | { readonly ok: true; readonly response: HttpResponse }
  | { readonly ok: false; readonly error: string };

/** Options for one request. */
export interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as `application/json` when present. */
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** A plain object. Used only to read `code` off an error cause. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `errno`-style code buried in a `fetch` failure, e.g. `ECONNREFUSED`. */
function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecordObject(current); depth += 1) {
    const code: unknown = current.code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}

/** Turns a transport failure into something a teammate can act on. */
function describeFailure(error: unknown, url: string, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `${url} did not answer within ${String(timeoutMs)} ms`;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return `the request to ${url} was cancelled`;
  }
  switch (causeCode(error)) {
    case 'ECONNREFUSED':
      return `nothing is listening at ${url}; is the ccledger server running?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `the host in ${url} does not resolve from this machine`;
    case 'ECONNRESET':
      return `the connection to ${url} was reset`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${url} is not reachable from this network`;
    case 'ETIMEDOUT':
      return `the connection to ${url} timed out`;
    case 'CERT_HAS_EXPIRED':
      return `the TLS certificate for ${url} has expired`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `the TLS certificate for ${url} is self-signed and this machine does not trust it`;
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `the TLS certificate for ${url} could not be verified`;
    default:
      return `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Makes one request. Never throws: a transport failure comes back as a sentence. */
export async function request(url: string, options: RequestOptions): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': `ccledger/${VERSION}`,
    ...options.headers,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return {
      ok: true,
      response: {
        status: response.status,
        ok: response.ok,
        body: text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    return { ok: false, error: describeFailure(error, url, timeoutMs) };
  }
}

/**
 * The `error` field of a ccledger error body, or a trimmed excerpt of whatever
 * did come back. Bounded, because the body may be someone else's HTML.
 */
export function errorTextOf(body: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecordObject(parsed) && typeof parsed.error === 'string' && parsed.error !== '') {
      return parsed.error;
    }
  } catch {
    // Not JSON. The excerpt below is the best that can be said about it.
  }
  const excerpt = body.trim().replace(/\s+/g, ' ').slice(0, 120);
  return excerpt === '' ? fallback : `${fallback} (${excerpt})`;
}
