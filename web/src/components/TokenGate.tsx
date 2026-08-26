import type { FormEvent, JSX } from 'react';
import { useState } from 'react';

/** What `TokenGate` needs from the app around it. */
export interface TokenGateProps {
  /** Called with a non-empty token when the form is submitted. */
  readonly onSubmit: (token: string, remember: boolean) => void;
  /** Why the last attempt failed, if one did. */
  readonly error: string | null;
  /** Whether "remember me" starts ticked, from whatever a previous visit chose. */
  readonly rememberInitially?: boolean;
}

/**
 * The first screen: ask for the admin token.
 *
 * It says where the token comes from and what happens to it, because both are
 * things a new admin has to be told exactly once. `serve` prints the token when
 * it first issues one and never again, so the honest answer to "I lost it" is
 * `--rotate-admin-token`, not a recovery flow.
 *
 * The checkbox is off by default and says what it does in the words that
 * matter — on this device, until you lock. Somebody opening this on a machine
 * that is not theirs should be able to decline without reading a paragraph.
 */
export function TokenGate({
  onSubmit,
  error,
  rememberInitially = false,
}: TokenGateProps): JSX.Element {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(rememberInitially);
  const trimmed = value.trim();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (trimmed !== '') onSubmit(trimmed, remember);
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={handleSubmit}>
        <h1>ccledger</h1>
        <p>
          This dashboard needs the admin token that <code>ccledger serve</code> printed when it
          first started. It is kept for this tab so a reload does not ask again, and erased when you
          lock or close it.
        </p>

        <label htmlFor="admin-token">Admin token</label>
        <input
          id="admin-token"
          type="password"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          placeholder="cca_…"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />

        <label className="gate-remember" htmlFor="remember-token">
          <input
            id="remember-token"
            type="checkbox"
            checked={remember}
            onChange={(event) => {
              setRemember(event.target.checked);
            }}
          />
          <span>
            Remember me on this device
            <span className="faint">
              {' '}
              — stays after the browser closes. Not on a shared machine.
            </span>
          </span>
        </label>

        <div className="gate-actions">
          <button className="btn btn-primary" type="submit" disabled={trimmed === ''}>
            Open dashboard
          </button>
          <span className="faint" style={{ fontSize: '12.5px' }}>
            Lost it? <code>ccledger serve --rotate-admin-token</code>
          </span>
        </div>

        {error !== null && <p className="gate-error">{error}</p>}
      </form>
    </div>
  );
}
