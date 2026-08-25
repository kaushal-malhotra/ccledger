/**
 * The `query_source` control, as one value.
 *
 * The dashboard offers a single dropdown that mixes two different things: the
 * three groupings the API understands (everything, real work, overhead) and the
 * individual sources present in the range. A `<select>` has one string value,
 * so the two are encoded with a prefix rather than by hoping they never
 * collide — Claude Code is free to add a `query_source` called `work` or `all`,
 * and `g:` versus `s:` is what stops that from silently changing the meaning of
 * someone's saved selection.
 */

import type { SourceGroup } from '../../../src/shared/api.js';
import { SOURCE_NONE } from './constants.js';

/** What the source control currently selects. */
export interface SourceSelection {
  readonly group: SourceGroup;
  /** An exact `query_source`, or `SOURCE_NONE`, or absent for no narrowing. */
  readonly source?: string;
}

/** Counting everything, which is where the dashboard starts. */
export const ALL_ACTIVITY: SourceSelection = { group: 'all' };

/** The three groupings, in the order the control offers them. */
export const GROUP_OPTIONS: ReadonlyArray<{ group: SourceGroup; label: string }> = [
  { group: 'all', label: 'All activity' },
  { group: 'work', label: 'Real work only' },
  { group: 'overhead', label: 'Overhead only' },
];

/** The `<option value>` for a selection. */
export function selectionKey(selection: SourceSelection): string {
  return selection.source === undefined ? `g:${selection.group}` : `s:${selection.source}`;
}

/**
 * The selection an `<option value>` names. Anything unrecognised falls back to
 * counting everything rather than throwing: a stale value is a control that
 * needs resetting, not a page that should fail to render.
 */
export function parseSelectionKey(key: string): SourceSelection {
  if (key.startsWith('s:')) return { group: 'all', source: key.slice(2) };
  const group = key.slice(2);
  if (group === 'work' || group === 'overhead' || group === 'all') return { group };
  return ALL_ACTIVITY;
}

/** The `group` and `source` query parameters a selection sends. */
export function selectionParams(selection: SourceSelection): {
  group?: string;
  source?: string;
} {
  return {
    ...(selection.group === 'all' ? {} : { group: selection.group }),
    ...(selection.source === undefined ? {} : { source: selection.source }),
  };
}

/** True when the selection is narrowing anything at all. */
export function isNarrowed(selection: SourceSelection): boolean {
  return selection.group !== 'all' || selection.source !== undefined;
}

/** How one `query_source` value reads in the control and in a table. */
export function sourceLabel(source: string | null): string {
  return source === null ? 'no source recorded' : source;
}

/** The `source` parameter for a `query_source` value, `null` included. */
export function sourceKey(source: string | null): string {
  return source === null ? SOURCE_NONE : source;
}

/** How the current selection reads beside a section heading. */
export function selectionLabel(selection: SourceSelection): string {
  if (selection.source !== undefined) {
    return `source: ${selection.source === SOURCE_NONE ? 'none recorded' : selection.source}`;
  }
  return GROUP_OPTIONS.find((option) => option.group === selection.group)?.label ?? 'All activity';
}
