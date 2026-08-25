import type { JSX } from 'react';

/** Which of the three kinds of nothing the dashboard is looking at. */
export type EmptyKind = 'no-members' | 'no-usage' | 'filtered-out';

/** What the empty state renders and what it can undo. */
export interface EmptyStateProps {
  readonly kind: EmptyKind;
  /** Clears the source filter. Only used by `filtered-out`. */
  readonly onResetFilter: () => void;
  /** Widens the range to thirty days. Only used by `no-usage`. */
  readonly onWidenRange: () => void;
}

/**
 * What an admin sees before there is anything to see.
 *
 * A new ccledger's first screen is an empty dashboard, and an empty dashboard
 * that says only "no data" is indistinguishable from a broken one. Each of the
 * three cases here names the next command to run, because the three have
 * genuinely different answers: nobody has joined, nobody has reported in this
 * window, or the filter is hiding what is there.
 *
 * The middle case is the one that matters. Almost every "it isn't working"
 * report is a teammate who ran `ccledger setup` and did not restart Claude
 * Code, which reads its telemetry configuration once at startup — and
 * `ccledger doctor` is the command that says so on their machine.
 */
export function EmptyState({ kind, onResetFilter, onWidenRange }: EmptyStateProps): JSX.Element {
  if (kind === 'no-members') {
    return (
      <div className="notice">
        <h2>No teammates have joined yet</h2>
        <p>
          ccledger shows usage for people who have enrolled. Generate an invitation, send the string
          it prints to a teammate, and they run <code>ccledger setup</code> with it.
        </p>
        <pre className="command">ccledger invite &quot;Alex&quot;</pre>
      </div>
    );
  }

  if (kind === 'filtered-out') {
    return (
      <div className="notice">
        <h2>Nothing matches this filter</h2>
        <p>There is usage in this range, but none of it comes from the source you have selected.</p>
        <button className="btn" type="button" onClick={onResetFilter}>
          Show all activity
        </button>
      </div>
    );
  }

  return (
    <div className="notice">
      <h2>No usage in this range</h2>
      <p>
        Nobody reported any requests between these dates. Three things to check, in the order they
        are usually wrong:
      </p>
      <ol>
        <li>
          The range may simply be too narrow.{' '}
          <button className="btn btn-sm" type="button" onClick={onWidenRange}>
            Try the last 30 days
          </button>
        </li>
        <li>
          Claude Code reads its telemetry configuration once, at startup. A teammate who ran{' '}
          <code>ccledger setup</code> and did not restart Claude Code is not reporting yet.
        </li>
        <li>
          On the teammate&apos;s machine, this says which of the two it is — and what to do about
          it:
          <pre className="command">ccledger doctor</pre>
        </li>
      </ol>
    </div>
  );
}
