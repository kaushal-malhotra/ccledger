import type { JSX } from 'react';

import type { SourceUsage } from '../../../src/shared/api.js';
import type { SourceSelection } from '../lib/filter.js';
import {
  GROUP_OPTIONS,
  parseSelectionKey,
  selectionKey,
  sourceKey,
  sourceLabel,
} from '../lib/filter.js';
import { formatCount } from '../lib/format.js';
import type { Range, RangePreset } from '../lib/range.js';
import { PRESET_LABELS } from '../lib/range.js';

/** Everything the toolbar reads and everything it can change. */
export interface ToolbarProps {
  readonly preset: RangePreset;
  readonly onPreset: (preset: RangePreset) => void;
  /** `YYYY-MM-DD`, only meaningful while the preset is `custom`. */
  readonly customFrom: string;
  readonly customTo: string;
  readonly onCustomFrom: (value: string) => void;
  readonly onCustomTo: (value: string) => void;
  /** The range as resolved, or `undefined` while the custom dates are unusable. */
  readonly range: Range | undefined;
  readonly selection: SourceSelection;
  readonly onSelection: (selection: SourceSelection) => void;
  /** Sources present in the range, unnarrowed by the current selection. */
  readonly sources: readonly SourceUsage[];
  readonly onRefresh: () => void;
  readonly loading: boolean;
  /**
   * False on a view the range and source do not apply to. The controls are
   * hidden rather than disabled: the members list is deliberately all-time, and
   * a date picker that changes nothing is worse than no date picker.
   */
  readonly ranged: boolean;
}

/** The presets, in the order the control shows them. */
const PRESETS: readonly RangePreset[] = ['today', '7d', '30d', 'custom'];

/**
 * The one row of controls above the data: which days, and which requests.
 *
 * The source control is a single `<select>` rather than a row of toggles
 * because it mixes two kinds of choice — three groupings and however many
 * individual sources the range happens to contain — and a dropdown is the one
 * shape that stays the same size as that list grows.
 */
export function Toolbar(props: ToolbarProps): JSX.Element {
  const { preset, range, selection, sources } = props;

  if (!props.ranged) {
    return (
      <div className="toolbar toolbar-bare">
        <div className="toolbar-spacer" />
        <button className="btn" type="button" onClick={props.onRefresh} disabled={props.loading}>
          {props.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
    );
  }

  return (
    <div className="toolbar">
      <div className="segmented" role="group" aria-label="Date range">
        {PRESETS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={preset === option}
            onClick={() => {
              props.onPreset(option);
            }}
          >
            {PRESET_LABELS[option]}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <div className="field">
          <label htmlFor="range-from">From</label>
          <input
            id="range-from"
            type="date"
            value={props.customFrom}
            onChange={(event) => {
              props.onCustomFrom(event.target.value);
            }}
          />
          <label htmlFor="range-to">to</label>
          <input
            id="range-to"
            type="date"
            value={props.customTo}
            onChange={(event) => {
              props.onCustomTo(event.target.value);
            }}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="source-filter">Show</label>
        <select
          id="source-filter"
          value={selectionKey(selection)}
          onChange={(event) => {
            props.onSelection(parseSelectionKey(event.target.value));
          }}
        >
          {GROUP_OPTIONS.map((option) => (
            <option key={option.group} value={selectionKey({ group: option.group })}>
              {option.label}
            </option>
          ))}
          {sources.length > 0 && (
            <optgroup label="One source only">
              {sources.map((source) => (
                <option
                  key={sourceKey(source.query_source)}
                  value={selectionKey({ group: 'all', source: sourceKey(source.query_source) })}
                >
                  {sourceLabel(source.query_source)} · {formatCount(source.requests)} req
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <div className="toolbar-spacer" />

      {range === undefined && (
        <span className="faint">Pick a start date on or before the end.</span>
      )}

      <button className="btn" type="button" onClick={props.onRefresh} disabled={props.loading}>
        {props.loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  );
}
