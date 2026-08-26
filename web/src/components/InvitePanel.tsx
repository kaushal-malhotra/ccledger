import type { FormEvent, JSX } from 'react';
import { useState } from 'react';

import type { InviteResponse, OpenInvite } from '../../../src/shared/api.js';
import { formatAbsolute, formatUntil } from '../lib/format.js';

/** What the invite panel renders and what it can do. */
export interface InvitePanelProps {
  /** The base URL invites carry, or null when the server has recorded none. */
  readonly endpoint: string | null;
  /** Issued and not yet claimed. */
  readonly invites: readonly OpenInvite[];
  /** Resolves with the new invite once the server has minted it. */
  readonly onCreate: (displayName: string) => Promise<InviteResponse>;
  /** The instant relative times are measured from. */
  readonly now: number;
}

/**
 * Adding a teammate, from the dashboard.
 *
 * The whole output of this panel is one line to send someone, because that is
 * the only thing the person on the other end can act on. The join code is shown
 * beside it for the case where an invite is read out loud rather than pasted —
 * three groups of four, from an alphabet with the confusable characters removed,
 * exists precisely for that.
 *
 * Nothing here can recover a code after the fact. `ccledger invite` cannot
 * either: what is stored is the code, and what is useful is the whole blob
 * around it, so an invite that scrolls away is reissued rather than found. The
 * unclaimed list below is what stops that mattering — it says who is still
 * outstanding, which is the question an admin actually asks.
 */
export function InvitePanel({ endpoint, invites, onCreate, now }: InvitePanelProps): JSX.Element {
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<InviteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const trimmed = name.trim();
  const ready = trimmed !== '' && !busy && endpoint !== null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const invite = await onCreate(trimmed);
      setIssued(invite);
      setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access needs a permission this page may not have, and the
      // command is selectable either way. Saying nothing is better than an
      // error about a convenience.
    }
  }

  return (
    <section className="invite-panel">
      <h2>Invite a teammate</h2>

      {endpoint === null ? (
        <p className="gate-error">
          This server has no public URL recorded, so an invite would point nowhere. Restart it with{' '}
          <code>--public-url https://your.domain</code>.
        </p>
      ) : (
        <p className="faint">
          They run one line, restart Claude Code, and appear here. The code works once and expires
          in 24 hours.
        </p>
      )}

      <form className="invite-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="invite-name" className="visually-hidden">
          Their name
        </label>
        <input
          id="invite-name"
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder="Their name"
          autoComplete="off"
          maxLength={64}
          disabled={endpoint === null}
        />
        <button className="btn btn-primary" type="submit" disabled={!ready}>
          {busy ? 'Creating…' : 'Create invite'}
        </button>
      </form>

      {error !== null && <p className="gate-error">{error}</p>}

      {issued !== null && (
        <div className="invite-result">
          <div className="invite-result-head">
            <span>
              Send this to <strong>{issued.display_name}</strong>
            </span>
            <button
              className="btn btn-quiet"
              type="button"
              onClick={() => void copy(issued.command)}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="invite-command">{issued.command}</pre>
          <p className="faint">
            Join code <code>{issued.code}</code> · expires {formatAbsolute(issued.expires_at)}
          </p>
        </div>
      )}

      {invites.length > 0 && (
        <div className="invite-open">
          <h3>Not claimed yet</h3>
          <ul>
            {invites.map((invite) => (
              <li key={invite.code}>
                <span>{invite.display_name}</span>
                <code>{invite.code}</code>
                <span className="faint">expires {formatUntil(invite.expires_at, now)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
