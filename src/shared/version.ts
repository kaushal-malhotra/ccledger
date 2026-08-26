/**
 * Identity read out of `package.json`, once.
 *
 * Two things live here because both have to agree with what was actually
 * published. The version is reported by the CLI's `--version` and the server's
 * `/health`, which must never disagree. The name is what `ccledger invite`
 * tells a teammate to `npx`, and getting that wrong is worse than a wrong
 * version number: `npx ccledger` resolves to a different author's package, so
 * the line an admin pastes into chat has to be the registry name this build was
 * published under rather than the command it installs.
 */

import { readFileSync } from 'node:fs';

/** Reported when `package.json` cannot be read; a broken install, not a crash. */
const UNKNOWN_VERSION = '0.0.0';

/**
 * Used when `package.json` cannot be read. Scoped, because that is what is on
 * the registry — the unscoped name was refused as too close to an unrelated
 * package, and it belongs to somebody else's project.
 */
const FALLBACK_PACKAGE_NAME = '@thisissbk/ccledger';

/**
 * Reads `package.json` at run time rather than importing it. A JSON import
 * would pull a file outside `rootDir` into the compile and change the emitted
 * layout; `readFileSync` keeps `dist/` a mirror of `src/`. The same
 * two-levels-up URL resolves from `src/shared/` under vitest, from
 * `dist/shared/` after a build, and from the installed package's own
 * `dist/shared/` once published.
 */
function readManifest(): Readonly<Record<string, unknown>> | undefined {
  try {
    const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // An unreadable package.json is a packaging problem, not a reason to refuse
    // to boot and stop collecting telemetry that is already being exported.
  }
  return undefined;
}

/** One non-empty string field of the manifest, or `undefined`. */
function stringField(
  manifest: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value: unknown = manifest?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Resolved at module load: `/health` must not do file I/O per request. */
const MANIFEST = readManifest();

/** The running ccledger version. */
export const VERSION: string = stringField(MANIFEST, 'version') ?? UNKNOWN_VERSION;

/**
 * The name this build is published under, for the `npx` lines the CLI prints.
 * Taken from the manifest rather than written out, so it cannot drift from what
 * `npm publish` actually uploaded.
 */
export const PACKAGE_NAME: string = stringField(MANIFEST, 'name') ?? FALLBACK_PACKAGE_NAME;
