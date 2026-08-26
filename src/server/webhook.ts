/**
 * Webhook delivery: the one outbound request ccledger makes.
 *
 * Everything here is about giving up well. A fire has already been recorded by
 * the time this runs — that is what makes the debounce atomic — so delivery can
 * only ever add to what is known, never decide whether the alert happened. It
 * gets five seconds an attempt, two retries, and then the failure is written
 * down where the admin will see it.
 *
 * The retry rule is worth stating outright: a 4xx is not retried. An incoming
 * webhook answering 404 has been revoked, and 400 means the far end will never
 * accept this body — re-sending either is a request that cannot succeed, made
 * three times. Only the answers that mean "not now" — a timeout, a dropped
 * connection, 408, 429, any 5xx — are worth a second attempt.
 *
 * A webhook URL is a credential: anyone holding a Slack incoming-webhook URL
 * can post to that channel. Nothing in this file logs one, and the caller is
 * expected to log the rule id instead.
 */

import type { AlertWebhookPayload } from '../shared/alerts.js';
import {
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_ERROR_LIMIT,
  WEBHOOK_RETRIES,
  WEBHOOK_TIMEOUT_MS,
} from '../shared/constants.js';

/** How one delivery ended, whatever it took to get there. */
export interface WebhookResult {
  /** True only for a 2xx. */
  readonly ok: boolean;
  /** The status of the final attempt, or `null` if none ever answered. */
  readonly status: number | null;
  /** Attempts made, including the first. */
  readonly attempts: number;
  /** Why it failed, truncated to `WEBHOOK_ERROR_LIMIT`. Absent on success. */
  readonly error?: string;
}

/** The delivery function `evaluateAlerts` calls. Injectable so tests can watch it. */
export type WebhookDeliver = (url: string, payload: AlertWebhookPayload) => Promise<WebhookResult>;

/** The pieces of the runtime this module reaches for, so a test can replace them. */
export interface WebhookOptions {
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds one attempt may take. Defaults to `WEBHOOK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Attempts after the first. Defaults to `WEBHOOK_RETRIES`. */
  readonly retries?: number;
  /** Waits before each retry. Defaults to `WEBHOOK_BACKOFF_MS`. */
  readonly backoffMs?: readonly number[];
  /** Defaults to a real timer; a test passes one that resolves immediately. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Statuses that mean "not now" rather than "never". */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/** A real timer, as a promise. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Trims a failure reason to something a table cell can hold. */
export function truncateError(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length <= WEBHOOK_ERROR_LIMIT
    ? collapsed
    : `${collapsed.slice(0, WEBHOOK_ERROR_LIMIT - 1)}…`;
}

/** The message out of an unknown throw, without assuming it is an `Error`. */
function messageOf(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    // An aborted fetch throws a DOMException named TimeoutError, whose own
    // message is far less use to the admin reading it than the fact of the
    // timeout and how long it waited.
    return error.name === 'TimeoutError' || error.name === 'AbortError'
      ? `no response within ${String(timeoutMs)}ms`
      : error.message;
  }
  return String(error);
}

/** True when a status is worth another attempt. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}

/**
 * The far end's own words about a rejection, as far as they fit.
 *
 * Included on purpose, unlike everywhere else in this server: the response
 * comes from an endpoint this instance's admin configured and is shown only to
 * that admin, and `invalid_payload` is precisely the sentence that turns a
 * broken Slack URL into a fixed one. Reading it can fail — a body already
 * consumed, a socket that closed — which is not itself a failure worth
 * reporting, so it degrades to the status alone.
 */
async function describeRejection(response: Response): Promise<string> {
  const status = `HTTP ${String(response.status)}`;
  try {
    const body = (await response.text()).trim();
    return body === '' ? status : `${status}: ${body}`;
  } catch {
    return status;
  }
}

/**
 * Posts one payload, retrying the failures that are worth retrying.
 *
 * Never throws. Every outcome — a refusal, a timeout, a DNS failure, a body
 * that could not be read — comes back as a `WebhookResult`, because the caller
 * is on the ingest path and has an exporter waiting on a 200.
 */
export async function deliverWebhook(
  url: string,
  payload: AlertWebhookPayload,
  options: WebhookOptions = {},
): Promise<WebhookResult> {
  const send = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const retries = options.retries ?? WEBHOOK_RETRIES;
  const backoff = options.backoffMs ?? WEBHOOK_BACKOFF_MS;
  const sleep = options.sleep ?? wait;
  const body = JSON.stringify(payload);

  let lastStatus: number | null = null;
  let lastError = 'webhook was never attempted';
  let made = 0;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    made = attempt;
    let retryable: boolean;
    try {
      const response = await send(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Named so an admin reading their endpoint's logs can tell what this
          // traffic is without correlating timestamps.
          'user-agent': 'ccledger',
        },
        body,
        // `AbortSignal.timeout` rather than a controller and a timer: it cancels
        // itself, so an attempt that succeeds leaves no pending handle behind
        // to keep the process alive.
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });

      lastStatus = response.status;
      if (response.ok) {
        return { ok: true, status: response.status, attempts: attempt };
      }
      lastError = await describeRejection(response);
      retryable = isRetryableStatus(response.status);
    } catch (error) {
      // A timeout, a refused connection, a name that does not resolve. No
      // status, and always worth another attempt.
      lastStatus = null;
      lastError = messageOf(error, timeoutMs);
      retryable = true;
    }

    if (!retryable || attempt > retries) break;
    await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0);
  }

  return { ok: false, status: lastStatus, attempts: made, error: truncateError(lastError) };
}
