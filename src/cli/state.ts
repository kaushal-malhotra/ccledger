/**
 * `~/.ccledger/state.json`: the record of what setup changed, so that uninstall
 * can change back exactly that much and nothing else.
 *
 * It holds the names of the five keys, where the backup went, and which server
 * the token came from. It does not hold the token, or any of the values: what
 * uninstall needs to know is whether a key still holds what ccledger put there,
 * and a sha-256 of each value answers that without leaving a second copy of a
 * bearer token on the disk. One file with the token in it is a thing to be
 * careful with; two is a thing to be careless with.
 */

import { createHash } from 'node:crypto';
import { readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensurePrivateDirectory } from './settings.js';

/** Format version of `state.json`. Bumped if the shape ever changes. */
export const STATE_VERSION = 1;

/** Mode for the state file. It names a server and a member; that is enough to guard. */
const PRIVATE_FILE_MODE = 0o600;

/** What setup did, as uninstall needs to read it back. */
export interface ClientState {
  readonly version: number;
  /** Base URL of the server, no trailing slash and no `/v1/logs`. */
  readonly serverUrl: string;
  /** The label the server calls itself, as `/join` reported it. */
  readonly serverName?: string;
  /** The member id `/join` issued. Printed if the server cannot be told about the removal. */
  readonly memberId: string;
  /** The display name this machine joined under. */
  readonly displayName: string;
  /** The settings file that was edited, absolute. */
  readonly settingsPath: string;
  /** Where the previous contents were copied. Absent when there was no file to copy. */
  readonly backupPath?: string;
  /** True when setup created the settings file, so uninstall may take it away again. */
  readonly createdSettingsFile: boolean;
  /** True when setup created the `env` object, so uninstall removes it once empty. */
  readonly createdEnvObject: boolean;
  /** The keys setup added, in the order it wrote them. Uninstall removes these and no others. */
  readonly addedKeys: readonly string[];
  /** sha-256, hex, of the value written for each added key. */
  readonly valueDigests: Readonly<Record<string, string>>;
  /** Epoch milliseconds. */
  readonly installedAt: number;
  /**
   * This install's profile name (`.claude`, `.claude-work`, ...), absent on a
   * record written before profiles existed. Absence is read as the default
   * profile, `.claude`.
   */
  readonly profileName?: string;
  /**
   * The exact `claude_profile=<value>` text written into
   * `OTEL_RESOURCE_ATTRIBUTES`, if any. Not a digest: unlike the token, this
   * value is not a secret, and uninstall needs to compare it verbatim against
   * whatever segment is there now.
   */
  readonly resourceAttributeSegment?: string;
  /** True when setup created `OTEL_RESOURCE_ATTRIBUTES` itself, empty until this. */
  readonly resourceAttributeCreated?: boolean;
}

/** A state file, the fact there is none, or the reason it could not be used. */
export type ReadStateResult =
  | { readonly ok: true; readonly state: ClientState }
  | { readonly ok: true; readonly state: undefined }
  | { readonly ok: false; readonly error: string };

/** A plain JSON object. Arrays and `null` are not records. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The sha-256 of a value, hex. What `state.json` keeps instead of the value. */
export function digestValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A string property, or `undefined` when it is missing or the wrong type. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads `state.json`. A file that is not there is not an error; a broken one is. */
export function readState(path: string): ReadStateResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = isRecordObject(error) ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, state: undefined };
    return { ok: false, error: `cannot read ${path}: ${String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${path} is not valid JSON, so ccledger cannot tell what it added` };
  }
  if (!isRecordObject(parsed)) return { ok: false, error: `${path} does not hold a JSON object` };

  const serverUrl = stringField(parsed, 'serverUrl');
  const memberId = stringField(parsed, 'memberId');
  const settingsPath = stringField(parsed, 'settingsPath');
  const addedKeys = parsed.addedKeys;
  if (
    serverUrl === undefined ||
    memberId === undefined ||
    settingsPath === undefined ||
    !Array.isArray(addedKeys)
  ) {
    return { ok: false, error: `${path} is missing fields ccledger needs to undo its changes` };
  }

  const digestsField = parsed.valueDigests;
  const valueDigests: Record<string, string> = {};
  if (isRecordObject(digestsField)) {
    for (const [key, value] of Object.entries(digestsField)) {
      if (typeof value === 'string') valueDigests[key] = value;
    }
  }

  const backupPath = stringField(parsed, 'backupPath');
  const serverName = stringField(parsed, 'serverName');
  const profileName = stringField(parsed, 'profileName');
  const resourceAttributeSegment = stringField(parsed, 'resourceAttributeSegment');
  const installedAt = parsed.installedAt;
  const version = parsed.version;

  return {
    ok: true,
    state: {
      version: typeof version === 'number' ? version : STATE_VERSION,
      serverUrl,
      memberId,
      settingsPath,
      displayName: stringField(parsed, 'displayName') ?? memberId,
      addedKeys: addedKeys.filter((key): key is string => typeof key === 'string'),
      valueDigests,
      createdSettingsFile: parsed.createdSettingsFile === true,
      createdEnvObject: parsed.createdEnvObject === true,
      installedAt: typeof installedAt === 'number' ? installedAt : 0,
      ...(backupPath !== undefined ? { backupPath } : {}),
      ...(serverName !== undefined ? { serverName } : {}),
      ...(profileName !== undefined ? { profileName } : {}),
      ...(resourceAttributeSegment !== undefined ? { resourceAttributeSegment } : {}),
      ...(parsed.resourceAttributeCreated === true ? { resourceAttributeCreated: true } : {}),
    },
  };
}

/** Writes `state.json`, creating `~/.ccledger` with owner-only permissions. */
export function writeState(path: string, state: ClientState): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
}

/** What removing `~/.ccledger` did. */
export interface StateRemoval {
  /** True when the directory is gone. */
  readonly removed: boolean;
  /** Set when the directory was left in place, saying why. */
  readonly reason?: string;
}

/**
 * Removes `state.json` and then the directory that held it — but only if that
 * directory is now empty. A `~/.ccledger` with something else in it is not
 * ccledger's to delete, whoever put the something else there.
 */
export function removeStateDirectory(statePath: string, stateDir: string): StateRemoval {
  rmSync(statePath, { force: true });
  try {
    // `rmdir` rather than a recursive remove: it refuses a directory with
    // anything left in it, which is exactly the guard wanted here.
    rmdirSync(stateDir);
    return { removed: true };
  } catch (error) {
    const code = isRecordObject(error) ? error.code : undefined;
    if (code === 'ENOENT') return { removed: true };
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') {
      return { removed: false, reason: 'it holds files ccledger did not write' };
    }
    return { removed: false, reason: String(error) };
  }
}
