/**
 * Finding Claude Code profiles on this machine without reading any of them.
 *
 * A profile's directory name is whatever `CLAUDE_CONFIG_DIR` was set to —
 * `.claude-work`, `.kaushal_dir`, anything — so it cannot be guessed by name.
 * What can be checked is structure: a profile directory holds some combination
 * of `settings.json`, `history.jsonl`, `stats-cache.json` and a `projects/`
 * directory, none of which this module ever opens for content. `history.jsonl`
 * and the files under `projects/` are Claude Code session transcripts — this
 * module only ever calls `readdir`/`stat` on them, the same as `ls`, never
 * `readFile`. Finding a profile and reading what happened inside it are two
 * different operations, and ccledger only ever does the first.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { CLAUDE_DIR_NAME, PROJECTS_DIR_NAME, SETTINGS_FILE_NAME } from './paths.js';

/** How deep under the home directory to look. Matches `find -maxdepth 3`. */
const MAX_DEPTH = 3;

/** The marker file a candidate directory is found by. */
const HISTORY_FILE_NAME = 'history.jsonl';

/** A second signal `stats-cache.json` gives when `history.jsonl` is absent. */
const STATS_CACHE_FILE_NAME = 'stats-cache.json';

/** Directory names never worth descending into looking for a profile. */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', PROJECTS_DIR_NAME]);

/** A Claude Code profile directory found on disk, validated by structure. */
export interface DiscoveredProfile {
  /** Absolute path, e.g. `/home/kaushal/.claude-work`. */
  readonly configDir: string;
  /** `basename(configDir)`, e.g. `.claude-work`. */
  readonly profileName: string;
  /** Which of the Claude Code-specific markers were found. */
  readonly evidence: readonly string[];
}

/** Directory entry names, without throwing on a directory that vanished mid-walk. */
function tryReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** True when `path` exists and is a directory. Never throws. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` exists and is a file. Never throws. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whichever of the Claude Code-specific markers `dir` has, checked by
 * existence only. A `projects/` directory counts on its own — Claude Code
 * session files live nowhere else — but `settings.json` alone does not, since
 * plenty of unrelated tools have one of those.
 */
function evidenceIn(dir: string): string[] {
  const found: string[] = [];
  if (isFile(join(dir, HISTORY_FILE_NAME))) found.push(HISTORY_FILE_NAME);
  if (isFile(join(dir, STATS_CACHE_FILE_NAME))) found.push(STATS_CACHE_FILE_NAME);
  if (isDirectory(join(dir, PROJECTS_DIR_NAME))) found.push(PROJECTS_DIR_NAME);
  if (isFile(join(dir, SETTINGS_FILE_NAME))) found.push(SETTINGS_FILE_NAME);
  return found;
}

/** True when the evidence found is enough to call `dir` a Claude Code profile. */
function isValidProfile(evidence: readonly string[]): boolean {
  if (evidence.includes(HISTORY_FILE_NAME)) return true;
  if (evidence.includes(PROJECTS_DIR_NAME)) return true;
  // settings.json and stats-cache.json alone are each too generic; together
  // they are specific enough that requiring both avoids a false positive on
  // some other tool's directory that happens to have a settings.json.
  return evidence.includes(SETTINGS_FILE_NAME) && evidence.includes(STATS_CACHE_FILE_NAME);
}

/**
 * Walks `home` up to `MAX_DEPTH` looking for directories with Claude Code's
 * structure, the same reach as
 * `find "$HOME" -maxdepth 3 -type f -name history.jsonl`. Every candidate is
 * validated by `isValidProfile` before it is returned, so a stray
 * `history.jsonl` from an unrelated tool does not get reported as a profile.
 * `os.homedir()` by default; a test passes a `mkdtemp`.
 */
export function discoverProfiles(home: string = homedir()): DiscoveredProfile[] {
  const found = new Map<string, DiscoveredProfile>();

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const evidence = evidenceIn(dir);
    if (evidence.length > 0 && isValidProfile(evidence) && dir !== home) {
      found.set(dir, { configDir: dir, profileName: basename(dir), evidence });
    }
    if (depth === MAX_DEPTH) return;
    for (const name of tryReadDir(dir)) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const child = join(dir, name);
      if (isDirectory(child)) visit(child, depth + 1);
    }
  };

  visit(home, 0);
  return [...found.values()].sort((a, b) => a.profileName.localeCompare(b.profileName));
}

/** The default profile's directory name, exported for callers that filter it out. */
export const DEFAULT_PROFILE_NAME = CLAUDE_DIR_NAME;
