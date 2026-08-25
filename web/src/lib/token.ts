/**
 * Getting the admin token out of the URL, once.
 *
 * `ccledger serve` prints the dashboard link as `.../#token=cca_...`. The
 * fragment is the right place for it — browsers never send a fragment to the
 * server, so the token stays out of access logs and out of `Referer` headers —
 * but it is still in the address bar, in the history, and in any screenshot of
 * the window. So it is read once and immediately erased from the URL, and the
 * value lives in React state for the life of the tab and nowhere else.
 *
 * There is no `localStorage` here and there is not meant to be. This token can
 * read every teammate's usage history; a reload asking for it again is a small
 * price for it never being at rest on a shared machine.
 */

/** The `token` parameter of a URL fragment, or `null` if it carries none. */
export function tokenFromHash(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (fragment === '') return null;

  // The fragment is parameter-shaped by convention rather than by spec, so it
  // is parsed the same way a query string would be.
  const token = new URLSearchParams(fragment).get('token');
  return token === null || token === '' ? null : token;
}
