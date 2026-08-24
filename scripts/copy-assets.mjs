/**
 * Copies non-TypeScript build assets into `dist/`. `tsc` emits only what it
 * compiles, so `schema.sql` would otherwise be missing from the published
 * package and `runMigrations` would fail on a global install.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Asset pairs, as `[source, destination]` relative to this script. */
const ASSETS = [['../src/db/schema.sql', '../dist/db/schema.sql']];

let failed = false;

for (const [from, to] of ASSETS) {
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

if (failed) {
  process.exitCode = 1;
}
