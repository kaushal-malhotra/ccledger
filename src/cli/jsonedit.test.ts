/**
 * Tests for the text-level JSON editor.
 *
 * Two properties matter and everything here is one of them. The scanner must
 * agree with `JSON.parse` about what is in a document, including when a brace is
 * inside a string. And an append followed by the matching removal must give back
 * the original text character for character, whatever layout that text was
 * written in — that is the promise `ccledger uninstall` keeps, and it is kept
 * here or not at all.
 */

import { describe, expect, it } from 'vitest';

import type { JsonEntry } from './jsonedit.js';
import {
  JsonScanError,
  appendMembers,
  appendObjectMember,
  detectNewline,
  findMember,
  removeMembers,
  scanJsonDocument,
} from './jsonedit.js';

/** The entries a round trip adds and then takes away again. */
const ENTRIES: readonly JsonEntry[] = [
  { key: 'CLAUDE_CODE_ENABLE_TELEMETRY', value: '1' },
  { key: 'OTEL_LOGS_EXPORTER', value: 'otlp' },
];

/** The keys of `ENTRIES`, as removal takes them. */
const KEYS: ReadonlySet<string> = new Set(ENTRIES.map((entry) => entry.key));

/** Layouts a real `~/.claude/settings.json` might plausibly be written in. */
const LAYOUTS: readonly (readonly [string, string])[] = [
  ['an empty object', '{}\n'],
  ['an empty object spread over two lines', '{\n}\n'],
  ['an empty object with a space in it', '{ }'],
  ['no trailing newline', '{\n  "model": "opus"\n}'],
  ['two-space indentation', '{\n  "model": "opus",\n  "env": {\n    "EDITOR": "vim"\n  }\n}\n'],
  ['four-space indentation', '{\n    "env": {\n        "EDITOR": "vim"\n    }\n}\n'],
  ['tab indentation', '{\n\t"env": {\n\t\t"EDITOR": "vim"\n\t}\n}\n'],
  ['windows line endings', '{\r\n  "env": {\r\n    "EDITOR": "vim"\r\n  }\r\n}\r\n'],
  ['an empty env object', '{\n  "model": "opus",\n  "env": {}\n}\n'],
  ['an env object on its own lines', '{\n  "env":\n  {\n  }\n}\n'],
  ['everything on one line', '{"model":"opus","env":{"EDITOR":"vim"}}'],
  ['a blank line between members', '{\n  "model": "opus",\n\n  "env": {\n    "A": "1"\n  }\n}\n'],
  ['env last with nothing after it', '{\n  "hooks": {"Stop": []},\n  "env": {"A": "1"}\n}\n'],
];

/**
 * Adds the entries under `env` the way `settings.ts` does, and reports whether
 * the `env` object had to be created — which is what decides whether removal
 * takes it away again.
 */
function addEnvEntries(text: string): { readonly text: string; readonly createdEnv: boolean } {
  const root = scanJsonDocument(text);
  const member = findMember(root, 'env');
  if (member?.object === undefined) {
    return { text: appendObjectMember(text, root, 'env', ENTRIES), createdEnv: true };
  }
  return { text: appendMembers(text, root, member.object, ENTRIES), createdEnv: false };
}

/** Takes the entries back out, and `env` too when it was created and is now empty. */
function removeEnvEntries(text: string, createdEnv: boolean): string {
  const root = scanJsonDocument(text);
  const member = findMember(root, 'env');
  if (member?.object === undefined) return text;
  const trimmed = removeMembers(text, member.object, KEYS);
  if (!createdEnv) return trimmed;

  const rescanned = scanJsonDocument(trimmed);
  const rescannedEnv = findMember(rescanned, 'env');
  if (rescannedEnv?.object === undefined || rescannedEnv.object.members.length > 0) return trimmed;
  return removeMembers(trimmed, rescanned, new Set(['env']));
}

describe('scanJsonDocument', () => {
  it('finds every member of the root object in source order', () => {
    const text = '{\n  "a": 1,\n  "b": [1, 2],\n  "c": {"d": true}\n}\n';

    const root = scanJsonDocument(text);

    expect(root.members.map((member) => member.key)).toEqual(['a', 'b', 'c']);
    for (const member of root.members) {
      // Every span has to slice back out to text that parses to the same value.
      const source = text.slice(member.valueStart, member.valueEnd);
      expect(JSON.parse(source)).toEqual((JSON.parse(text) as Record<string, unknown>)[member.key]);
    }
  });

  it('is not fooled by braces, brackets or escapes inside strings', () => {
    const text = '{"a": "}{ [] \\" not a key", "b": {"c": "\\\\"}, "d": 2}';

    const root = scanJsonDocument(text);

    expect(root.members.map((member) => member.key)).toEqual(['a', 'b', 'd']);
    const b = findMember(root, 'b');
    expect(b?.object?.members.map((member) => member.key)).toEqual(['c']);
  });

  it('decodes escaped keys the way JSON.parse does', () => {
    const root = scanJsonDocument('{"a\\nb": 1, "\\u00e9": 2}');

    expect(root.members.map((member) => member.key)).toEqual(['a\nb', 'é']);
  });

  it('resolves a duplicate key to the one JSON.parse would keep', () => {
    const text = '{"env": {"A": "1"}, "env": {"B": "2"}}';

    const member = findMember(scanJsonDocument(text), 'env');

    expect(member?.object?.members.map((entry) => entry.key)).toEqual(['B']);
    expect((JSON.parse(text) as { env: Record<string, string> }).env).toEqual({ B: '2' });
  });

  it.each([
    ['an array at the root', '[1, 2]'],
    ['a bare value', '"hello"'],
    ['a trailing comma', '{"a": 1,}'],
    ['content after the object', '{"a": 1} trailing'],
    ['an unterminated string', '{"a": "x}'],
    ['nothing at all', ''],
  ])('refuses %s rather than guessing', (_label, text) => {
    expect(() => scanJsonDocument(text)).toThrow(JsonScanError);
  });
});

describe('detectNewline', () => {
  it('follows the file rather than the platform', () => {
    expect(detectNewline('{\r\n}\r\n')).toBe('\r\n');
    expect(detectNewline('{\n}\n')).toBe('\n');
    expect(detectNewline('{}')).toBe('\n');
  });
});

describe('append and remove', () => {
  it.each(LAYOUTS)('leaves %s exactly as it was found', (_label, original) => {
    const added = addEnvEntries(original);

    // The addition has to be real, and it has to say what it should.
    const parsed = JSON.parse(added.text) as { env: Record<string, string> };
    expect(parsed.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(parsed.env.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(removeEnvEntries(added.text, added.createdEnv)).toBe(original);
  });

  it.each(LAYOUTS)('changes nothing but env in %s', (_label, original) => {
    const before = JSON.parse(original) as Record<string, unknown>;

    const after = JSON.parse(addEnvEntries(original).text) as Record<string, unknown>;

    for (const [key, value] of Object.entries(before)) {
      if (key === 'env') continue;
      expect(after[key]).toEqual(value);
    }
  });

  it('keeps the file readable when it adds to an indented env', () => {
    const original = '{\n  "env": {\n    "EDITOR": "vim"\n  }\n}\n';

    const added = addEnvEntries(original).text;

    expect(added).toBe(
      '{\n  "env": {\n    "EDITOR": "vim",\n' +
        '    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",\n' +
        '    "OTEL_LOGS_EXPORTER": "otlp"\n  }\n}\n',
    );
  });

  it('writes the endings the file already uses', () => {
    const added = addEnvEntries('{\r\n  "env": {\r\n    "A": "1"\r\n  }\r\n}\r\n').text;

    expect(added).not.toMatch(/[^\r]\n/);
  });

  it('adds env beside the keys already there rather than at the top', () => {
    const original = '{\n  "model": "opus"\n}\n';

    const added = addEnvEntries(original).text;

    expect(added).toBe(
      '{\n  "model": "opus",\n  "env": {\n' +
        '    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",\n' +
        '    "OTEL_LOGS_EXPORTER": "otlp"\n  }\n}\n',
    );
  });

  it('removes several adjacent members without eating the one after them', () => {
    const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4\n}\n';

    const trimmed = removeMembers(text, scanJsonDocument(text), new Set(['b', 'c']));

    expect(trimmed).toBe('{\n  "a": 1,\n  "d": 4\n}\n');
    expect(JSON.parse(trimmed)).toEqual({ a: 1, d: 4 });
  });

  it('removes the first member without leaving a leading comma', () => {
    const text = '{\n  "a": 1,\n  "b": 2\n}\n';

    expect(removeMembers(text, scanJsonDocument(text), new Set(['a']))).toBe('{\n  "b": 2\n}\n');
  });

  it('leaves a key it was not asked about alone', () => {
    const text = '{"env": {"A": "1"}}';

    expect(removeMembers(text, scanJsonDocument(text), new Set(['other']))).toBe(text);
  });
});
