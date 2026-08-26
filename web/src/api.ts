/**
 * Talking to `/api`.
 *
 * The admin token is passed in on every call rather than held here. There is no
 * module-level variable to read and no cookie: React state owns it, and where
 * it is kept between visits is `lib/token.ts`'s decision alone. Keeping that in
 * one place is what lets "erase it" be one function rather than a search.
 *
 * `import type` is the only thing that crosses into `src/`. The response shapes
 * come from `src/shared/api.ts` so the dashboard cannot drift from the server,
 * and because the import is type-only the bundler erases it: nothing in `src/`
 * is compiled into this bundle.
 */

import type {
  AlertRuleBody,
  AlertRuleDeleteResponse,
  AlertRulePatch,
  AlertRuleResponse,
  AlertsResponse,
  InviteResponse,
  InvitesResponse,
  MemberDetailResponse,
  MembersResponse,
  ModelsResponse,
  RevokeResponse,
  SummaryResponse,
  TimeseriesResponse,
} from '../../src/shared/api.js';

/** A response that was not a 2xx, carrying the status so 401 can be acted on. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** True when this failure means the token is wrong rather than the request. */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** The message out of an unknown throw, without assuming it is an `Error`. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The `{ "error": ... }` body every ccledger rejection uses. */
interface ErrorBody {
  readonly error?: unknown;
}

/** Pulls the server's sentence out of a rejection, or falls back to the status. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ErrorBody;
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // A rejection that is not JSON — a proxy's own error page, most likely.
  }
  return `request failed with status ${String(response.status)}`;
}

/** Query parameters, skipping any the caller left undefined. */
export type Query = Readonly<Record<string, string | number | undefined>>;

/** Builds a path with its query string, encoding every value. */
function withQuery(path: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** GETs a JSON endpoint, or throws `ApiError`. */
async function getJson<T>(
  path: string,
  query: Query,
  token: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  const response = await fetch(withQuery(path, query), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    // The token is in a header, so no credentials are needed and none are sent.
    credentials: 'omit',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  return (await response.json()) as T;
}

/** Options every ranged request takes. */
export interface RangeRequest {
  readonly from: string;
  readonly to: string;
  readonly group?: string;
  readonly source?: string;
}

/** The unauthenticated `/health` body. */
export interface HealthBody {
  readonly status: string;
  readonly version: string;
  readonly uptimeSeconds: number;
}

/**
 * `GET /health`. Unauthenticated, so it answers at the token gate too — which
 * is what makes the version in the corner useful for a self-hosted tool whose
 * operator is also the person reading a bug report about it.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthBody> {
  const response = await fetch('/health', {
    credentials: 'omit',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  return (await response.json()) as HealthBody;
}

/** `GET /api/summary`. */
export function fetchSummary(
  request: RangeRequest,
  token: string,
  signal?: AbortSignal,
): Promise<SummaryResponse> {
  return getJson<SummaryResponse>('/api/summary', { ...request }, token, signal);
}

/** `GET /api/members`. */
export function fetchMembers(token: string, signal?: AbortSignal): Promise<MembersResponse> {
  return getJson<MembersResponse>('/api/members', {}, token, signal);
}

/** `GET /api/members/:id`. */
export function fetchMemberDetail(
  memberId: string,
  request: RangeRequest,
  token: string,
  signal?: AbortSignal,
): Promise<MemberDetailResponse> {
  return getJson<MemberDetailResponse>(
    `/api/members/${encodeURIComponent(memberId)}`,
    { ...request },
    token,
    signal,
  );
}

/** `GET /api/models`. */
export function fetchModels(
  request: RangeRequest,
  token: string,
  signal?: AbortSignal,
): Promise<ModelsResponse> {
  return getJson<ModelsResponse>('/api/models', { ...request }, token, signal);
}

/** `GET /api/timeseries`. */
export function fetchTimeseries(
  request: RangeRequest & { readonly bucket?: string; readonly tz_offset?: number },
  token: string,
  signal?: AbortSignal,
): Promise<TimeseriesResponse> {
  return getJson<TimeseriesResponse>('/api/timeseries', { ...request }, token, signal);
}

/**
 * A write to `/api`, with the JSON body the route expects.
 *
 * Separate from `getJson` rather than a flag on it, because these are the calls
 * that change something: they are never given an `AbortSignal`, so a rule is
 * not half-created because a re-render cancelled the request that was making
 * it.
 */
async function sendJson<T>(
  path: string,
  method: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'omit',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  return (await response.json()) as T;
}

/** `GET /api/alerts`: the rules, the recent fires, and who is over right now. */
export function fetchAlerts(token: string, signal?: AbortSignal): Promise<AlertsResponse> {
  return getJson<AlertsResponse>('/api/alerts', {}, token, signal);
}

/** `POST /api/alerts/rules`. */
export function createAlertRule(body: AlertRuleBody, token: string): Promise<AlertRuleResponse> {
  return sendJson<AlertRuleResponse>('/api/alerts/rules', 'POST', token, body);
}

/** `PATCH /api/alerts/rules/:id`. */
export function updateAlertRule(
  id: string,
  patch: AlertRulePatch,
  token: string,
): Promise<AlertRuleResponse> {
  return sendJson<AlertRuleResponse>(
    `/api/alerts/rules/${encodeURIComponent(id)}`,
    'PATCH',
    token,
    patch,
  );
}

/** `DELETE /api/alerts/rules/:id`. Idempotent, like the endpoint behind it. */
export function deleteAlertRule(id: string, token: string): Promise<AlertRuleDeleteResponse> {
  return sendJson<AlertRuleDeleteResponse>(
    `/api/alerts/rules/${encodeURIComponent(id)}`,
    'DELETE',
    token,
  );
}

/** `POST /api/members/:id/revoke`. Idempotent, like the endpoint behind it. */
export async function revokeMember(memberId: string, token: string): Promise<RevokeResponse> {
  const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    credentials: 'omit',
  });
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  return (await response.json()) as RevokeResponse;
}

/** `GET /api/invites`: what has been issued and not claimed. */
export function fetchInvites(token: string, signal?: AbortSignal): Promise<InvitesResponse> {
  return getJson<InvitesResponse>('/api/invites', {}, token, signal);
}

/** `POST /api/invites`. Returns the whole line to send a teammate. */
export function createInvite(displayName: string, token: string): Promise<InviteResponse> {
  return sendJson<InviteResponse>('/api/invites', 'POST', token, { display_name: displayName });
}
