/**
 * Compiles `src/` to `dist/` with esbuild.
 *
 * Transform only — `bundle: false` — and that is the load-bearing choice here.
 * Three modules find files at run time through `import.meta.url`: `migrate.ts`
 * reads `schema.sql` beside itself, `dashboard.ts` reads `public/index.html`
 * beside itself, and `version.ts` reads `package.json` two levels up. Bundling
 * would collapse those directories together and every one of those lookups
 * would resolve somewhere else, so `dist/` is kept a file-for-file mirror of
 * `src/` and each path resolves identically in a checkout under vitest and in
 * an installed package.
 *
 * esbuild does not type-check. That is not a gap: `npm run typecheck` runs
 * `tsc --noEmit` over `src/`, `test/` and `web/`, and the commit gate runs it
 * before this. Splitting the two means a build never re-does work the gate has
 * already done.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/** Repo root, resolved from this file rather than from the working directory. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** What is compiled. */
const SOURCE_DIR = join(ROOT, 'src');

/** Where it lands. */
const OUT_DIR = join(ROOT, 'dist');

/**
 * The floor in `engines`, so the output may not use syntax newer than it
 * understands. Node 22 rather than 20 because better-sqlite3 and commander
 * both require it — see the note in `docker/Dockerfile`.
 */
const TARGET = 'node22';

/**
 * Colocated tests, which `tsconfig.build.json` also excludes. They import
 * vitest, which is a devDependency and absent from an installed package.
 */
const TEST_FILE = /\.test\.tsx?$/;

/** Compiled. `.d.ts` files declare types and emit nothing. */
const SOURCE_FILE = /\.tsx?$/;

/** Type declarations, which are input to `tsc` and not to this. */
const DECLARATION_FILE = /\.d\.tsx?$/;

/** Every compilable file under `directory`, recursively, as absolute paths. */
function collectSources(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(path));
      continue;
    }
    if (!SOURCE_FILE.test(entry.name)) continue;
    if (DECLARATION_FILE.test(entry.name)) continue;
    if (TEST_FILE.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

const entryPoints = collectSources(SOURCE_DIR);
if (entryPoints.length === 0) {
  console.error(`build: no TypeScript sources under ${SOURCE_DIR}`);
  process.exit(1);
}

// A stale `dist/` is worse than none: a module deleted from `src/` would stay
// behind and keep resolving, so a broken import would pass the build and fail
// on someone else's install.
rmSync(OUT_DIR, { recursive: true, force: true });

await build({
  entryPoints,
  outdir: OUT_DIR,
  // Mirrors the tree rather than flattening it into `dist/`, which is what
  // keeps every `import.meta.url` lookup resolving.
  outbase: SOURCE_DIR,
  platform: 'node',
  // `package.json` declares `"type": "module"`, so a `.js` file is ESM and the
  // `.js` extensions already written in the imports stay correct.
  format: 'esm',
  target: TARGET,
  bundle: false,
  // The published package is a CLI, not a library: nothing imports from it, so
  // sourcemaps and declarations would be weight in the tarball that no consumer
  // has a use for. Stack traces still name the right file and the source is one
  // `npm view`, or one clone, away.
  sourcemap: false,
  logLevel: 'warning',
});

console.log(
  `build: ${String(entryPoints.length)} modules -> ${relative(ROOT, OUT_DIR).replace(/\\/g, '/')}/`,
);
