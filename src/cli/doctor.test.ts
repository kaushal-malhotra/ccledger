/**
 * Tests for `ccledger doctor`.
 *
 * The check that earns this command its place is number two — the config is
 * right and Claude Code has not been restarted since it was written — so that
 * one is exercised from both sides, with the modification times set by hand.
 * The rest of the file is about the two things a diagnostic must never do: give
 * a verdict with no remedy attached, and print the token it was checking.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ClientPaths } from './paths.js';
import { resolveClientPaths } from './paths.js';
import { baseUrlOfLogsEndpoint, tokenOfHeaders } from './settings.js';
import type { CheckResult, DoctorReport } from './doctor.js';
import { diagnose, newestMtimeMs } from './doctor.js';

/** A token that would be a real one, used to prove it never reaches the output. */
const TOKEN = 'ccm_S3CR3TS3CR3TS3CR3TS3CR3TS3CR3TA';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A temporary home directory, removed after the test. */
function tempHome(): ClientPaths {
  const home = mkdtempSync(join(tmpdir(), 'ccledger-doctor-'));
  homes.push(home);
  return resolveClientPaths(home);
}

/** Writes a settings file with the given `env` entries. */
function writeSettings(paths: ClientPaths, env: Record<string, string>): void {
  mkdirSync(paths.claudeDir, { recursive: true });
  writeFileSync(paths.settingsPath, `${JSON.stringify({ env }, null, 2)}\n`, 'utf8');
}

/** A port nothing is listening on, so a probe fails immediately rather than hanging. */
async function closedPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** A complete five-key config pointing at an endpoint. */
function fullConfig(endpoint: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${TOKEN}`,
  };
}

/** The check with this id, which must exist. */
function check(report: DoctorReport, id: string): CheckResult {
  const found = report.checks.find((candidate) => candidate.id === id);
  expect(found, `no ${id} check in the report`).toBeDefined();
  return found ?? { id, title: id, status: 'skip', detail: '' };
}

describe('newestMtimeMs', () => {
  it('finds the newest thing under a directory, however deep', () => {
    const paths = tempHome();
    const nested = join(paths.projectsDir, 'a-project', 'nested');
    mkdirSync(nested, { recursive: true });
    const old = join(paths.projectsDir, 'a-project', 'old.jsonl');
    const recent = join(nested, 'recent.jsonl');
    writeFileSync(old, '{}', 'utf8');
    writeFileSync(recent, '{}', 'utf8');
    utimesSync(old, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    utimesSync(recent, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const newest = newestMtimeMs(paths.projectsDir);

    expect(newest).toBeGreaterThanOrEqual(1_700_000_000_000);
  });

  it('returns nothing for a directory that is not there', () => {
    expect(newestMtimeMs(join(tempHome().home, 'nope'))).toBeUndefined();
  });
});

describe('reading the config back', () => {
  it.each([
    ['https://meter.example.com/v1/logs', 'https://meter.example.com'],
    ['http://desk-01.local:4318/v1/logs', 'http://desk-01.local:4318'],
    ['http://desk-01.local:4318/v1/logs/', 'http://desk-01.local:4318'],
    ['https://meter.example.com/metrics', undefined],
    ['not a url at all', undefined],
    [undefined, undefined],
  ])('reads %s as %s', (value, expected) => {
    expect(baseUrlOfLogsEndpoint(value)).toBe(expected);
  });

  it.each([
    [`Authorization=Bearer ${TOKEN}`, TOKEN],
    [`x-team=blue,Authorization=Bearer ${TOKEN}`, TOKEN],
    ['Authorization=Basic abc', undefined],
    ['', undefined],
  ])('takes the token out of %s', (value, expected) => {
    expect(tokenOfHeaders(value)).toBe(expected);
  });
});

describe('diagnose', () => {
  it('tells a teammate with no config to run setup', async () => {
    const paths = tempHome();

    const report = await diagnose(paths, {});

    expect(report.ok).toBe(false);
    const config = check(report, 'config');
    expect(config.status).toBe('fail');
    expect(config.remedy).toContain('ccledger setup');
    // Nothing to compare against and nothing to reach, so these are skips
    // rather than failures — a skip says "not applicable", a fail says "wrong".
    expect(check(report, 'restart').status).toBe('skip');
    expect(check(report, 'endpoint').status).toBe('skip');
    expect(check(report, 'token').status).toBe('skip');
  });

  it('names the keys when only some of them are there', async () => {
    const paths = tempHome();
    writeSettings(paths, { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp' });

    const config = check(await diagnose(paths, {}), 'config');

    expect(config.status).toBe('fail');
    expect(config.detail).toContain('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
  });

  it('reports a config that is present but switched off', async () => {
    const paths = tempHome();
    writeSettings(paths, {
      ...fullConfig('http://127.0.0.1:9'),
      CLAUDE_CODE_ENABLE_TELEMETRY: '0',
    });

    const config = check(await diagnose(paths, {}), 'config');

    expect(config.status).toBe('fail');
    expect(config.detail).toContain('is off');
  });

  it('says loudly that Claude Code has not restarted since the config changed', async () => {
    const paths = tempHome();
    writeSettings(paths, fullConfig('http://127.0.0.1:9'));
    mkdirSync(join(paths.projectsDir, 'a-project'), { recursive: true });
    const transcript = join(paths.projectsDir, 'a-project', 'session.jsonl');
    writeFileSync(transcript, '{}', 'utf8');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(transcript, old, old);
    utimesSync(join(paths.projectsDir, 'a-project'), old, old);
    utimesSync(paths.projectsDir, old, old);

    const restart = check(await diagnose(paths, {}), 'restart');

    expect(restart.status).toBe('fail');
    expect(restart.remedy).toContain('RESTART CLAUDE CODE');
  });

  it('passes the restart check once Claude Code has written since', async () => {
    const paths = tempHome();
    writeSettings(paths, fullConfig('http://127.0.0.1:9'));
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(paths.settingsPath, old, old);
    mkdirSync(join(paths.projectsDir, 'a-project'), { recursive: true });
    writeFileSync(join(paths.projectsDir, 'a-project', 'session.jsonl'), '{}', 'utf8');

    expect(check(await diagnose(paths, {}), 'restart').status).toBe('pass');
  });

  it('reports a server that is not listening, and does not blame the token for it', async () => {
    const paths = tempHome();
    const port = await closedPort();
    writeSettings(paths, fullConfig(`http://127.0.0.1:${String(port)}`));

    const report = await diagnose(paths, {});

    expect(check(report, 'endpoint').status).toBe('fail');
    expect(check(report, 'endpoint').detail).toContain('127.0.0.1');
    expect(check(report, 'token').remedy).toContain('Fix the endpoint first');
  });

  it('finds a shell variable that contradicts the config', async () => {
    const paths = tempHome();
    writeSettings(paths, fullConfig('http://127.0.0.1:9'));

    const environment = check(
      await diagnose(paths, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://elsewhere/v1/logs' }),
      'environment',
    );

    expect(environment.status).toBe('fail');
    expect(environment.detail).toContain('http://elsewhere/v1/logs');
  });

  it('finds a generic OTLP variable that would take over when the specific one is absent', async () => {
    const paths = tempHome();
    writeSettings(paths, fullConfig('http://127.0.0.1:9'));

    const environment = check(
      await diagnose(paths, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://elsewhere' }),
      'environment',
    );

    expect(environment.status).toBe('fail');
  });

  it('passes the environment check when the shell agrees with the config', async () => {
    const paths = tempHome();
    const config = fullConfig('http://127.0.0.1:9');
    writeSettings(paths, config);

    const environment = check(await diagnose(paths, { ...config }), 'environment');

    expect(environment.status).toBe('pass');
  });

  it.each([
    ['the config', 'config'],
    ['the shell', 'shell'],
  ])('warns loudly about content logging turned on in %s', async (_label, where) => {
    const paths = tempHome();
    const base = fullConfig('http://127.0.0.1:9');
    writeSettings(paths, where === 'config' ? { ...base, OTEL_LOG_USER_PROMPTS: '1' } : base);

    const report = await diagnose(
      paths,
      where === 'shell' ? { OTEL_LOG_USER_PROMPTS: 'true' } : {},
    );

    const content = check(report, 'content-logging');
    expect(content.status).toBe('fail');
    expect(content.detail).toContain('content may be leaving this machine');
    expect(report.ok).toBe(false);
  });

  it('passes content logging when nothing has turned any of it on', async () => {
    const paths = tempHome();
    writeSettings(paths, fullConfig('http://127.0.0.1:9'));

    expect(check(await diagnose(paths, {}), 'content-logging').status).toBe('pass');
  });

  it('never prints the token, wherever it found one', async () => {
    const paths = tempHome();
    const port = await closedPort();
    writeSettings(paths, fullConfig(`http://127.0.0.1:${String(port)}`));

    const report = await diagnose(paths, {
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${TOKEN}`,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${TOKEN}`,
    });

    // `doctor --json` output is meant to be pasted into bug reports, so this is
    // the assertion that keeps that safe.
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(report)).toContain('ccm_S3CR');
  });

  it('gives every failure something to do about it', async () => {
    const paths = tempHome();

    const report = await diagnose(paths, { OTEL_LOG_USER_PROMPTS: '1', OTEL_SDK_DISABLED: 'true' });

    for (const failed of report.checks.filter((entry) => entry.status === 'fail')) {
      expect(failed.remedy, `${failed.id} has no remedy`).toBeTruthy();
    }
  });
});
