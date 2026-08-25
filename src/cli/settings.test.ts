/**
 * Tests for the settings reader and writer, against real files in a temporary
 * home directory.
 *
 * The acceptance criterion for this stage is a sentence about someone else's
 * file: setup adds five keys to a settings file full of permissions and hooks
 * and touches nothing else, and uninstall gives that file back. Both halves are
 * asserted here on the bytes, not on the parsed value — a file that is only
 * equivalent to the one someone had is a file that shows up in their next
 * `git diff`.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { JsonEntry } from './jsonedit.js';
import { resolveClientPaths } from './paths.js';
import {
  LOGS_ENDPOINT_KEY,
  LOGS_EXPORTER_KEY,
  LOGS_HEADERS_KEY,
  LOGS_PROTOCOL_KEY,
  SettingsError,
  TELEMETRY_ENABLED_KEY,
  findContentLogging,
  findEnvConflicts,
  isTruthyFlag,
  readSettings,
  removeEnvKeys,
  writeEnvEntries,
} from './settings.js';
import { digestValue } from './state.js';

/** A settings file someone has actually configured, used as the "do not touch" case. */
const REALISTIC_SETTINGS = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(npm run test:*)", "Read(~/.zshrc)"],
    "deny": ["Bash(curl:*)"]
  },
  "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "say done" }] }]
  },
  "env": {
    "EDITOR": "vim"
  },
  "statusLine": { "type": "command", "command": "ccstatus" }
}
`;

/** The five entries setup writes. */
const ENTRIES: readonly JsonEntry[] = [
  { key: TELEMETRY_ENABLED_KEY, value: '1' },
  { key: LOGS_EXPORTER_KEY, value: 'otlp' },
  { key: LOGS_PROTOCOL_KEY, value: 'http/json' },
  { key: LOGS_ENDPOINT_KEY, value: 'https://meter.example.com/v1/logs' },
  { key: LOGS_HEADERS_KEY, value: 'Authorization=Bearer ccm_ABCDEFGHIJKLMNOPQRSTUVWX' },
];

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Where a test's files live. */
type Paths = ReturnType<typeof resolveClientPaths>;

/** A temporary home directory, removed after the test whatever it did. */
function tempHome(): Paths {
  const home = mkdtempSync(join(tmpdir(), 'ccledger-home-'));
  homes.push(home);
  return resolveClientPaths(home);
}

/** Writes a settings file into a temporary home, creating `~/.claude` first. */
function writeSettingsFile(paths: Paths, text: string): void {
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(paths.settingsPath, text, 'utf8');
}

/** The digests uninstall compares against, as setup records them. */
const DIGESTS: Readonly<Record<string, string>> = Object.fromEntries(
  ENTRIES.map((entry) => [entry.key, digestValue(entry.value)]),
);

/** Backup files sitting beside a settings file. */
function backupsIn(directory: string): readonly string[] {
  return readdirSync(directory).filter((name) => name.includes('.ccledger-backup-'));
}

describe('readSettings', () => {
  it('treats a missing file as an empty object rather than an error', () => {
    const paths = tempHome();

    const result = readSettings(paths.settingsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.exists).toBe(false);
    expect(result.settings.root).toEqual({});
    expect(result.settings.envKind).toBe('absent');
  });

  it('refuses a malformed file and says so without changing it', () => {
    const paths = tempHome();
    writeSettingsFile(paths, '{ "model": "opus", }\n');

    const result = readSettings(paths.settingsPath);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not valid JSON');
    expect(result.error).toContain('changed nothing');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ "model": "opus", }\n');
  });

  it('names a byte-order mark instead of reporting it as a syntax error', () => {
    const paths = tempHome();
    writeSettingsFile(paths, '\ufeff{"model": "opus"}\n');

    const result = readSettings(paths.settingsPath);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('byte-order mark');
  });

  it('refuses a file whose top level is not an object', () => {
    const paths = tempHome();
    writeSettingsFile(paths, '["opus"]\n');

    const result = readSettings(paths.settingsPath);

    expect(result.ok).toBe(false);
  });

  it('reports an env that is not an object rather than replacing it', () => {
    const paths = tempHome();
    writeSettingsFile(paths, '{"env": "PATH=/usr/bin"}\n');

    const result = readSettings(paths.settingsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.envKind).toBe('other');
    expect(() => writeEnvEntries(result.settings, ENTRIES)).toThrow(SettingsError);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{"env": "PATH=/usr/bin"}\n');
  });
});

describe('findEnvConflicts', () => {
  it('reports a key already set to something else', () => {
    const conflicts = findEnvConflicts(
      { [LOGS_ENDPOINT_KEY]: 'http://someone-else.example/v1/logs' },
      ENTRIES,
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.key).toBe(LOGS_ENDPOINT_KEY);
    expect(conflicts[0]?.current).toBe('http://someone-else.example/v1/logs');
  });

  it('does not report a key already set to the value ccledger would write', () => {
    expect(findEnvConflicts({ [LOGS_EXPORTER_KEY]: 'otlp' }, ENTRIES)).toEqual([]);
  });

  it('reports a non-string value, because Claude Code wants strings', () => {
    const conflicts = findEnvConflicts({ [TELEMETRY_ENABLED_KEY]: 1 }, ENTRIES);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.current).toBe('1');
  });
});

describe('content logging detection', () => {
  it('finds a content switch that something else turned on', () => {
    const found = findContentLogging({ OTEL_LOG_USER_PROMPTS: 'true', EDITOR: 'vim' });

    expect(found).toEqual([{ key: 'OTEL_LOG_USER_PROMPTS', value: 'true' }]);
  });

  it('ignores one that is present and off', () => {
    expect(findContentLogging({ OTEL_LOG_USER_PROMPTS: '0' })).toEqual([]);
  });

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['0', false],
    ['false', false],
    ['', false],
  ])('reads %s as %s', (value, expected) => {
    expect(isTruthyFlag(value)).toBe(expected);
  });
});

describe('writeEnvEntries', () => {
  it('creates the file and the directory when there is nothing there', () => {
    const paths = tempHome();
    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const outcome = writeEnvEntries(before.settings, ENTRIES);

    expect(outcome.createdFile).toBe(true);
    expect(outcome.createdEnv).toBe(true);
    expect(outcome.backupPath).toBeUndefined();
    const written = JSON.parse(readFileSync(paths.settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(Object.keys(written)).toEqual(['env']);
    expect(Object.keys(written.env)).toEqual(ENTRIES.map((entry) => entry.key));
  });

  it('adds five keys to a configured file and touches nothing else', () => {
    const paths = tempHome();
    writeSettingsFile(paths, REALISTIC_SETTINGS);
    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    writeEnvEntries(before.settings, ENTRIES);

    const after = readFileSync(paths.settingsPath, 'utf8');
    const parsed = JSON.parse(after) as Record<string, unknown>;
    const original = JSON.parse(REALISTIC_SETTINGS) as Record<string, unknown>;
    for (const key of ['model', 'permissions', 'hooks', 'statusLine']) {
      expect(parsed[key]).toEqual(original[key]);
    }
    expect(parsed.env).toEqual({
      EDITOR: 'vim',
      ...Object.fromEntries(ENTRIES.map((entry) => [entry.key, entry.value])),
    });
    // Everything outside `env` is untouched down to the byte, so the diff a
    // teammate sees is five added lines and nothing else.
    expect(after.startsWith(REALISTIC_SETTINGS.slice(0, REALISTIC_SETTINGS.indexOf('"env"')))).toBe(
      true,
    );
  });

  it('copies the file aside before writing it', () => {
    const paths = tempHome();
    writeSettingsFile(paths, REALISTIC_SETTINGS);
    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const outcome = writeEnvEntries(before.settings, ENTRIES);

    expect(outcome.backupPath).toBeDefined();
    expect(readFileSync(outcome.backupPath ?? '', 'utf8')).toBe(REALISTIC_SETTINGS);
    expect(backupsIn(paths.claudeDir)).toHaveLength(1);
  });

  it('leaves an empty file as a file with only our five keys in it', () => {
    const paths = tempHome();
    writeSettingsFile(paths, '   \n');
    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    writeEnvEntries(before.settings, ENTRIES);

    expect(Object.keys(JSON.parse(readFileSync(paths.settingsPath, 'utf8')) as object)).toEqual([
      'env',
    ]);
  });
});

describe('removeEnvKeys', () => {
  it.each([
    ['a configured file', REALISTIC_SETTINGS],
    ['a file with no env', '{\n  "model": "opus"\n}\n'],
    ['a file with an empty env', '{\n  "model": "opus",\n  "env": {}\n}\n'],
    ['windows endings', '{\r\n  "env": {\r\n    "EDITOR": "vim"\r\n  }\r\n}\r\n'],
    ['one compact line', '{"model":"opus","env":{"EDITOR":"vim"}}'],
    ['an empty object', '{}\n'],
  ])('gives %s back byte for byte', (_label, original) => {
    const paths = tempHome();
    writeSettingsFile(paths, original);

    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const outcome = writeEnvEntries(before.settings, ENTRIES);
    expect(readFileSync(paths.settingsPath, 'utf8')).not.toBe(original);

    const installed = readSettings(paths.settingsPath);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    removeEnvKeys(
      installed.settings,
      ENTRIES.map((entry) => entry.key),
      { expected: DIGESTS, digest: digestValue, removeEmptyEnv: outcome.createdEnv },
    );

    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(original);
  });

  it('leaves a key whose value someone has changed since', () => {
    const paths = tempHome();
    writeSettingsFile(paths, REALISTIC_SETTINGS);
    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    writeEnvEntries(before.settings, ENTRIES);

    const edited = readFileSync(paths.settingsPath, 'utf8').replace(
      'https://meter.example.com/v1/logs',
      'https://elsewhere.example.com/v1/logs',
    );
    writeFileSync(paths.settingsPath, edited, 'utf8');
    const installed = readSettings(paths.settingsPath);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const outcome = removeEnvKeys(
      installed.settings,
      ENTRIES.map((entry) => entry.key),
      { expected: DIGESTS, digest: digestValue },
    );

    expect(outcome.kept.map((entry) => entry.key)).toEqual([LOGS_ENDPOINT_KEY]);
    const env = (JSON.parse(readFileSync(paths.settingsPath, 'utf8')) as { env: object }).env;
    expect(env).toEqual({
      EDITOR: 'vim',
      [LOGS_ENDPOINT_KEY]: 'https://elsewhere.example.com/v1/logs',
    });
  });

  it('does nothing at all when none of the keys are there', () => {
    const paths = tempHome();
    writeSettingsFile(paths, REALISTIC_SETTINGS);
    const settings = readSettings(paths.settingsPath);
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;

    const outcome = removeEnvKeys(settings.settings, [TELEMETRY_ENABLED_KEY]);

    expect(outcome.removed).toEqual([]);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(REALISTIC_SETTINGS);
    expect(backupsIn(paths.claudeDir)).toHaveLength(0);
  });

  it('reports a file that is now nothing but an empty object', () => {
    const paths = tempHome();
    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    writeEnvEntries(before.settings, ENTRIES);

    const installed = readSettings(paths.settingsPath);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const outcome = removeEnvKeys(
      installed.settings,
      ENTRIES.map((entry) => entry.key),
      { removeEmptyEnv: true },
    );

    expect(outcome.removedEnv).toBe(true);
    expect(outcome.fileIsEmptyObject).toBe(true);
  });
});

describe('file permissions', () => {
  it.skipIf(process.platform === 'win32')('creates a settings file only its owner can read', () => {
    const paths = tempHome();
    const before = readSettings(paths.settingsPath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    writeEnvEntries(before.settings, ENTRIES);

    expect(statSync(paths.settingsPath).mode & 0o777).toBe(0o600);
  });
});
