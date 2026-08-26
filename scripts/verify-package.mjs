/**
 * Checks what `npm pack` would actually ship.
 *
 * The failures this catches are all silent ones. A tarball missing
 * `schema.sql` installs fine and dies on first run, inside a migration, with an
 * ENOENT naming a path that does not exist on the user's machine. A tarball
 * missing the dashboard installs fine and serves an apology at `/`. And a
 * tarball that picked up `captures/` would publish the capturing account's real
 * email to the registry, permanently — npm does not allow a republish over a
 * deleted version.
 *
 * None of that is visible in a green test run, so it is asserted here and run
 * in CI on the built tree.
 *
 * Usage: npm run build && node scripts/verify-package.mjs
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file rather than from the working directory. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files that must be in the tarball. The entry point and the two kinds of
 * asset `tsc` would never have emitted on its own — every one of them is
 * loaded by path at run time, so a build that drops one still passes tests.
 */
const REQUIRED = [
  'package.json',
  'dist/cli/index.js',
  'dist/server/app.js',
  'dist/db/schema.sql',
  'dist/db/schema-identity.sql',
  'dist/db/schema-alerts.sql',
  'dist/server/public/index.html',
];

/**
 * Path patterns that must not be in the tarball, with why. Tests are excluded
 * because they import vitest, which is absent from an installed package;
 * sourcemaps and declarations because nothing consumes them; the rest because
 * they are either private or somebody's local state.
 */
const FORBIDDEN = [
  [/(^|\/)captures\//, 'raw OTLP captures carry a real email and account identifiers'],
  [/\.test\.[cm]?[jt]sx?$/, 'tests import vitest, which an installed package does not have'],
  [/\.map$/, 'sourcemaps are weight no consumer of a CLI reads'],
  [/\.d\.[cm]?ts$/, 'nothing imports types from this package'],
  [/^src\//, 'the published package ships the build, not the sources'],
  [/^(test|web|docker|scripts|\.github)\//, 'development-only trees'],
  [/\.db(-wal|-shm)?$/, 'a local database would ship somebody’s telemetry'],
  [/(^|\/)\.env$/, 'local secrets'],
];

/** Everything `npm pack` reports it would include, as forward-slash paths. */
function packedFiles() {
  // `--dry-run` writes no tarball; `--json` is what makes this an assertion
  // rather than a grep over human-readable output that changes between npm
  // versions. npm writes its notices to stderr, so stdout is only the JSON.
  //
  // Run through a shell as one fixed string, which is the only portable way to
  // reach npm: on Windows it is `npm.cmd`, and since Node 20.12 spawning a
  // `.cmd` without a shell fails with EINVAL. Nothing here is interpolated, so
  // there is no argument to escape.
  const output = execSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf8' });
  const parsed = JSON.parse(output);
  const entry = parsed[0];
  if (entry === undefined) throw new Error('npm pack --json reported no package');
  return entry.files.map((file) => file.path.replace(/\\/g, '/'));
}

const files = packedFiles();
const problems = [];

for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`missing: ${required}`);
}

for (const [pattern, reason] of FORBIDDEN) {
  for (const file of files.filter((path) => pattern.test(path))) {
    problems.push(`must not ship: ${file} — ${reason}`);
  }
}

// A dashboard is more than its index. Vite fingerprints the bundle, so the
// filenames are not knowable here, but their absence is.
if (!files.some((file) => file.startsWith('dist/server/public/assets/'))) {
  problems.push('missing: dist/server/public/assets/ — the dashboard bundle was not copied');
}

if (problems.length > 0) {
  console.error(`verify-package: ${String(problems.length)} problem(s) with the tarball\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nRun `npm run build` first; if that was run, the build lost a step.');
  process.exit(1);
}

console.log(`verify-package: ${String(files.length)} files, all required present`);
for (const required of REQUIRED) console.log(`  ok  ${required}`);
