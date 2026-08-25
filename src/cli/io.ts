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

/**
 * A token rendered so it can be recognised on sight but not used. Enough of the
 * prefix to tell a member token from an admin one, four characters to compare
 * against a screenshot, and nothing else — `doctor --json` output ends up
 * pasted into bug reports.
 */
export function maskToken(token: string): string {
  const separator = token.indexOf('_');
  const head = separator === -1 ? 0 : separator + 1;
  return `${token.slice(0, head + 4)}…`;
}

/** The same string with any `Bearer <token>` in it masked. */
export function maskSecrets(text: string): string {
  return text.replace(
    /Bearer[ \t]+(\S+)/gi,
    (_match, token: string) => `Bearer ${maskToken(token)}`,
  );
}
