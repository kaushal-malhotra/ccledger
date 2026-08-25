/**
 * Talking to `/api`.
 *
 * The admin token is passed in on every call rather than held here. That is the
 * whole of the storage policy: there is no module-level variable to read, no
 * `localStorage`, no cookie, nothing that survives the tab. React state holds
 * it, a reload asks for it again, and a shared machine forgets it when the tab
 * closes — which is the correct behaviour for a credential that grants every
 * teammate's usage history.
 *
 * `import type` is the only thing that crosses into `src/`. The response shapes
 * come from `src/shared/api.ts` so the dashboard cannot drift from the server,
 * and because the import is type-only the bundler erases it: nothing in `src/`
 * is compiled into this bundle.
 */

import type {
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
