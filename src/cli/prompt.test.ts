/**
 * Tests for the prompter.
 *
 * Small file, two properties. Several answers arriving in one write have to be
 * handed out one per question — a script piping its answers in writes them all
 * at once, and losing all but the first would silently take the default for
 * every question after it. And a question nobody is there to answer has to
 * resolve to its default rather than hang, because the alternative is a
 * terminal that never comes back.
 */

import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createPrompter, isAffirmative } from './prompt.js';

/** Collects what the prompter writes, so the questions themselves can be asserted. */
function sink(): PassThrough & { readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return Object.assign(stream, { text: (): string => chunks.join('') });
}

describe('isAffirmative', () => {
  it.each([
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['  YES  ', true],
    ['n', false],
    ['no', false],
    ['', false],
    ['maybe', false],
    ['yep', false],
  ])('reads %s as %s', (answer, expected) => {
    expect(isAffirmative(answer)).toBe(expected);
  });
});

describe('createPrompter', () => {
  it('hands out one answer per question when they all arrive at once', async () => {
    const output = sink();
    const prompter = createPrompter(Readable.from(['Alice\ny\nn\n']), output);

    expect(await prompter.ask('name? ')).toBe('Alice');
    expect(await prompter.ask('go on? ')).toBe('y');
    expect(await prompter.ask('again? ')).toBe('n');
    prompter.close();

    expect(output.text()).toBe('name? go on? again? ');
  });

  it('tells an empty answer apart from no answer at all', async () => {
    const prompter = createPrompter(Readable.from(['\nRahim\n']), sink());

    // Someone pressing Enter is an answer, which each caller reads as its own
    // default. Reaching the end of the input is not an answer, and says so.
    expect(await prompter.ask('name? ')).toBe('');
    expect(await prompter.ask('name? ')).toBe('Rahim');
    expect(await prompter.ask('name? ')).toBeUndefined();
    prompter.close();
  });

  it('trims what was typed', async () => {
    const prompter = createPrompter(Readable.from(['   Alice   \n']), sink());

    expect(await prompter.ask('name? ')).toBe('Alice');
    prompter.close();
  });

  it('reports no answer rather than hanging when there is nothing to read', async () => {
    const prompter = createPrompter(Readable.from([]), sink());

    expect(await prompter.ask('go on? ')).toBeUndefined();
    expect(await prompter.ask('and again? ')).toBeUndefined();
    prompter.close();
  });

  it('counts a last line that was never finished with a newline', async () => {
    // What it looks like when someone types an answer and then presses Ctrl-D
    // instead of Enter. readline flushes what it has, and honouring that is
    // both what a shell does and the only reading that is not surprising.
    const prompter = createPrompter(Readable.from(['y']), sink());

    expect(await prompter.ask('go on? ')).toBe('y');
    prompter.close();
  });

  it('waits for an answer that has not arrived yet', async () => {
    const input = new PassThrough();
    const prompter = createPrompter(input, sink());

    const pending = prompter.ask('name? ');
    input.write('Rahim\n');

    expect(await pending).toBe('Rahim');
    prompter.close();
  });
});
