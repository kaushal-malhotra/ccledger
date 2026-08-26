import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MemberListEntry, SummaryResponse, TimeseriesResponse } from '../../src/shared/api.js';

import {
  fetchHealth,
  fetchMembers,
  fetchSummary,
  fetchTimeseries,
  isAuthFailure,
  messageOf,
  revokeMember as postRevoke,
} from './api.js';
import { EmptyState } from './components/EmptyState.js';
import type { EmptyKind } from './components/EmptyState.js';
import { MemberTable } from './components/MemberTable.js';
import { MembersView } from './components/MembersView.js';
import { StatTiles } from './components/StatTiles.js';
import { TokenGate } from './components/TokenGate.js';
import { TokensOverTime } from './components/TokensOverTime.js';
import { Toolbar } from './components/Toolbar.js';
import { assignSlots } from './lib/colors.js';
import type { SourceSelection } from './lib/filter.js';
import { ALL_ACTIVITY, isNarrowed, selectionLabel, selectionParams } from './lib/filter.js';
import { COST_DISCLAIMER, formatRangeLabel } from './lib/format.js';
import type { RangePreset } from './lib/range.js';
import {
  customRange,
  localDaysAgo,
  presetRange,
  toDateInputValue,
  toQueryParams,
  tzOffsetMinutes,
} from './lib/range.js';
import { tokenFromHash } from './lib/token.js';

/** The two things the shell can show. */
type View = 'usage' | 'members';

/** Days the custom picker opens on, matching the default preset. */
const DEFAULT_CUSTOM_DAYS = 6;

/** The range the dashboard opens on. */
const DEFAULT_PRESET: RangePreset = '7d';

/**
 * The dashboard.
 *
 * Three decisions are load-bearing and worth finding here rather than deducing.
 *
 * The admin token lives in this component's state and nowhere else. It is read
 * once out of the URL fragment that `ccledger serve` prints, immediately erased
 * from the address bar, and never written to storage — so closing the tab is
 * the whole of "logging out", and a 401 from any request puts the gate back.
 *
 * `/api/members` is fetched alongside every summary even though the usage table
 * does not need it. It is what tells the difference between the two empty
 * dashboards that look identical and mean opposite things: nobody has joined,
 * or people have joined and nothing is arriving. It earns its request a second
 * time as the source of the colour assignment — being the one list that does
 * not change with the range is exactly what a stable palette needs.
 *
 * The ranged endpoints are fetched together and land together. A page
 * where the table has updated and the chart above it has not is a page showing
 * two different ranges without saying so.
 */
export function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => tokenFromHash(window.location.hash));
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [view, setView] = useState<View>('usage');

  const [asOf, setAsOf] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);
  const [preset, setPreset] = useState<RangePreset>(DEFAULT_PRESET);
  const [customFrom, setCustomFrom] = useState(() =>
    toDateInputValue(localDaysAgo(Date.now(), DEFAULT_CUSTOM_DAYS)),
  );
  const [customTo, setCustomTo] = useState(() => toDateInputValue(Date.now()));
  const [selection, setSelection] = useState<SourceSelection>(ALL_ACTIVITY);

  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [members, setMembers] = useState<readonly MemberListEntry[] | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The token has been read out of the fragment by now, so take it out of the
  // address bar before anyone screenshots the window or shares the link.
  useEffect(() => {
    if (tokenFromHash(window.location.hash) === null) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((body) => {
        setVersion(body.version);
      })
      .catch(() => {
        // The version in the corner is a nicety. Failing to read it says
        // nothing the rest of the page will not say more clearly.
      });
    return () => {
      controller.abort();
    };
  }, []);

  const range = useMemo(
    () => (preset === 'custom' ? customRange(customFrom, customTo) : presetRange(preset, asOf)),
    [preset, customFrom, customTo, asOf],
  );

  const request = useMemo(
    () =>
      range === undefined ? undefined : { ...toQueryParams(range), ...selectionParams(selection) },
    [range, selection],
  );

  const handleFailure = useCallback((cause: unknown): void => {
    if (isAuthFailure(cause)) {
      setToken(null);
      setSummary(null);
      setMembers(null);
      setTimeseries(null);
      setTokenError(messageOf(cause));
      return;
    }
    setError(messageOf(cause));
  }, []);

  useEffect(() => {
    if (token === null || request === undefined) return undefined;

    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      fetchSummary(request, token, controller.signal),
      fetchMembers(token, controller.signal),
      // No `bucket`: the server picks hours under three days and days above,
      // and the response says which it used. Choosing here would put the same
      // rule in two places and let them drift.
      fetchTimeseries(
        { ...request, tz_offset: tzOffsetMinutes(range?.to ?? Date.now()) },
        token,
        controller.signal,
      ),
    ])
      .then(([summaryBody, membersBody, timeseriesBody]) => {
        setSummary(summaryBody);
        setMembers(membersBody.members);
        setTimeseries(timeseriesBody);
        setError(null);
      })
      .catch((cause: unknown) => {
        // An aborted request is this effect being superseded, not a failure.
        if (controller.signal.aborted) return;
        handleFailure(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [token, request, reloadKey, range, handleFailure]);

  const refresh = useCallback(() => {
    setAsOf(Date.now());
    setReloadKey((key) => key + 1);
  }, []);

  const choosePreset = useCallback((next: RangePreset) => {
    setPreset(next);
    // A preset means "as of now", so re-anchor rather than reusing whatever
    // instant the page happened to load at.
    setAsOf(Date.now());
  }, []);

  const handleRevoke = useCallback(
    async (memberId: string): Promise<void> => {
      if (token === null) return;
      try {
        await postRevoke(memberId, token);
        setReloadKey((key) => key + 1);
      } catch (cause) {
        handleFailure(cause);
      }
    },
    [token, handleFailure],
  );

  const reporting = useMemo(
    () => summary?.members.filter((member) => member.requests > 0).length ?? 0,
    [summary],
  );

  // Assigned from the enrolment list rather than from whoever is in the range,
  // so a member keeps their colour when a filter drops them and gets it back
  // unchanged when it stops.
  const slots = useMemo(() => assignSlots(members ?? []), [members]);

  const emptyKind = useMemo<EmptyKind | null>(() => {
    if (summary === null || members === null) return null;
    if (summary.totals.requests > 0) return null;
    if (members.length === 0) return 'no-members';
    // `sources` is computed without the filter, so it answers "is there
    // anything here at all" independently of what is currently selected.
    const anythingInRange = summary.sources.some((source) => source.requests > 0);
    return anythingInRange && isNarrowed(selection) ? 'filtered-out' : 'no-usage';
  }, [summary, members, selection]);

  if (token === null) {
    return (
      <TokenGate
        error={tokenError}
        onSubmit={(next) => {
          setTokenError(null);
          setError(null);
          setToken(next);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap topbar-inner">
          <div className="wordmark">
            ccledger
            {version !== null && <span className="server-name">v{version}</span>}
          </div>

          <div className="nav">
            <div className="segmented" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={view === 'usage'}
                onClick={() => {
                  setView('usage');
                }}
              >
                Usage
              </button>
              <button
                type="button"
                aria-pressed={view === 'members'}
                onClick={() => {
                  setView('members');
                }}
              >
                Members
              </button>
            </div>
            <button
              className="btn btn-quiet"
              type="button"
              title="Forget the admin token in this tab"
              onClick={() => {
                setToken(null);
                setSummary(null);
                setMembers(null);
                setTimeseries(null);
                setTokenError(null);
              }}
            >
              Lock
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        <div className="wrap">
          <Toolbar
            preset={preset}
            onPreset={choosePreset}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
            range={range}
            selection={selection}
            onSelection={setSelection}
            sources={summary?.sources ?? []}
            onRefresh={refresh}
            loading={loading}
            ranged={view === 'usage'}
          />

          {error !== null && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          {view === 'usage' ? (
            <>
              <StatTiles totals={summary?.totals ?? null} reporting={reporting} />

              {emptyKind !== 'no-members' && (
                <div className="chart-grid">
                  <TokensOverTime response={timeseries} slots={slots} loading={loading} />
                </div>
              )}

              <section className="section">
                <div className="section-head">
                  <h2>Usage by member</h2>
                  <span className="section-note">
                    {range === undefined
                      ? 'no range selected'
                      : formatRangeLabel(range.from, range.to)}
                    {' · '}
                    {selectionLabel(selection)}
                  </span>
                </div>

                {emptyKind !== null ? (
                  <EmptyState
                    kind={emptyKind}
                    onResetFilter={() => {
                      setSelection(ALL_ACTIVITY);
                    }}
                    onWidenRange={() => {
                      choosePreset('30d');
                    }}
                  />
                ) : (
                  <MemberTable
                    members={summary?.members ?? []}
                    totals={summary?.totals ?? EMPTY_TOTALS}
                    loading={loading}
                  />
                )}
              </section>
            </>
          ) : (
            <section className="section">
              <div className="section-head">
                <h2>Members</h2>
                <span className="section-note">all time, not the selected range</span>
              </div>

              {members !== null && members.length === 0 ? (
                <EmptyState
                  kind="no-members"
                  onResetFilter={() => {
                    setSelection(ALL_ACTIVITY);
                  }}
                  onWidenRange={() => {
                    choosePreset('30d');
                  }}
                />
              ) : (
                <MembersView
                  members={members ?? []}
                  onRevoke={handleRevoke}
                  now={asOf}
                  loading={loading}
                />
              )}
            </section>
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="wrap">
          <p>{COST_DISCLAIMER}</p>
          <p>
            ccledger stores token counts, model names and timestamps. It never receives prompt or
            response content, and it is not in the request path between Claude Code and Anthropic.
          </p>
          <p>
            Nothing arriving from a teammate? <code>ccledger doctor</code> on their machine says
            why.
          </p>
        </div>
      </footer>
    </div>
  );
}

/** What the table shows before the first response arrives. */
const EMPTY_TOTALS = {
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  requests: 0,
  sessions: 0,
  cost_micros: 0,
} as const;
