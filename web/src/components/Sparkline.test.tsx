/**
 * The per-row sparkline.
 *
 * A sparkline in a table row is the easiest chart on the page to make
 * inaccessible: it is small, it has no axes, and it is tempting to leave it as
 * decoration. It carries a label naming whose trend it is and where it peaks,
 * and a member with nothing in the range gets a dash rather than a flat line
 * that would read as "reported zero all week" instead of "reported nothing".
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Sparkline } from './Sparkline.js';

describe('Sparkline', () => {
  it('stands in for the picture with a label', () => {
    const markup = renderToStaticMarkup(
      <Sparkline
        values={[10, 400, 30]}
        color="var(--series-3)"
        label="Alice: daily trend over 3 buckets, peaking at 400 tokens."
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Alice: daily trend over 3 buckets, peaking at 400 tokens."',
    );
  });

  it('renders its plot rather than the dash when there is something to draw', () => {
    const markup = renderToStaticMarkup(
      <Sparkline values={[1, 2]} color="var(--series-5)" label="Bob" />,
    );

    // Recharts measures its box before drawing, so a string render produces the
    // wrapper and not the path. The colour reaching the stroke is covered in
    // `MemberTable.test.tsx`, where the row's swatch carries the same value.
    expect(markup).toContain('recharts-wrapper');
    expect(markup).not.toContain('spark-flat');
  });

  it('draws a dash rather than a chart when there is nothing to draw', () => {
    for (const values of [[], [0, 0, 0]]) {
      const markup = renderToStaticMarkup(
        <Sparkline values={values} color="var(--series-1)" label="Cara: no usage in this range." />,
      );
      expect(markup).toContain('spark-flat');
      expect(markup).toContain('aria-label="Cara: no usage in this range."');
      expect(markup).not.toContain('recharts');
    }
  });

  it('is a block element, so it nests validly inside a table cell', () => {
    const markup = renderToStaticMarkup(
      <Sparkline values={[1, 2]} color="var(--series-1)" label="Bob" />,
    );
    expect(markup.startsWith('<div')).toBe(true);
  });
});
