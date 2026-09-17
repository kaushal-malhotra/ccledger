/**
 * Where the client commands look on disk, resolved from one home directory.
 *
 * Every path ccledger reads or writes on a teammate's machine is derived here
 * rather than assembled at each call site, for two reasons. The first is that
 * `~` is not a path — the shell expands it, `fs` does not — and the second is
 * that a test needs to point the whole client at a temporary directory. Taking
 * the home directory as a defaulted parameter gives both: production passes
 * nothing, a test passes a `mkdtemp` and no real settings file is ever at risk.
 */

import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** Claude Code's own directory under the home directory, and the default profile's name. */
export const CLAUDE_DIR_NAME = '.claude';

/** The file that carries the config contract: the five keys ccledger owns. */
export const SETTINGS_FILE_NAME = 'settings.json';

/** Where Claude Code writes a session's transcripts. `doctor` reads its mtimes. */
export const PROJECTS_DIR_NAME = 'projects';

/** ccledger's own directory. Holds one `state*.json` file per profile tracked here. */
export const CCLEDGER_DIR_NAME = '.ccledger';

/**
 * The record of what setup added for the default (`.claude`) profile. Kept as
 * the bare, unsuffixed name for backward compatibility: every install made
 * before profiles existed already has its record at this exact path, and
 * moving it out from under existing installs would orphan them.
 */
export const STATE_FILE_NAME = 'state.json';

/** The environment variable Claude Code itself reads to relocate `~/.claude`. */
export const CONFIG_DIR_ENV_VAR = 'CLAUDE_CONFIG_DIR';

/**
 * Prefix of a settings backup. The unix timestamp is appended, so backups sort
 * by age and no two runs collide.
 */
export const BACKUP_PREFIX = `${SETTINGS_FILE_NAME}.ccledger-backup-`;

/** Every path the client commands use, absolute, for one home directory. */
export interface ClientPaths {
  readonly home: string;
  /** `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` points this profile at. */
  readonly claudeDir: string;
  /** The basename of `claudeDir` — `.claude` for the default profile. */
  readonly profileName: string;
  /** `<claudeDir>/settings.json`. */
  readonly settingsPath: string;
  /** `<claudeDir>/projects`. May not exist until Claude Code has run once. */
  readonly projectsDir: string;
  /** `~/.ccledger`. Shared by every profile on this machine. */
  readonly stateDir: string;
  /**
   * `~/.ccledger/state.json` for the default profile, `~/.ccledger/state-<profile>.json`
   * for any other, so each profile's install is undone independently and
   * `removeStateDirectory` only clears `~/.ccledger` once every profile is gone.
   */
  readonly statePath: string;
}

/**
 * Expands a leading `~` against `home` and resolves a relative path against the
 * current working directory — the same handling a shell gives `CLAUDE_CONFIG_DIR`
 * before Node ever sees it, applied again here for the callers (a script, a
 * different shell) that pass the value through unexpanded.
 */
export function resolveConfigDirValue(value: string, home: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(home, trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

/**
 * Resolves every client path from a home directory, `os.homedir()` by default,
 * and a Claude Code config directory override — `CLAUDE_CONFIG_DIR` by default,
 * mirroring exactly what Claude Code itself honours, so a teammate who runs
 * `CLAUDE_CONFIG_DIR=~/.claude-work ccledger setup` gets that profile wired up
 * without a ccledger-specific flag to learn.
 */
export function resolveClientPaths(
  home: string = homedir(),
  configDir: string | undefined = process.env[CONFIG_DIR_ENV_VAR],
): ClientPaths {
  const trimmed = configDir?.trim();
  const claudeDir =
    trimmed === undefined || trimmed === ''
      ? join(home, CLAUDE_DIR_NAME)
      : resolveConfigDirValue(trimmed, home);
  const profileName = basename(claudeDir) || CLAUDE_DIR_NAME;
  const stateDir = join(home, CCLEDGER_DIR_NAME);
  const stateFileName =
    profileName === CLAUDE_DIR_NAME ? STATE_FILE_NAME : `state-${profileName}.json`;
  return {
    home,
    claudeDir,
    profileName,
    settingsPath: join(claudeDir, SETTINGS_FILE_NAME),
    projectsDir: join(claudeDir, PROJECTS_DIR_NAME),
    stateDir,
    statePath: join(stateDir, stateFileName),
  };
}

/** The path a backup taken at `now` is written to, beside the settings file. */
export function backupPathFor(settingsPath: string, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  return `${settingsPath}.ccledger-backup-${String(seconds)}`;
}
