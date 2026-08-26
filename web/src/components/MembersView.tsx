import type { JSX } from 'react';
import { useState } from 'react';

import type { MemberListEntry } from '../../../src/shared/api.js';
import { formatAbsolute, formatCount, formatDate, formatRelative } from '../lib/format.js';

/** What the members table renders and what it can do. */
export interface MembersViewProps {
  readonly members: readonly MemberListEntry[];
  /** Resolves once the revocation has been applied and the list refetched. */
  readonly onRevoke: (memberId: string) => Promise<void>;
  /** The instant relative times are measured from. */
  readonly now: number;
  readonly loading: boolean;
  /** Opens a member's detail page. */
  readonly onSelect: (memberId: string) => void;
}

/**
 * Who is enrolled, when each of them was last heard from, and how to stop one
 * of them reporting.
 *
 * This list is not scoped to the date range on purpose. "Is Bob reporting?" is
 * a question about all of time, and answering it inside a seven-day window
 * would show a teammate who went on holiday as though they had never joined.
 *
 * Revocation asks twice, in place. It cannot be undone — the member's token is
 * only ever stored as a hash, so restoring access means a fresh invitation —
 * and a confirmation that appears where the button was is harder to dismiss by
 * reflex than a modal.
 */
export function MembersView({
  members,
  onRevoke,
  now,
  loading,
  onSelect,
}: MembersViewProps): JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  async function revoke(memberId: string): Promise<void> {
    setWorking(memberId);
    try {
      await onRevoke(memberId);
      setConfirming(null);
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">
              <span className="th-inner">Member</span>
            </th>
            <th scope="col">
              <span className="th-inner">Status</span>
            </th>
            <th scope="col">
              <span className="th-inner">Last seen</span>
            </th>
            <th scope="col" className="num">
              <span className="th-inner">Installs</span>
            </th>
            <th scope="col">
              <span className="th-inner">Joined</span>
            </th>
            <th scope="col">
              <span className="th-inner">Joined from</span>
            </th>
            <th scope="col">
              <span className="th-inner">
                <span className="visually-hidden">Actions</span>
              </span>
            </th>
          </tr>
        </thead>

        <tbody>
          {loading && members.length === 0 && (
            <tr>
              <td colSpan={7}>
                <span className="skeleton">loading members</span>
              </td>
            </tr>
          )}

          {members.map((member) => (
            <tr key={member.member_id}>
              <td>
                <button
                  type="button"
                  className="link-button member-name"
                  onClick={() => {
                    onSelect(member.member_id);
                  }}
                >
                  {member.display_name}
                </button>
                <div className="faint mono detail-sub">{member.member_id}</div>
              </td>
              <td>
                {member.revoked_at === null ? (
                  <span className="badge badge-active">active</span>
                ) : (
                  <span className="badge badge-revoked" title={formatAbsolute(member.revoked_at)}>
                    revoked {formatRelative(member.revoked_at, now)}
                  </span>
                )}
              </td>
              <td className={member.last_seen === null ? 'faint' : undefined}>
                {member.last_seen === null ? (
                  'never'
                ) : (
                  <span title={formatAbsolute(member.last_seen)}>
                    {formatRelative(member.last_seen, now)}
                  </span>
                )}
              </td>
              <td className="num">{formatCount(member.installs)}</td>
              <td className="muted">{formatDate(member.created_at)}</td>
              <td className="muted">
                {member.join_hostname ?? <span className="faint">unknown</span>}
                {member.join_os !== null && <span className="faint"> · {member.join_os}</span>}
              </td>
              <td className="num">
                {member.revoked_at !== null ? (
                  <span className="faint">—</span>
                ) : confirming === member.member_id ? (
                  <>
                    <button
                      className="btn btn-sm btn-danger"
                      type="button"
                      disabled={working !== null}
                      onClick={() => {
                        void revoke(member.member_id);
                      }}
                    >
                      {working === member.member_id ? 'Revoking…' : 'Revoke for good'}
                    </button>{' '}
                    <button
                      className="btn btn-sm btn-quiet"
                      type="button"
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => {
                      setConfirming(member.member_id);
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
