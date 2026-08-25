import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the dashboard into `src/server/public`, which `@fastify/static` serves
 * and `scripts/copy-assets.mjs` copies into `dist/` for the published package.
 *
 * `modulePreload.polyfill` is off because it is the one thing Vite would inject
 * as an inline `<script>`, and `src/server/dashboard.ts` serves this page under
 * a `script-src 'self'` policy that would block it. Every browser that can run
 * an ES module bundle either supports `modulepreload` or ignores the hint and
 * loads the module anyway, so the polyfill buys nothing here.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../src/server/public', import.meta.url)),
    // The output directory is outside this root, so Vite will not clear it
    // without being told to. It is a build artefact and gitignored.
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    // `npm run dev:web` in one terminal, `ccledger serve` in another: the
    // dashboard reloads on save and still talks to a real database.
    proxy: { '/api': 'http://localhost:4318' },
  },
});
