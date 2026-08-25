/**
 * The handful of protocol literals the dashboard needs at runtime.
 *
 * They are written out here rather than imported from `src/shared/constants.ts`
 * so that nothing in `src/` is compiled into the browser bundle — the only
 * thing that crosses that boundary is `import type`, which the bundler erases.
 * That leaves a duplicated string, which is exactly the sort of thing that
 * drifts, so `filter.test.ts` imports both and asserts they still agree. The
 * test runs in Node, where reaching into `src/` costs nothing.
 */

/** Mirrors `SOURCE_NONE`: the `source` value selecting rows with none. */
export const SOURCE_NONE = 'none';
