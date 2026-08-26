/**
 * The alerting half of `/api`: reading the rules, and the four verbs that
 * change them.
 *
 * Registered by `registerApiRoutes` onto the same scope as everything else
 * under `/api`, so the admin-token hook `buildApp` installs over that prefix
 * covers these too — a route added here is guarded whether or not whoever adds
 * it remembers to.
 *
 * Validation happens twice, the same way the ranged endpoints do it. The
 * Fastify schema rejects anything that is not shaped like a rule: an unknown
 * metric, a threshold that is not a number, a body carrying fields nobody
 * defined. What the schema cannot know is checked here — that a `share_pct`
 * threshold above 100 is not a percentage of anything, that a webhook URL names
 * a scheme this server will actually fetch, and that a rule naming a member
 * names one that exists. All of them are 400s, because all of them describe a
 * rule that could never fire.
 */

import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { activeAlertStates, resolveTimeZone } from './alerts.js';
import { findMember } from './auth.js';
import { JSON_CONTENT_TYPE, fail } from './reply.js';
import {
  alertRuleById,
  createAlertRule,
  deleteAlertRule,
  listAlertFires,
  listAlertRules,
  updateAlertRule,
} from '../db/alerts.js';
import type { AlertRuleInput, AlertRulePatchInput } from '../db/alerts.js';
import type {
  AlertRuleBody,
  AlertRuleDeleteResponse,
  AlertRulePatch,
  AlertRuleResponse,
  AlertsResponse,
} from '../shared/api.js';
import {
  ALERT_METRICS,
  ALERT_WINDOWS,
  MAX_SHARE_PCT,
  MAX_WEBHOOK_URL_LENGTH,
  normaliseWebhookUrl,
} from '../shared/alerts.js';
import type { AlertMetric } from '../shared/alerts.js';
import { ADMIN_API_PREFIX, ALERT_FIRES_LIMIT } from '../shared/constants.js';

/**
 * Ceiling on a `tokens` or `cost_usd` threshold.
 *
 * Not a judgement about how much anyone should use — it is the point past which
 * a double stops being able to hold an exact integer, so a threshold above it
 * would compare against a number the database cannot represent either.
 */
const MAX_THRESHOLD = Number.MAX_SAFE_INTEGER;

/** The fields a rule is made of. Shared by the create and patch schemas. */
const RULE_PROPERTIES = {
  member_id: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
  metric: { type: 'string', enum: [...ALERT_METRICS] },
  window: { type: 'string', enum: [...ALERT_WINDOWS] },
  threshold: { type: 'number', exclusiveMinimum: 0, maximum: MAX_THRESHOLD },
  webhook_url: { type: ['string', 'null'], maxLength: MAX_WEBHOOK_URL_LENGTH },
  enabled: { type: 'boolean' },
} as const;

/** `POST /api/alerts/rules`. The three fields that define a rule are required. */
const CREATE_RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['metric', 'window', 'threshold'],
  properties: RULE_PROPERTIES,
} as const;

/** `PATCH /api/alerts/rules/:id`. Any subset, including none. */
const PATCH_RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: RULE_PROPERTIES,
} as const;

/** The `:id` of a rule route. Bounded, not interpreted. */
const RULE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

/** The `:id` route parameter. */
interface RuleParams {
  readonly id: string;
}

/** A validated field, or the sentence to answer 400 with. */
type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * A threshold that means something for its metric.
 *
 * The metric matters because the unit does. 150 tokens is a small number and a
 * legitimate rule; 150 percent is not a share anyone can reach, so a rule
 * carrying it would sit in the list looking active and never fire once.
 */
export function checkThreshold(metric: AlertMetric, threshold: number): Checked<number> {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { ok: false, error: 'threshold must be greater than zero' };
  }
  if (metric === 'share_pct' && threshold > MAX_SHARE_PCT) {
    return {
      ok: false,
      error: `a share_pct threshold is a percentage, so it cannot be above ${String(MAX_SHARE_PCT)}`,
    };
  }
  if (threshold > MAX_THRESHOLD) {
    return { ok: false, error: 'threshold is larger than this server can compare against' };
  }
  return { ok: true, value: threshold };
}

/** A webhook URL as it will be stored, or the reason it will not be. */
function checkWebhookUrl(value: string | null | undefined): Checked<string | null> {
  if (value === undefined || value === null || value.trim() === '') {
    return { ok: true, value: null };
  }
  const normalised = normaliseWebhookUrl(value);
  if (normalised === undefined) {
    return { ok: false, error: 'webhook_url must be an absolute http or https URL' };
  }
  return { ok: true, value: normalised };
}

/** A member id that exists, `null` for a rule that names nobody, or a reason. */
function checkMemberId(
  db: Database.Database,
  value: string | null | undefined,
): Checked<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (findMember(db, value) === undefined) {
    return { ok: false, error: 'no such member' };
  }
  return { ok: true, value };
}

/**
 * Registers the alert routes. Takes the instance rather than being a plugin, so
 * the routes share the app's scope and the admin hook installed there.
 */
export function registerAlertRoutes(app: FastifyInstance, db: Database.Database): void {
  // Unranged, like `/api/members`: a rule is not a fact about the date range
  // the dashboard happens to be showing, and neither is being over one today.
  app.get(`${ADMIN_API_PREFIX}/alerts`, (_request, reply) => {
    const body: AlertsResponse = {
      timezone: resolveTimeZone(db),
      rules: listAlertRules(db),
      fires: listAlertFires(db, ALERT_FIRES_LIMIT),
      fires_limit: ALERT_FIRES_LIMIT,
      active: activeAlertStates(db),
    };
    reply.code(200).type(JSON_CONTENT_TYPE).send(body);
  });

  app.post<{ Body: AlertRuleBody }>(
    `${ADMIN_API_PREFIX}/alerts/rules`,
    { schema: { body: CREATE_RULE_SCHEMA } },
    (request, reply) => {
      const body = request.body;
      const threshold = checkThreshold(body.metric, body.threshold);
      if (!threshold.ok) {
        fail(reply, 400, threshold.error);
        return;
      }
      const webhookUrl = checkWebhookUrl(body.webhook_url);
      if (!webhookUrl.ok) {
        fail(reply, 400, webhookUrl.error);
        return;
      }
      const memberId = checkMemberId(db, body.member_id);
      if (!memberId.ok) {
        fail(reply, 400, memberId.error);
        return;
      }

      const input: AlertRuleInput = {
        memberId: memberId.value,
        metric: body.metric,
        window: body.window,
        threshold: threshold.value,
        webhookUrl: webhookUrl.value,
        // A new rule is on unless it says otherwise: somebody who has just
        // filled in a threshold means it to watch something.
        enabled: body.enabled ?? true,
      };
      const rule = createAlertRule(db, input);
      request.log.info(
        { ruleId: rule.id, metric: rule.metric, window: rule.window },
        'alert rule created',
      );
      const created: AlertRuleResponse = { rule };
      reply.code(201).type(JSON_CONTENT_TYPE).send(created);
    },
  );

  app.patch<{ Params: RuleParams; Body: AlertRulePatch }>(
    `${ADMIN_API_PREFIX}/alerts/rules/:id`,
    { schema: { params: RULE_PARAMS_SCHEMA, body: PATCH_RULE_SCHEMA } },
    (request, reply) => {
      const existing = alertRuleById(db, request.params.id);
      if (existing === undefined) {
        fail(reply, 404, 'no such alert rule');
        return;
      }
      const body = request.body;
      const patch: Record<string, unknown> = {};

      // The threshold is checked against whichever metric the rule will have
      // after the patch, not the one it had before: changing a `tokens` rule to
      // `share_pct` without touching its threshold is exactly how a rule ends
      // up at 4,000,000 percent.
      const metric = body.metric ?? existing.metric;
      if (body.threshold !== undefined || body.metric !== undefined) {
        const threshold = checkThreshold(metric, body.threshold ?? existing.threshold);
        if (!threshold.ok) {
          fail(reply, 400, threshold.error);
          return;
        }
        patch.threshold = threshold.value;
      }
      if (body.metric !== undefined) patch.metric = body.metric;
      if (body.window !== undefined) patch.window = body.window;
      if (body.enabled !== undefined) patch.enabled = body.enabled;

      if (body.webhook_url !== undefined) {
        const webhookUrl = checkWebhookUrl(body.webhook_url);
        if (!webhookUrl.ok) {
          fail(reply, 400, webhookUrl.error);
          return;
        }
        patch.webhookUrl = webhookUrl.value;
      }
      if (body.member_id !== undefined) {
        const memberId = checkMemberId(db, body.member_id);
        if (!memberId.ok) {
          fail(reply, 400, memberId.error);
          return;
        }
        patch.memberId = memberId.value;
      }

      const rule = updateAlertRule(db, request.params.id, patch as AlertRulePatchInput);
      if (rule === undefined) {
        // Deleted between the read above and the write. Not an error worth a
        // 500; the caller's next refresh will show it gone.
        fail(reply, 404, 'no such alert rule');
        return;
      }
      request.log.info({ ruleId: rule.id }, 'alert rule updated');
      const updated: AlertRuleResponse = { rule };
      reply.code(200).type(JSON_CONTENT_TYPE).send(updated);
    },
  );

  // Idempotent, like revocation: a second delete answers 200 with
  // `deleted: false` rather than 404, because someone clicking twice has not
  // made a mistake worth an error.
  app.delete<{ Params: RuleParams }>(
    `${ADMIN_API_PREFIX}/alerts/rules/:id`,
    { schema: { params: RULE_PARAMS_SCHEMA } },
    (request, reply) => {
      const removal = deleteAlertRule(db, request.params.id);
      if (removal.deleted) {
        request.log.info(
          { ruleId: request.params.id, firesDeleted: removal.firesDeleted },
          'alert rule deleted',
        );
      }
      const body: AlertRuleDeleteResponse = {
        rule_id: request.params.id,
        deleted: removal.deleted,
        fires_deleted: removal.firesDeleted,
      };
      reply.code(200).type(JSON_CONTENT_TYPE).send(body);
    },
  );
}
