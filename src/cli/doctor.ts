/**
 * `ccledger doctor`: six checks, in the order that answers "why is there no
 * data?" fastest.
 *
 * The order is not arbitrary. Almost every report of "it isn't working" is
 * check 2 — the config is right and Claude Code has not been restarted since it
 * was written, because telemetry configuration is read once at startup. So the
 * checks run outwards from the machine: what is in the file, whether Claude Code
 * has read it, whether the server answers, whether the token is accepted, and
 * only then what in the surrounding environment might be overriding it.
 *
 * Check 6 is the odd one out and belongs here anyway. It looks for the five
 * content-capture switches, which ccledger never sets and something else might
 * have, and says so loudly — a teammate who agreed to token counts leaving their
 * machine did not agree to prompts leaving it.
 *
 * Every failure carries a remedy. A check that can only say "no" is a check that
 * turns into a support thread.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { HEALTH_PATH, OTLP_LOGS_PATH } from '../shared/constants.js';
import { VERSION } from '../shared/version.js';
import { errorTextOf, request } from './http.js';
import { maskSecrets, say } from './io.js';
import type { ClientPaths } from './paths.js';
import { resolveClientPaths } from './paths.js';
import type { SettingsFile } from './settings.js';
import {
  CONTENT_LOGGING_KEYS,
  LOGS_ENDPOINT_KEY,
  LOGS_EXPORTER_KEY,
  LOGS_HEADERS_KEY,
  LOGS_PROTOCOL_KEY,
  OWNED_ENV_KEYS,
  TELEMETRY_ENABLED_KEY,
  baseUrlOfLogsEndpoint,
  findContentLogging,
  formatEnvValue,
  isTruthyFlag,
  readSettings,
  tokenOfHeaders,
} from './settings.js';
import { readState } from './state.js';

/** A valid OTLP logs payload carrying no records. Proves the token without storing a row. */
const EMPTY_OTLP_ENVELOPE = '{"resourceLogs":[]}';

/** Five seconds, as the brief specifies. Long enough for a VPN, short enough to wait for. */
const PROBE_TIMEOUT_MS = 5000;

/** How deep under `~/.claude/projects` to look for a recently written file. */
const PROJECT_SCAN_DEPTH = 3;

/** Ceiling on directory entries examined, so a huge history cannot stall the command. */
const PROJECT_SCAN_LIMIT = 5000;

/**
 * Generic OTLP variables. They apply to logs whenever the logs-specific variable
 * is not set, so one of these in a shell profile is a live way for a teammate's
 * telemetry to end up somewhere other than where they think it goes.
 */
const GENERIC_OTLP_KEYS: readonly string[] = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
];

/** What one check concluded. */
export type CheckStatus = 'pass' | 'fail' | 'skip';

/** The result of one check, in the shape `--json` prints. */
export interface CheckResult {
  /** Stable identifier, so a bug report can be searched. */
  readonly id: string;
  /** Short label for the human output. */
  readonly title: string;
  readonly status: CheckStatus;
  /** What was found. Never carries a token. */
  readonly detail: string;
  /** What to do about it. Present on every failure. */
  readonly remedy?: string;
}

/** Everything `doctor` concluded. Safe to paste into a bug report. */
export interface DoctorReport {
  /** False when any check failed. */
  readonly ok: boolean;
  readonly version: string;
  /** The settings file that was examined. */
  readonly settingsPath: string;
  /** The server this machine is configured to report to, if any. */
  readonly endpoint?: string;
  readonly checks: readonly CheckResult[];
}

/** Options for `ccledger doctor`, as Commander hands them over. */
export interface DoctorOptions {
  /** Print the report as JSON instead of as text. */
  readonly json?: boolean;
  /** Home directory to resolve `~` against. The CLI never sets it; a test does. */
  readonly home?: string;
  /** Environment to inspect for overrides. Defaults to this process's own. */
  readonly env?: NodeJS.ProcessEnv;
}

/** A check that failed, with what to do about it. */
function failure(id: string, title: string, detail: string, remedy: string): CheckResult {
  return { id, title, status: 'fail', detail, remedy };
}

/** A check that passed. */
function pass(id: string, title: string, detail: string): CheckResult {
  return { id, title, status: 'pass', detail };
}

/** A check there was nothing to run against. */
function skip(id: string, title: string, detail: string): CheckResult {
  return { id, title, status: 'skip', detail };
}

/**
 * The newest modification time anywhere under a directory, or `undefined` when
 * there is nothing there. Directory times count as well as file times: a
 * directory's own mtime moves when a session file is added to it, which is
 * exactly the event being looked for.
 */
export function newestMtimeMs(directory: string): number | undefined {
  let newest: number | undefined;
  let examined = 0;
  const stack: { path: string; depth: number }[] = [{ path: directory, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (examined >= PROJECT_SCAN_LIMIT) return newest;
      examined += 1;
      const path = join(current.path, entry.name);
      try {
        const mtime = statSync(path).mtimeMs;
        if (newest === undefined || mtime > newest) newest = mtime;
      } catch {
        continue;
      }
      if (entry.isDirectory() && current.depth + 1 < PROJECT_SCAN_DEPTH) {
        stack.push({ path, depth: current.depth + 1 });
      }
    }
  }
  return newest;
}

/** Check 1: are the five keys ccledger writes present in the settings file? */
function checkConfigKeys(settings: SettingsFile): CheckResult {
  const id = 'config';
  const title = 'config keys';
  if (!settings.exists) {
    return failure(
      id,
      title,
      `${settings.path} does not exist`,
      'Run `ccledger setup --code <invite>` with the invite your admin sent you.',
    );
  }
  const missing = OWNED_ENV_KEYS.filter((key) => !Object.hasOwn(settings.env, key));
  if (missing.length === OWNED_ENV_KEYS.length) {
    return failure(
      id,
      title,
      `none of ccledger's five keys are in ${settings.path}`,
      'Run `ccledger setup --code <invite>` with the invite your admin sent you.',
    );
  }
  if (missing.length > 0) {
    return failure(
      id,
      title,
      `${String(missing.length)} of five keys are missing: ${missing.join(', ')}`,
      'The config is half written. Run `ccledger uninstall` and then `ccledger setup` again.',
    );
  }
  const wrong: string[] = [];
  if (!isTruthyFlag(formatEnvValue(settings.env[TELEMETRY_ENABLED_KEY]))) {
    wrong.push(`${TELEMETRY_ENABLED_KEY} is off`);
  }
  if (formatEnvValue(settings.env[LOGS_EXPORTER_KEY]) !== 'otlp') {
    wrong.push(`${LOGS_EXPORTER_KEY} is not otlp`);
  }
  if (formatEnvValue(settings.env[LOGS_PROTOCOL_KEY]) !== 'http/json') {
    wrong.push(`${LOGS_PROTOCOL_KEY} is not http/json`);
  }
  if (wrong.length > 0) {
    return failure(
      id,
      title,
      wrong.join('; '),
      'Run `ccledger uninstall` and then `ccledger setup` again to rewrite the five keys.',
    );
  }
  return pass(id, title, `all five keys are in ${settings.path}`);
}

/** A span of time in the largest unit that keeps it readable. */
function describeGap(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 90) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hours`;
  return `${String(Math.round(hours / 24))} days`;
}

/**
 * Check 2: has Claude Code started since the config was written?
 *
 * The evidence is indirect and worth being honest about: what this compares is
 * the config's modification time against the newest thing under
 * `~/.claude/projects`, which says Claude Code has *written* since then rather
 * than that it *started* since then. A session that was already open when setup
 * ran would keep writing and look like a restart. It is still the check that
 * resolves most reports, because the usual shape is a config written minutes ago
 * and a transcript last touched yesterday.
 */
function checkRestarted(settings: SettingsFile, projectsDir: string): CheckResult {
  const id = 'restart';
  const title = 'restart';
  if (!settings.exists || settings.mtimeMs === undefined) {
    return skip(id, title, 'there is no config to compare against');
  }
  const newest = newestMtimeMs(projectsDir);
  if (newest === undefined) {
    return skip(id, title, `nothing has been written under ${projectsDir} to compare against`);
  }
  if (settings.mtimeMs > newest) {
    return failure(
      id,
      title,
      `the config is ${describeGap(settings.mtimeMs - newest)} newer than anything Claude Code ` +
        'has written, so it has almost certainly not been read yet',
      'RESTART CLAUDE CODE. This is the answer nearly every time: telemetry configuration is ' +
        'read once, when Claude Code starts, so an open session keeps reporting nothing.',
    );
  }
  return pass(id, title, 'Claude Code has written a session since the config was last changed');
}

/** Check 3: does the server answer at all? */
async function checkEndpoint(endpoint: string | undefined): Promise<CheckResult> {
  const id = 'endpoint';
  const title = 'endpoint';
  if (endpoint === undefined) {
    return skip(id, title, 'there is no endpoint configured to reach');
  }
  const url = `${endpoint}${HEALTH_PATH}`;
  const result = await request(url, { method: 'GET', timeoutMs: PROBE_TIMEOUT_MS });
  if (!result.ok) {
    return failure(
      id,
      title,
      result.error,
      'Check the server is running and that this machine can reach it. On a laptop server ' +
        'both machines have to be on the same network, and the name in the endpoint has to ' +
        'resolve from here.',
    );
  }
  if (result.response.status !== 200) {
    return failure(
      id,
      title,
      `${url} answered ${String(result.response.status)}`,
      'Something is answering at that address but it is not a healthy ccledger server. ' +
        'Check the URL, and any proxy in front of it.',
    );
  }
  return pass(id, title, `${url} answered in ${String(result.response.durationMs)} ms`);
}

/** Check 4: does the server accept this machine's token? */
async function checkToken(
  endpoint: string | undefined,
  token: string | undefined,
): Promise<CheckResult> {
  const id = 'token';
  const title = 'token';
  if (endpoint === undefined || token === undefined) {
    return skip(id, title, 'there is no endpoint and token to try');
  }
  const url = `${endpoint}${OTLP_LOGS_PATH}`;
  const result = await request(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: EMPTY_OTLP_ENVELOPE,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (!result.ok) return failure(id, title, result.error, 'Fix the endpoint first; see above.');

  const status = result.response.status;
  if (status === 200)
    return pass(id, title, 'the server accepted an empty batch from this machine');
  if (status === 401) {
    return failure(
      id,
      title,
      'the server does not recognise this token',
      'The token is unknown to that server — it may have been rebuilt from an empty database. ' +
        'Ask your admin for a new invite, then run `ccledger uninstall` and set up again.',
    );
  }
  if (status === 403) {
    return failure(
      id,
      title,
      'this token has been revoked',
      'Your admin revoked this token. Ask them for a new invite, then run `ccledger uninstall` ' +
        'and set up again.',
    );
  }
  return failure(
    id,
    title,
    `the server answered ${String(status)}: ` +
      errorTextOf(result.response.body, 'no reason given'),
    'Check the endpoint is the ccledger ingest URL and that nothing in front of it is ' +
      'rewriting the request.',
  );
}

/** Check 5: is anything in the environment overriding the settings file? */
function checkEnvironment(settings: SettingsFile, environment: NodeJS.ProcessEnv): CheckResult {
  const id = 'environment';
  const title = 'environment';
  const problems: string[] = [];

  for (const key of OWNED_ENV_KEYS) {
    const shellValue = environment[key];
    if (shellValue === undefined) continue;
    const configured = settings.env[key];
    if (typeof configured === 'string' && configured === shellValue) continue;
    problems.push(
      `${key} is set in this shell to ${maskSecrets(shellValue)}, which is not what the config says`,
    );
  }
  for (const key of GENERIC_OTLP_KEYS) {
    const value = environment[key];
    if (value === undefined || value === '') continue;
    problems.push(`${key} is set in this shell to ${maskSecrets(value)}`);
  }
  if (isTruthyFlag(environment.OTEL_SDK_DISABLED)) {
    problems.push('OTEL_SDK_DISABLED is on, which turns the whole exporter off');
  }

  if (problems.length > 0) {
    return failure(
      id,
      title,
      problems.join('; '),
      'Remove these from your shell profile, or make them match the config. A variable in the ' +
        'environment can take precedence over the settings file, and this check only sees the ' +
        'shell doctor was run from — the one Claude Code starts in may differ.',
    );
  }
  return pass(id, title, 'no OTEL variable in this shell contradicts the config');
}

/** Check 6: is anything, anywhere, exporting prompt or response content? */
function checkContentLogging(settings: SettingsFile, environment: NodeJS.ProcessEnv): CheckResult {
  const id = 'content-logging';
  const title = 'content logging';
  const found = [
    ...findContentLogging(settings.env).map((entry) => `${entry.key}=${entry.value} in the config`),
    ...CONTENT_LOGGING_KEYS.filter((key) => isTruthyFlag(environment[key])).map(
      (key) => `${key}=${String(environment[key])} in this shell`,
    ),
  ];
  if (found.length > 0) {
    return failure(
      id,
      title,
      `${found.join('; ')} — prompt or response content may be leaving this machine`,
      'ccledger never sets these and does not want the data. Something else turned them on. ' +
        'Unset them unless you know exactly where that content is going.',
    );
  }
  return pass(id, title, 'no content-capture variable is on');
}

/**
 * Runs the six checks and returns what they found. Pure enough to test: the
 * only things it touches are the paths and environment it is handed.
 */
export async function diagnose(
  paths: ClientPaths,
  environment: NodeJS.ProcessEnv,
): Promise<DoctorReport> {
  const read = readSettings(paths.settingsPath);
  const settings = read.ok
    ? read.settings
    : {
        path: paths.settingsPath,
        exists: false,
        text: '',
        root: {},
        envKind: 'absent' as const,
        env: {},
      };

  const checks: CheckResult[] = [];
  if (!read.ok) {
    checks.push(
      failure(
        'config',
        'config keys',
        read.error,
        'ccledger will not edit a settings file it cannot parse. Fix the JSON, then run this again.',
      ),
    );
  } else {
    checks.push(checkConfigKeys(settings));
  }
  checks.push(checkRestarted(settings, paths.projectsDir));

  // The endpoint comes from the settings file rather than from ccledger's own
  // record, because the settings file is what Claude Code will actually use.
  // The record is the fallback, so a half-removed config can still be probed.
  const state = readState(paths.statePath);
  const endpoint =
    baseUrlOfLogsEndpoint(settings.env[LOGS_ENDPOINT_KEY]) ??
    (state.ok ? state.state?.serverUrl : undefined);
  const token = tokenOfHeaders(settings.env[LOGS_HEADERS_KEY]);

  checks.push(await checkEndpoint(endpoint));
  checks.push(await checkToken(endpoint, token));
  checks.push(checkEnvironment(settings, environment));
  checks.push(checkContentLogging(settings, environment));

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    version: VERSION,
    settingsPath: paths.settingsPath,
    checks,
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

/** Wraps a remedy to the terminal width the rest of the output assumes. */
function wrap(text: string, width: number, indent: string): readonly string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(`${indent}${line}`);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(`${indent}${line}`);
  return lines;
}

/** Prints the report the way a person reads it. */
function printReport(report: DoctorReport): void {
  const width = Math.max(...report.checks.map((check) => check.title.length));
  say();
  say(`ccledger doctor ${report.version}`);
  say();
  for (const check of report.checks) {
    const label = check.status.toUpperCase().padEnd(4);
    say(`  ${label}  ${check.title.padEnd(width)}   ${check.detail}`);
    if (check.remedy !== undefined) {
      // Aligned with the detail above it, because it is a continuation of it.
      for (const line of wrap(check.remedy, 72, ' '.repeat(width + 11))) say(line);
    }
  }

  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const skipped = report.checks.filter((check) => check.status === 'skip').length;
  const passed = report.checks.length - failed - skipped;
  say();
  say(
    `  ${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped` +
      (report.endpoint === undefined ? '' : ` · reporting to ${report.endpoint}`),
  );
  say();
}

/** Runs the checks and prints them. Sets a non-zero exit code if any failed. */
export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const paths = resolveClientPaths(options.home);
  const report = await diagnose(paths, options.env ?? process.env);

  if (options.json === true) {
    say(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (!report.ok) {
    // Not `fail`: the report is the message, and a second line saying "failed"
    // after six lines that already say so is noise. The exit code is what a
    // script reads.
    process.exitCode = 1;
  }
}
