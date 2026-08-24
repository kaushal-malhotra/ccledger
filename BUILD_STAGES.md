# ccledger — Build Stages and Claude Code Prompts

Eight stages. Each one ends with something you can run. Don't start the next until the acceptance criteria pass — the whole point of the staging is that a broken ingest parser in stage 1 is trivial to find and impossible to find once there's a dashboard sitting on top of it.

Each stage has a prompt to paste into Claude Code.

> **Shell note.** Development is on Windows / PowerShell. Where this document shows a shell command, the PowerShell form is:
> ```powershell
> $env:NAME = "value"      # set          (bash: export NAME=value)
> $env:NAME = $null        # unset        (bash: unset NAME)
> Get-ChildItem Env: | Where-Object Name -like "OTEL*"    # inspect
> ```
> Both forms need to appear in the shipped docs, since teammates will be on mixed platforms. CI already runs the test matrix on Windows — keep it that way; the settings-file writer in stage 3 is where cross-platform bugs will actually live. Run stage 0 by hand first: it produces the single fact everything else depends on.

---

## Before anything: version control

The repo is initialised before stage 1 writes its first file, not at stage 7 when CI arrives. Eight stages of agent-written code with no history is eight stages you cannot diff, bisect, or roll back — and the review-and-fix pass at the end of each stage rewrites files, so without commits there is nothing to compare it against.

```powershell
git init -b main       # main, because the guide's branch protection assumes it
```

Two things to get right on day one, because both are painful to retrofit:

**`.gitattributes` pinning `* text=auto eol=lf`.** Development is on Windows where `core.autocrlf` is usually true, Prettier is configured `endOfLine: "lf"`, and CI runs a Windows leg. Without it a clean clone on Windows checks out CRLF and fails `format:check` before it runs a single test.

**`captures/` in `.gitignore`.** The stage 0 payloads carry the capturing account's real email, `organization.id`, and account identifiers. Sanitised copies belong in `test/fixtures/`, with the substituted values recorded in a README beside them. Those four attributes are exactly the ones the parser drops, so replacing them costs no test coverage, and distinctive sentinels are easier to grep a SQLite file for than a real address.

**Commit when the stage's acceptance criteria pass, not before.** A commit of code that the next verification pass is about to rewrite is noise. Run the gate — `format:check`, `lint`, `typecheck`, `test`, `build` — then commit.

**One commit per component, not one per stage.** Conventional commits with a scope, subject in the imperative, and a body that says *why* rather than restating the diff. Scopes track the layout: `db`, `server`, `cli`, `web`, `shared`, plus unscoped `chore`, `test`, `docs`, `ci`.

| Stage | Commits it should produce |
|---|---|
| 1 | `chore:` skeleton · `feat(shared):` types · `test:` fixtures · `feat(db):` schema and migrations · `feat(server):` parser · `feat(server):` ingest · `feat(server):` app · `feat(cli):` serve · `test:` acceptance suite |
| 2 | `feat(server):` auth and token hashing · `feat(server):` join codes · `feat(server):` admin token · `feat(cli):` serve flags · `feat(cli):` invite |
| 3 | `feat(cli):` settings writer · `feat(cli):` setup · `feat(cli):` doctor · `feat(cli):` uninstall |
| 4 | `feat(server):` read API · `feat(web):` shell and date range · `feat(web):` member table |
| 5 | `feat(web):` timeseries chart · `feat(web):` model chart · `feat(web):` sparklines · `feat(web):` member detail |
| 6 | `feat(db):` rules and fires · `feat(server):` evaluation · `feat(server):` webhook delivery · `feat(web):` rules UI |
| 7 | `chore:` build and packaging · `feat(cli):` mDNS · `chore(docker):` image and compose · `feat(cli):` backup · `ci:` workflows |
| 8 | `docs:` one commit per document · `chore:` LICENSE and templates |

Append this line to every stage prompt you paste, stage 2 onward:

```
When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

A stage is not done until its acceptance criteria pass **and** its commits are on `main`.

---

## Before anything: set up CLAUDE.md

Claude Code reads `CLAUDE.md` at the repo root on every session. Put the project's context there once and every later prompt gets shorter and more accurate.

**Prompt:**

```
Create a CLAUDE.md at the repo root for a project called ccledger.

ccledger is a self-hosted usage dashboard for small teams using Claude Code.
Claude Code has native OpenTelemetry support; ccledger runs a server that
receives OTLP log events from each teammate's Claude Code, stores them in
SQLite, and shows per-person token usage.

Include these sections:

## What this is
Short description as above. Emphasise: ccledger is NOT a proxy. It never sits
in the request path, never reads or stores Claude credentials, and never
handles prompt or response content.

## Stack
TypeScript, Node 20+, Fastify, better-sqlite3, Commander, Vite + React +
Recharts for the dashboard, Vitest for tests. Single npm package with
subcommands, not a monorepo.

## Hard rules
- Never write code that sets OTEL_LOG_USER_PROMPTS, OTEL_LOG_ASSISTANT_RESPONSES,
  OTEL_LOG_TOOL_DETAILS, OTEL_LOG_TOOL_CONTENT, or OTEL_LOG_RAW_API_BODIES.
  These enable content capture and are out of scope permanently.
- Never overwrite ~/.claude/settings.json. Read, parse, merge, write, after
  taking a timestamped backup.
- OTLP JSON encodes 64-bit integers as strings. Always coerce timeUnixNano
  and intValue explicitly; never assume a number type.
- Ingest must be idempotent. OTLP delivery is at-least-once.
- Return 400 for malformed ingest bodies, never 500 — exporters retry on 5xx
  and will produce a retry storm.

## Layout
src/cli/       command implementations
src/server/    fastify app, routes, alert evaluation
src/db/        schema, migrations, queries
src/shared/    types shared between cli and server
web/           vite dashboard, builds to src/server/public
test/

## Conventions
- Strict TypeScript, no `any` in committed code
- Every exported function has a JSDoc line
- Tests colocated as *.test.ts
- Conventional commits

Keep it under 100 lines.
```

---

## Stage 0 — Confirm the payload — DONE

Verified against **Claude Code 2.1.241, Windows 11, VS Code terminal**, 2026-08-23.

Captures live in `test/fixtures/`: two real OTLP/HTTP JSON payloads, six and four records.

### Findings that changed the plan

| Finding | Consequence |
|---|---|
| Identity attributes are on the **record**; resource holds only `host.arch`, `os.type`, `os.version`, `service.name`, `service.version` | Know where to read from; still flatten both defensively |
| `intValue` arrives as a bare JSON **number**, `timeUnixNano` as a **string** | The "always quoted" assumption was wrong. One `toInt()` helper accepting both |
| `cost_usd_micros` (integer) emitted alongside `cost_usd` (float) | Store micros as INTEGER, no float drift across a month of `SUM()` |
| `client_request_id` present | Idempotency key confirmed available |
| One `claude -p` produced **two** `api_request` events | `query_source: generate_session_title` on Haiku plus `query_source: sdk` on Opus. Requests ≠ prompts. Group by `query_source` so overhead is visible |
| `query_source` is free-form, not the 3-value enum the metrics use | Store the raw string |
| Model strings mix dated and alias forms (`claude-haiku-4-5-20251001`, `claude-opus-5`) | Derive a `model_family` column for charts, keep the raw |
| `prompt.id` and `effort` absent on some records | Every optional attribute must tolerate absence |
| `service.version` gives the Claude Code version | Store per install as schema-drift early warning |
| Not gzipped, one `resourceLogs` entry per POST | Accept gzip anyway, loop the array anyway |
| Payload contains `user.email`, `user.account_uuid`, `user.account_id`, `organization.id` | Real PII, worthless on a shared account. Drop at parse time |

### Still open

- [ ] `node -v` on all five teammates' machines — decides whether npx-only survives

## Stage 1 — Schema and ingest

**Prompt:**

```
Set up the ccledger project skeleton and the ingest path.

1. Initialise a TypeScript npm package named ccledger. Node 20+, ESM,
   strict tsconfig, vitest, eslint + prettier. Add a `ccledger` bin entry
   pointing at src/cli/index.ts via a built dist.

2. Create the SQLite schema in src/db/schema.sql exactly as specified in
   PRD.md section 8 — tables members, installs, requests, alert_rules,
   alert_fires, with the indexes listed. Write a simple forward-only
   migration runner in src/db/migrate.ts that tracks applied versions in a
   schema_version table.

3. Write src/server/otlp.ts: a parser that turns an OTLP/HTTP JSON logs
   payload into a flat array of typed event objects.
   - The payload nests resourceLogs[] -> scopeLogs[] -> logRecords[]
   - Attributes are arrays of {key, value:{stringValue|intValue|doubleValue|boolValue}}.
     Identity attributes are on the record; the resource carries only
     host.arch, os.type, os.version, service.name, service.version.
     Flatten both into one map per record; record wins on key collision.
   - NUMBER ENCODING IS INCONSISTENT. In the captured fixtures, intValue is a
     bare JSON number (898) while timeUnixNano is a quoted string
     ("1787503991194000000"). Write one toInt() helper that accepts either and
     never trust the JSON type.
   - Prefer the event.timestamp attribute (ISO 8601 string) over timeUnixNano.
   - Take cost_usd_micros (integer), never cost_usd (float).
   - Match on the event.name attribute (bare, e.g. "api_request"), not the
     record body (prefixed, e.g. "claude_code.api_request").
   - DROP PII AT PARSE TIME. Never return or persist user.email,
     user.account_uuid, user.account_id, or organization.id.
   - Derive model_family (opus|sonnet|haiku|other) from the model string,
     which mixes dated and alias forms. Keep the raw string too.
   - Tolerate missing attributes — prompt.id and effort are absent on some
     records. Never throw on an unexpected shape; return what parsed and
     count what didn't.

4. Write src/server/ingest.ts: given parsed events, filter to
   event.name === "api_request" and insert into requests.
   - Row id = client_request_id ?? request_id ?? sha256(session_id + ts +
     input_tokens + output_tokens). client_request_id is present in 2.1.241.
   - Use INSERT OR IGNORE so redelivery is a no-op
   - Upsert installs from user.id, terminal.type, plus os.type, os.version,
     host.arch and service.version from the resource block
   - Log unknown event names at debug level with a counter

5. Fastify app in src/server/app.ts with POST /v1/logs and GET /health.
   Accept gzip. Return 200 {"partialSuccess":{}} on success and 400 on a
   malformed body. Never 500 for bad input.

6. Tests using the real captures in test/fixtures/ (001.json, 002.json).
   Cover: both files parse; 001 yields 6 records and 002 yields 4; exactly
   2 api_request rows total across both; numeric coercion works for both
   bare-number and quoted forms; duplicate delivery of the same file inserts
   no new rows; malformed payload returns 400 not 500; missing optional
   attributes don't throw; no PII field reaches the database (assert on the
   row shape, not just the parser).

Auth comes in stage 2 — for now accept any request. Add a TODO.

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

**Acceptance:** `curl` the fixture at `/v1/logs` twice, see exactly one row in SQLite, and see correct integer values.

---

## Stage 2 — Identity, tokens, join codes

**Prompt:**

```
Add identity to ccledger.

1. src/server/auth.ts
   - Tokens formatted ccm_<32 url-safe random chars>
   - Store only sha256 hashes in members.token_hash
   - bearerAuth middleware: parse Authorization header, hash, look up.
     401 unknown, 403 revoked. Attach member to the request.
   - Apply to POST /v1/logs. Ingest now writes member_id on every row.

2. Join codes
   - In-memory + SQLite table: code, display_name, expires_at, used_at
   - Single use, 24h expiry
   - Codes are short and human-typeable: 3 groups of 4 uppercase
     alphanumerics, excluding easily confused characters (0/O, 1/I/L)
   - POST /join takes {code, display_name, hostname, os}, creates the member,
     returns {token, member_id, server_name}
   - The invite string given to a teammate bundles endpoint and code as one
     base64url blob so there is exactly one thing to paste

3. Admin auth for the dashboard: a single admin token generated on first
   `serve` and printed once, persisted hashed in the db. Flag to rotate.
   Guard all /api/* routes with it. The dashboard stores it in memory,
   not localStorage.

4. `ccledger serve` command: --port, --db, --host, --mode=laptop|vps.
   Runs migrations on boot. In laptop mode, print the mDNS URL and warn
   clearly that traffic is unencrypted and this is for trusted networks only.
   Print the admin URL with token on first run.

5. `ccledger invite <display-name>` prints the paste-able invite string.

Tests: token hashing round-trip, revoked member gets 403, join code is
single-use, expired code rejected, ingest without a token is 401.

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

**Acceptance:** `ccledger invite alice` gives a string; a manual `POST /join` with it returns a token; ingest with that token attributes rows to Alice; reusing the code fails.

---

## Stage 3 — The client commands

This is the stage that determines whether the thing is actually plug and play.

**Prompt:**

```
Build the ccledger client commands. These run on a teammate's machine and
must work identically on macOS, Linux, WSL, and Windows.

1. src/cli/settings.ts — safe manipulation of ~/.claude/settings.json
   - Resolve the path cross-platform via os.homedir()
   - Read and parse; if the file is absent, treat as {}; if it exists but is
     malformed, abort with a clear message and change nothing
   - Back up to ~/.claude/settings.json.ccledger-backup-<unix-ts> before writing
   - Deep-merge only the env keys we own; preserve everything else including
     key order and formatting as far as practical
   - Record added keys in ~/.ccledger/state.json alongside the backup path,
     server url, member id and name

2. `ccledger setup --code <invite>`
   Flow:
   a. Decode the invite to endpoint + code
   b. Prompt for display name, defaulting to the name in the invite
   c. Print the disclosure block from PRD.md section 11 verbatim and require
      explicit confirmation before touching anything
   d. POST /join, receive the token
   e. Check for pre-existing conflicting keys. If any of our five keys exist
      with different values, STOP and tell the user what conflicts and how to
      resolve it. Do not clobber.
   f. Write exactly these five env keys:
      CLAUDE_CODE_ENABLE_TELEMETRY=1
      OTEL_LOGS_EXPORTER=otlp
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<endpoint>/v1/logs
      OTEL_EXPORTER_OTLP_LOGS_HEADERS=Authorization=Bearer <token>
      Nothing else. No OTEL_RESOURCE_ATTRIBUTES, no metrics exporter, no
      generic OTEL_EXPORTER_OTLP_* keys.
   g. Final line, visually prominent: restart Claude Code for this to take
      effect. Telemetry config is read once at startup.
   Support --yes for non-interactive use.

3. `ccledger doctor` — run these six checks in order, print pass/fail/skip
   with a specific remedy for each failure:
   1. Are our five keys present in ~/.claude/settings.json?
   2. Has Claude Code restarted since the config was written? Compare config
      mtime against the newest mtime in ~/.claude/projects/. If the config is
      newer, this is almost certainly the problem — say so emphatically.
   3. Is the endpoint reachable? GET /health with a 5s timeout.
   4. Is the token accepted? POST an empty valid OTLP envelope, expect 200.
   5. Any conflicting OTEL_* variables in process.env that would override?
   6. Any content-logging variables enabled anywhere? If yes, warn loudly
      that prompt or response content may be leaving the machine.
   Exit non-zero if any check fails. --json for machine output.

4. `ccledger uninstall`
   - Remove ONLY the keys listed in state.json, leave everything else
   - Offer to restore the backup instead
   - Offer to notify the server so the admin can revoke the token
   - Delete ~/.ccledger/

Tests with a temp HOME: fresh install, merge into an existing settings file
with unrelated keys, refuse on conflict, uninstall restores the original
byte-for-byte, malformed settings file aborts safely.

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

**Acceptance:** On a machine with an existing `~/.claude/settings.json` containing custom permissions and hooks, setup adds five keys and touches nothing else; uninstall returns the file to its original state.

---

## Stage 4 — Read API and dashboard shell

**Prompt:**

```
Build the ccledger read API and dashboard shell.

Server, src/server/api.ts, all admin-token guarded:
  GET /api/summary?from=&to=      per-member aggregates
  GET /api/timeseries?from=&to=&bucket=hour|day   tokens per member per bucket
  GET /api/models?from=&to=       tokens and requests per model
  GET /api/members                list with last_seen and install count
  GET /api/members/:id?from=&to=  detail: sessions, models, installs
  POST /api/members/:id/revoke

Aggregates return: total tokens, input, output, cache_read, cache_creation,
request count, distinct session count, estimated cost, share of period as a
percentage of total tokens.

Write these as SQL aggregates, not by loading rows into JS. Parameterise
every query. Validate from/to as ISO timestamps with a Fastify schema and
reject anything else.

Dashboard in web/, Vite + React + TypeScript, building to src/server/public,
served statically by Fastify.
  - Date range picker: Today / 7d / 30d / Custom
  - Member table, sortable, sorted by share descending by default
  - Costs are stored as integer micros. Divide by 1e6 for display; never
    SUM() a float.
  - Every cost column labelled "est." with a tooltip explaining that
    subscription costs are notional API-equivalent prices, not real spend
  - A query_source filter or grouping, so overhead requests
    (generate_session_title, compact) can be separated from real work
  - Empty state that links to the doctor command — a new admin's first
    experience is an empty dashboard and they need to know what to do
  - Admin token entered once, held in memory, never localStorage

Design: clean and plain. Legible tabular numbers, generous spacing, no
gradients, works at 1280px. Dark mode via prefers-color-scheme.

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

**Acceptance:** With seeded data, the table shows correct per-member totals and shares that sum to 100%.

---

## Stage 5 — Charts

**Prompt:**

```
Add charts to the ccledger dashboard using Recharts.

1. Stacked area, tokens over time, one band per member, driven by
   /api/timeseries. Auto-select hourly buckets for ranges under 3 days,
   daily above. Consistent colour per member across every chart — derive it
   deterministically from the member id so it doesn't shuffle between loads.

2. Horizontal bar: tokens by model, from /api/models.

3. Sparkline per row in the member table showing that member's daily trend.

4. Member detail page: their own timeseries, model split, session list with
   token totals, and their installs with terminal type and last-seen.

Requirements:
  - Loading skeletons, not spinners
  - Empty state per chart when a range has no data
  - Tooltips show formatted numbers with thousands separators
  - Accessible: every chart has a text summary for screen readers, and colour
    is never the only signal — the legend is always visible
  - Responsive down to 768px

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

**Acceptance:** A range with three members renders a readable stacked area whose per-bucket totals match the table.

---

## Stage 6 — Alerts

**Prompt:**

```
Add alerting to ccledger.

Rules stored in alert_rules per PRD.md section 8.
  - member_id null means the rule applies to every member independently
  - metric is share_pct | tokens | cost_usd
  - window is day | week
  - share_pct is the primary metric; it's what a team on a shared
    subscription actually argues about

Evaluation:
  - Run on ingest, after the insert transaction, not on a cron
  - Compute the member's value for the current window and compare
  - Debounce hard: one fire per rule per member per window. Check
    alert_fires before firing, insert after.
  - Windows are calendar-aligned in the server's configured timezone.
    Make the timezone a serve flag defaulting to the system zone, and store
    it — a "weekly" budget that resets at a surprising hour is confusing.
  - Never let alert evaluation fail an ingest request. Wrap it, log errors,
    always return 200.

Delivery:
  - Webhook only. One URL per rule.
  - JSON payload with a top-level `text` field so it works as-is with Slack
    and Discord incoming webhooks, plus structured fields alongside.
  - 5s timeout, 2 retries with backoff, then give up and record the failure.
  - No SMTP.

UI: rules CRUD in Settings, recent fires list, and a badge on any member row
currently over threshold.

Tests: threshold crossing fires exactly once, second crossing in the same
window does not fire, new window allows a fire again, webhook failure does
not break ingest.

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

**Acceptance:** Seed usage past a 50% share threshold, confirm one webhook, confirm a second ingest in the same window sends nothing.

---

## Stage 7 — Packaging and deployment

**Prompt:**

```
Make ccledger installable and deployable.

1. Build: tsup or esbuild to dist/, dashboard built to src/server/public and
   included. Set "files" in package.json so the tarball ships dist, public,
   and schema.sql and nothing else. Verify with `npm pack --dry-run`.

2. Laptop mode: on serve --mode=laptop, advertise over mDNS as
   ccledger.local using the bonjour-service package. Print the URL. Print a
   clear warning that traffic is unencrypted and this mode is for trusted
   networks only. Fall back to printing the LAN IP if mDNS is unavailable.

3. VPS mode: docker/ directory with a Dockerfile (multi-stage, non-root
   user, node:20-alpine), docker-compose.yml with a Caddy service in front
   for automatic TLS, and a .env.example. The admin should set one domain
   and run one command. A named volume for the SQLite file.

4. Backup: `ccledger backup <path>` using SQLite's online backup API, plus a
   note in the docs about the volume.

5. GitHub Actions:
   - ci.yml: lint, typecheck, test on ubuntu/macos/windows, Node 20 and 22
   - release.yml: on tag, build, npm publish with provenance, create a
     GitHub Release with notes from the changelog

6. Health and version endpoints, and a --version flag.

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

**Acceptance:** `npm pack`, install the tarball globally in a clean container, run `serve`, and complete a full join-setup-ingest cycle against it.

---

## Stage 8 — Documentation and release

Follow `OPEN_SOURCE_GUIDE.md` for the full checklist. The prompt:

```
Write the ccledger documentation set, following OPEN_SOURCE_GUIDE.md.

Produce:
  README.md         per the structure in the guide
  docs/install.md   both server modes, step by step, with expected output
  docs/setup.md     the teammate's two-minute path
  docs/privacy.md   what is sent and what is not, in a table, plus the
                    honor-system limitation stated plainly
  docs/troubleshoot.md   the six doctor checks with remedies
  docs/architecture.md   for contributors
  CONTRIBUTING.md   dev setup, test commands, PR expectations
  SECURITY.md       private disclosure address, supported versions
  CODE_OF_CONDUCT.md   Contributor Covenant 2.1
  CHANGELOG.md      Keep a Changelog format
  LICENSE           MIT, Shakib Bin Kabir
  .github/ISSUE_TEMPLATE/{bug,feature}.yml
  .github/pull_request_template.md

Writing rules:
  - Plain sentences. No marketing adjectives. No "seamless", "powerful",
    "robust", "comprehensive".
  - Every command block shows the expected output
  - State limitations in the README, not buried in docs: costs are estimates,
    attribution is honor-system, claude.ai browser and desktop usage is not
    tracked
  - A prominent line stating this is an independent project, not affiliated
    with or endorsed by Anthropic
  - The README's first screenshot slot is the dashboard. Leave a placeholder
    with the exact filename to add.

When the acceptance criteria pass and the gate is green, commit the work as
separate conventional commits, one per component, following "Before anything:
version control" in BUILD_STAGES.md. Do not commit before the gate is green.
```

---

## Order notes

Stage 3 before stage 4 is deliberate. A dashboard with no way to onboard a real teammate is a demo; a working setup command with no dashboard is already useful to one person reading SQLite directly. Front-load the part that's hard to retrofit.

If you slip on time, stages 5 and 6 are the ones to cut. Stage 3's `doctor` is not cuttable — it's the difference between an open-source project people use and one whose issue tracker is forty copies of "no data showing."