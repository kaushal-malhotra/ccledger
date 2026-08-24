/**
 * The command line's own output. Small on purpose: every command writes through
 * these three functions so that a failure looks the same whichever one you hit,
 * and so nothing in `src/cli/` reaches for `console.log`, whose stream and
 * newline behaviour differ from `process.stdout.write` in ways that show up as
 * interleaved output the moment a command prints while the server is logging.
 */

/** Writes a line to stdout. */
export function say(message = ''): void {
  process.stdout.write(`${message}\n`);
}

/** Writes a `ccledger:`-prefixed line to stderr. */
export function warn(message: string): void {
  process.stderr.write(`ccledger: ${message}\n`);
}

/** Prints one line to stderr and exits non-zero. Never returns. */
export function fail(message: string): never {
  warn(message);
  process.exit(1);
}

/** The message of an unknown throw, without assuming it is an `Error`. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The `errno` string of a Node system error, e.g. `EADDRINUSE`. */
export function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}
