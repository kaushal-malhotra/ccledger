/**
 * Reading and writing `~/.claude/settings.json` without ever taking it over.
 *
 * That file is the user's. It is where their permissions, hooks, MCP servers and
 * status line live, and ccledger's whole footprint on a teammate's machine is
 * five string entries under one key of it. Every rule here follows from that:
 * read, parse, merge, write — never overwrite; back up before touching it; stop
 * rather than replace a key someone else set; and refuse to install a
 * configuration this module cannot then take back out exactly.
 *
 * The last one is enforced rather than asserted. `writeEnvEntries` runs its own
 * removal against the text it is about to write and refuses unless the result is
 * the original file byte for byte, so `ccledger uninstall` restoring the file
 * exactly is a property checked at install time, not a hope at removal time.
 */

import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { JsonEntry, JsonObjectSpan } from './jsonedit.js';
import {
  JsonScanError,
  appendMembers,
  appendObjectMember,
  findMember,
  removeMembers,
  replaceMemberValue,
  scanJsonDocument,
} from './jsonedit.js';
import { backupPathFor } from './paths.js';
import { OTLP_LOGS_PATH } from '../shared/constants.js';

/** The settings key ccledger writes under. Claude Code reads it at startup. */
export const ENV_KEY = 'env';

/** The master switch. Without it Claude Code exports nothing, whatever else is set. */
export const TELEMETRY_ENABLED_KEY = 'CLAUDE_CODE_ENABLE_TELEMETRY';

/** Selects the OTLP exporter for logs. Metrics and traces are left alone. */
export const LOGS_EXPORTER_KEY = 'OTEL_LOGS_EXPORTER';

/** OTLP over HTTP with a JSON body — the only encoding ccledger's ingest accepts. */
export const LOGS_PROTOCOL_KEY = 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL';

/** The full ingest URL, `/v1/logs` included. */
export const LOGS_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';

/** Carries the member's bearer token. The one entry here that is a secret. */
export const LOGS_HEADERS_KEY = 'OTEL_EXPORTER_OTLP_LOGS_HEADERS';

/**
 * Every key ccledger owns, in the order it writes them. Nothing outside this
 * list is ever written: no `OTEL_RESOURCE_ATTRIBUTES`, no metrics exporter, and
 * none of the generic `OTEL_EXPORTER_OTLP_*` keys, which would redirect traces
 * and metrics a teammate may be exporting somewhere else entirely.
 */
export const OWNED_ENV_KEYS: readonly string[] = [
  TELEMETRY_ENABLED_KEY,
  LOGS_EXPORTER_KEY,
  LOGS_PROTOCOL_KEY,
  LOGS_ENDPOINT_KEY,
  LOGS_HEADERS_KEY,
];

/**
 * The env key Claude Code reads for arbitrary OTLP resource labels
 * (`department=eng,team.id=platform`, per Claude Code's own docs). Unlike the
 * five keys above, ccledger does not own this key outright — a teammate may
 * already export their own labels through it — so it is never in
 * `OWNED_ENV_KEYS` and never whole-value conflict-checked or blindly appended.
 * ccledger only ever adds, changes, or removes its own `claude_profile=`
 * segment inside whatever value is already there.
 */
export const RESOURCE_ATTRIBUTES_KEY = 'OTEL_RESOURCE_ATTRIBUTES';

/**
 * The one key-value pair ccledger ever writes inside `OTEL_RESOURCE_ATTRIBUTES`.
 * It exists because Claude Code's own `user.id` telemetry attribute does not
 * vary with `CLAUDE_CONFIG_DIR` — two profiles on one machine report the same
 * `user.id` — so distinguishing them at all requires a label Claude Code
 * actually transmits, and this is the documented mechanism for exactly that.
 */
export const PROFILE_ATTRIBUTE_KEY = 'claude_profile';

/**
 * The five switches that make Claude Code export prompt, response and tool
 * content. ccledger never sets any of them — not behind a flag, not in a test,
 * not as a suggestion — and they are named here for the one purpose that
 * requires naming them: so `doctor` can tell a teammate when something else has.
 */
export const CONTENT_LOGGING_KEYS: readonly string[] = [
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_RAW_API_BODIES',
];

/** Mode for a file ccledger creates. It holds a bearer token; nobody else needs it. */
const PRIVATE_FILE_MODE = 0o600;

/** Mode for a directory ccledger creates. */
const PRIVATE_DIR_MODE = 0o700;

/** What `env` turned out to be, which decides whether it can be merged into. */
export type EnvKind = 'absent' | 'object' | 'other';

/** A settings file as it was found on disk. */
export interface SettingsFile {
  readonly path: string;
  /** False when the file is not there, which is not an error. */
  readonly exists: boolean;
  /** The bytes as text. Empty when the file is not there. */
  readonly text: string;
  /** The parsed root object; empty when the file is not there. */
  readonly root: Readonly<Record<string, unknown>>;
  /** Whether `env` is missing, an object, or something that cannot be merged into. */
  readonly envKind: EnvKind;
  /** `env`'s entries, values unconverted. Empty unless `envKind` is `object`. */
  readonly env: Readonly<Record<string, unknown>>;
  /** POSIX mode bits, when the file exists and the platform reports them. */
  readonly mode?: number;
  /** Last modification time in epoch milliseconds, when the file exists. */
  readonly mtimeMs?: number;
}

/** A settings file, or the sentence explaining why it was left alone. */
export type ReadSettingsResult =
  | { readonly ok: true; readonly settings: SettingsFile }
  | { readonly ok: false; readonly error: string };

/** A key ccledger wants to write that is already set to something else. */
export interface EnvConflict {
  readonly key: string;
  /** The value in the file, rendered for display. Secrets are masked by the caller. */
  readonly current: string;
  /** The value ccledger would have written. */
  readonly wanted: string;
}

/** What writing the settings file did, for the record uninstall reads later. */
export interface WriteOutcome {
  readonly path: string;
  /** Where the previous contents were copied. Absent when there was no file. */
  readonly backupPath?: string;
  /** True when ccledger created the settings file itself. */
  readonly createdFile: boolean;
  /** True when ccledger added the `env` object, so uninstall knows to take it away. */
  readonly createdEnv: boolean;
}

/** What removing the keys did. */
export interface RemoveOutcome {
  readonly path: string;
  readonly backupPath?: string;
  /** Keys that were present and were taken out. */
  readonly removed: readonly string[];
  /** Keys left in place, with why. */
  readonly kept: readonly { readonly key: string; readonly reason: string }[];
  /** True when the now-empty `env` object was taken out too. */
  readonly removedEnv: boolean;
  /** True when nothing but an empty object is left in the file. */
  readonly fileIsEmptyObject: boolean;
}

/** Raised for a settings file this module will not touch. Carries a finished sentence. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** A plain JSON object. Arrays and `null` are not records. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `errno` string of a Node system error, e.g. `ENOENT`. */
function errnoOf(error: unknown): string | undefined {
  if (!isRecordObject(error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
}

/** An env value as a printable string. Non-strings are shown as the JSON they are. */
export function formatEnvValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Deep equality over parsed JSON, insensitive to key order. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualJson(item, b[index]));
  }
  if (isRecordObject(a) && isRecordObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => Object.hasOwn(b, key) && deepEqualJson(a[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * Reads and parses the settings file. A file that is not there is `{}`, because
 * a teammate who has never opened Claude Code's settings has nothing wrong with
 * their machine. A file that is there and does not parse is a refusal: it is not
 * ours to repair, and rewriting it is how someone loses a hook they spent an
 * afternoon on.
 */
export function readSettings(path: string): ReadSettingsResult {
  let text: string;
  let mode: number | undefined;
  let mtimeMs: number | undefined;
  try {
    text = readFileSync(path, 'utf8');
    const stats = statSync(path);
    mode = stats.mode;
    mtimeMs = stats.mtimeMs;
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') {
      return {
        ok: true,
        settings: { path, exists: false, text: '', root: {}, envKind: 'absent', env: {} },
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, error: `cannot read ${path}: permission denied` };
    }
    if (code === 'EISDIR') return { ok: false, error: `${path} is a directory, not a file` };
    return { ok: false, error: `cannot read ${path}: ${String(error)}` };
  }

  // A byte-order mark is invisible in an editor and fatal to a strict JSON
  // parser, so it is worth naming rather than reporting as a syntax error.
  if (text.charCodeAt(0) === 0xfeff) {
    return {
      ok: false,
      error:
        `${path} begins with a byte-order mark, which a strict JSON parser rejects. ` +
        'Re-save it as UTF-8 without a BOM and run this again. Nothing has been changed.',
    };
  }
  if (text.trim() === '') {
    // An empty file is the state a `touch`, a crash or a full disk leaves behind.
    // Treating it as `{}` is safe: there is nothing in it to lose.
    return {
      ok: true,
      settings: { path, exists: true, text, root: {}, envKind: 'absent', env: {} },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error:
        `${path} is not valid JSON (${detail}). ccledger has changed nothing. ` +
        'Fix or move the file, then run this again.',
    };
  }
  if (!isRecordObject(parsed)) {
    return { ok: false, error: `${path} does not hold a JSON object at its top level` };
  }

  const rawEnv: unknown = parsed[ENV_KEY];
  const envKind: EnvKind =
    rawEnv === undefined ? 'absent' : isRecordObject(rawEnv) ? 'object' : 'other';

  return {
    ok: true,
    settings: {
      path,
      exists: true,
      text,
      root: parsed,
      envKind,
      env: envKind === 'object' && isRecordObject(rawEnv) ? rawEnv : {},
      ...(mode !== undefined ? { mode } : {}),
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
    },
  };
}

/**
 * The entries already set to something other than what ccledger would write.
 *
 * A key set to exactly the value ccledger wants is not a conflict — writing it
 * again would be a no-op — but every other case is, and none of them is ours to
 * resolve. The caller stops rather than choosing.
 */
export function findEnvConflicts(
  env: Readonly<Record<string, unknown>>,
  entries: readonly JsonEntry[],
): readonly EnvConflict[] {
  const conflicts: EnvConflict[] = [];
  for (const entry of entries) {
    if (!Object.hasOwn(env, entry.key)) continue;
    const current = env[entry.key];
    if (current === entry.value) continue;
    conflicts.push({ key: entry.key, current: formatEnvValue(current), wanted: entry.value });
  }
  return conflicts;
}

/** The keys of `env` that are one of the content-capture switches and are on. */
export function findContentLogging(
  env: Readonly<Record<string, unknown>>,
): readonly { readonly key: string; readonly value: string }[] {
  const found: { key: string; value: string }[] = [];
  for (const key of CONTENT_LOGGING_KEYS) {
    if (!Object.hasOwn(env, key)) continue;
    const value = formatEnvValue(env[key]);
    if (isTruthyFlag(value)) found.push({ key, value });
  }
  return found;
}

/** The base URL behind a configured logs endpoint, or `undefined` if it is not one. */
export function baseUrlOfLogsEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed.endsWith(OTLP_LOGS_PATH)) return undefined;
  const base = trimmed.slice(0, -OTLP_LOGS_PATH.length);
  return base === '' ? undefined : base;
}

/** The bearer token out of a configured `OTEL_EXPORTER_OTLP_LOGS_HEADERS` value. */
export function tokenOfHeaders(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /(?:^|,)\s*Authorization\s*=\s*Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1];
}

/** How Claude Code reads a boolean environment variable: `1` or `true` is on. */
export function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalised = value.trim().toLowerCase();
  return normalised === '1' || normalised === 'true' || normalised === 'yes' || normalised === 'on';
}

/** Writes `text` to `path` through a temporary file, so a crash cannot truncate it. */
function writeAtomically(path: string, text: string, mode: number): void {
  const temporary = `${path}.ccledger-tmp-${String(process.pid)}`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode });
    // `rename` replaces the destination on every platform Node supports, so the
    // file a reader opens is either all of the old bytes or all of the new ones.
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created. Nothing to clean up.
    }
    throw error;
  }
}

/** Creates a directory, and its parents, with owner-only permissions. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** Copies the file aside before it is written. Returns where the copy went. */
function takeBackup(path: string, now: number): string {
  const backupPath = backupPathFor(path, now);
  copyFileSync(path, backupPath);
  try {
    chmodSync(backupPath, PRIVATE_FILE_MODE);
  } catch {
    // Windows reports a mode it does not enforce; a failure here is not a reason
    // to abandon a backup that has already been written.
  }
  return backupPath;
}

/** The text of a settings file ccledger creates from nothing. */
function freshSettingsText(entries: readonly JsonEntry[]): string {
  return `${JSON.stringify({ [ENV_KEY]: Object.fromEntries(entries.map((e) => [e.key, e.value])) }, null, 2)}\n`;
}

/** The `env` object's span, or a `SettingsError` naming what is there instead. */
function envSpanOf(settings: SettingsFile, root: JsonObjectSpan): JsonObjectSpan | undefined {
  const member = findMember(root, ENV_KEY);
  if (member === undefined) return undefined;
  if (member.object === undefined) {
    throw new SettingsError(
      `the "${ENV_KEY}" entry in ${settings.path} is ${JSON.stringify(settings.root[ENV_KEY])}, ` +
        'not an object. ccledger has changed nothing; fix that entry and run this again.',
    );
  }
  return member.object;
}

/** Parses text the module just produced, or reports it as the bug it would be. */
function reparse(text: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsError(
      `the edit ccledger prepared for ${path} did not parse as JSON, so nothing was written. ` +
        'This is a bug in ccledger; please report it with a copy of the file.',
    );
  }
  if (!isRecordObject(parsed)) {
    throw new SettingsError(`the edit ccledger prepared for ${path} was not an object`);
  }
  return parsed;
}

/**
 * Adds ccledger's entries to `env` and writes the file. Returns what was done,
 * which is what `state.json` records so uninstall can undo exactly this much.
 *
 * Three things are checked before a byte is written: the result parses, it holds
 * the values it should and nothing else changed, and removing those same keys
 * from it gives back the original file exactly. The third is the one that
 * matters — it is uninstall's promise, verified here, while the original is
 * still in hand to compare against.
 */
export function writeEnvEntries(
  settings: SettingsFile,
  entries: readonly JsonEntry[],
  now: number = Date.now(),
): WriteOutcome {
  if (settings.envKind === 'other') {
    throw new SettingsError(
      `the "${ENV_KEY}" entry in ${settings.path} is ${JSON.stringify(settings.root[ENV_KEY])}, ` +
        'not an object. ccledger has changed nothing; fix that entry and run this again.',
    );
  }

  if (!settings.exists || settings.text.trim() === '') {
    ensurePrivateDirectory(dirname(settings.path));
    writeAtomically(settings.path, freshSettingsText(entries), PRIVATE_FILE_MODE);
    return { path: settings.path, createdFile: !settings.exists, createdEnv: true };
  }

  let root: JsonObjectSpan;
  try {
    root = scanJsonDocument(settings.text);
  } catch (error) {
    const detail = error instanceof JsonScanError ? error.message : String(error);
    throw new SettingsError(
      `${settings.path} could not be read as JSON text (${detail}); nothing was changed`,
    );
  }

  const envSpan = envSpanOf(settings, root);
  const createdEnv = envSpan === undefined;
  const updated =
    envSpan === undefined
      ? appendObjectMember(settings.text, root, ENV_KEY, entries)
      : appendMembers(settings.text, root, envSpan, entries);

  const parsed = reparse(updated, settings.path);
  const expectedEnv: Record<string, unknown> = { ...settings.env };
  for (const entry of entries) expectedEnv[entry.key] = entry.value;
  if (!deepEqualJson(parsed, { ...settings.root, [ENV_KEY]: expectedEnv })) {
    throw new SettingsError(
      `the edit ccledger prepared for ${settings.path} would have changed more than its own five ` +
        'keys, so nothing was written. This is a bug in ccledger; please report it.',
    );
  }

  const keys = new Set(entries.map((entry) => entry.key));
  if (removeOwnedText(updated, keys, createdEnv) !== settings.text) {
    throw new SettingsError(
      `ccledger could not work out how to remove its keys from ${settings.path} again, so it ` +
        'did not add them. This is a bug in ccledger; please report it with a copy of the file.',
    );
  }

  const backupPath = takeBackup(settings.path, now);
  writeAtomically(settings.path, updated, settings.mode ?? PRIVATE_FILE_MODE);
  return { path: settings.path, backupPath, createdFile: false, createdEnv };
}

/**
 * Parses `OTEL_RESOURCE_ATTRIBUTES`' comma-separated `key=value` pairs, in the
 * order they appear. A segment with no `=`, or an empty one from a trailing
 * comma, is skipped rather than rejected — this only ever has to round-trip a
 * value that already reached Claude Code as a resource attribute, not validate
 * one from scratch.
 */
export function parseResourceAttributes(value: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    pairs.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return pairs;
}

/** The inverse of `parseResourceAttributes`: pairs back to comma-joined `key=value` text. */
export function serializeResourceAttributes(pairs: ReadonlyMap<string, string>): string {
  return [...pairs].map(([key, value]) => `${key}=${value}`).join(',');
}

/**
 * The conflict setting `claude_profile=profileName` would have to overwrite,
 * if any. Not a conflict when the key is absent, or when it already holds
 * exactly that pair — writing it again would be a no-op, same rule as
 * `findEnvConflicts`. A whole value that is not a string is reported as a
 * conflict too: there is nothing here to merge into.
 */
export function profileAttributeConflict(
  env: Readonly<Record<string, unknown>>,
  profileName: string,
): EnvConflict | undefined {
  if (!Object.hasOwn(env, RESOURCE_ATTRIBUTES_KEY)) return undefined;
  const current = env[RESOURCE_ATTRIBUTES_KEY];
  if (typeof current !== 'string') {
    return {
      key: RESOURCE_ATTRIBUTES_KEY,
      current: formatEnvValue(current),
      wanted: `a string containing ${PROFILE_ATTRIBUTE_KEY}=${profileName}`,
    };
  }
  const existing = parseResourceAttributes(current).get(PROFILE_ATTRIBUTE_KEY);
  if (existing === undefined || existing === profileName) return undefined;
  return {
    key: `${RESOURCE_ATTRIBUTES_KEY} (${PROFILE_ATTRIBUTE_KEY})`,
    current: existing,
    wanted: profileName,
  };
}

/** What writing the profile attribute did, mirroring `WriteOutcome` for the other five keys. */
export interface ProfileAttributeOutcome {
  readonly path: string;
  readonly backupPath?: string;
  /** True when ccledger created `OTEL_RESOURCE_ATTRIBUTES` itself, so uninstall may remove it whole. */
  readonly createdKey: boolean;
  /** The exact `claude_profile=<value>` text written, for uninstall to verify it is unchanged. */
  readonly segment: string;
}

/**
 * Sets `claude_profile=<profileName>` inside `OTEL_RESOURCE_ATTRIBUTES`,
 * merging into whatever else is already there instead of owning the whole
 * value. Call `profileAttributeConflict` first and stop on anything it
 * reports — this throws the same refusal if the check and the write ever
 * disagree, the same gap `writeEnvEntries`'s callers already re-check for.
 */
export function writeProfileAttribute(
  settings: SettingsFile,
  profileName: string,
  now: number = Date.now(),
  /**
   * Skips taking a backup here. Setup calls this right after `writeEnvEntries`
   * already took one of the true pre-ccledger original, in the same run; a
   * second backup at the same second-resolution timestamp would either collide
   * with that filename or, if it did not, would become the one `state.json`
   * records — and restoring "the backup" would then put back the file with the
   * five keys already in it rather than the teammate's original file.
   */
  skipBackup = false,
): ProfileAttributeOutcome {
  const conflict = profileAttributeConflict(settings.env, profileName);
  if (conflict !== undefined) {
    throw new SettingsError(
      `${RESOURCE_ATTRIBUTES_KEY} in ${settings.path} already sets ${conflict.key} to ` +
        `${conflict.current}; ccledger will not overwrite it. Remove that pair, or run setup for ` +
        'the profile it already names, then try again.',
    );
  }

  const segment = `${PROFILE_ATTRIBUTE_KEY}=${profileName}`;
  const current = settings.env[RESOURCE_ATTRIBUTES_KEY];

  if (typeof current === 'string') {
    const pairs = parseResourceAttributes(current);
    pairs.set(PROFILE_ATTRIBUTE_KEY, profileName);
    const value = serializeResourceAttributes(pairs);

    const root = scanJsonDocument(settings.text);
    const envSpan = envSpanOf(settings, root);
    const member = envSpan === undefined ? undefined : findMember(envSpan, RESOURCE_ATTRIBUTES_KEY);
    if (member === undefined) {
      throw new SettingsError(
        `ccledger could not locate ${RESOURCE_ATTRIBUTES_KEY} in ${settings.path} to edit it. ` +
          'This is a bug in ccledger; please report it.',
      );
    }
    const updated = replaceMemberValue(settings.text, member, value);
    reparse(updated, settings.path);
    const backupPath = skipBackup ? undefined : takeBackup(settings.path, now);
    writeAtomically(settings.path, updated, settings.mode ?? PRIVATE_FILE_MODE);
    return {
      path: settings.path,
      createdKey: false,
      segment,
      ...(backupPath !== undefined ? { backupPath } : {}),
    };
  }

  if (skipBackup) {
    // Same "add a key" edit `writeEnvEntries` performs, without its own
    // backup: `appendMembers`/`appendObjectMember` plus the atomic write, with
    // the same round-trip check inlined so a bug here fails loudly rather than
    // writing something uninstall could not remove again.
    const root = scanJsonDocument(settings.text);
    const envSpan = envSpanOf(settings, root);
    const entries: readonly JsonEntry[] = [{ key: RESOURCE_ATTRIBUTES_KEY, value: segment }];
    const updated =
      envSpan === undefined
        ? appendObjectMember(settings.text, root, ENV_KEY, entries)
        : appendMembers(settings.text, root, envSpan, entries);
    const parsed = reparse(updated, settings.path);
    const expectedEnv = { ...settings.env, [RESOURCE_ATTRIBUTES_KEY]: segment };
    if (!deepEqualJson(parsed, { ...settings.root, [ENV_KEY]: expectedEnv })) {
      throw new SettingsError(
        `the edit ccledger prepared for ${settings.path} would have changed more than ` +
          `${RESOURCE_ATTRIBUTES_KEY}, so nothing was written. This is a bug in ccledger; please report it.`,
      );
    }
    writeAtomically(settings.path, updated, settings.mode ?? PRIVATE_FILE_MODE);
    return { path: settings.path, createdKey: true, segment };
  }

  // Not present yet: reuse the generic add-a-key path, which is safe here
  // because it round-trip-verifies against exactly the one entry it was given
  // rather than assuming `OWNED_ENV_KEYS`.
  const written = writeEnvEntries(
    settings,
    [{ key: RESOURCE_ATTRIBUTES_KEY, value: segment }],
    now,
  );
  return {
    path: written.path,
    createdKey: true,
    segment,
    ...(written.backupPath !== undefined ? { backupPath: written.backupPath } : {}),
  };
}

/** What removing the profile attribute did. */
export interface ProfileAttributeRemoval {
  readonly path: string;
  readonly backupPath?: string;
  readonly removed: boolean;
  /** True when the whole `OTEL_RESOURCE_ATTRIBUTES` key was taken out, now empty. */
  readonly removedKey: boolean;
  /** Set when nothing was removed, saying why. */
  readonly reason?: string;
}

/**
 * Takes `claude_profile=<the value setup wrote>` back out of
 * `OTEL_RESOURCE_ATTRIBUTES`, leaving every other pair in it untouched — and
 * leaving the whole thing alone if the pair has changed since setup wrote it,
 * the same "belongs to whoever changed it now" rule `removeEnvKeys` follows
 * for the other five keys.
 */
export function removeProfileAttribute(
  settings: SettingsFile,
  expectedSegment: string,
  removeKeyIfEmpty: boolean,
  now: number = Date.now(),
): ProfileAttributeRemoval {
  if (!settings.exists) return { path: settings.path, removed: false, removedKey: false };

  const current = settings.env[RESOURCE_ATTRIBUTES_KEY];
  if (typeof current !== 'string') {
    return { path: settings.path, removed: false, removedKey: false, reason: 'is not set' };
  }

  const eq = expectedSegment.indexOf('=');
  const expectedValue = eq === -1 ? '' : expectedSegment.slice(eq + 1);
  const pairs = parseResourceAttributes(current);
  if (pairs.get(PROFILE_ATTRIBUTE_KEY) !== expectedValue) {
    return {
      path: settings.path,
      removed: false,
      removedKey: false,
      reason: 'its value has changed since ccledger wrote it',
    };
  }
  pairs.delete(PROFILE_ATTRIBUTE_KEY);

  const root = scanJsonDocument(settings.text);
  const envSpan = envSpanOf(settings, root);
  const member = envSpan === undefined ? undefined : findMember(envSpan, RESOURCE_ATTRIBUTES_KEY);
  if (member === undefined) {
    return {
      path: settings.path,
      removed: false,
      removedKey: false,
      reason: 'could not be located',
    };
  }

  if (pairs.size === 0 && removeKeyIfEmpty) {
    const updated = removeOwnedText(settings.text, new Set([RESOURCE_ATTRIBUTES_KEY]), false);
    reparse(updated, settings.path);
    const backupPath = takeBackup(settings.path, now);
    writeAtomically(settings.path, updated, settings.mode ?? PRIVATE_FILE_MODE);
    return { path: settings.path, backupPath, removed: true, removedKey: true };
  }

  const value = serializeResourceAttributes(pairs);
  const updated = replaceMemberValue(settings.text, member, value);
  reparse(updated, settings.path);
  const backupPath = takeBackup(settings.path, now);
  writeAtomically(settings.path, updated, settings.mode ?? PRIVATE_FILE_MODE);
  return { path: settings.path, backupPath, removed: true, removedKey: false };
}

/**
 * The text with `keys` taken out of `env`, and `env` itself taken out when it
 * ends up empty and ccledger is the one that added it. Shared by the write
 * path's round-trip check and by uninstall, so the two can never disagree.
 */
function removeOwnedText(text: string, keys: ReadonlySet<string>, removeEmptyEnv: boolean): string {
  const root = scanJsonDocument(text);
  const envMember = findMember(root, ENV_KEY);
  if (envMember?.object === undefined) return text;

  const trimmed = removeMembers(text, envMember.object, keys);
  if (!removeEmptyEnv) return trimmed;

  const rescanned = scanJsonDocument(trimmed);
  const rescannedEnv = findMember(rescanned, ENV_KEY);
  if (rescannedEnv?.object === undefined || rescannedEnv.object.members.length > 0) return trimmed;
  return removeMembers(trimmed, rescanned, new Set([ENV_KEY]));
}

/**
 * Takes the named keys back out of `env` and writes the file.
 *
 * A key whose value is no longer the one ccledger wrote is left where it is: it
 * belongs to whoever changed it now, and removing it would be the clobbering
 * this whole module exists to avoid. `expected` carries the sha-256 of each
 * value written at install time, which is enough to tell "unchanged" from
 * "edited" without keeping a second copy of the token on disk.
 */
export function removeEnvKeys(
  settings: SettingsFile,
  keys: readonly string[],
  options: {
    /** Digest of the value ccledger wrote, per key. A key with no entry is removed unchecked. */
    readonly expected?: Readonly<Record<string, string>>;
    /** Take `env` out too if removing these keys empties it. */
    readonly removeEmptyEnv?: boolean;
    /** Digest function, so the caller decides how values are compared. */
    readonly digest?: (value: string) => string;
    readonly now?: number;
  } = {},
): RemoveOutcome {
  const now = options.now ?? Date.now();
  const expected = options.expected;
  const digest = options.digest;

  if (!settings.exists) {
    return {
      path: settings.path,
      removed: [],
      kept: [],
      removedEnv: false,
      fileIsEmptyObject: false,
    };
  }

  const removable: string[] = [];
  const kept: { key: string; reason: string }[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(settings.env, key)) continue;
    const current = settings.env[key];
    const wantedDigest = expected?.[key];
    if (wantedDigest !== undefined && digest !== undefined) {
      if (typeof current !== 'string' || digest(current) !== wantedDigest) {
        kept.push({ key, reason: 'its value has changed since ccledger wrote it' });
        continue;
      }
    }
    removable.push(key);
  }

  if (removable.length === 0) {
    return {
      path: settings.path,
      removed: [],
      kept,
      removedEnv: false,
      fileIsEmptyObject: Object.keys(settings.root).length === 0,
    };
  }

  let updated: string;
  try {
    updated = removeOwnedText(settings.text, new Set(removable), options.removeEmptyEnv ?? false);
  } catch (error) {
    const detail = error instanceof JsonScanError ? error.message : String(error);
    throw new SettingsError(
      `${settings.path} could not be read as JSON text (${detail}); nothing was changed`,
    );
  }

  const parsed = reparse(updated, settings.path);
  const backupPath = takeBackup(settings.path, now);
  writeAtomically(settings.path, updated, settings.mode ?? PRIVATE_FILE_MODE);

  const remainingEnv: unknown = parsed[ENV_KEY];
  return {
    path: settings.path,
    backupPath,
    removed: removable,
    kept,
    removedEnv: !Object.hasOwn(parsed, ENV_KEY),
    fileIsEmptyObject:
      Object.keys(parsed).length === 0 ||
      (Object.keys(parsed).length === 1 &&
        isRecordObject(remainingEnv) &&
        Object.keys(remainingEnv).length === 0),
  };
}

/** Restores a backup over the settings file. Returns the bytes that were put back. */
export function restoreBackup(backupPath: string, settingsPath: string): string {
  const text = readFileSync(backupPath, 'utf8');
  ensurePrivateDirectory(dirname(settingsPath));
  writeAtomically(settingsPath, text, PRIVATE_FILE_MODE);
  return text;
}

/** True when the file's mode lets someone other than its owner read it. */
export function isGroupOrWorldReadable(mode: number | undefined): boolean {
  // Windows reports a mode it does not enforce, so asking there would produce a
  // warning nobody can act on.
  if (mode === undefined || process.platform === 'win32') return false;
  return (mode & 0o077) !== 0;
}
