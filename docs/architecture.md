# Architecture

For contributors. What the pieces are, how data moves through them, and where
the decisions that are easy to get wrong already live.

## Shape

One npm package with subcommands. Not a monorepo: no workspaces, no per-package
`package.json`, one build. The dashboard is a Vite app that compiles into the
server's static directory and ships inside the same tarball.

```
src/cli/       command implementations — serve, invite, setup, doctor, uninstall, backup
src/server/    fastify app, routes, OTLP parser, ingest, alert evaluation
src/db/        schema, migrations, queries
src/shared/    types and constants shared between cli and server
web/           vite dashboard, builds to src/server/public
test/          integration tests and the OTLP fixtures
docker/        VPS-mode image and compose stack
scripts/       build, asset copy, tarball verification, changelog extraction
```

The dependency runs one way. `src/cli/` composes the server through its public
entrypoint, `buildApp`. `src/server/` never imports from `src/cli/`. Anything
both need is in `src/shared/` rather than imported across.

## The path a number takes

```
Claude Code
  │  OTLP/HTTP, JSON encoding, gzip optional
  │  Authorization: Bearer ccm_…
  ▼
POST /v1/logs                        src/server/app.ts
  │  raw bytes, own plugin scope, gunzip
  ▼
requireMember()                      src/server/auth.ts
  │  sha256 the token, look it up. 401 unknown, 403 revoked
  ▼
parseOtlpLogs()                      src/server/otlp.ts
  │  resourceLogs[] → scopeLogs[] → logRecords[]
  │  flatten resource + record attributes, record wins
  │  drop the six identity and content keys
  │  coerce every number, derive model_family
  ▼
ingestEvents()                       src/server/ingest.ts
  │  keep event.name === "api_request"
  │  INSERT OR IGNORE into requests, keyed on the request id
  │  upsert installs
  ▼
SQLite                               ccledger.db
  │
  ├─ evaluateAlerts()                src/server/alerts.ts  (after the transaction)
  │    debounce on (rule, member, window start), then webhook
  │
  └─ GET /api/*                      src/server/api.ts
       SQL aggregates, admin token, → web/
```

## The five things that are easy to get wrong

These are load-bearing. Each has a test, and each has a comment at the site
explaining why.

**1. OTLP JSON number encoding is inconsistent.** In the 2.1.241 captures,
`timeUnixNano` arrives as a quoted string (`"1787503991194000000"`) while
`intValue` arrives as a bare number (`898`). The serializer quotes only what
would lose precision as a JSON number. There is one `toInt()` helper that
accepts either; never trust the JSON type, and never do arithmetic on an
unparsed value.

**2. Ingest must be idempotent.** OTLP delivery is at-least-once and the same
batch will arrive twice. Row ids come from `client_request_id`, falling back to
`request_id`, falling back to a hash of `(session_id, ts, input_tokens,
output_tokens)`, and every insert is `INSERT OR IGNORE`. Storing a request
twice does not error — it silently inflates every number on the dashboard,
which is the worst kind of bug this project can have.

**3. Malformed bodies get 400, never 500.** Exporters retry on 5xx. A 500 on a
body that will never parse produces a retry storm from every machine on the
team at once.

**4. PII is dropped at parse time, not filtered at query time.** `user.email`,
`user.account_uuid`, `user.account_id`, `organization.id`, `prompt` and
`response` are removed in the parser, so they cannot reach a row, a log line, or
a backup. That is what makes [privacy.md](privacy.md) true by construction
rather than by discipline.

**5. `~/.claude/settings.json` is never overwritten.** Read, parse, merge,
write, after a timestamped backup. That file belongs to the user and holds
unrelated settings. A malformed one aborts the command and changes nothing.

## Schema

Five tables plus a version stamp and a config table. `src/db/schema.sql` is the
base; migrations 3 and 4 add identity and alerting.

**`members`** — one row per person. `token_hash` is the SHA-256 of a `ccm_`
token; the token itself is shown once and never stored. `join_hostname` and
`join_os` come from the join request, because OTLP carries no hostname and two
people called Alex are otherwise indistinguishable.

**`installs`** — one row per Claude Code installation, keyed on `user.id`, which
is a per-install random id from `~/.claude.json` rather than an account. One
member can own several. `os_type`, `os_version`, `arch` and `cc_version` come
from the OTLP resource block; `terminal_type` from the record.

**`requests`** — one row per API call. `id` is the idempotency key described
above. Token counts are split four ways (input, output, cache read, cache
creation) because cache reads dominate real Claude Code usage and a single
total hides it. `cost_micros` is an **integer** — `cost_usd_micros` from the
payload, never the `cost_usd` float, so a month of `SUM()` does not drift.
`model` keeps the raw string, which mixes dated and alias forms, and
`model_family` is derived for charts.

**`alert_rules`** — `member_id` NULL means the rule applies to every member
independently. `metric` is `share_pct`, `tokens` or `cost_usd`; `"window"` is
`day` or `week` and is quoted everywhere because it is a SQLite keyword.

**`alert_fires`** — one row per fire. Written _before_ delivery is attempted,
which is what makes the debounce atomic, with `delivery_status` recording what
became of the webhook afterwards.

**`server_config`** — key/value. Holds the admin token hash, the server name,
the public URL `invite` reads back, and the alert timezone.

Migrations are forward-only, appended to `MIGRATIONS` in `src/db/migrate.ts`,
and tracked in `schema_version`. Published versions are immutable: add a new
migration, never edit an old one.

## Identity

Two token kinds, deliberately distinguishable on sight:

|           | Member                          | Admin                             |
| --------- | ------------------------------- | --------------------------------- |
| Prefix    | `ccm_`                          | `cca_`                            |
| Grants    | posting usage as one member     | reading everything under `/api/*` |
| How many  | one per teammate                | one per server                    |
| Stored as | SHA-256 in `members.token_hash` | SHA-256 in `server_config`        |

Both are 32 base64url characters — 24 random bytes, 192 bits. The prefixes
differ so that an admin pasting their own token into a teammate's config is
visible rather than silent.

Join codes are 3 groups of 4 characters from a 31-character alphabet with `0`,
`O`, `1`, `I` and `L` removed, single use, 24-hour expiry. Just under 60 bits,
readable over a phone call.

`/api` is guarded by prefix, not per route, so a route added later is protected
by default rather than on remembering.

## Alerts

Evaluated on ingest, after the insert transaction, never on a cron. The window
is calendar-aligned to the server's configured timezone, which is stored rather
than read from the machine on every boot — a server that moved or restarted
under a different `TZ` would otherwise redraw every boundary, and the window
start is half the debounce key, so the first symptom would be an alert firing
twice.

Debounce is one fire per rule per member per window: check `alert_fires`, insert,
then deliver. Delivery is a webhook with a top-level `text` field so it works
unmodified with Slack and Discord, 5-second timeout, two retries with backoff,
then the failure is recorded.

Alert evaluation can never fail an ingest request. It is wrapped; errors are
logged; the response is still 200.

## Dashboard

Vite + React + Recharts in `web/`, building to `src/server/public`, served by
`@fastify/static`. The bundle is optional — a checkout that has never run
`vite build` still has a working ingest server and API, and `/` answers with a
sentence naming the missing command instead of a 404.

The admin token is entered once and held in memory. Never `localStorage`. The
`serve` banner puts it in a URL _fragment_, which is never sent to the server,
so it stays out of access logs and `Referer` headers. The page ships a strict
CSP: no framing, no script source but itself.

Aggregates are SQL, not rows loaded into JS. Every query is parameterised, and
`from`/`to` are validated as ISO timestamps by a Fastify schema before they
reach a statement.

A member's colour is derived from the enrolment list — never from position in a
response — so it survives a filter, a range change, and a new teammate joining.
Colour is never the only signal: the legend is always visible and every band's
number is also in the table.

## Build

```console
$ npm run build

> vite build --config web/vite.config.ts

vite v8.2.2 building client environment for production...
✓ 614 modules transformed.
src/server/public/index.html                   0.96 kB │ gzip:   0.53 kB
src/server/public/assets/index-HxwH0DFw.css   12.90 kB │ gzip:   3.47 kB
src/server/public/assets/index-D9D5DCpV.js   619.54 kB │ gzip: 181.84 kB
✓ built in 4.30s

> node scripts/build.mjs && node scripts/copy-assets.mjs

build: 40 modules -> dist/
copy-assets: ../src/db/schema.sql -> ../dist/db/schema.sql
copy-assets: ../src/db/schema-identity.sql -> ../dist/db/schema-identity.sql
copy-assets: ../src/db/schema-alerts.sql -> ../dist/db/schema-alerts.sql
copy-assets: ../src/server/public/ -> ../dist/server/public/
```

`scripts/build.mjs` runs esbuild over `src/` into `dist/`.
`scripts/copy-assets.mjs` brings along the three `.sql` files and the built
dashboard, because neither is something a TypeScript compiler would emit and
both are loaded by path at run time.

`scripts/verify-package.mjs` asserts what `npm pack` would actually ship:

```console
$ npm run verify:package
verify-package: 49 files, all required present
  ok  package.json
  ok  dist/cli/index.js
  ok  dist/server/app.js
  ok  dist/db/schema.sql
  ok  dist/db/schema-identity.sql
  ok  dist/db/schema-alerts.sql
  ok  dist/server/public/index.html
```

It also asserts the absence of `captures/`, tests, sourcemaps, and any `.db`
file. Every one of those failures is silent at install time and only shows up
on a user's first run.

## Tests

Colocated `*.test.ts` next to the code they cover, plus integration tests in
`test/` that drive a real Fastify instance against a real SQLite file.

`test/fixtures/` holds two genuine OTLP captures from Claude Code 2.1.241, byte
for byte except for four identity values replaced with sentinels. The parser
tests assert against them exactly, which is why that directory is in
`.prettierignore`. `test/ingest.integration.test.ts` ingests them and then
searches the database file byte by byte for those sentinels — the PII guarantee
is asserted against bytes on disk, not against what the parser returned.

The raw captures live in `captures/`, which is gitignored: they carry the
capturing account's real email and account identifiers, and a project whose
pitch is "we never store your PII" cannot ship a directory containing the
author's.

## Where to look first

| If you are changing    | Start at                                             |
| ---------------------- | ---------------------------------------------------- |
| How a payload is read  | `src/server/otlp.ts` and its fixtures test           |
| What gets stored       | `src/server/ingest.ts`, `src/db/schema.sql`          |
| A dashboard number     | `src/db/queries.ts` — it is SQL, not JS              |
| The teammate's config  | `src/cli/settings.ts`, `src/cli/jsonedit.ts`         |
| A `doctor` check       | `src/cli/doctor.ts` — each check is its own function |
| Alerting               | `src/server/alerts.ts`, `src/shared/alerts.ts`       |
| The chart or the table | `web/src/components/`, `web/src/lib/`                |

Conventions, the commit gate, and what will and will not be merged are in
[CONTRIBUTING.md](../CONTRIBUTING.md).
