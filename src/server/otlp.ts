/**
 * OTLP/HTTP JSON logs parser: one exported payload in, typed Claude Code events
 * out. Every number the dashboard shows passes through this file, so nothing is
 * trusted — not the nesting, not the JSON type of a number, not the presence of
 * any field — and nothing here throws. Unusable sub-trees become `ParseIssue`s
 * and parsing continues with what remains.
 */

import { DROPPED_ATTRIBUTE_KEYS } from '../shared/constants.js';
import type {
  ApiRequestEvent,
  AttributeValue,
  BaseEvent,
  ClaudeCodeEvent,
  GenericEvent,
  ModelFamily,
  ParseCounts,
  ParseIssue,
  ParseResult,
  ResourceInfo,
  TimestampSource,
} from '../shared/types.js';

/** Nanoseconds per millisecond, as BigInt so timestamp division stays exact. */
const NANOS_PER_MILLI = 1_000_000n;

/** An optionally signed run of ASCII digits — the only form `BigInt` accepts. */
const DIGIT_STRING = /^[+-]?\d+$/;

/** Decimal or exponent notation. Excludes hex, `Infinity`, and bare whitespace. */
const DECIMAL_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** OTLP scalar value wrappers, in the order a mixed wrapper is resolved. */
const SCALAR_VALUE_KEYS = ['stringValue', 'intValue', 'doubleValue', 'boolValue'] as const;

/** A plain JSON object. Arrays and `null` are not records. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unwraps an OTLP scalar value wrapper (`{intValue: 898}`) to its payload, and
 * returns anything else unchanged. Callers therefore accept both a raw value and
 * the wrapper it arrived in without a second code path.
 */
function unwrapScalar(value: unknown): unknown {
  if (!isRecordObject(value)) return value;
  for (const key of SCALAR_VALUE_KEYS) {
    if (key in value) return value[key];
  }
  return value;
}

/** `JSON.stringify` that yields `undefined` instead of throwing on hostile input. */
function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single numeric coercion in this file. Accepts bare numbers, numeric
 * strings, and OTLP wrappers; rejects booleans, objects, empty and non-numeric
 * strings, `NaN` and `Infinity`. Floats truncate toward zero.
 */
export function toInt(value: unknown): number | undefined {
  const raw = unwrapScalar(value);
  // Booleans coerce to 0/1 in JS, which would silently turn a flag into a count.
  if (typeof raw === 'boolean') return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : undefined;
  if (typeof raw !== 'string') return undefined;

  const text = raw.trim();
  if (text === '') return undefined;
  if (DIGIT_STRING.test(text)) {
    // BigInt first, so the magnitude is known exactly before a double is
    // involved. Past MAX_SAFE_INTEGER a double cannot hold the value and
    // `Number()` would return a neighbouring integer that looks plausible —
    // no number beats a wrong one. Nanosecond timestamps do exceed that
    // bound, which is why `nanosToMillis` divides in BigInt space instead of
    // coming through here.
    const parsed = BigInt(text);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
  }
  if (!DECIMAL_STRING.test(text)) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return undefined;
  // A decimal that large already lost digits inside `Number`; a wrong number is
  // worse than no number.
  if (Math.abs(parsed) > Number.MAX_SAFE_INTEGER) return undefined;
  return Math.trunc(parsed);
}

/**
 * String coercion for typed fields. Unwraps OTLP wrappers, renders finite
 * numbers and booleans, and treats the empty string as absent.
 */
export function toStr(value: unknown): string | undefined {
  const raw = unwrapScalar(value);
  if (typeof raw === 'string') return raw === '' ? undefined : raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : undefined;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return undefined;
}

/** Groups a raw model string by family; anything unrecognised is `other`. */
export function modelFamily(model: string | undefined): ModelFamily {
  if (model === undefined) return 'other';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return 'other';
}

/**
 * Nanoseconds to epoch milliseconds. Digit strings divide as BigInt because
 * `Number('1787503991194000000') / 1e6` floors to ...193 — the double cannot
 * hold the nanosecond value exactly and the lost bit costs a whole millisecond.
 */
function nanosToMillis(value: unknown): number | undefined {
  const raw = unwrapScalar(value);
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (DIGIT_STRING.test(text)) {
      const millis = Number(BigInt(text) / NANOS_PER_MILLI);
      return Number.isSafeInteger(millis) ? millis : undefined;
    }
  }
  const nanos = toInt(value);
  return nanos === undefined ? undefined : Math.floor(nanos / 1e6);
}

/**
 * Flattens one OTLP `value` wrapper to a scalar. Kinds this version does not
 * model (`arrayValue`, `kvlistValue`, `bytesValue`, anything newer) keep their
 * raw JSON rather than vanishing, so schema drift shows up as data, not silence.
 */
function attributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!isRecordObject(value)) return undefined;
  // `{}` is OTLP's unset value, not a structure worth stringifying.
  if (Object.keys(value).length === 0) return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if ('intValue' in value) return toInt(value.intValue) ?? safeJson(value);
  if ('doubleValue' in value) {
    const double = value.doubleValue;
    if (typeof double === 'number' && Number.isFinite(double)) return double;
    return safeJson(value);
  }
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  return safeJson(value);
}

/**
 * Merges one OTLP attribute array into `target`, later keys winning. Dropped
 * keys are never written, so PII and content cannot reach an event even by
 * accident. Every unusable entry becomes an issue instead of an exception.
 */
function collectAttributes(
  raw: unknown,
  target: Map<string, AttributeValue>,
  path: string,
  issues: ParseIssue[],
): void {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    issues.push({ path, reason: 'attributes is not an array' });
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const entryPath = `${path}[${i}]`;
    const entry: unknown = raw[i];
    if (!isRecordObject(entry)) {
      issues.push({ path: entryPath, reason: 'attribute entry is not an object' });
      continue;
    }
    const key = typeof entry.key === 'string' ? entry.key : undefined;
    if (key === undefined || key === '') {
      issues.push({ path: entryPath, reason: 'attribute has no key' });
      continue;
    }
    const value = attributeValue(entry.value);
    if (value === undefined) {
      // Reasons are logged, so they name the key but never the value.
      issues.push({ path: entryPath, reason: `attribute '${key}' has no usable value` });
      continue;
    }
    if (seen.has(key)) {
      issues.push({ path: entryPath, reason: `duplicate attribute key '${key}'; last one wins` });
    }
    seen.add(key);
    if (DROPPED_ATTRIBUTE_KEYS.has(key)) continue;
    target.set(key, value);
  }
}

/** Projects the resource attribute map onto the fields ccledger records. */
function toResourceInfo(attributes: ReadonlyMap<string, AttributeValue>): ResourceInfo {
  const hostArch = toStr(attributes.get('host.arch'));
  const osType = toStr(attributes.get('os.type'));
  const osVersion = toStr(attributes.get('os.version'));
  const serviceName = toStr(attributes.get('service.name'));
  const serviceVersion = toStr(attributes.get('service.version'));
  const claudeProfile = toStr(attributes.get('claude_profile'));
  return {
    ...(hostArch !== undefined ? { hostArch } : {}),
    ...(osType !== undefined ? { osType } : {}),
    ...(osVersion !== undefined ? { osVersion } : {}),
    ...(serviceName !== undefined ? { serviceName } : {}),
    ...(serviceVersion !== undefined ? { serviceVersion } : {}),
    ...(claudeProfile !== undefined ? { claudeProfile } : {}),
  };
}

/** Resolved event time plus the field it came from. */
interface ResolvedTimestamp {
  readonly ts: number;
  readonly timestampSource: TimestampSource;
}

/**
 * `event.timestamp` (unambiguous ISO 8601) beats `timeUnixNano` beats
 * `observedTimeUnixNano`. Nothing usable is reported as `missing` with ts 0 —
 * substituting `Date.now()` would invent data that looks real on a chart.
 */
function resolveTimestamp(
  record: Record<string, unknown>,
  attributes: ReadonlyMap<string, AttributeValue>,
): ResolvedTimestamp {
  const iso = attributes.get('event.timestamp');
  // Only a genuine string is date-parsed: `Date.parse` on a rendered number is
  // implementation-defined and can yield a plausible-looking wrong year.
  if (typeof iso === 'string') {
    const millis = Date.parse(iso);
    if (Number.isFinite(millis)) return { ts: millis, timestampSource: 'event.timestamp' };
  }
  const emitted = nanosToMillis(record.timeUnixNano);
  if (emitted !== undefined) return { ts: emitted, timestampSource: 'timeUnixNano' };
  const observed = nanosToMillis(record.observedTimeUnixNano);
  if (observed !== undefined) return { ts: observed, timestampSource: 'observedTimeUnixNano' };
  return { ts: 0, timestampSource: 'missing' };
}

/** Builds the typed event for one log record from its merged attribute map. */
function buildEvent(
  record: Record<string, unknown>,
  resource: ResourceInfo,
  attributes: ReadonlyMap<string, AttributeValue>,
  eventName: string,
): ClaudeCodeEvent {
  const { ts, timestampSource } = resolveTimestamp(record, attributes);
  const userId = toStr(attributes.get('user.id'));
  const sessionId = toStr(attributes.get('session.id'));
  const terminalType = toStr(attributes.get('terminal.type'));
  const promptId = toStr(attributes.get('prompt.id'));
  const eventSequence = toInt(attributes.get('event.sequence'));
  const body = toStr(record.body);

  const base: BaseEvent = {
    eventName,
    ts,
    timestampSource,
    resource,
    attributes: Object.fromEntries(attributes),
    ...(userId !== undefined ? { userId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(terminalType !== undefined ? { terminalType } : {}),
    ...(promptId !== undefined ? { promptId } : {}),
    ...(eventSequence !== undefined ? { eventSequence } : {}),
    ...(body !== undefined ? { body } : {}),
  };

  if (eventName !== 'api_request') {
    const generic: GenericEvent = { ...base, kind: 'other' };
    return generic;
  }

  const model = toStr(attributes.get('model'));
  const durationMs = toInt(attributes.get('duration_ms'));
  const requestId = toStr(attributes.get('request_id'));
  const clientRequestId = toStr(attributes.get('client_request_id'));
  const querySource = toStr(attributes.get('query_source'));
  const speed = toStr(attributes.get('speed'));
  const effort = toStr(attributes.get('effort'));

  const apiRequest: ApiRequestEvent = {
    ...base,
    kind: 'api_request',
    eventName: 'api_request',
    modelFamily: modelFamily(model),
    inputTokens: toInt(attributes.get('input_tokens')) ?? 0,
    outputTokens: toInt(attributes.get('output_tokens')) ?? 0,
    cacheReadTokens: toInt(attributes.get('cache_read_tokens')) ?? 0,
    cacheCreationTokens: toInt(attributes.get('cache_creation_tokens')) ?? 0,
    // Only ever the integer: `cost_usd` is a float whose rounding differs from
    // Claude Code's own, so deriving micros from it would drift.
    costMicros: toInt(attributes.get('cost_usd_micros')) ?? 0,
    ...(model !== undefined ? { model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(clientRequestId !== undefined ? { clientRequestId } : {}),
    ...(querySource !== undefined ? { querySource } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
  return apiRequest;
}

/** Mutable counters assembled during a parse and frozen into `ParseCounts`. */
interface Tally {
  resourceLogs: number;
  scopeLogs: number;
  logRecords: number;
  parsed: number;
  skipped: number;
  readonly byEventName: Record<string, number>;
}

/** A fresh zeroed tally. */
function newTally(): Tally {
  // A null-prototype object, not {}: event names come from the exporter, and
  // an event called __proto__ or constructor would otherwise read back an
  // inherited member instead of a count — losing the tally or returning a
  // function where the type promises a number.
  return {
    resourceLogs: 0,
    scopeLogs: 0,
    logRecords: 0,
    parsed: 0,
    skipped: 0,
    byEventName: Object.create(null) as Record<string, number>,
  };
}

/** Records one sighting of an event name, `''` for a record that had none. */
function countName(tally: Tally, name: string): void {
  tally.byEventName[name] = (tally.byEventName[name] ?? 0) + 1;
}

/** Freezes a tally into the shape callers see. */
function toCounts(tally: Tally): ParseCounts {
  return {
    resourceLogs: tally.resourceLogs,
    scopeLogs: tally.scopeLogs,
    logRecords: tally.logRecords,
    parsed: tally.parsed,
    skipped: tally.skipped,
    byEventName: tally.byEventName,
  };
}

/** The `ok: false` result: the envelope itself was unusable, so answer 400. */
function envelopeFailure(error: string): ParseResult {
  return { ok: false, error, events: [], counts: toCounts(newTally()), issues: [] };
}

/**
 * Parses one OTLP/HTTP JSON logs payload. Never throws: `ok` is false only when
 * the envelope itself is unusable, and every lesser problem is an issue beside
 * the events that did parse.
 */
export function parseOtlpLogsPayload(payload: unknown): ParseResult {
  if (!isRecordObject(payload)) return envelopeFailure('payload is not a JSON object');
  const resourceLogs: unknown = payload.resourceLogs;
  if (resourceLogs === undefined || resourceLogs === null) {
    return envelopeFailure('payload has no resourceLogs array');
  }
  if (!Array.isArray(resourceLogs)) return envelopeFailure('resourceLogs is not an array');

  const issues: ParseIssue[] = [];
  const events: ClaudeCodeEvent[] = [];
  const tally = newTally();
  tally.resourceLogs = resourceLogs.length;

  for (let i = 0; i < resourceLogs.length; i += 1) {
    const resourcePath = `resourceLogs[${i}]`;
    const entry: unknown = resourceLogs[i];
    if (!isRecordObject(entry)) {
      issues.push({ path: resourcePath, reason: 'resourceLogs entry is not an object' });
      continue;
    }

    const resourceAttributes = new Map<string, AttributeValue>();
    const rawResource: unknown = entry.resource;
    if (rawResource !== undefined && rawResource !== null) {
      if (isRecordObject(rawResource)) {
        collectAttributes(
          rawResource.attributes,
          resourceAttributes,
          `${resourcePath}.resource.attributes`,
          issues,
        );
      } else {
        issues.push({ path: `${resourcePath}.resource`, reason: 'resource is not an object' });
      }
    }
    const resource = toResourceInfo(resourceAttributes);

    const scopeLogs: unknown = entry.scopeLogs;
    if (scopeLogs === undefined || scopeLogs === null) continue;
    if (!Array.isArray(scopeLogs)) {
      issues.push({ path: `${resourcePath}.scopeLogs`, reason: 'scopeLogs is not an array' });
      continue;
    }

    for (let j = 0; j < scopeLogs.length; j += 1) {
      const scopePath = `${resourcePath}.scopeLogs[${j}]`;
      tally.scopeLogs += 1;
      const scopeEntry: unknown = scopeLogs[j];
      if (!isRecordObject(scopeEntry)) {
        issues.push({ path: scopePath, reason: 'scopeLogs entry is not an object' });
        continue;
      }
      const logRecords: unknown = scopeEntry.logRecords;
      if (logRecords === undefined || logRecords === null) continue;
      if (!Array.isArray(logRecords)) {
        issues.push({ path: `${scopePath}.logRecords`, reason: 'logRecords is not an array' });
        continue;
      }

      for (let k = 0; k < logRecords.length; k += 1) {
        const recordPath = `${scopePath}.logRecords[${k}]`;
        tally.logRecords += 1;
        const record: unknown = logRecords[k];
        if (!isRecordObject(record)) {
          issues.push({ path: recordPath, reason: 'log record is not an object' });
          countName(tally, '');
          tally.skipped += 1;
          continue;
        }
        let eventName = '';
        try {
          // The record wins on collision, so resource attributes go in first.
          const attributes = new Map(resourceAttributes);
          collectAttributes(record.attributes, attributes, `${recordPath}.attributes`, issues);
          eventName = toStr(attributes.get('event.name')) ?? '';
          events.push(buildEvent(record, resource, attributes, eventName));
          tally.parsed += 1;
        } catch (error) {
          // Belt and braces: a record must never be able to fail the batch.
          const reason = error instanceof Error ? error.message : 'unknown error';
          issues.push({ path: recordPath, reason: `log record could not be parsed: ${reason}` });
          tally.skipped += 1;
        }
        // Counted exactly once either way, so byEventName always sums to logRecords.
        countName(tally, eventName);
      }
    }
  }

  return { ok: true, events, counts: toCounts(tally), issues };
}

/** Narrows a parsed event to the one type ccledger persists today. */
export function isApiRequest(event: ClaudeCodeEvent): event is ApiRequestEvent {
  return event.kind === 'api_request';
}
