/**
 * Where the admin token comes from, and how long it stays.
 *
 * `ccledger serve` prints the dashboard link as `.../#token=cca_...`. The
 * fragment is the right place for it — browsers never send a fragment to the
 * server, so the token stays out of access logs and out of `Referer` headers —
 * but it is still in the address bar, in the history, and in any screenshot of
 * the window. So it is read once and immediately erased from the URL.
 *
 * Until 0.1.2 the value then lived in React state and nowhere else, which meant
 * a reload asked for it again. That was defensible and it was wrong in
 * practice: the token is thirty-six characters of base64 nobody memorises, so
 * "never at rest" really meant "keep it somewhere else at rest, and paste it in
 * several times a day". The honest trade is to store it and say where.
 *
 * Two tiers, because they carry different risk:
 *
 * - **`sessionStorage`, always.** Scoped to the tab and erased when it closes.
 *   This is what makes a reload keep working, and it survives nothing else.
 * - **`localStorage`, only when asked.** Survives closing the browser, so it is
 *   behind an explicit "remember me" and off by default.
 *
 * What makes both defensible is the page's own Content-Security-Policy:
 * `script-src 'self'` with no relaxations, served by the same process, so there
 * is no third-party script in the document that could read either store. The
 * residual risk is somebody with access to the browser profile, which is why
 * the durable tier is opt-in and `Lock` erases both.
 *
 * Every function here takes the stores as a defaulted parameter, the way
 * `resolveClientPaths` takes a home directory: production passes nothing, a
 * test passes fakes, and the suite keeps running under the `node` environment
 * with no DOM in the dependency tree.
 */

/** Where the token is kept. Namespaced, because a dashboard may share an origin. */
const STORAGE_KEY = 'ccledger.admin-token';

/**
 * The part of `Storage` this module uses. Declared structurally rather than as
 * `Storage` so the module carries no dependency on the DOM lib and a test can
 * satisfy it with an object literal.
 */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The two tiers. Either may be absent where the browser refuses access. */
export interface TokenStores {
  /** Erased when the tab closes. */
  readonly session: TokenStore | undefined;
  /** Survives the browser closing. */
  readonly durable: TokenStore | undefined;
}

/** This browser's stores, or `undefined` for either where reaching it throws. */
export function browserStores(): TokenStores {
  return {
    session: attempt(() => window.sessionStorage),
    durable: attempt(() => window.localStorage),
  };
}

/**
 * Runs a storage operation, returning `undefined` if the browser refuses.
 *
 * Access to `localStorage` throws rather than returning null in a few real
 * situations — Safari's private mode historically, and any browser configured
 * to block site data. A dashboard that cannot remember a token should still
 * open, so every access goes through here.
 */
function attempt<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

/** The `token` parameter of a URL fragment, or `null` if it carries none. */
export function tokenFromHash(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (fragment === '') return null;

  // The fragment is parameter-shaped by convention rather than by spec, so it
  // is parsed the same way a query string would be.
  const token = new URLSearchParams(fragment).get('token');
  return token === null || token === '' ? null : token;
}

/**
 * The token a previous visit left behind, or `null`.
 *
 * The tab-scoped copy wins. If both exist they are the same value, and
 * preferring the narrower one means a session that has been locked in this tab
 * stays locked even where a durable copy is still on disk.
 */
export function storedToken(stores: TokenStores = browserStores()): string | null {
  const session = attempt(() => stores.session?.getItem(STORAGE_KEY));
  if (session !== undefined && session !== null && session !== '') return session;
  const durable = attempt(() => stores.durable?.getItem(STORAGE_KEY));
  return durable === undefined || durable === null || durable === '' ? null : durable;
}

/** True when a durable copy exists, so the checkbox can come back the way it was left. */
export function isRemembered(stores: TokenStores = browserStores()): boolean {
  const durable = attempt(() => stores.durable?.getItem(STORAGE_KEY));
  return durable !== undefined && durable !== null && durable !== '';
}

/**
 * Keeps a token for this tab, and on this device when `remember` is set.
 *
 * Turning `remember` off removes the durable copy rather than leaving it: a
 * checkbox that only ever adds storage is a checkbox that cannot be undone.
 */
export function rememberToken(
  token: string,
  remember: boolean,
  stores: TokenStores = browserStores(),
): void {
  attempt(() => stores.session?.setItem(STORAGE_KEY, token));
  attempt(() => {
    if (remember) stores.durable?.setItem(STORAGE_KEY, token);
    else stores.durable?.removeItem(STORAGE_KEY);
  });
}

/** Erases both copies. What `Lock`, and a rejected token, both mean. */
export function forgetToken(stores: TokenStores = browserStores()): void {
  attempt(() => stores.session?.removeItem(STORAGE_KEY));
  attempt(() => stores.durable?.removeItem(STORAGE_KEY));
}
