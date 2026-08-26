import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import type {
  AlertRule,
  AlertRuleBody,
  AlertsResponse,
  MemberListEntry,
} from '../../../src/shared/api.js';
import type { AlertMetric, AlertWindow } from '../../../src/shared/alerts.js';
import {
  DEFAULT_METRIC,
  DEFAULT_WINDOW,
  METRIC_CHOICES,
  WINDOW_CHOICES,
  deliveryLabel,
  deliveryTone,
  fireValue,
  formatMetric,
  metricLabel,
  thresholdUnit,
  windowLabel,
} from '../lib/alerts.js';
import { formatAbsolute, formatRelative } from '../lib/format.js';

/** Everything the settings page reads, and everything it can change. */
export interface AlertsViewProps {
  readonly alerts: AlertsResponse | null;
  /** Every enrolled member, for the "who does this watch" control. */
  readonly members: readonly MemberListEntry[];
  readonly loading: boolean;
  /** The instant relative times are measured from. */
  readonly now: number;
  readonly onCreate: (body: AlertRuleBody) => Promise<void>;
  readonly onUpdate: (id: string, patch: Partial<AlertRuleBody>) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}

/** The form's fields, as the controls hold them: strings until submit. */
interface FormState {
  readonly memberId: string;
  readonly metric: AlertMetric;
  readonly window: AlertWindow;
  readonly threshold: string;
  readonly webhookUrl: string;
}

/** The `member_id` value standing for "every member, independently". */
const ANYONE = '';

/** What the form opens on, and what it returns to after a save. */
const EMPTY_FORM: FormState = {
  memberId: ANYONE,
  metric: DEFAULT_METRIC,
  window: DEFAULT_WINDOW,
  threshold: '50',
  webhookUrl: '',
};

/** The form fields that describe an existing rule, for editing it in place. */
function formFor(rule: AlertRule): FormState {
  return {
    memberId: rule.member_id ?? ANYONE,
    metric: rule.metric,
    window: rule.window,
    threshold: String(rule.threshold),
    webhookUrl: rule.webhook_url ?? '',
  };
}

/** The threshold a form holds, or the reason it is not one. */
function readThreshold(form: FormState): { value?: number; error?: string } {
  const value = Number(form.threshold.trim());
  if (form.threshold.trim() === '' || !Number.isFinite(value) || value <= 0) {
    return { error: 'Threshold must be a number greater than zero.' };
  }
  if (form.metric === 'share_pct' && value > 100) {
    return { error: 'A share is a percentage, so it cannot be above 100.' };
  }
  return { value };
}

/**
 * Alert rules, the fires they have produced, and the form that edits both.
 *
 * One form rather than a row of inline editors. Editing loads the rule into it
 * and scrolls nothing: a rule is five fields, and five fields in two places
 * would be two sets of validation that could disagree about what a threshold
 * is.
 *
 * Deleting confirms in place, like revoking a member does, and says how many
 * recorded fires go with the rule — they reference it and cannot outlive it, so
 * a rule someone deletes to "tidy up" takes its history along.
 */
export function AlertsView({
  alerts,
  members,
  loading,
  now,
  onCreate,
  onUpdate,
  onDelete,
}: AlertsViewProps): JSX.Element {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  // A rule deleted in another tab, or by a refresh, must not leave the form
  // editing something that is no longer there.
  useEffect(() => {
    if (editing === null || alerts === null) return;
    if (!alerts.rules.some((rule) => rule.id === editing)) {
      setEditing(null);
      setForm(EMPTY_FORM);
    }
  }, [alerts, editing]);

  const rules = alerts?.rules ?? [];
  const fires = alerts?.fires ?? [];
  const timezone = alerts?.timezone ?? 'the server’s timezone';
  const metricHint = METRIC_CHOICES.find((choice) => choice.value === form.metric)?.hint ?? '';

  function reset(): void {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function submit(): Promise<void> {
    const threshold = readThreshold(form);
    if (threshold.value === undefined) {
      setError(threshold.error ?? 'That is not a rule.');
      return;
    }
    const body: AlertRuleBody = {
      member_id: form.memberId === ANYONE ? null : form.memberId,
      metric: form.metric,
      window: form.window,
      threshold: threshold.value,
      webhook_url: form.webhookUrl.trim() === '' ? null : form.webhookUrl.trim(),
    };

    setBusy(true);
    setError(null);
    try {
      if (editing === null) {
        await onCreate(body);
      } else {
        await onUpdate(editing, body);
      }
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    try {
      await onDelete(id);
      setConfirming(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>Alert rules</h2>
          <span className="section-note">windows reset on the calendar in {timezone}</span>
        </div>

        <form
          className="alert-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label htmlFor="alert-member">Watch</label>
            <select
              id="alert-member"
              value={form.memberId}
              onChange={(event) => {
                setForm({ ...form, memberId: event.target.value });
              }}
            >
              <option value={ANYONE}>Anyone (each member separately)</option>
              {members.map((member) => (
                <option key={member.member_id} value={member.member_id}>
                  {member.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="alert-metric">Metric</label>
            <select
              id="alert-metric"
              value={form.metric}
              onChange={(event) => {
                setForm({ ...form, metric: event.target.value as AlertMetric });
              }}
            >
              {METRIC_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value} title={choice.hint}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="alert-window">Window</label>
            <select
              id="alert-window"
              value={form.window}
              onChange={(event) => {
                setForm({ ...form, window: event.target.value as AlertWindow });
              }}
            >
              {WINDOW_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value} title={choice.hint}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="alert-threshold">Over</label>
            <span className="threshold-input">
              <input
                id="alert-threshold"
                type="text"
                inputMode="decimal"
                value={form.threshold}
                size={8}
                onChange={(event) => {
                  setForm({ ...form, threshold: event.target.value });
                }}
              />
              <span className="faint">{thresholdUnit(form.metric)}</span>
            </span>
          </div>

          <div className="field field-wide">
            <label htmlFor="alert-webhook">Webhook URL</label>
            <input
              id="alert-webhook"
              type="text"
              placeholder="https://hooks.slack.com/services/… (optional)"
              value={form.webhookUrl}
              onChange={(event) => {
                setForm({ ...form, webhookUrl: event.target.value });
              }}
            />
          </div>

          <div className="alert-form-actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing === null ? 'Add rule' : 'Save rule'}
            </button>
            {editing !== null && (
              <button className="btn btn-quiet" type="button" onClick={reset} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </form>

        <p className="alert-hint faint">
          {metricHint} Leave the webhook empty to raise the badge on the dashboard without notifying
          anywhere.
        </p>

        {error !== null && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-inner">Watches</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Metric</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Window</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">Threshold</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Webhook</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Status</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">
                    <span className="visually-hidden">Actions</span>
                  </span>
                </th>
              </tr>
            </thead>

            <tbody>
              {loading && rules.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <span className="skeleton">loading rules</span>
                  </td>
                </tr>
              )}

              {!loading && rules.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No rules yet. A share rule at 50% per week is the usual first one.
                  </td>
                </tr>
              )}

              {rules.map((rule) => (
                <tr key={rule.id} className={rule.enabled ? undefined : 'row-muted'}>
                  <td>{rule.member_name ?? <span className="muted">Anyone</span>}</td>
                  <td>{metricLabel(rule.metric)}</td>
                  <td>{windowLabel(rule.window)}</td>
                  <td className="num">{formatMetric(rule.metric, rule.threshold)}</td>
                  <td className="muted">
                    {rule.webhook_url === null ? (
                      <span className="faint">badge only</span>
                    ) : (
                      // The host, not the URL: a Slack incoming-webhook URL is
                      // a credential, and this page is often on a shared screen.
                      <span title="The full URL is only shown while editing the rule.">
                        {hostOf(rule.webhook_url)}
                      </span>
                    )}
                  </td>
                  <td>
                    {rule.enabled ? (
                      <span className="badge badge-active">on</span>
                    ) : (
                      <span className="badge">off</span>
                    )}
                  </td>
                  <td className="num">
                    {confirming === rule.id ? (
                      <>
                        <button
                          className="btn btn-sm btn-danger"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void remove(rule.id);
                          }}
                        >
                          {firesOf(fires, rule.id) === 0
                            ? 'Delete rule'
                            : `Delete rule and ${String(firesOf(fires, rule.id))} fires`}
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
                      <>
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void onUpdate(rule.id, { enabled: !rule.enabled });
                          }}
                        >
                          {rule.enabled ? 'Disable' : 'Enable'}
                        </button>{' '}
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => {
                            setEditing(rule.id);
                            setForm(formFor(rule));
                            setError(null);
                          }}
                        >
                          Edit
                        </button>{' '}
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => {
                            setConfirming(rule.id);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Recent alerts</h2>
          <span className="section-note">one per rule, member and window — newest first</span>
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-inner">When</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Member</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Rule</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-inner">Value</span>
                </th>
                <th scope="col">
                  <span className="th-inner">Webhook</span>
                </th>
              </tr>
            </thead>

            <tbody>
              {fires.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    {loading ? (
                      <span className="skeleton">loading alerts</span>
                    ) : (
                      'Nothing has crossed a threshold yet.'
                    )}
                  </td>
                </tr>
              )}

              {fires.map((fire) => (
                <tr key={fire.id}>
                  <td>
                    <span title={formatAbsolute(fire.fired_at)}>
                      {formatRelative(fire.fired_at, now)}
                    </span>
                  </td>
                  <td>{fire.member_name ?? <span className="faint">{fire.member_id}</span>}</td>
                  <td className="muted">
                    {metricLabel(fire.metric).toLowerCase()},{' '}
                    {windowLabel(fire.window).toLowerCase()}
                  </td>
                  <td className="num">{fireValue(fire)}</td>
                  <td>
                    <span
                      className={deliveryTone(fire.delivery_status)}
                      title={fire.delivery_error ?? undefined}
                    >
                      {deliveryLabel(fire.delivery_status)}
                    </span>
                    {fire.delivery_error !== null && (
                      <div className="faint detail-sub">{fire.delivery_error}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** The host of a webhook URL, or the whole string if it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** How many of the listed fires belong to a rule, for the delete confirmation. */
function firesOf(fires: AlertsResponse['fires'], ruleId: string): number {
  return fires.filter((fire) => fire.rule_id === ruleId).length;
}
