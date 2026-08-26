import type { JSX } from 'react';

import type { MemberDetailResponse, TimeseriesResponse } from '../../../src/shared/api.js';
import { memberColor } from '../lib/colors.js';
import {
  formatAbsolute,
  formatCostMicros,
  formatCount,
  formatPercent,
  formatRelative,
} from '../lib/format.js';

import { Est } from './Est.js';
import { ModelBars } from './ModelBars.js';
import { StatTiles } from './StatTiles.js';
import { TokensOverTime } from './TokensOverTime.js';

/** What a member's page reads. */
export interface MemberDetailProps {
  /** `null` until the first response lands. */
  readonly detail: MemberDetailResponse | null;
  /** The team's timeseries, which already holds this member's buckets. */
  readonly timeseries: TimeseriesResponse | null;
  /** The member whose page this is, known before the response arrives. */
  readonly memberId: string;
  /** Their name, carried over from the table so the heading is never blank. */
  readonly fallbackName: string;
  readonly slots: ReadonlyMap<string, number>;
  readonly loading: boolean;
  /** The instant relative times are measured from. */
  readonly now: number;
  readonly onBack: () => void;
}

/** A session id at table width: enough to match against a log, not the whole. */
function shortId(value: string | null): string {
  if (value === null) return 'no session id';
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/** How long a session ran, in the largest unit that still reads as a quantity. */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

/**
 * One member, in full.
 *
 * The charts are the same two components the team page uses, narrowed rather
 * than reimplemented — the timeseries is filtered to this member out of the
 * response already in hand, and the model bars take their split. That is what
 * keeps a member's numbers reading the same way as the team's, and keeps one
 * place to fix when a chart is wrong.
 *
 * Two tables sit underneath because neither is a chart: a session list is a
 * list, and an install list is a fact sheet. The install list is the one an
 * admin actually comes here for — "is Bob reporting from his laptop or from the
 * build box, and which Claude Code is it" — so it carries the terminal, the
 * version and the last-seen rather than summarising them.
 */
export function MemberDetail(props: MemberDetailProps): JSX.Element {
  const { detail, timeseries, memberId, fallbackName, slots, loading, now, onBack } = props;

  const name = detail?.member.display_name ?? fallbackName;
  const color = memberColor(memberId, slots);
  const truncated =
    detail !== null && detail.sessions_total > detail.sessions.length
      ? detail.sessions_total
      : null;

  return (
    <div className="detail">
      <div className="detail-head">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          ← All members
        </button>
        <h2 className="detail-name">
          <span className="legend-swatch" style={{ background: color }} aria-hidden="true" />
          {name}
        </h2>
        {detail !== null && (
          <>
            {detail.member.revoked_at === null ? (
              <span className="badge badge-active">active</span>
            ) : (
              <span
                className="badge badge-revoked"
                title={formatAbsolute(detail.member.revoked_at)}
              >
                revoked {formatRelative(detail.member.revoked_at, now)}
              </span>
            )}
            <span className="section-note">
              {formatPercent(detail.share_pct)} of the team&apos;s tokens in this range
            </span>
          </>
        )}
      </div>

      <StatTiles totals={detail?.totals ?? null} reporting={detail === null ? 0 : 1} />

      <div className="chart-grid">
        <TokensOverTime
          response={timeseries}
          slots={slots}
          loading={loading}
          only={memberId}
          title={`${name} over time`}
        />
        <ModelBars
          models={detail?.models ?? null}
          totalTokens={detail?.totals.total_tokens ?? 0}
          loading={loading}
          title="Their models"
        />
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Sessions</h2>
          <span className="section-note">
            heaviest first
            {truncated !== null &&
              ` · showing ${String(detail?.sessions.length ?? 0)} of ${String(truncated)}`}
          </span>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-inner">Session</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Started</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Ran for</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">Tokens</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">In</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">Out</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">Requests</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">
                    Cost, <Est />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {detail === null ? (
                <tr>
                  <td colSpan={8}>
                    <span className="skeleton">loading sessions</span>
                  </td>
                </tr>
              ) : detail.sessions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="faint">
                    No sessions in this range.
                  </td>
                </tr>
              ) : (
                detail.sessions.map((session) => (
                  <tr key={session.session_id ?? 'none'}>
                    <td className="mono" title={session.session_id ?? undefined}>
                      {shortId(session.session_id)}
                    </td>
                    <td className="muted" title={formatAbsolute(session.started_at)}>
                      {formatRelative(session.started_at, now)}
                    </td>
                    <td className="muted">
                      {formatDuration(session.ended_at - session.started_at)}
                    </td>
                    <td className="num">{formatCount(session.total_tokens)}</td>
                    <td className="num">{formatCount(session.input_tokens)}</td>
                    <td className="num">{formatCount(session.output_tokens)}</td>
                    <td className="num">{formatCount(session.requests)}</td>
                    <td className="num">{formatCostMicros(session.cost_micros)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Installs</h2>
          <span className="section-note">all time, not the selected range</span>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-inner">Machine</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Terminal</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Claude Code</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Last seen</span>
                </th>
                <th scope="col">
                  <span className="th-inner">First seen</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {detail === null ? (
                <tr>
                  <td colSpan={5}>
                    <span className="skeleton">loading installs</span>
                  </td>
                </tr>
              ) : detail.installs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="faint">
                    Nothing has reported under this member yet.
                  </td>
                </tr>
              ) : (
                detail.installs.map((install) => (
                  <tr key={install.install_id}>
                    <td>
                      <span className="member-name">
                        {install.hostname ?? <span className="faint">unknown host</span>}
                      </span>
                      <div className="faint detail-sub">
                        {install.os_type ?? 'unknown os'}
                        {install.os_version !== null && ` ${install.os_version}`}
                        {install.arch !== null && ` · ${install.arch}`}
                      </div>
                    </td>
                    <td className="muted">
                      {install.terminal_type ?? <span className="faint">unreported</span>}
                    </td>
                    <td className="muted mono">
                      {install.cc_version ?? <span className="faint">unreported</span>}
                    </td>
                    <td className="muted" title={formatAbsolute(install.last_seen)}>
                      {formatRelative(install.last_seen, now)}
                    </td>
                    <td className="muted" title={formatAbsolute(install.first_seen)}>
                      {formatRelative(install.first_seen, now)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
