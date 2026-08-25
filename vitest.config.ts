import { defineConfig } from 'vitest/config';

/** Vitest configuration: node environment, explicit imports, no coverage gates. */
export default defineConfig({
  test: {
    environment: 'node',
    // `web/` is included so the dashboard's pure helpers — range arithmetic,
    // share rounding, formatting — are covered by the same gate as the server.
    // They are deliberately free of DOM access, which is why the environment
    // stays `node` and there is no jsdom in the dependency tree.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    // Explicit `import { describe, it, expect } from 'vitest'` in every test, so
    // a test file type-checks under `tsc` without a globals type reference.
    globals: false,
  },
});
