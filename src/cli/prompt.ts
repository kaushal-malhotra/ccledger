/**
 * Asking a question at the terminal.
 *
 * Two rules, both of which exist because this is the code path that stands
 * between a teammate and a change to their machine. An answer that never comes —
 * a closed stdin, a Ctrl-D, a command run with nothing on the other end — is
 * reported as no answer rather than silently becoming one, so a command can
 * refuse to act instead of hanging a terminal or guessing. And the default for
 * anything that would change something is no: a prompt that proceeds when it is
 * ignored is not a prompt, it is a delay.
 *
 * Lines are queued here rather than taken one at a time from `readline`'s own
 * `question`. `question` only hears the lines that arrive while it is waiting,
 * so several answers delivered in one write — which is exactly what a script or
 * a fast paste looks like — would have all but the first thrown away.
 */

import { createInterface } from 'node:readline/promises';

/** A question-and-answer session bound to one pair of streams. */
export interface Prompter {
  /**
   * Asks, and resolves to the trimmed answer. An empty string means the line
   * was empty — someone pressed Enter, which every caller reads as its own
   * default. `undefined` means there was no answer to read at all: a closed
   * stdin, a Ctrl-D, a command run with nothing on the other end. That is not a
   * default, and no caller treats it as one.
   */
  ask(question: string): Promise<string | undefined>;
  /** Releases the streams. Safe to call more than once. */
  close(): void;
}

/** Answers that mean yes. Everything else, the empty answer included, means no. */
const AFFIRMATIVE: ReadonlySet<string> = new Set(['y', 'yes']);

/** True when an answer is one of the words that means yes. */
export function isAffirmative(answer: string): boolean {
  return AFFIRMATIVE.has(answer.trim().toLowerCase());
}

/**
 * Opens a prompter over the given streams.
 *
 * `terminal: false` on purpose: the line editing readline turns on for a TTY is
 * not worth the difference in behaviour it creates between a real terminal and
 * the scripted stream a test hands over. The shell echoes typed characters
 * either way, and the prompt itself is written here.
 */
export function createPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter {
  const rl = createInterface({ input, terminal: false });
  /** Lines that arrived before anything asked for them. */
  const buffered: string[] = [];
  /** Askers waiting for a line that has not arrived. */
  const waiting: ((line: string | undefined) => void)[] = [];
  let closed = false;

  rl.on('line', (line: string) => {
    const waiter = waiting.shift();
    if (waiter === undefined) buffered.push(line);
    else waiter(line);
  });
  rl.once('close', () => {
    closed = true;
    // Whoever is still waiting is told there was no answer, which is not the
    // same as an empty one and is never taken for agreement.
    while (waiting.length > 0) waiting.shift()?.(undefined);
  });

  return {
    async ask(question: string): Promise<string | undefined> {
      output.write(question);
      const queued = buffered.shift();
      const line =
        queued ??
        (closed
          ? undefined
          : await new Promise<string | undefined>((resolve) => {
              waiting.push(resolve);
            }));
      return line?.trim();
    },
    close(): void {
      if (!closed) rl.close();
    },
  };
}
