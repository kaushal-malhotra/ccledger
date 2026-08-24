# ccledger

## What this is

ccledger is a self-hosted usage dashboard for small teams using Claude Code.
Claude Code has native OpenTelemetry support; ccledger runs a server that
receives OTLP log events from each teammate's Claude Code, stores them in
SQLite, and shows per-person token usage.

ccledger is **not** a proxy. It never sits in the request path, never reads or
stores Claude credentials, and never handles prompt or response content. It is
a passive consumer of telemetry that Claude Code already exports. Any change
that moves ccledger toward the request path, toward credential handling, or
toward content capture is out of scope — stop and raise it rather than
implementing it.

## Stack

- TypeScript, Node 20+
- Fastify (HTTP server: OTLP ingest, API, static dashboard)
- better-sqlite3 (synchronous, single-file storage)
- Commander (CLI)
- Vite + React + Recharts (dashboard)
- Vitest (tests)

Single npm package with subcommands. **Not** a monorepo — no workspaces, no
per-package `package.json`, one build.

## Hard rules

- **Never write code that sets `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, or `OTEL_LOG_RAW_API_BODIES`.** These enable content
  capture and are out of scope permanently. Not behind a flag, not in tests,
  not in docs as a suggestion.
- **Never overwrite `~/.claude/settings.json`.** Read, parse, merge, write —
  after taking a timestamped backup. The file belongs to the user and may
  contain unrelated settings.
- **OTLP JSON encodes 64-bit integers as strings.** Always coerce
  `timeUnixNano` and `intValue` explicitly. Never assume a number type; never
  rely on JS arithmetic against an unparsed value.
- **Ingest must be idempotent.** OTLP delivery is at-least-once. The same event
  will arrive more than once; storing it twice is a bug that silently inflates
  every number on the dashboard.
- **Return 400 for malformed ingest bodies, never 500.** Exporters retry on
  5xx. A 500 on a body that will never parse produces a retry storm.

## Layout

```
src/cli/       command implementations
src/server/    fastify app, routes, alert evaluation
src/db/        schema, migrations, queries
src/shared/    types shared between cli and server
web/           vite dashboard, builds to src/server/public
test/
```

`web/` builds into `src/server/public`, which the Fastify app serves as static
assets. Types crossing the cli/server boundary live in `src/shared/` — neither
side imports from the other directly.

## Conventions

- Strict TypeScript. No `any` in committed code.
- Every exported function has a JSDoc line.
- Tests colocated as `*.test.ts` next to the code they cover.
- Conventional commits (`feat:`, `fix:`, `chore:`, …), scoped to the layout —
  `db`, `server`, `cli`, `web`, `shared`. One commit per component, not one per
  build stage. The body says why, not what the diff already shows.
- Commit only once the gate is green: `format:check`, `lint`, `typecheck`,
  `test`, `build`. See "Before anything: version control" in `BUILD_STAGES.md`
  for the per-stage commit breakdown.
- `captures/` is gitignored. The raw OTLP payloads carry a real email and
  account identifiers; only the sanitised `test/fixtures/` copies are committed.
- LF line endings, pinned by `.gitattributes`. Prettier is `endOfLine: "lf"`
  and CI runs a Windows leg, so a CRLF checkout fails the format gate.
