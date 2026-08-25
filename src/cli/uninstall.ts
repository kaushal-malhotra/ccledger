/**
 * `ccledger uninstall`: giving the machine back.
 *
 * This is the command that makes the rest of it acceptable to install. It has
 * to be as careful on the way out as setup was on the way in, which means it
 * removes exactly the keys `~/.ccledger/state.json` says were added, leaves a
 * key someone has since edited alone, and never rewrites anything else in the
 * settings file.
 *
 * Three things are offered rather than assumed: restoring the backup instead of
 * removing the keys, telling the server so the admin can revoke the token, and —
 * implicitly — doing none of it, because every prompt can be answered no.
 */

import { LEAVE_PATH, MEMBER_TOKEN_PREFIX } from '../shared/constants.js';
import { errorTextOf, request } from './http.js';
import { fail, say, warn } from './io.js';
import { resolveClientPaths } from './paths.js';
import { createPrompter, isAffirmative } from './prompt.js';
import type { SettingsFile } from './settings.js';
import {
  LOGS_ENDPOINT_KEY,
  LOGS_HEADERS_KEY,
  OWNED_ENV_KEYS,
  SettingsError,
  baseUrlOfLogsEndpoint,
  readSettings,
  removeEnvKeys,
  restoreBackup,
  tokenOfHeaders,
} from './settings.js';
import type { ClientState } from './state.js';
import { digestValue, readState, removeStateDirectory } from './state.js';

/** Options for `ccledger uninstall`, as Commander hands them over. */
export interface UninstallOptions {
  /** Take every offer at its default and ask nothing. */
  readonly yes?: boolean;
  /** Put the backup back instead of removing the five keys. */
  readonly restoreBackup?: boolean;
  /** Tell the server the token is being given up. True unless `--no-notify`. */
  readonly notify?: boolean;
  /** Home directory to resolve `~` against. The CLI never sets it; a test does. */
  readonly home?: string;
  /** Stream the questions are read from. The CLI never sets it; a test does. */
  readonly input?: NodeJS.ReadableStream;
}

/** What uninstall decided to take out, and on whose authority. */
interface RemovalPlan {
  readonly keys: readonly string[];
  /** Digests to compare values against. Empty when working without a state file. */
  readonly digests: Readonly<Record<string, string>>;
  /** Take `env` away too if it ends up empty. */
  readonly removeEmptyEnv: boolean;
  /** True when the keys came from a guess rather than from `state.json`. */
  readonly inferred: boolean;
}

/**
 * True when the five keys in a settings file look like ccledger's own work: an
 * endpoint that ends in the ingest path, and a header carrying a member token.
 *
 * This is only consulted when `state.json` has gone missing. Someone who deletes
 * `~/.ccledger` should not be permanently unable to uninstall, but "remove only
 * the keys ccledger added" still has to hold — so without the record, the keys
 * have to look like ccledger's before they are touched at all.
 */
function looksLikeCcledgerConfig(settings: SettingsFile): boolean {
  const headers = settings.env[LOGS_HEADERS_KEY];
  return (
    baseUrlOfLogsEndpoint(settings.env[LOGS_ENDPOINT_KEY]) !== undefined &&
    typeof headers === 'string' &&
    headers.includes(`Bearer ${MEMBER_TOKEN_PREFIX}`)
  );
}

/** Works out what may be removed, from the record if there is one and cautiously if not. */
function planRemoval(state: ClientState | undefined, settings: SettingsFile): RemovalPlan {
  if (state !== undefined) {
    return {
      // Only the ones still there: a key that has already gone is not something
      // to announce, and `state.json` is a record of the past, not of the file.
      keys: state.addedKeys.filter((key) => Object.hasOwn(settings.env, key)),
      digests: state.valueDigests,
      removeEmptyEnv: state.createdEnvObject,
      inferred: false,
    };
  }
  if (!looksLikeCcledgerConfig(settings)) {
    return { keys: [], digests: {}, removeEmptyEnv: false, inferred: true };
  }
  return {
    keys: OWNED_ENV_KEYS.filter((key) => Object.hasOwn(settings.env, key)),
    digests: {},
    removeEmptyEnv: false,
    inferred: true,
  };
}

/**
 * Tells the server the token is being given up. Advisory: a machine that is
 * offline still gets to uninstall, and the member id is printed so an admin can
 * revoke it by hand.
 */
async function notifyServer(serverUrl: string, token: string, memberId: string): Promise<void> {
  const url = `${serverUrl}${LEAVE_PATH}`;
  const result = await request(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{}',
  });
  if (!result.ok) {
    warn(`could not reach the server: ${result.error}`);
    say(`  Ask your admin to revoke member ${memberId}.`);
    return;
  }
  const status = result.response.status;
  if (status === 200) {
    say('  The server has revoked this token.');
    return;
  }
  if (status === 403) {
    say('  The server had already revoked this token.');
    return;
  }
  if (status === 401) {
    say('  The server does not recognise this token; there is nothing left to revoke.');
    return;
  }
  warn(
    `the server answered ${String(status)}: ` +
      errorTextOf(result.response.body, 'no reason given'),
  );
  say(`  Ask your admin to revoke member ${memberId}.`);
}

/**
 * The sentence for a run that has to confirm something and has nobody to ask.
 */
const NO_ANSWER =
  'uninstall will not change anything without a confirmation, and there is no terminal to ask ' +
  'at. Re-run with --yes to accept in a script.';

/** Removes ccledger's keys, offers the backup instead, and clears `~/.ccledger`. */
export async function runUninstall(options: UninstallOptions = {}): Promise<void> {
  const paths = resolveClientPaths(options.home);

  const stateResult = readState(paths.statePath);
  if (!stateResult.ok) fail(stateResult.error);
  const state = stateResult.state;

  const settingsPath = state?.settingsPath ?? paths.settingsPath;
  const read = readSettings(settingsPath);
  if (!read.ok) fail(read.error);
  const settings = read.settings;

  const plan = planRemoval(state, settings);
  const token = tokenOfHeaders(settings.env[LOGS_HEADERS_KEY]);
  const serverUrl = state?.serverUrl ?? baseUrlOfLogsEndpoint(settings.env[LOGS_ENDPOINT_KEY]);

  say();
  if (state === undefined) {
    warn(`no record at ${paths.statePath}, so ccledger does not know what it added here`);
  }
  if (plan.keys.length === 0) {
    say(`Nothing of ccledger's is in ${settingsPath}.`);
  } else {
    say(`These keys will be removed from ${settingsPath}:`);
    say();
    for (const key of plan.keys) say(`  ${key}`);
    say();
    if (plan.inferred) {
      say('They are being taken from the five keys ccledger writes, because the record of');
      say('what it wrote is gone. Nothing else in the file will be touched.');
      say();
    }
  }

  // `isTTY` rather than "read stdin and see": a stdin that is a pipe nobody
  // ever writes to — a CI job, a daemonised run — would otherwise wait for an
  // answer that is never coming, and a command that hangs is worse than one
  // that says what flag it needs. A test supplies its own stream instead.
  const assumeYes = options.yes === true;
  const canAsk = options.input !== undefined || process.stdin.isTTY === true;
  const prompter = assumeYes || !canAsk ? undefined : createPrompter(options.input);

  /**
   * Asks a yes-or-no question. `--yes` answers it with `standard`; `undefined`
   * means nobody answered at all, which the caller has to tell apart from a no
   * because one of these questions decides whether the command does anything.
   */
  const ask = async (question: string, standard: boolean): Promise<boolean | undefined> => {
    if (assumeYes) return standard;
    if (prompter === undefined) return undefined;
    const answer = await prompter.ask(`${question} ${standard ? '[Y/n]' : '[y/N]'} `);
    if (answer === undefined) return undefined;
    return answer === '' ? standard : isAffirmative(answer);
  };

  try {
    if (plan.keys.length > 0) {
      const proceed = await ask('Remove them?', true);
      if (proceed === undefined) fail(NO_ANSWER);
      if (!proceed) fail('cancelled; nothing was changed');
    }

    const backupPath = state?.backupPath;
    const restore =
      backupPath !== undefined &&
      (options.restoreBackup === true ||
        (options.restoreBackup === undefined &&
          // No answer means no: an offer nobody took is an offer declined.
          ((await ask(
            `Put the backup at ${backupPath} back instead, undoing anything else changed since?`,
            false,
          )) ??
            false)));

    if (options.restoreBackup === true && backupPath === undefined) {
      fail('there is no backup recorded for this machine, so there is nothing to restore');
    }

    if (restore && backupPath !== undefined) {
      try {
        restoreBackup(backupPath, settingsPath);
      } catch (error) {
        fail(
          `could not restore ${backupPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      say(`Restored ${settingsPath} from ${backupPath}.`);
    } else if (plan.keys.length > 0) {
      let outcome;
      try {
        outcome = removeEnvKeys(settings, plan.keys, {
          expected: plan.digests,
          digest: digestValue,
          removeEmptyEnv: plan.removeEmptyEnv,
        });
      } catch (error) {
        if (error instanceof SettingsError) fail(error.message);
        throw error;
      }
      say(
        `Removed ${String(outcome.removed.length)} key${outcome.removed.length === 1 ? '' : 's'} ` +
          `from ${settingsPath}.`,
      );
      if (outcome.backupPath !== undefined)
        say(`  A copy of the previous file is at ${outcome.backupPath}.`);
      for (const kept of outcome.kept) {
        warn(`left ${kept.key} in place: ${kept.reason}`);
      }
      if (state?.createdSettingsFile === true && outcome.fileIsEmptyObject) {
        say('  ccledger created that file and it is now empty; it has been left in place.');
      }
    }

    const wantsNotify =
      serverUrl !== undefined &&
      token !== undefined &&
      (options.notify ??
        (await ask('Tell the server, so it can revoke the token?', true)) ??
        false);
    if (wantsNotify && serverUrl !== undefined && token !== undefined) {
      await notifyServer(serverUrl, token, state?.memberId ?? 'unknown');
    } else if (serverUrl !== undefined && token !== undefined) {
      say(
        `  The server was not told. Ask your admin to revoke member ${state?.memberId ?? 'yours'}.`,
      );
    }
  } finally {
    prompter?.close();
  }

  const removal = removeStateDirectory(paths.statePath, paths.stateDir);
  if (removal.removed) {
    say(`Removed ${paths.stateDir}.`);
  } else {
    warn(`left ${paths.stateDir} in place: ${removal.reason ?? 'unknown reason'}`);
  }

  say();
  say('Restart Claude Code to stop it exporting; it reads this configuration once, at startup.');
  say();
}
