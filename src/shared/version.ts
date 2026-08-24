/**
 * The package version, read once. Both the CLI's `--version` and the server's
 * `/health` report it, and they must never disagree.
 */

import { readFileSync } from 'node:fs';

/** Reported when `package.json` cannot be read; a broken install, not a crash. */
const UNKNOWN_VERSION = '0.0.0';

/**
 * Reads the version from `package.json` at run time rather than importing it.
 * A JSON import would pull a file outside `rootDir` into the compile and change
 * the emitted layout; `readFileSync` keeps `dist/` a mirror of `src/`. The same
 * two-levels-up URL resolves from `src/shared/` under vitest, from `dist/shared/`
 * after a build, and from `node_modules/ccledger/dist/shared/` once installed.
 */
function readPackageVersion(): string {
  try {
    const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const version: unknown = (parsed as Record<string, unknown>).version;
      if (typeof version === 'string' && version !== '') return version;
    }
  } catch {
    // An unreadable package.json is a packaging problem, not a reason to refuse
    // to boot and stop collecting telemetry that is already being exported.
  }
  return UNKNOWN_VERSION;
}

/**
 * The running ccledger version. Resolved at module load: `/health` must not do
 * file I/O per request.
 */
export const VERSION: string = readPackageVersion();
