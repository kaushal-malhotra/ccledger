import type { FormEvent, JSX } from 'react';
import { useState } from 'react';

/** What `TokenGate` needs from the app around it. */
export interface TokenGateProps {
  /** Called with a non-empty token when the form is submitted. */
  readonly onSubmit: (token: string) => void;
  /** Why the last attempt failed, if one did. */
  readonly error: string | null;
}

/**
 * The first screen: ask for the admin token.
 *
 * It says where the token comes from and what happens to it, because both are
 * things a new admin has to be told exactly once. `serve` prints the token when
 * it first issues one and never again, so the honest answer to "I lost it" is
 * `--rotate-admin-token`, not a recovery flow.
 */
export function TokenGate({ onSubmit, error }: TokenGateProps): JSX.Element {
  const [value, setValue] = useState('');
  const trimmed = value.trim();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (trimmed !== '') onSubmit(trimmed);
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={handleSubmit}>
        <h1>ccledger</h1>
        <p>
          This dashboard needs the admin token that <code>ccledger serve</code> printed when it
          first started. It is held in memory for this tab only — never written to storage — so a
          reload asks again.
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
