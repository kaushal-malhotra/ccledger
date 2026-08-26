/**
 * Webhook delivery, against a stubbed `fetch`.
 *
 * Nothing here opens a socket. What is being tested is the giving-up policy —
 * how many attempts, which failures earn another one, and what ends up in the
 * `delivery_error` an admin will read — and every one of those is a decision
 * this module makes before any I/O happens.
 */

import { describe, expect, it } from 'vitest';

import { deliverWebhook, truncateError } from './webhook.js';
import { WEBHOOK_ERROR_LIMIT } from '../shared/constants.js';
import type { AlertWebhookPayload } from '../shared/alerts.js';

/** A payload shaped like the real one; only its JSON matters here. */
const PAYLOAD: AlertWebhookPayload = {
  text: 'Rahim is at 52.3% of this week.',
  content: 'Rahim is at 52.3% of this week.',
  event: 'alert.fired',
  rule_id: 'ar_1',
  member_id: 'm_1',
  member_name: 'Rahim',
  metric: 'share_pct',
  window: 'week',
  threshold: 50,
  value: 52.3,
  window_start: '2026-08-24T00:00:00.000Z',
  window_end: '2026-08-31T00:00:00.000Z',
  timezone: 'UTC',
  fired_at: '2026-08-26T09:00:00.000Z',
  usage: { total_tokens: 5230, cost_usd: 1.2, share_pct: 52.3, period_total_tokens: 10_000 },
};

/** What one stubbed call recorded. */
interface Call {
  readonly url: string;
  readonly body: string;
  readonly method: string;
  readonly contentType: string | undefined;
}

/** A `fetch` that answers from a script and records what it was asked. */
function stubFetch(script: readonly (number | Error)[]): {
  readonly fetchImpl: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = ((url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      body: String(init.body),
      method: init.method ?? 'GET',
      contentType: headers.get('content-type') ?? undefined,
    });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    const status = next ?? 200;
    // `Response` refuses a body on a status that is defined not to have one,
    // so the stub has to respect that too or it throws before the code does.
    const body = status === 204 || status === 205 || status === 304 ? null : 'nope';
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** No real waiting; the backoff policy is asserted through the call count. */
const noSleep = (): Promise<void> => Promise.resolve();

/** `deliverWebhook` with the timers and the network taken out. */
function deliver(script: readonly (number | Error)[]) {
  const stub = stubFetch(script);
  return {
    calls: stub.calls,
    result: deliverWebhook('https://hooks.example.invalid/x', PAYLOAD, {
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
    }),
  };
}

describe('deliverWebhook', () => {
  it('posts the payload as JSON and stops at the first success', async () => {
    const { calls, result } = deliver([200]);
    await expect(result).resolves.toEqual({ ok: true, status: 200, attempts: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual(PAYLOAD);
  });

  it('treats every 2xx as delivered', async () => {
    await expect(deliver([204]).result).resolves.toMatchObject({ ok: true, status: 204 });
  });

  it('retries a 5xx twice and then gives up', async () => {
    const { calls, result } = deliver([500]);
    const outcome = await result;

    expect(calls).toHaveLength(3);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(500);
    expect(outcome.attempts).toBe(3);
    expect(outcome.error).toContain('HTTP 500');
  });

  it('stops as soon as a retry succeeds', async () => {
    const { calls, result } = deliver([503, 200]);
    await expect(result).resolves.toEqual({ ok: true, status: 200, attempts: 2 });
    expect(calls).toHaveLength(2);
  });

  it('retries a rate limit, because it means not now rather than never', async () => {
    const { calls } = deliver([429]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBeGreaterThan(1);
  });

  it('does not retry a 4xx, which will never succeed however often it is sent', async () => {
    for (const status of [400, 403, 404]) {
      const { calls, result } = deliver([status]);
      const outcome = await result;
      expect(calls).toHaveLength(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.error).toContain(`HTTP ${String(status)}`);
    }
  });

  it('retries a transport failure and reports it without a status', async () => {
    const { calls, result } = deliver([new Error('ECONNREFUSED')]);
    const outcome = await result;

    expect(calls).toHaveLength(3);
    expect(outcome.status).toBeNull();
    expect(outcome.error).toContain('ECONNREFUSED');
  });

  it('says how long it waited when an attempt times out', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const stub = stubFetch([timeout]);
    const outcome = await deliverWebhook('https://hooks.example.invalid/x', PAYLOAD, {
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      timeoutMs: 5000,
    });
    expect(outcome.error).toBe('no response within 5000ms');
  });

  it('honours a retry count of zero', async () => {
    const stub = stubFetch([500]);
    const outcome = await deliverWebhook('https://hooks.example.invalid/x', PAYLOAD, {
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      retries: 0,
    });
    expect(stub.calls).toHaveLength(1);
    expect(outcome.attempts).toBe(1);
  });

  it('never rejects, whatever the transport does', async () => {
    const exploding = (() => {
      throw new Error('synchronous explosion');
    }) as unknown as typeof fetch;
    await expect(
      deliverWebhook('https://hooks.example.invalid/x', PAYLOAD, {
        fetchImpl: exploding,
        sleep: noSleep,
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('truncateError', () => {
  it('collapses whitespace so a multi-line body stays one table cell', () => {
    expect(truncateError('  HTTP 400:\n  invalid_payload  ')).toBe('HTTP 400: invalid_payload');
  });

  it('caps what it keeps', () => {
    const long = truncateError('x'.repeat(WEBHOOK_ERROR_LIMIT * 2));
    expect(long).toHaveLength(WEBHOOK_ERROR_LIMIT);
    expect(long.endsWith('…')).toBe(true);
  });
});
