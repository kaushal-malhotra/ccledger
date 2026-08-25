/**
 * Copies non-TypeScript build assets into `dist/`. `tsc` emits only what it
 * compiles, so `schema.sql` would otherwise be missing from the published
 * package and `runMigrations` would fail on a global install — and the built
 * dashboard, which Vite writes into `src/server/public`, would never reach it
 * at all.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Single files, as `[source, destination]` relative to this script. */
const FILES = [
  ['../src/db/schema.sql', '../dist/db/schema.sql'],
  ['../src/db/schema-identity.sql', '../dist/db/schema-identity.sql'],
];

/**
 * Whole trees, same shape. The dashboard bundle sits beside the module that
 * serves it in both layouts, which is what lets `dashboardRoot()` find it with
 * one relative URL rather than a search path.
 */
const DIRECTORIES = [['../src/server/public', '../dist/server/public']];

/** What to say when the dashboard has not been built. */
const MISSING_DASHBOARD =
  'run `npm run build:web` first, or `npm run build`, which runs both halves in order';

let failed = false;

for (const [from, to] of FILES) {
  const source = fileURLToPath(new URL(from, import.meta.url));
  const destination = fileURLToPath(new URL(to, import.meta.url));

  if (!existsSync(source)) {
    console.error(`copy-assets: missing ${source}`);
    failed = true;
    continue;
  }

  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  console.log(`copy-assets: ${from} -> ${to}`);
}

for (const [from, to] of DIRECTORIES) {
  const source = fileURLToPath(new URL(from, import.meta.url));
  const destination = fileURLToPath(new URL(to, import.meta.url));

  if (!existsSync(source)) {
    // Deliberately fatal. A `dist/` with no dashboard in it is a package that
    // installs, starts, serves telemetry, and answers `/` with an apology.
    console.error(`copy-assets: missing ${source} — ${MISSING_DASHBOARD}`);
    failed = true;
    continue;
  }

  cpSync(source, destination, { recursive: true, force: true });
  console.log(`copy-assets: ${from}/ -> ${to}/`);
}

if (failed) {
  process.exitCode = 1;
}
