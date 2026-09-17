/**
 * Tests for profile discovery: finding Claude Code config directories by
 * filename existence alone, and never opening a session transcript to do it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverProfiles } from './discover.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A temporary home directory, removed after the test whatever it did. */
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ccledger-discover-'));
  homes.push(home);
  return home;
}

/** Creates `<home>/<name>/history.jsonl`, the strongest of the discovery markers. */
function makeProfileWithHistory(home: string, name: string): void {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'history.jsonl'), '{}\n', 'utf8');
}

describe('discoverProfiles', () => {
  it('finds a profile by history.jsonl regardless of what its directory is named', () => {
    const home = tempHome();
    for (const name of [
      '.claude',
      '.claude-work',
      '.claude-personal',
      '.kaushal_dir',
      '.random_profile_name',
    ]) {
      makeProfileWithHistory(home, name);
    }

    const found = discoverProfiles(home).map((profile) => profile.profileName);

    expect(found.sort()).toEqual(
      [
        '.claude',
        '.claude-personal',
        '.claude-work',
        '.kaushal_dir',
        '.random_profile_name',
      ].sort(),
    );
  });

  it('finds a profile by its projects/ directory alone, with no history.jsonl', () => {
    const home = tempHome();
    mkdirSync(join(home, '.claude-fresh', 'projects'), { recursive: true });

    const found = discoverProfiles(home);

    expect(found).toEqual([
      {
        configDir: join(home, '.claude-fresh'),
        profileName: '.claude-fresh',
        evidence: ['projects'],
      },
    ]);
  });

  it('does not report a directory with only a generic settings.json', () => {
    const home = tempHome();
    mkdirSync(join(home, '.some-other-tool'), { recursive: true });
    writeFileSync(join(home, '.some-other-tool', 'settings.json'), '{}', 'utf8');

    expect(discoverProfiles(home)).toEqual([]);
  });

  it('reports settings.json plus stats-cache.json together as enough evidence', () => {
    const home = tempHome();
    const dir = join(home, '.claude-alt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'stats-cache.json'), '{}', 'utf8');

    const found = discoverProfiles(home);

    expect(found).toHaveLength(1);
    expect(found[0]?.profileName).toBe('.claude-alt');
  });

  it('never reads the contents of history.jsonl or anything under projects/', () => {
    const home = tempHome();
    const dir = join(home, '.claude-secret');
    mkdirSync(join(dir, 'projects', 'some-project'), { recursive: true });
    // A payload that would throw if anything tried to JSON.parse it.
    writeFileSync(join(dir, 'history.jsonl'), 'not valid json at all {{{', 'utf8');
    writeFileSync(
      join(dir, 'projects', 'some-project', 'session.jsonl'),
      'also not valid json {{{',
      'utf8',
    );

    expect(() => discoverProfiles(home)).not.toThrow();
    expect(discoverProfiles(home).map((p) => p.profileName)).toEqual(['.claude-secret']);
  });

  it('finds a newly created profile on a rescan, without restarting anything', () => {
    const home = tempHome();
    expect(discoverProfiles(home)).toEqual([]);

    makeProfileWithHistory(home, '.claude-new');

    expect(discoverProfiles(home).map((p) => p.profileName)).toEqual(['.claude-new']);
  });

  it('does not descend more than three levels deep', () => {
    const home = tempHome();
    const tooDeep = join(home, 'a', 'b', 'c', 'd', '.claude-buried');
    mkdirSync(tooDeep, { recursive: true });
    writeFileSync(join(tooDeep, 'history.jsonl'), '{}', 'utf8');

    expect(discoverProfiles(home)).toEqual([]);
  });

  it('skips node_modules and .git while walking', () => {
    const home = tempHome();
    makeProfileWithHistory(home, 'node_modules');
    makeProfileWithHistory(home, '.git');

    expect(discoverProfiles(home)).toEqual([]);
  });
});
