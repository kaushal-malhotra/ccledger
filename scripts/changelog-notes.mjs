/**
 * Pulls one release's section out of a Keep a Changelog file.
 *
 * `release.yml` puts the result in the GitHub Release body, so this runs
 * exactly once per tag and only ever on a machine nobody is watching. That is
 * the argument for it being a tested module rather than the four lines of `awk`
 * it replaces: a release is the worst possible moment to find out that a
 * heading matched one character differently than expected.
 *
 * Usage:
 *   node scripts/changelog-notes.mjs 1.2.0 [CHANGELOG.md]
 *
 * Prints the section to stdout and exits 0, or prints nothing and exits 1 when
 * there is no section for that version — including when the changelog does not
 * exist yet. The workflow reads the exit code and falls back to GitHub's own
 * generated notes, so a missing entry costs a worse release body and not a
 * failed release.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Matches a version heading, with or without the reference-link brackets that
 * Keep a Changelog uses, and with or without a `v` prefix or a trailing date:
 *
 *   ## [1.2.0] - 2026-08-26
 *   ## 1.2.0
 *   ## [v1.2.0]
 *
 * The version is escaped into the pattern because it arrives from a git tag,
 * and `.` in a version would otherwise match any character — enough for
 * `1.2.0` to select the notes of `1220`.
 */
function headingPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`, 'i');
}

/** True for any level-2 heading, which is where one version's section ends. */
const ANY_VERSION_HEADING = /^##\s/;

/**
 * A markdown reference-link definition, e.g. `[1.2.0]: https://…/compare/…`.
 * Keep a Changelog collects these at the foot of the file, which puts them
 * inside the last version's section — plumbing that renders as nothing and
 * reads as noise in a release body.
 */
const LINK_DEFINITION = /^\[[^\]]+\]:\s*\S+/;

/**
 * The body of `version`'s section, without its heading, trimmed. Empty string
 * when the changelog has no section for it or the section has no content.
 *
 * `version` may carry a `v` prefix, because the caller usually has a git tag
 * rather than a version.
 */
export function releaseNotes(changelog, version) {
  const wanted = headingPattern(version.replace(/^v/i, ''));
  const lines = changelog.split(/\r?\n/);

  const start = lines.findIndex((line) => wanted.test(line));
  if (start === -1) return '';

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => ANY_VERSION_HEADING.test(line));
  const body = end === -1 ? rest : rest.slice(0, end);

  // Only from the end, and only past blank lines: a definition that somehow
  // appears mid-section is left where the author put it.
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.trim() === '' || LINK_DEFINITION.test(last)) {
      body.pop();
      continue;
    }
    break;
  }

  return body.join('\n').trim();
}

/** The version a git ref names, with any `refs/tags/` and `v` prefix removed. */
export function versionFromRef(ref) {
  return ref.replace(/^refs\/tags\//, '').replace(/^v/, '');
}

/** Reads a file, or returns an empty string if it is not there. */
function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // A repository that has not written its changelog yet. The caller's
    // fallback is better than a failed release.
    return '';
  }
}

/**
 * True when this module is the process entry point. The same check `src/cli`
 * uses, and for the same reason: comparing the two paths as strings gets
 * Windows separators and percent-encoding wrong, while comparing URLs does not.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

// Only when run as a command, so importing this from a test parses no
// arguments and exits nothing.
if (invokedDirectly()) {
  const version = versionFromRef(process.argv[2] ?? '');
  const path = process.argv[3] ?? 'CHANGELOG.md';

  if (version === '') {
    console.error('usage: node scripts/changelog-notes.mjs <version> [changelog]');
    process.exit(1);
  }

  const notes = releaseNotes(readOrEmpty(path), version);
  if (notes === '') {
    console.error(`changelog-notes: no section for ${version} in ${path}`);
    process.exit(1);
  }

  process.stdout.write(`${notes}\n`);
}
