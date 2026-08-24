import { defineConfig } from 'vitest/config';

/** Vitest configuration: node environment, explicit imports, no coverage gates. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Explicit `import { describe, it, expect } from 'vitest'` in every test, so
    // a test file type-checks under `tsc` without a globals type reference.
    globals: false,
  },
});
