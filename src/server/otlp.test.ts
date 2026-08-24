import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DROPPED_ATTRIBUTE_KEYS } from '../shared/constants.js';
import type { ApiRequestEvent, ClaudeCodeEvent, ParseResult } from '../shared/types.js';
import { isApiRequest, modelFamily, parseOtlpLogsPayload, toInt, toStr } from './otlp.js';

/** Raw text of a checked-in capture. Resolved against this file, never `cwd`. */
function fixtureText(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');
}

/** A checked-in capture, parsed. Typed `unknown` because that is what ingest sees. */
function fixture(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

/** Narrows away `undefined` so tests can index without non-null assertions. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

/** One OTLP attribute entry. */
function attr(key: string, value: unknown): Record<string, unknown> {
  return { key, value };
}

/** Wraps log records in the smallest valid OTLP envelope. */
function envelope(
  records: readonly unknown[],
  resourceAttributes: readonly unknown[] = [],
): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes, droppedAttributesCount: 0 },
        scopeLogs: [{ scope: { name: 'test', version: '0' }, logRecords: records }],
      },
    ],
  };
}

/** Every typed field of an event, `attributes` excluded. */
function typedFields(event: ClaudeCodeEvent): Record<string, unknown> {
  const { attributes: _attributes, ...rest } = event;
  return rest;
}

/** The four sentinel values `test/fixtures/README.md` substituted for real PII. */
const PII_SENTINELS = [
  'teammate@example.invalid',
  '22222222-2222-4222-8222-222222222222',
  'user_012FIXTUREACCOUNTID000',
  '11111111-1111-4111-8111-111111111111',
];

/** Resource attributes are identical in both captures. */
const EXPECTED_RESOURCE = {
  hostArch: 'amd64',
  osType: 'windows',
  osVersion: '10.0.26200',
  serviceName: 'claude-code',
  serviceVersion: '2.1.241',
};

describe('toInt', () => {
  const cases: ReadonlyArray<readonly [string, unknown, number | undefined]> = [
    ['a bare intValue number', 898, 898],
    ['zero', 0, 0],
    ['a negative number', -7, -7],
    ['a numeric string, as prompt_length arrives', '26', 26],
    ['a signed digit string', '-42', -42],
    ['a plus-signed digit string', '+42', 42],
    ['a padded digit string', '  898  ', 898],
    ['an OTLP intValue wrapper holding a number', { intValue: 898 }, 898],
    ['an OTLP intValue wrapper holding a string', { intValue: '898' }, 898],
    ['an OTLP stringValue wrapper holding digits', { stringValue: '26' }, 26],
    ['an OTLP doubleValue wrapper', { doubleValue: 0.000963 }, 0],
    ['a positive float, truncated toward zero', 1.9, 1],
    ['a negative float, truncated toward zero', -1.9, -1],
    ['exponent notation', '1e3', 1000],
    ['a decimal string', '1.5', 1],
    ['true', true, undefined],
    ['false', false, undefined],
    ['an OTLP boolValue wrapper', { boolValue: true }, undefined],
    ['an empty string', '', undefined],
    ['a whitespace-only string', '   ', undefined],
    ['a non-numeric string', 'abc', undefined],
    ['a partly numeric string', '12abc', undefined],
    ['a hex string', '0x10', undefined],
    ['the string Infinity', 'Infinity', undefined],
    [
      'a decimal beyond MAX_SAFE_INTEGER, where precision is already lost',
      '9007199254740993.5',
      undefined,
    ],
    ['the first digit string a double cannot represent', '9007199254740993', undefined],
    [
      'a quoted nanosecond timestamp, which only nanosToMillis may divide',
      '1787503991194000000',
      undefined,
    ],
    ['NaN', Number.NaN, undefined],
    ['Infinity', Number.POSITIVE_INFINITY, undefined],
    ['-Infinity', Number.NEGATIVE_INFINITY, undefined],
    ['a plain object', { a: 1 }, undefined],
    ['an empty object', {}, undefined],
    ['an array', [], undefined],
    ['null', null, undefined],
    ['undefined', undefined, undefined],
  ];

  for (const [label, input, expected] of cases) {
    it(`coerces ${label}`, () => {
      expect(toInt(input)).toBe(expected);
    });
  }

  it('refuses a value a double cannot hold, rather than returning a near miss', () => {
    // `String(1787503991193999872)` renders as "1787503991194000000", so an
    // assertion on the rendered form passes against a number that has already
    // lost its low digits. Compare in BigInt space, where the loss is visible.
    const parsed = toInt('1787503991194000000');

    expect(parsed).toBeUndefined();
    expect(Number('1787503991194000000')).not.toBe(1787503991194000000n);
  });

  it('is not the path a nanosecond timestamp takes: parsing keeps the exact millisecond', () => {
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1787503991194000000',
                  attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }],
                },
              ],
            },
          ],
        },
      ],
    };

    const event = parseOtlpLogsPayload(payload).events[0];

    // Dividing as a double would floor to ...193 and lose a whole millisecond.
    expect(event?.ts).toBe(1787503991194);
    expect(event?.timestampSource).toBe('timeUnixNano');
  });
});

describe('toStr', () => {
  const cases: ReadonlyArray<readonly [string, unknown, string | undefined]> = [
    ['a plain string', 'vscode', 'vscode'],
    ['an OTLP stringValue wrapper', { stringValue: 'claude-opus-5' }, 'claude-opus-5'],
    ['an OTLP intValue wrapper', { intValue: 898 }, '898'],
    ['an OTLP boolValue wrapper', { boolValue: false }, 'false'],
    ['a number', 5, '5'],
    ['an empty string, which carries no information', '', undefined],
    ['an empty stringValue wrapper', { stringValue: '' }, undefined],
    ['NaN', Number.NaN, undefined],
    ['a structured value', { arrayValue: { values: [] } }, undefined],
    ['an empty object', {}, undefined],
    ['null', null, undefined],
    ['undefined', undefined, undefined],
  ];

  for (const [label, input, expected] of cases) {
    it(`coerces ${label}`, () => {
      expect(toStr(input)).toBe(expected);
    });
  }
});

describe('modelFamily', () => {
  const cases: ReadonlyArray<readonly [string | undefined, string]> = [
    ['claude-opus-5', 'opus'],
    ['claude-sonnet-4-5-20250929', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['CLAUDE-OPUS-5', 'opus'],
    ['claude-3-5-sonnet-latest', 'sonnet'],
    ['some-other-model', 'other'],
    ['', 'other'],
    [undefined, 'other'],
  ];

  for (const [model, expected] of cases) {
    it(`groups ${String(model)} as ${expected}`, () => {
      expect(modelFamily(model)).toBe(expected);
    });
  }
});

describe('parseOtlpLogsPayload against the real captures', () => {
  it('parses 001.json into six events with no issues', () => {
    const result = parseOtlpLogsPayload(fixture('001.json'));
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.issues).toEqual([]);
    expect(result.events).toHaveLength(6);
    expect(result.counts).toEqual({
      resourceLogs: 1,
      scopeLogs: 1,
      logRecords: 6,
      parsed: 6,
      skipped: 0,
      byEventName: {
        plugin_loaded: 1,
        mcp_server_connection: 2,
        api_request: 1,
        assistant_response: 1,
        user_prompt: 1,
      },
    });
  });

  it('parses 002.json into four events with no issues', () => {
    const result = parseOtlpLogsPayload(fixture('002.json'));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.events).toHaveLength(4);
    expect(result.counts).toEqual({
      resourceLogs: 1,
      scopeLogs: 1,
      logRecords: 4,
      parsed: 4,
      skipped: 0,
      byEventName: {
        api_request: 1,
        assistant_response: 1,
        mcp_server_connection: 2,
      },
    });
  });

  it('counts every record it saw, whatever its name', () => {
    for (const name of ['001.json', '002.json']) {
      const result = parseOtlpLogsPayload(fixture(name));
      const total = Object.values(result.counts.byEventName).reduce((sum, n) => sum + n, 0);
      expect(total).toBe(result.counts.logRecords);
      expect(result.counts.parsed + result.counts.skipped).toBe(result.counts.logRecords);
    }
  });

  it('reads the resource attributes off both captures', () => {
    for (const name of ['001.json', '002.json']) {
      const result = parseOtlpLogsPayload(fixture(name));
      for (const event of result.events) {
        expect(event.resource).toEqual(EXPECTED_RESOURCE);
      }
    }
  });

  it('keeps the prefixed body and the bare event name apart', () => {
    const result = parseOtlpLogsPayload(fixture('001.json'));
    const event = must(result.events[2], 'the third record of 001.json');
    expect(event.eventName).toBe('api_request');
    expect(event.body).toBe('claude_code.api_request');
  });
});

describe('the two api_request records', () => {
  const first = parseOtlpLogsPayload(fixture('001.json'));
  const second = parseOtlpLogsPayload(fixture('002.json'));
  const apiRequests: readonly ApiRequestEvent[] = [...first.events, ...second.events].filter(
    isApiRequest,
  );

  it('finds exactly two across both captures', () => {
    expect(apiRequests).toHaveLength(2);
  });

  it('parses every typed field of the haiku request in 001.json', () => {
    const event = must(apiRequests[0], 'the api_request in 001.json');
    expect(typedFields(event)).toEqual({
      kind: 'api_request',
      eventName: 'api_request',
      ts: 1787503991194,
      timestampSource: 'event.timestamp',
      userId: 'aa83f64c6c308f626d85d6deae05eaecdba5eb615a4eea59c16587dd417a6396',
      sessionId: 'bc697788-f3f4-493b-80cc-2a03174c8861',
      terminalType: 'vscode',
      eventSequence: 2,
      body: 'claude_code.api_request',
      resource: EXPECTED_RESOURCE,
      model: 'claude-haiku-4-5-20251001',
      modelFamily: 'haiku',
      inputTokens: 898,
      outputTokens: 13,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costMicros: 963,
      durationMs: 1014,
      requestId: 'req_011CeL2bXveDkmU34ZSs7Tev',
      clientRequestId: 'f1f6314c-4ac2-4e04-afc4-6e2b7b477bd6',
      querySource: 'generate_session_title',
      speed: 'normal',
    });
  });

  it('leaves promptId and effort off the haiku request rather than throwing', () => {
    const event = must(apiRequests[0], 'the api_request in 001.json');
    expect(event.promptId).toBeUndefined();
    expect(event.effort).toBeUndefined();
    expect('promptId' in event).toBe(false);
    expect('effort' in event).toBe(false);
  });

  it('parses every typed field of the opus request in 002.json', () => {
    const event = must(apiRequests[1], 'the api_request in 002.json');
    expect(typedFields(event)).toEqual({
      kind: 'api_request',
      eventName: 'api_request',
      ts: 1787503997172,
      timestampSource: 'event.timestamp',
      userId: 'aa83f64c6c308f626d85d6deae05eaecdba5eb615a4eea59c16587dd417a6396',
      sessionId: 'bc697788-f3f4-493b-80cc-2a03174c8861',
      terminalType: 'vscode',
      promptId: '4fc4bb31-78d6-48ed-8d5c-13c3417a6f4f',
      eventSequence: 6,
      body: 'claude_code.api_request',
      resource: EXPECTED_RESOURCE,
      model: 'claude-opus-5',
      modelFamily: 'opus',
      inputTokens: 2,
      outputTokens: 317,
      cacheReadTokens: 21360,
      cacheCreationTokens: 8097,
      costMicros: 99585,
      durationMs: 4919,
      requestId: 'req_011CeL2bghV84BmU8827fY5u',
      clientRequestId: '4c5693d6-70ad-4503-bc26-47b1816fd1f9',
      querySource: 'sdk',
      speed: 'normal',
      effort: 'xhigh',
    });
  });

  it('takes cost from cost_usd_micros and leaves the float in the attribute map', () => {
    const haiku = must(apiRequests[0], 'the api_request in 001.json');
    const opus = must(apiRequests[1], 'the api_request in 002.json');
    expect(haiku.costMicros).toBe(963);
    expect(opus.costMicros).toBe(99585);
    expect(haiku.attributes['cost_usd']).toBe(0.000963);
    expect(opus.attributes['cost_usd']).toBe(0.099585);
  });

  it('coerces int-valued attributes into numbers in the attribute map', () => {
    const haiku = must(apiRequests[0], 'the api_request in 001.json');
    expect(haiku.attributes['input_tokens']).toBe(898);
    expect(haiku.attributes['event.sequence']).toBe(2);
  });
});

describe('numeric-string attributes elsewhere in the captures', () => {
  it('coerces prompt_length, which arrives as a string', () => {
    const result = parseOtlpLogsPayload(fixture('001.json'));
    const prompts = result.events.filter((event) => event.eventName === 'user_prompt');
    const event = must(prompts[0], 'the user_prompt record');
    expect(toInt(event.attributes['prompt_length'])).toBe(26);
    expect(event.promptId).toBe('4fc4bb31-78d6-48ed-8d5c-13c3417a6f4f');
  });
});

describe('privacy', () => {
  it('drops every dropped key from every parsed event', () => {
    for (const name of ['001.json', '002.json']) {
      const result = parseOtlpLogsPayload(fixture(name));
      for (const event of result.events) {
        for (const key of DROPPED_ATTRIBUTE_KEYS) {
          expect(Object.hasOwn(event.attributes, key)).toBe(false);
        }
      }
    }
  });

  it('leaves no PII sentinel anywhere in the serialised parse result', () => {
    for (const name of ['001.json', '002.json']) {
      const raw = fixtureText(name);
      const serialised = JSON.stringify(parseOtlpLogsPayload(fixture(name)));
      for (const sentinel of PII_SENTINELS) {
        // Prove the capture still contains it, or the assertion below is vacuous.
        expect(raw).toContain(sentinel);
        expect(serialised).not.toContain(sentinel);
      }
      // `prompt` and `response` ship as `<REDACTED>` with content logging off;
      // ccledger drops the keys by name rather than trusting that.
      expect(serialised).not.toContain('<REDACTED>');
    }
  });
});

describe('timestamp precedence', () => {
  const iso = '2026-08-23T16:53:11.194Z';

  it('prefers event.timestamp over the nanosecond fields', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          timeUnixNano: '1787599999999000000',
          observedTimeUnixNano: '1787699999999000000',
          attributes: [
            attr('event.name', { stringValue: 'api_request' }),
            attr('event.timestamp', { stringValue: iso }),
          ],
        },
      ]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.ts).toBe(1787503991194);
    expect(event.timestampSource).toBe('event.timestamp');
  });

  it('falls back to timeUnixNano, dividing exactly', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          timeUnixNano: '1787503991194000000',
          observedTimeUnixNano: '1787699999999000000',
          attributes: [attr('event.name', { stringValue: 'api_request' })],
        },
      ]),
    );
    const event = must(result.events[0], 'the record');
    // Double division floors this to ...193; only BigInt keeps the millisecond.
    expect(event.ts).toBe(1787503991194);
    expect(event.timestampSource).toBe('timeUnixNano');
  });

  it('falls back to observedTimeUnixNano when timeUnixNano is absent', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          observedTimeUnixNano: '1787503992281000000',
          attributes: [attr('event.name', { stringValue: 'user_prompt' })],
        },
      ]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.ts).toBe(1787503992281);
    expect(event.timestampSource).toBe('observedTimeUnixNano');
  });

  it('reports ts 0 and missing when no field is usable', () => {
    const result = parseOtlpLogsPayload(
      envelope([{ attributes: [attr('event.name', { stringValue: 'user_prompt' })] }]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.ts).toBe(0);
    expect(event.timestampSource).toBe('missing');
  });

  it('ignores an unparseable event.timestamp and uses the nanosecond field', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          timeUnixNano: '1787503991194000000',
          attributes: [
            attr('event.name', { stringValue: 'api_request' }),
            attr('event.timestamp', { stringValue: 'not-a-date' }),
          ],
        },
      ]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.ts).toBe(1787503991194);
    expect(event.timestampSource).toBe('timeUnixNano');
  });
});

describe('attribute flattening', () => {
  it('lets a record attribute win over a resource attribute of the same key', () => {
    const result = parseOtlpLogsPayload(
      envelope(
        [
          {
            attributes: [
              attr('event.name', { stringValue: 'api_request' }),
              attr('terminal.type', { stringValue: 'vscode' }),
            ],
          },
        ],
        [
          attr('terminal.type', { stringValue: 'resource-loses' }),
          attr('service.version', { stringValue: '2.1.241' }),
        ],
      ),
    );
    expect(result.issues).toEqual([]);
    const event = must(result.events[0], 'the record');
    expect(event.attributes['terminal.type']).toBe('vscode');
    expect(event.terminalType).toBe('vscode');
    expect(event.attributes['service.version']).toBe('2.1.241');
  });

  it('stringifies value kinds it does not model rather than dropping them', () => {
    const arrayValue = { arrayValue: { values: [{ stringValue: 'a' }, { intValue: 2 }] } };
    const kvlistValue = { kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } };
    const result = parseOtlpLogsPayload(
      envelope([
        {
          attributes: [
            attr('event.name', { stringValue: 'tool_result' }),
            attr('tags', arrayValue),
            attr('meta', kvlistValue),
          ],
        },
      ]),
    );
    expect(result.issues).toEqual([]);
    const event = must(result.events[0], 'the record');
    expect(event.attributes['tags']).toBe(JSON.stringify(arrayValue));
    expect(event.attributes['meta']).toBe(JSON.stringify(kvlistValue));
  });

  it('keeps boolean and double attributes as their own types', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          attributes: [
            attr('event.name', { stringValue: 'plugin_loaded' }),
            attr('has_hooks', { boolValue: false }),
            attr('cost_usd', { doubleValue: 0.000963 }),
          ],
        },
      ]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.attributes['has_hooks']).toBe(false);
    expect(event.attributes['cost_usd']).toBe(0.000963);
  });
});

describe('api_request defaults', () => {
  it('defaults token and cost fields to zero and leaves the rest undefined', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          attributes: [
            attr('event.name', { stringValue: 'api_request' }),
            // Present on purpose: costMicros must never be derived from it.
            attr('cost_usd', { doubleValue: 0.5 }),
          ],
        },
      ]),
    );
    const event = must(result.events[0], 'the record');
    if (!isApiRequest(event)) throw new Error('expected an api_request event');
    expect(event.inputTokens).toBe(0);
    expect(event.outputTokens).toBe(0);
    expect(event.cacheReadTokens).toBe(0);
    expect(event.cacheCreationTokens).toBe(0);
    expect(event.costMicros).toBe(0);
    expect(event.durationMs).toBeUndefined();
    expect(event.model).toBeUndefined();
    expect(event.modelFamily).toBe('other');
    expect(event.requestId).toBeUndefined();
    expect(event.clientRequestId).toBeUndefined();
  });

  it('classifies anything that is not api_request as other', () => {
    const result = parseOtlpLogsPayload(
      envelope([{ attributes: [attr('event.name', { stringValue: 'mcp_server_connection' })] }]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.kind).toBe('other');
    expect(isApiRequest(event)).toBe(false);
  });

  it('names a record with no event.name attribute the empty string', () => {
    const result = parseOtlpLogsPayload(envelope([{ attributes: [] }]));
    const event = must(result.events[0], 'the record');
    expect(event.eventName).toBe('');
    expect(result.counts.byEventName).toEqual({ '': 1 });
  });
});

describe('malformed envelopes', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'resourceLogs'],
    ['an array', []],
    ['an empty object', {}],
    ['resourceLogs as a string', { resourceLogs: 'nope' }],
    ['resourceLogs as a number', { resourceLogs: 1 }],
    ['resourceLogs as an object', { resourceLogs: { 0: {} } }],
    ['an object truncated before resourceLogs', { resource: { attributes: [] } }],
    ['capture text truncated mid-record and never parsed', fixtureText('001.json').slice(0, 200)],
  ];

  for (const [label, input] of cases) {
    it(`rejects ${label} with ok false and no exception`, () => {
      expect(() => parseOtlpLogsPayload(input)).not.toThrow();
      const result: ParseResult = parseOtlpLogsPayload(input);
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error).not.toBe('');
      expect(result.events).toEqual([]);
      expect(result.counts.logRecords).toBe(0);
      expect(result.issues).toEqual([]);
    });
  }

  it('accepts an empty resourceLogs array as a valid, empty batch', () => {
    const result = parseOtlpLogsPayload({ resourceLogs: [] });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.events).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.counts).toEqual({
      resourceLogs: 0,
      scopeLogs: 0,
      logRecords: 0,
      parsed: 0,
      skipped: 0,
      byEventName: {},
    });
  });
});

describe('hostile shapes below the envelope', () => {
  it('keeps the good records when one is garbage', () => {
    const good = {
      timeUnixNano: '1787503991194000000',
      attributes: [attr('event.name', { stringValue: 'api_request' })],
    };
    const alsoGood = {
      timeUnixNano: '1787503992225000000',
      attributes: [attr('event.name', { stringValue: 'user_prompt' })],
    };
    const result = parseOtlpLogsPayload(envelope([good, null, alsoGood]));
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(must(result.issues[0], 'the issue').path).toBe(
      'resourceLogs[0].scopeLogs[0].logRecords[1]',
    );
    expect(result.counts.logRecords).toBe(3);
    expect(result.counts.parsed).toBe(2);
    expect(result.counts.skipped).toBe(1);
    expect(result.counts.byEventName).toEqual({ api_request: 1, user_prompt: 1, '': 1 });
  });

  const shapes: ReadonlyArray<readonly [string, unknown]> = [
    ['a resourceLogs entry that is null', { resourceLogs: [null] }],
    ['a resourceLogs entry that is a string', { resourceLogs: ['nope'] }],
    ['a resource that is a string', { resourceLogs: [{ resource: 'nope', scopeLogs: [] }] }],
    [
      'resource attributes that are an object',
      { resourceLogs: [{ resource: { attributes: {} } }] },
    ],
    ['scopeLogs that is a string', { resourceLogs: [{ scopeLogs: 'nope' }] }],
    ['a scopeLogs entry that is a string', { resourceLogs: [{ scopeLogs: ['nope'] }] }],
    ['logRecords that is a string', { resourceLogs: [{ scopeLogs: [{ logRecords: 'nope' }] }] }],
    ['a log record that is a number', { resourceLogs: [{ scopeLogs: [{ logRecords: [7] }] }] }],
  ];

  for (const [label, input] of shapes) {
    it(`reports ${label} as an issue and keeps going`, () => {
      expect(() => parseOtlpLogsPayload(input)).not.toThrow();
      const result = parseOtlpLogsPayload(input);
      expect(result.ok).toBe(true);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      for (const issue of result.issues) {
        expect(issue.path).not.toBe('');
        expect(issue.reason).not.toBe('');
      }
    });
  }

  it('reports record attributes that are an object, and still emits the event', () => {
    const result = parseOtlpLogsPayload(
      envelope([{ attributes: { 'event.name': 'api_request' } }]),
    );
    expect(result.events).toHaveLength(1);
    expect(must(result.events[0], 'the record').eventName).toBe('');
    expect(result.issues).toHaveLength(1);
    expect(must(result.issues[0], 'the issue').reason).toBe('attributes is not an array');
  });

  it('reports an attribute whose value is null and keeps the rest', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        { attributes: [attr('event.name', { stringValue: 'api_request' }), attr('speed', null)] },
      ]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.eventName).toBe('api_request');
    expect(Object.hasOwn(event.attributes, 'speed')).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(must(result.issues[0], 'the issue').reason).toContain("attribute 'speed'");
  });

  it('reports an attribute with no key', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          attributes: [attr('event.name', { stringValue: 'api_request' }), { value: 'orphan' }],
        },
      ]),
    );
    expect(result.events).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(must(result.issues[0], 'the issue').reason).toBe('attribute has no key');
  });

  it('reports a duplicate attribute key and keeps the last value', () => {
    const result = parseOtlpLogsPayload(
      envelope([
        {
          attributes: [
            attr('event.name', { stringValue: 'api_request' }),
            attr('speed', { stringValue: 'fast' }),
            attr('speed', { stringValue: 'normal' }),
          ],
        },
      ]),
    );
    const event = must(result.events[0], 'the record');
    expect(event.attributes['speed']).toBe('normal');
    expect(result.issues).toHaveLength(1);
    expect(must(result.issues[0], 'the issue').reason).toContain('duplicate attribute key');
  });

  it('never lets a dropped key through, whatever shape it arrives in', () => {
    const result = parseOtlpLogsPayload(
      envelope(
        [
          {
            attributes: [
              attr('event.name', { stringValue: 'user_prompt' }),
              attr('prompt', { stringValue: 'secret text' }),
              attr('user.email', { stringValue: 'someone@example.invalid' }),
            ],
          },
        ],
        [attr('organization.id', { stringValue: '11111111-1111-4111-8111-111111111111' })],
      ),
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('secret text');
    expect(serialised).not.toContain('someone@example.invalid');
    expect(serialised).not.toContain('11111111-1111-4111-8111-111111111111');
    const event = must(result.events[0], 'the record');
    for (const key of DROPPED_ATTRIBUTE_KEYS) {
      expect(Object.hasOwn(event.attributes, key)).toBe(false);
    }
  });

  it('walks every resourceLogs and scopeLogs entry, not just the first', () => {
    const record = (name: string): unknown => ({
      timeUnixNano: '1787503991194000000',
      attributes: [attr('event.name', { stringValue: name })],
    });
    const result = parseOtlpLogsPayload({
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            { logRecords: [record('api_request')] },
            { logRecords: [record('user_prompt')] },
          ],
        },
        {
          resource: { attributes: [] },
          scopeLogs: [{ logRecords: [record('api_request')] }],
        },
      ],
    });
    expect(result.events).toHaveLength(3);
    expect(result.counts).toEqual({
      resourceLogs: 2,
      scopeLogs: 3,
      logRecords: 3,
      parsed: 3,
      skipped: 0,
      byEventName: { api_request: 2, user_prompt: 1 },
    });
  });
});
