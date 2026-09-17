import type { JSX } from 'react';

import type { ProfileUsage, UsageTotals } from '../../../src/shared/api.js';
import { formatCostMicros, formatCount, formatRelative } from '../lib/format.js';

/** What the table renders. */
export interface ProfilesTableProps {
  /** `null` until the first response lands. */
  readonly profiles: readonly ProfileUsage[] | null;
  readonly totals: UsageTotals;
  readonly loading: boolean;
  readonly now: number;
}

/** Rows drawn while the first response is still in flight. */
const SKELETON_ROWS = 3;

/** The default profile's directory name, called out so it reads as "the default" rather than a gap. */
const DEFAULT_PROFILE_NAME = '.claude';

/** One profile row, right-aligned counts, heaviest first as the API already orders them. */
function ProfileRow({
  profile,
  now,
}: {
  readonly profile: ProfileUsage;
  readonly now: number;
}): JSX.Element {
  return (
    <tr>
      <td>
        <code>{profile.profile_name ?? '(not tagged)'}</code>
        {profile.profile_name === DEFAULT_PROFILE_NAME && (
          <span className="section-note"> default</span>
        )}
      </td>
      <td>{profile.hostname ?? '—'}</td>
      <td>{profile.display_name}</td>
      <td className="num">{formatCount(profile.sessions)}</td>
      <td className="num">{formatCount(profile.total_tokens)}</td>
      <td className="num">{formatCount(profile.input_tokens)}</td>
      <td className="num">{formatCount(profile.output_tokens)}</td>
      <td className="num">{formatCostMicros(profile.cost_micros)}</td>
      <td>{profile.last_seen === null ? '—' : formatRelative(profile.last_seen, now)}</td>
    </tr>
  );
}

const COLUMN_COUNT = 9;

/**
 * Per-`CLAUDE_CONFIG_DIR` profile usage: which profile, on which machine, under
 * which teammate, moved how many tokens.
 *
 * This is local telemetry ccledger itself received and summed — never
 * Anthropic's account-level 5-hour or 7-day quota, and the two numbers are not
 * expected to agree. A profile's directory name is arbitrary (a teammate could
 * call it anything via `CLAUDE_CONFIG_DIR`), so it is shown verbatim rather
 * than interpreted.
 */
export function ProfilesTable({ profiles, totals, loading, now }: ProfilesTableProps): JSX.Element {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Profile</th>
            <th scope="col">Machine</th>
            <th scope="col">Member</th>
            <th scope="col" className="num">
              Sessions
            </th>
            <th scope="col" className="num">
              Tokens
            </th>
            <th scope="col" className="num">
              In
            </th>
            <th scope="col" className="num">
              Out
            </th>
            <th
              scope="col"
              className="num"
              title="Estimated, not real spend on a subscription plan."
            >
              Cost, est.
            </th>
            <th scope="col">Last activity</th>
          </tr>
        </thead>

        <tbody>
          {loading && (profiles === null || profiles.length === 0)
            ? Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
                <tr key={`skeleton-${String(index)}`}>
                  {Array.from({ length: COLUMN_COUNT }, (_unused2, column) => (
                    <td key={column} className={column >= 3 && column <= 7 ? 'num' : undefined}>
                      <span className="skeleton">0,000,000</span>
                    </td>
                  ))}
                </tr>
              ))
            : (profiles ?? []).map((profile) => (
                <ProfileRow
                  key={`${profile.member_id}|${profile.hostname ?? ''}|${profile.profile_name ?? ''}`}
                  profile={profile}
                  now={now}
                />
              ))}
        </tbody>

        {profiles !== null && profiles.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={4}>Total</td>
              <td className="num">{formatCount(totals.total_tokens)}</td>
              <td className="num">{formatCount(totals.input_tokens)}</td>
              <td className="num">{formatCount(totals.output_tokens)}</td>
              <td className="num">{formatCostMicros(totals.cost_micros)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
