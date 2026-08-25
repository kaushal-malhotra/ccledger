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
import { join } from 'node:path';

/** Claude Code's own directory under the home directory. */
export const CLAUDE_DIR_NAME = '.claude';

/** The file that carries the config contract, PRD section 7. */
export const SETTINGS_FILE_NAME = 'settings.json';

/** Where Claude Code writes a session's transcripts. `doctor` reads its mtimes. */
export const PROJECTS_DIR_NAME = 'projects';

/** ccledger's own directory. Holds `state.json` and nothing else. */
export const CCLEDGER_DIR_NAME = '.ccledger';

/** The record of what setup added, so uninstall removes only that. */
export const STATE_FILE_NAME = 'state.json';

/**
 * Prefix of a settings backup. The unix timestamp is appended, so backups sort
 * by age and no two runs collide.
 */
export const BACKUP_PREFIX = `${SETTINGS_FILE_NAME}.ccledger-backup-`;

/** Every path the client commands use, absolute, for one home directory. */
export interface ClientPaths {
  readonly home: string;
  /** `~/.claude`. */
  readonly claudeDir: string;
  /** `~/.claude/settings.json`. */
  readonly settingsPath: string;
  /** `~/.claude/projects`. May not exist until Claude Code has run once. */
  readonly projectsDir: string;
  /** `~/.ccledger`. */
  readonly stateDir: string;
  /** `~/.ccledger/state.json`. */
  readonly statePath: string;
}

/** Resolves every client path from a home directory, `os.homedir()` by default. */
export function resolveClientPaths(home: string = homedir()): ClientPaths {
  const claudeDir = join(home, CLAUDE_DIR_NAME);
  const stateDir = join(home, CCLEDGER_DIR_NAME);
  return {
    home,
    claudeDir,
    settingsPath: join(claudeDir, SETTINGS_FILE_NAME),
    projectsDir: join(claudeDir, PROJECTS_DIR_NAME),
    stateDir,
    statePath: join(stateDir, STATE_FILE_NAME),
  };
}

/** The path a backup taken at `now` is written to, beside the settings file. */
export function backupPathFor(settingsPath: string, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  return `${settingsPath}.ccledger-backup-${String(seconds)}`;
}
