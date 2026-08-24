import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Node globals used by the plain-JavaScript tooling files. Listed by hand rather
 * than adding the `globals` package for one small, stable set.
 */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
};

/**
 * Flat ESLint config for ccledger. Type-aware linting is deliberately off: the
 * root tooling files and `test/` sit outside `tsconfig.json`, so the project
 * service would have to be widened just to lint them. The rule that matters
 * here — the ban on `any` — is syntactic and needs no type information.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'web/',
      'captures/',
      'coverage/',
      'src/server/public/',
      'test/fixtures/',
      // Stage-0 capture tooling, kept exactly as written.
      'capture.mjs',
      'inspect.mjs',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      // The hard rule from CLAUDE.md: no `any` in committed code, tests included.
      '@typescript-eslint/no-explicit-any': 'error',
      // TypeScript resolves identifiers itself; `no-undef` only produces false
      // positives on type-only names.
      'no-undef': 'off',
      // Underscore-prefixed parameters are the conventional "intentionally
      // unused" marker and must not fail the build.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
);
