/**
 * Editing a JSON file as text instead of as a value.
 *
 * `~/.claude/settings.json` belongs to the user. It may hold permissions, hooks,
 * an MCP server list and a status line, laid out however they or their editor
 * left it. Parsing that to an object and re-serialising it would return a file
 * that is equivalent but not the same: key order can be made to survive, but
 * indentation, blank lines, the trailing newline and CRLF endings do not. A diff
 * of the whole file after adding five keys is not a change anyone asked for, and
 * it makes the one promise uninstall has to keep — put it back exactly as it
 * was — impossible to keep.
 *
 * So this module locates the members of a JSON object by offset in the source
 * text and splices. Adding keys inserts one run of characters; removing them
 * rebuilds the object's interior out of the original spans of the members that
 * survive, which reproduces the original bytes exactly when the keys removed are
 * the keys that were added.
 *
 * The scanner accepts strict JSON only. That is deliberate rather than a
 * shortcut: `JSON.parse` decides whether the file is valid before any of this
 * runs, and a file this module could edit but a JSON parser could not read is a
 * file ccledger would have broken.
 */

/** JSON's four whitespace characters. */
const WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r']);

/** Characters that end an unquoted literal: a number, `true`, `false`, `null`. */
const LITERAL_END: ReadonlySet<string> = new Set([',', '}', ']']);

/** Indentation assumed when a document gives no example of its own. */
const DEFAULT_INDENT = '  ';

/** One member of a JSON object, with the offsets it occupies in the source. */
export interface JsonMemberSpan {
  /** The decoded key, as `JSON.parse` would give it. */
  readonly key: string;
  /** Offset of the opening quote of the key. */
  readonly keyStart: number;
  /** Offset of the first character of the value. */
  readonly valueStart: number;
  /** Offset just past the last character of the value. */
  readonly valueEnd: number;
  /** Set when the value is itself an object, so nesting can be walked. */
  readonly object?: JsonObjectSpan;
}

/** A JSON object in source text: where it starts, where it ends, what is in it. */
export interface JsonObjectSpan {
  /** Offset of the opening brace. */
  readonly start: number;
  /** Offset just past the closing brace. */
  readonly end: number;
  /** Members in source order. */
  readonly members: readonly JsonMemberSpan[];
}

/** A key and the string value to write for it. */
export interface JsonEntry {
  readonly key: string;
  readonly value: string;
}

/** Raised when text is not the strict JSON the scanner requires. */
export class JsonScanError extends Error {
  constructor(
    message: string,
    /** Offset the scanner gave up at, for a message that can point at it. */
    readonly offset: number,
  ) {
    super(message);
    this.name = 'JsonScanError';
  }
}

/** Offset of the first character at or after `from` that is not whitespace. */
function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const character = text[index];
    if (character === undefined || !WHITESPACE.has(character)) break;
    index += 1;
  }
  return index;
}

/**
 * Scans a string literal starting at its opening quote. The decoded value comes
 * from `JSON.parse` on the slice rather than from an escape handler written
 * here: there is exactly one right answer for a surrogate pair and the platform
 * already has it.
 */
function scanString(text: string, from: number): { readonly value: string; readonly end: number } {
  let index = from + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"') {
      const end = index + 1;
      const value: unknown = JSON.parse(text.slice(from, end));
      if (typeof value !== 'string') throw new JsonScanError('not a string', from);
      return { value, end };
    }
    index += 1;
  }
  throw new JsonScanError('unterminated string', from);
}

/** Scans any JSON value, returning where it ends and its object span if it has one. */
function scanValue(
  text: string,
  from: number,
): { readonly end: number; readonly object?: JsonObjectSpan } {
  const character = text[from];
  if (character === '{') {
    const object = scanObject(text, from);
    return { end: object.end, object };
  }
  if (character === '[') return { end: scanArray(text, from) };
  if (character === '"') return { end: scanString(text, from).end };

  // A number, `true`, `false` or `null`. Its exact shape does not matter here —
  // `JSON.parse` has already ruled on that — only where it stops.
  let index = from;
  while (index < text.length) {
    const next = text[index];
    if (next === undefined || WHITESPACE.has(next) || LITERAL_END.has(next)) break;
    index += 1;
  }
  if (index === from) throw new JsonScanError('expected a value', from);
  return { end: index };
}

/** Scans an array starting at its bracket, returning the offset just past the close. */
function scanArray(text: string, from: number): number {
  let index = skipWhitespace(text, from + 1);
  if (text[index] === ']') return index + 1;
  for (;;) {
    const value = scanValue(text, index);
    index = skipWhitespace(text, value.end);
    const character = text[index];
    if (character === ',') {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    if (character === ']') return index + 1;
    throw new JsonScanError('expected a comma or a closing bracket in an array', index);
  }
}

/** Scans an object starting at its brace, recording every member's offsets. */
function scanObject(text: string, from: number): JsonObjectSpan {
  const members: JsonMemberSpan[] = [];
  let index = skipWhitespace(text, from + 1);
  if (text[index] === '}') return { start: from, end: index + 1, members };

  for (;;) {
    if (text[index] !== '"') throw new JsonScanError('expected a quoted key', index);
    const keyStart = index;
    const key = scanString(text, index);
    index = skipWhitespace(text, key.end);
    if (text[index] !== ':') throw new JsonScanError('expected a colon after a key', index);
    const valueStart = skipWhitespace(text, index + 1);
    const value = scanValue(text, valueStart);
    members.push({
      key: key.value,
      keyStart,
      valueStart,
      valueEnd: value.end,
      ...(value.object !== undefined ? { object: value.object } : {}),
    });

    index = skipWhitespace(text, value.end);
    const character = text[index];
    if (character === ',') {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    if (character === '}') return { start: from, end: index + 1, members };
    throw new JsonScanError('expected a comma or a closing brace in an object', index);
  }
}

/**
 * Maps a JSON document whose root is an object. Throws `JsonScanError` for
 * anything else, a root array or a bare value included — the settings file is an
 * object, and a file that is not one is not one this program knows how to merge
 * into.
 */
export function scanJsonDocument(text: string): JsonObjectSpan {
  const start = skipWhitespace(text, 0);
  if (text[start] !== '{') throw new JsonScanError('the document is not a JSON object', start);
  const object = scanObject(text, start);
  const trailing = skipWhitespace(text, object.end);
  if (trailing !== text.length) {
    throw new JsonScanError('trailing content after the JSON object', trailing);
  }
  return object;
}

/**
 * The member with this key, or `undefined`. A duplicate key resolves the way
 * `JSON.parse` resolves it — last one wins — so an edit lands on the member
 * whose value the file actually has.
 */
export function findMember(object: JsonObjectSpan, key: string): JsonMemberSpan | undefined {
  let found: JsonMemberSpan | undefined;
  for (const member of object.members) {
    if (member.key === key) found = member;
  }
  return found;
}

/** The Windows line ending when the document uses one anywhere, otherwise the Unix one. */
export function detectNewline(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * The whitespace between the start of `offset`'s line and `offset`, or
 * `undefined` when something other than whitespace is in front of it.
 *
 * `undefined` is the signal that a member is not on a line of its own — that the
 * object was written inline — and breaking the line for the next one would be a
 * reformat rather than an addition.
 */
function indentBefore(text: string, offset: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

/** How the document indents one level, taken from the root object's first member. */
function documentIndent(text: string, root: JsonObjectSpan): string {
  const first = root.members[0];
  if (first === undefined) return DEFAULT_INDENT;
  return indentBefore(text, first.keyStart) ?? DEFAULT_INDENT;
}

/** Renders one member. Values are strings because the config contract has no others. */
function renderEntry(entry: JsonEntry): string {
  return `${JSON.stringify(entry.key)}: ${JSON.stringify(entry.value)}`;
}

/** True when the object's source text spans more than one line. */
function isMultiline(text: string, object: JsonObjectSpan): boolean {
  return text.slice(object.start, object.end).includes('\n');
}

/**
 * Appends string members to an object, in order, and returns the new text.
 *
 * The layout is copied from what is already there rather than imposed: an object
 * whose members each sit on their own line gets new lines indented to match, and
 * one written inline stays inline however long that makes it. An empty object
 * has no example to copy, so it follows the document — one level in from the
 * line its brace is on, unless the whole file is a single line.
 */
export function appendMembers(
  text: string,
  root: JsonObjectSpan,
  object: JsonObjectSpan,
  entries: readonly JsonEntry[],
): string {
  if (entries.length === 0) return text;
  const newline = detectNewline(text);
  const last = object.members[object.members.length - 1];

  if (last !== undefined) {
    const indent = indentBefore(text, last.keyStart);
    const separator = indent === undefined ? ', ' : `,${newline}${indent}`;
    const addition = entries.map((entry) => `${separator}${renderEntry(entry)}`).join('');
    return text.slice(0, last.valueEnd) + addition + text.slice(last.valueEnd);
  }

  // An empty object has no member to imitate, so imitate the document instead.
  // Whatever whitespace is already inside the braces is left exactly where it
  // is and the members go in front of it, which is what makes the insertion
  // reversible: `{}` and `{\n}` are different files, and only the text added
  // here is text `removeMembers` is entitled to take away again.
  const interiorStart = object.start + 1;
  const braceIndent = indentBefore(text, object.start);
  const body =
    braceIndent === undefined || !isMultiline(text, root)
      ? entries.map(renderEntry).join(', ')
      : entries
          .map(
            (entry) => `${newline}${braceIndent}${documentIndent(text, root)}${renderEntry(entry)}`,
          )
          .join(',');
  return text.slice(0, interiorStart) + body + text.slice(interiorStart);
}

/**
 * The whitespace separating a member from its predecessor, comma excluded.
 * Everything up to and including the comma is dropped, so what comes back is the
 * part that has to be reproduced if that member moves up the list.
 */
function separatorAfterComma(
  text: string,
  previous: JsonMemberSpan,
  member: JsonMemberSpan,
): string {
  const between = text.slice(previous.valueEnd, member.keyStart);
  const comma = between.indexOf(',');
  return comma === -1 ? between : between.slice(comma + 1);
}

/**
 * Removes members by key and returns the new text.
 *
 * The interior is rebuilt from the source spans of the members that survive —
 * their own text, their own separators, the object's own leading and trailing
 * whitespace — rather than by deleting the ranges around the ones that go.
 * Deleting ranges is where an adjacent pair of removals overlaps and eats a
 * member nobody asked to remove; rebuilding cannot, and it reproduces the file
 * byte for byte when the members removed are the members that were added.
 */
export function removeMembers(
  text: string,
  object: JsonObjectSpan,
  keys: ReadonlySet<string>,
): string {
  const kept = object.members.filter((member) => !keys.has(member.key));
  if (kept.length === object.members.length) return text;

  const interiorStart = object.start + 1;
  const interiorEnd = object.end - 1;
  const first = object.members[0];
  const last = object.members[object.members.length - 1];
  if (first === undefined || last === undefined) return text;

  // Emptying the object deletes from the brace to the end of the last value and
  // keeps what follows. That is the exact inverse of the insertion above: the
  // whitespace an empty object was written with sits after the members, so it
  // survives, and the whitespace ccledger introduced sits before them, so it
  // goes.
  if (kept.length === 0) return text.slice(0, interiorStart) + text.slice(last.valueEnd);

  let interior = text.slice(interiorStart, first.keyStart);
  kept.forEach((member, position) => {
    if (position > 0) {
      // A member that is not first in what is kept was not first in the original
      // either, so it always has a predecessor to copy a separator from.
      const previous = object.members[object.members.indexOf(member) - 1];
      interior += previous === undefined ? ', ' : `,${separatorAfterComma(text, previous, member)}`;
    }
    interior += text.slice(member.keyStart, member.valueEnd);
  });
  interior += text.slice(last.valueEnd, interiorEnd);

  return text.slice(0, interiorStart) + interior + text.slice(interiorEnd);
}

/**
 * Adds a member holding an object of string entries to the root, for a settings
 * file that has no `env` in it yet. Returns the new text.
 */
export function appendObjectMember(
  text: string,
  root: JsonObjectSpan,
  key: string,
  entries: readonly JsonEntry[],
): string {
  const newline = detectNewline(text);
  const last = root.members[root.members.length - 1];
  const indent =
    (last === undefined ? undefined : indentBefore(text, last.keyStart)) ??
    documentIndent(text, root);
  const multiline =
    isMultiline(text, root) &&
    (last === undefined || indentBefore(text, last.keyStart) !== undefined);

  const body = multiline
    ? `{${entries
        .map((entry) => `${newline}${indent}${documentIndent(text, root)}${renderEntry(entry)}`)
        .join(',')}${newline}${indent}}`
    : `{${entries.map(renderEntry).join(', ')}}`;
  const member = `${JSON.stringify(key)}: ${body}`;

  if (last === undefined) {
    // Same rule as an empty `env`: go in front of whatever is already between
    // the braces, so removal has an unambiguous span to take back out.
    return (
      text.slice(0, root.start + 1) +
      (multiline ? `${newline}${indent}${member}` : member) +
      text.slice(root.start + 1)
    );
  }
  const separator = multiline ? `,${newline}${indent}` : ', ';
  return text.slice(0, last.valueEnd) + separator + member + text.slice(last.valueEnd);
}
