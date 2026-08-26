/**
 * Release-notes extraction.
 *
 * This runs once per tag, on a machine nobody is watching, and its output is
 * the release body every user reads first. The failure worth guarding against
 * is not a crash but a near miss — a heading that matches one version too many,
 * or a section that swallows the one below it — because nothing about the
 * release fails when that happens.
 */

import { describe, expect, it } from 'vitest';

import { releaseNotes, versionFromRef } from '../scripts/changelog-notes.mjs';

/** A changelog in the format `CHANGELOG.md` is written in. */
const CHANGELOG = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Something not released yet.

## [1.2.0] - 2026-08-26

### Added

- A backup command that uses SQLite's online backup API.

### Fixed

- mDNS falls back to a LAN address instead of advertising nothing.

## [1.1.0] - 2026-08-01

### Added

- Alert rules.

## [1.0.0] - 2026-07-15

- First release.

[unreleased]: https://github.com/example/ccledger/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/example/ccledger/compare/v1.1.0...v1.2.0
`;

describe('releaseNotes', () => {
  it('returns one version’s section without its heading or its neighbours', () => {
    const notes = releaseNotes(CHANGELOG, '1.2.0');

    expect(notes).toContain('A backup command');
    expect(notes).toContain('mDNS falls back');
    // The heading itself belongs to the release title, not the body.
    expect(notes).not.toContain('## [1.2.0]');
    // The section below it, which a greedy match would swallow.
    expect(notes).not.toContain('Alert rules');
    // And the section above, which is not released at all.
    expect(notes).not.toContain('Something not released yet');
  });

  it('accepts the version with or without the tag’s v prefix', () => {
    expect(releaseNotes(CHANGELOG, 'v1.2.0')).toBe(releaseNotes(CHANGELOG, '1.2.0'));
  });

  it('stops at the link definitions after the last section', () => {
    const notes = releaseNotes(CHANGELOG, '1.0.0');

    expect(notes).toContain('First release');
    // Reference-link definitions are markdown plumbing and read as noise in a
    // release body.
    expect(notes).not.toContain('[unreleased]:');
  });

  it('treats the version as a literal, not a pattern', () => {
    // `.` matching any character is enough for `1.2.0` to select `1x2x0`, and a
    // version arrives here straight from a git tag.
    const confusable = '## [1x2x0] - 2026-08-26\n\n- Not this one.\n';

    expect(releaseNotes(confusable, '1.2.0')).toBe('');
  });

  it('returns nothing for a version that is not in the changelog', () => {
    expect(releaseNotes(CHANGELOG, '9.9.9')).toBe('');
    // A repository whose changelog does not exist yet. The workflow falls back
    // to GitHub's generated notes rather than failing the release.
    expect(releaseNotes('', '1.2.0')).toBe('');
  });

  it('reads a section whose heading carries no brackets or date', () => {
    expect(releaseNotes('## 2.0.0\n\n- Plain heading.\n', '2.0.0')).toBe('- Plain heading.');
  });

  it('survives a changelog with CRLF line endings', () => {
    // A Windows checkout without the `.gitattributes` rule, or a file edited in
    // a tool that does not honour it.
    expect(releaseNotes(CHANGELOG.replace(/\n/g, '\r\n'), '1.2.0')).toContain('A backup command');
  });
});

describe('versionFromRef', () => {
  it('reduces a tag ref to the bare version', () => {
    expect(versionFromRef('refs/tags/v1.2.0')).toBe('1.2.0');
    expect(versionFromRef('v1.2.0')).toBe('1.2.0');
    expect(versionFromRef('1.2.0')).toBe('1.2.0');
    // Prerelease tags keep everything after the version.
    expect(versionFromRef('refs/tags/v1.2.0-rc.1')).toBe('1.2.0-rc.1');
  });
});
