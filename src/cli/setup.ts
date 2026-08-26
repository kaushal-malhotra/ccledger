/**
 * `ccledger setup --code <invite>`: the one command a teammate runs.
 *
 * Everything that happens on someone else's machine happens here, so the order
 * is the design. Nothing is written until the person running it has seen, in
 * plain words, what will and will not be sent, and said yes. Nothing is
 * overwritten, ever: if any of the five keys is already set to something else,
 * this stops and explains rather than choosing for them. And the conflict check
 * runs before the join code is spent, because a code that is burned and then
 * refused leaves a teammate needing a new invite for a problem that was already
 * visible.
 *
 * The last line of a successful run is the reminder to restart Claude Code.
 * Telemetry configuration is read once, at startup, so a teammate who does not
 * restart has a perfect config and no data — the single most likely support
 * question this project will ever get.
 */

import { hostname, platform, release } from 'node:os';

import { OTLP_LOGS_PATH, JOIN_PATH, MEMBER_TOKEN_PREFIX } from '../shared/constants.js';
import { MAX_DISPLAY_NAME_LENGTH, decodeInvite, normaliseDisplayName } from '../shared/invite.js';
import type { JoinRequestBody, JoinResponseBody } from '../shared/types.js';
import { errorTextOf, request } from './http.js';
import { fail, maskSecrets, say, warn } from './io.js';
import type { JsonEntry } from './jsonedit.js';
import { resolveClientPaths } from './paths.js';
import type { Prompter } from './prompt.js';
import { createPrompter, isAffirmative } from './prompt.js';
import type { EnvConflict, SettingsFile } from './settings.js';
import {
  LOGS_ENDPOINT_KEY,
  LOGS_EXPORTER_KEY,
  LOGS_HEADERS_KEY,
  LOGS_PROTOCOL_KEY,
  SettingsError,
  TELEMETRY_ENABLED_KEY,
  findEnvConflicts,
  formatEnvValue,
  isGroupOrWorldReadable,
  readSettings,
  writeEnvEntries,
} from './settings.js';
import { digestValue, writeState } from './state.js';

/**
 * The disclosure, verbatim. It is quoted rather than paraphrased on purpose:
 * people are being asked to install monitoring at a manager's request, and what
 * makes that acceptable is being able to read exactly what it does, in the same
 * words every time, before anything is written.
 */
const DISCLOSURE: readonly string[] = [
  'ccledger will send, per API request:',
  '  model name, token counts, duration, timestamp, session id',
  '',
  'It will NOT send:',
  '  prompts, responses, file contents, file paths,',
  '  command text, or repository names',
  '',
  'Config written to: ~/.claude/settings.json',
  'Remove any time with: npx ccledger uninstall',
];

/** A valid OTLP logs payload carrying no records. Proves the token without storing a row. */
const EMPTY_OTLP_ENVELOPE = '{"resourceLogs":[]}';

/** Width of the rule around the restart notice. */
const RULE = '─'.repeat(66);

/** Options for `ccledger setup`, as Commander hands them over. */
export interface SetupOptions {
  /** The invite string, base64url, as `ccledger invite` printed it. */
  readonly code: string;
  /** Display name to join under. Defaults to the one in the invite, then to a prompt. */
  readonly name?: string;
  /** Accept the disclosure without being asked. For scripted installs. */
  readonly yes?: boolean;
  /**
   * Home directory to resolve `~` against. The CLI never sets it; a test does,
   * so that no run of this suite can reach a real `~/.claude/settings.json`.
   */
  readonly home?: string;
  /** Stream the questions are read from. The CLI never sets it; a test does. */
  readonly input?: NodeJS.ReadableStream;
}

/** This machine, as the server records it at join time. Informational only. */
function machineDescription(): { readonly hostname: string; readonly os: string } {
  return { hostname: hostname(), os: `${platform()} ${release()}`.slice(0, 64) };
}

/** The five entries, in the order they are written. */
function entriesFor(endpoint: string, token: string): readonly JsonEntry[] {
  return [
    { key: TELEMETRY_ENABLED_KEY, value: '1' },
    { key: LOGS_EXPORTER_KEY, value: 'otlp' },
    { key: LOGS_PROTOCOL_KEY, value: 'http/json' },
    { key: LOGS_ENDPOINT_KEY, value: `${endpoint}${OTLP_LOGS_PATH}` },
    { key: LOGS_HEADERS_KEY, value: `Authorization=Bearer ${token}` },
  ];
}

/**
 * The keys already set to something ccledger would have to overwrite.
 *
 * The header key is a conflict whenever it is present at all: it carries a
 * token this run has not been issued yet, so no existing value can be the one
 * that is about to be written. Checking it that way is what lets the whole
 * check happen before the join code is spent.
 */
function conflictsBeforeJoin(settings: SettingsFile, endpoint: string): readonly EnvConflict[] {
  const known = entriesFor(endpoint, 'x').filter((entry) => entry.key !== LOGS_HEADERS_KEY);
  const conflicts = [...findEnvConflicts(settings.env, known)];
  if (Object.hasOwn(settings.env, LOGS_HEADERS_KEY)) {
    conflicts.push({
      key: LOGS_HEADERS_KEY,
      current: maskSecrets(formatEnvValue(settings.env[LOGS_HEADERS_KEY])),
      wanted: 'Authorization=Bearer <the token this invite would issue>',
    });
  }
  return conflicts;
}

/** True when the existing keys look like a ccledger install rather than someone else's. */
function looksLikeCcledger(settings: SettingsFile): boolean {
  const headers = settings.env[LOGS_HEADERS_KEY];
  return typeof headers === 'string' && headers.includes(`Bearer ${MEMBER_TOKEN_PREFIX}`);
}

/** Prints the conflicts and the way out of them, then exits non-zero. */
function refuseOnConflict(settings: SettingsFile, conflicts: readonly EnvConflict[]): never {
  say();
  say(`These keys are already set in ${settings.path}:`);
  say();
  for (const conflict of conflicts) {
    say(`  ${conflict.key}`);
    say(`      is       ${conflict.current}`);
    say(`      would be ${conflict.wanted}`);
  }
  say();
  if (looksLikeCcledger(settings)) {
    const endpoint = settings.env[LOGS_ENDPOINT_KEY];
    say(
      `This machine is already set up for ccledger${
        typeof endpoint === 'string' ? `, reporting to ${endpoint}` : ''
      }.`,
    );
    say('To point it somewhere else, run `ccledger uninstall` first and then setup again.');
  } else {
    say('Something other than ccledger is using these keys — another OTLP collector, most');
    say('likely. ccledger will not overwrite them. Remove or rename them if you want');
    say('ccledger to take over, or point that collector somewhere else.');
  }
  say();
  fail('nothing was changed');
}

/**
 * The sentence for a run that has to confirm something and has nobody to ask.
 * It is the same wherever the silence turns up, because the way out of it is.
 */
const NO_ANSWER =
  'setup will not change anything without a confirmation, and there is no terminal to ask at. ' +
  'Re-run with --yes (and --name "Your Name") to accept this in a script.';

/** Asks for a display name, or takes the one that was given. */
async function resolveDisplayName(
  options: SetupOptions,
  suggestion: string | undefined,
  prompter: Prompter | undefined,
): Promise<string> {
  const given = options.name ?? (prompter === undefined ? suggestion : undefined);
  if (given !== undefined) {
    const name = normaliseDisplayName(given);
    if (name === undefined) {
      fail(`the display name must be 1 to ${String(MAX_DISPLAY_NAME_LENGTH)} printable characters`);
    }
    return name;
  }
  if (prompter === undefined) {
    fail('there is no name in this invite, so --yes needs --name "Your Name" as well');
  }

  const prompt =
    suggestion === undefined
      ? 'Display name to show on the dashboard: '
      : `Display name to show on the dashboard [${suggestion}]: `;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await prompter.ask(prompt);
    if (answer === undefined) fail(NO_ANSWER);
    const candidate = answer === '' ? suggestion : answer;
    const name = candidate === undefined ? undefined : normaliseDisplayName(candidate);
    if (name !== undefined) return name;
    warn(`a display name is 1 to ${String(MAX_DISPLAY_NAME_LENGTH)} printable characters`);
  }
  fail('no usable display name was given');
}

/** Spends the join code. Every refusal the server can send gets its own sentence. */
async function join(endpoint: string, body: JoinRequestBody): Promise<JoinResponseBody> {
  const url = `${endpoint}${JOIN_PATH}`;
  const result = await request(url, { method: 'POST', body: JSON.stringify(body) });
  if (!result.ok) fail(result.error);

  const response = result.response;
  if (response.status === 200) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      fail(
        `${url} answered 200 with something that is not JSON; is that really a ccledger server?`,
      );
    }
    const record = parsed as Partial<JoinResponseBody>;
    if (typeof record.token !== 'string' || typeof record.member_id !== 'string') {
      fail(`${url} answered 200 without a token; is that really a ccledger server?`);
    }
    return {
      token: record.token,
      member_id: record.member_id,
      server_name: typeof record.server_name === 'string' ? record.server_name : 'ccledger',
    };
  }

  const message = errorTextOf(response.body, `the server answered ${String(response.status)}`);
  if (response.status === 404 || response.status === 409 || response.status === 410) {
    fail(`${message}`);
  }
  fail(`could not join at ${url}: ${message}`);
}

/** Prints the block that has to be read before anything is written. */
function printDisclosure(settingsPath: string): void {
  say();
  for (const line of DISCLOSURE) say(line);
  say();
  say(`On this machine that file is: ${settingsPath}`);
  say('Joining also tells the server this machine name and operating system, once.');
  say();
}

/** The notice that decides whether any of this produces data. */
function printRestartNotice(): void {
  say();
  say(`  ${RULE}`);
  say('   RESTART CLAUDE CODE for any of this to take effect.');
  say('   Telemetry configuration is read once, when Claude Code starts, so a');
  say('   session that is already open will keep reporting nothing.');
  say(`  ${RULE}`);
  say();
}

/** Joins a server and writes the config. Exits non-zero, having changed nothing, on refusal. */
export async function runSetup(options: SetupOptions): Promise<void> {
  const paths = resolveClientPaths(options.home);

  const decoded = decodeInvite(options.code);
  if (!decoded.ok) {
    fail(`${decoded.error}. Ask your admin to send the invite again.`);
  }
  const invite = decoded.invite;

  const read = readSettings(paths.settingsPath);
  if (!read.ok) fail(read.error);
  const settings = read.settings;

  // Read-only, and before the disclosure: a conflict is not something anyone
  // should have to confirm their way into discovering.
  const conflicts = conflictsBeforeJoin(settings, invite.endpoint);
  if (conflicts.length > 0) refuseOnConflict(settings, conflicts);

  // `isTTY` rather than "read stdin and see": a stdin that is a pipe nobody
  // ever writes to — a CI job, a daemonised run — would otherwise wait for an
  // answer that is never coming, and a command that hangs is worse than one
  // that says what flag it needs. A test supplies its own stream instead.
  const canAsk = options.input !== undefined || process.stdin.isTTY === true;
  const prompter = options.yes === true || !canAsk ? undefined : createPrompter(options.input);
  try {
    if (prompter === undefined && options.yes !== true) fail(NO_ANSWER);
    const displayName = await resolveDisplayName(options, invite.name, prompter);

    printDisclosure(paths.settingsPath);
    if (prompter === undefined) {
      say('Accepted without asking, because --yes was given.');
    } else {
      const answer = await prompter.ask(`Send this to ${invite.endpoint}? [y/N] `);
      if (answer === undefined) fail(NO_ANSWER);
      if (!isAffirmative(answer)) fail('cancelled; nothing was changed');
    }

    const machine = machineDescription();
    const joined = await join(invite.endpoint, {
      code: invite.code,
      display_name: displayName,
      hostname: machine.hostname,
      os: machine.os,
    });

    // Re-read: between the check above and now a token was issued over the
    // network, and the file is not this process's to assume it still owns.
    const recheck = readSettings(paths.settingsPath);
    if (!recheck.ok) fail(`${recheck.error} (your token is member ${joined.member_id})`);
    const stillClear = conflictsBeforeJoin(recheck.settings, invite.endpoint);
    if (stillClear.length > 0) {
      warn(`${paths.settingsPath} changed while setup was running; nothing was written`);
      warn(`ask your admin to revoke member ${joined.member_id}, then start again`);
      refuseOnConflict(recheck.settings, stillClear);
    }

    const entries = entriesFor(invite.endpoint, joined.token);
    let written;
    try {
      written = writeEnvEntries(recheck.settings, entries);
    } catch (error) {
      if (error instanceof SettingsError) {
        warn(`ask your admin to revoke member ${joined.member_id}, then start again`);
        fail(error.message);
      }
      throw error;
    }

    writeState(paths.statePath, {
      version: 1,
      serverUrl: invite.endpoint,
      serverName: joined.server_name,
      memberId: joined.member_id,
      displayName,
      settingsPath: written.path,
      createdSettingsFile: written.createdFile,
      createdEnvObject: written.createdEnv,
      addedKeys: entries.map((entry) => entry.key),
      valueDigests: Object.fromEntries(
        entries.map((entry) => [entry.key, digestValue(entry.value)]),
      ),
      installedAt: Date.now(),
      ...(written.backupPath !== undefined ? { backupPath: written.backupPath } : {}),
    });

    say();
    say(`Joined ${joined.server_name} as ${displayName}.`);
    say();
    say(`  config      ${written.path}`);
    if (written.backupPath !== undefined) say(`  backup      ${written.backupPath}`);
    say(`  ingest      ${invite.endpoint}${OTLP_LOGS_PATH}`);
    say(`  record      ${paths.statePath}`);
    say();
    say('  Five keys were added under "env". Nothing else in that file was touched.');

    if (isGroupOrWorldReadable(recheck.settings.mode)) {
      warn(`${written.path} is readable by other users on this machine, and it now holds a token`);
    }

    await verifyToken(invite.endpoint, joined.token);
    printRestartNotice();
  } finally {
    prompter?.close();
  }
}

/**
 * Sends an empty batch, which is a valid OTLP payload carrying no records, to
 * confirm the token works and the path is right. It stores nothing.
 *
 * A failure here is a warning, not an error: the config is written and correct
 * as far as this machine can tell, and the thing to do about a proxy that eats
 * `/v1/logs` is to say so, not to unwind an install over it.
 */
async function verifyToken(endpoint: string, token: string): Promise<void> {
  const url = `${endpoint}${OTLP_LOGS_PATH}`;
  const result = await request(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: EMPTY_OTLP_ENVELOPE,
  });
  if (!result.ok) {
    warn(`could not check the new token: ${result.error}`);
    warn('run `ccledger doctor` once the server is reachable');
    return;
  }
  if (result.response.status !== 200) {
    warn(
      `the server answered ${String(result.response.status)} to a test batch: ` +
        errorTextOf(result.response.body, 'no reason given'),
    );
    warn('run `ccledger doctor` for the details');
    return;
  }
  say('  Checked: the server accepted a test batch from this machine.');
}
