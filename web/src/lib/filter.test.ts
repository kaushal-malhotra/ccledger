/**
 * The source control's one string value, and the duplication behind it.
 *
 * The encoding test that matters is the collision one: `query_source` is a
 * free-form string chosen by Claude Code, so nothing stops a future version
 * from emitting one called `work`. If that value and the `work` grouping shared
 * an encoding, selecting one would silently select the other.
 */

import { describe, expect, it } from 'vitest';

import { SOURCE_NONE as SHARED_SOURCE_NONE } from '../../../src/shared/constants.js';
import { SOURCE_NONE } from './constants.js';
import {
  ALL_ACTIVITY,
  isNarrowed,
  parseSelectionKey,
  selectionKey,
  selectionParams,
  selectionLabel,
  sourceKey,
  sourceLabel,
} from './filter.js';

describe('the duplicated protocol literals', () => {
  it('still agree with the server', () => {
    expect(SOURCE_NONE).toBe(SHARED_SOURCE_NONE);
  });
});

describe('selectionKey and parseSelectionKey', () => {
  it('round-trips a grouping', () => {
    for (const group of ['all', 'work', 'overhead'] as const) {
      expect(parseSelectionKey(selectionKey({ group }))).toEqual({ group });
    }
  });

  it('round-trips an exact source', () => {
    const selection = { group: 'all', source: 'generate_session_title' } as const;
    expect(parseSelectionKey(selectionKey(selection))).toEqual(selection);
  });

  it('keeps a source named after a grouping distinct from that grouping', () => {
    const asSource = selectionKey({ group: 'all', source: 'work' });
    const asGroup = selectionKey({ group: 'work' });

    expect(asSource).not.toBe(asGroup);
    expect(parseSelectionKey(asSource)).toEqual({ group: 'all', source: 'work' });
    expect(parseSelectionKey(asGroup)).toEqual({ group: 'work' });
  });

  it('falls back to counting everything for a value it does not know', () => {
    expect(parseSelectionKey('g:sideways')).toEqual(ALL_ACTIVITY);
    expect(parseSelectionKey('')).toEqual(ALL_ACTIVITY);
  });
});

describe('selectionParams', () => {
  it('sends nothing at all for the default', () => {
    expect(selectionParams(ALL_ACTIVITY)).toEqual({});
  });

  it('sends only the parameter that is narrowing', () => {
    expect(selectionParams({ group: 'overhead' })).toEqual({ group: 'overhead' });
    expect(selectionParams({ group: 'all', source: 'sdk' })).toEqual({ source: 'sdk' });
  });
});

describe('isNarrowed', () => {
  it('is false only when nothing is filtered out', () => {
    expect(isNarrowed(ALL_ACTIVITY)).toBe(false);
    expect(isNarrowed({ group: 'work' })).toBe(true);
    expect(isNarrowed({ group: 'all', source: SOURCE_NONE })).toBe(true);
  });
});

describe('selectionLabel', () => {
  it('names the grouping when no exact source is chosen', () => {
    expect(selectionLabel(ALL_ACTIVITY)).toBe('All activity');
    expect(selectionLabel({ group: 'overhead' })).toBe('Overhead only');
  });

  it('names the source when one is chosen', () => {
    expect(selectionLabel({ group: 'all', source: 'sdk' })).toBe('source: sdk');
    expect(selectionLabel({ group: 'all', source: SOURCE_NONE })).toBe('source: none recorded');
  });
});

describe('sourceLabel and sourceKey', () => {
  it('names the absent source rather than showing an empty cell', () => {
    expect(sourceLabel(null)).toBe('no source recorded');
    expect(sourceKey(null)).toBe(SOURCE_NONE);
    expect(sourceLabel('sdk')).toBe('sdk');
    expect(sourceKey('sdk')).toBe('sdk');
  });
});
