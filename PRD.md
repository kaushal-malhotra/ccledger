# ccledger — Product Requirements

**Repo:** `github.com/shakibbinkabir/ccledger`
**Status:** Draft v0.1
**Owner:** Shakib Bin Kabir

Name confirmed. `ccledger` was free on the npm registry as of this draft; verify `github.com/shakibbinkabir/ccledger` is clear before the first push.

---

## 1. The problem

Small teams share Claude Code access. Sometimes that's one subscription several people use, sometimes it's a handful of individual accounts. Either way, nobody can see who is using how much.

Anthropic does publish per-user analytics, but it's Enterprise-only. Team and Pro plans get nothing. The open-source alternatives — LiteLLM, Portkey, full Grafana stacks — are proxies and observability platforms built for organizations with a platform team. Setting one up for five people means Postgres, Redis, YAML, and a reverse proxy before you see a single number.

ccledger is the small version. One command on the server, one command per teammate, a dashboard that answers "who's burning the tokens."

## 2. Who it's for

Teams of 2–10 developers using Claude Code, where somebody is responsible for the bill and currently has no visibility. Every user is already a developer with a terminal, which is why a CLI is an acceptable install path.

Not for: enterprises with an existing observability stack (use the OTel collector directly), or anyone needing audit-grade attribution.

## 2b. Prior art

Two families of tool exist already, and ccledger is neither.

**Local log readers** — `ccusage`, and `CCMeter` (hmenzagh/CCMeter, ~113 stars, Rust TUI). These parse `~/.claude/projects/*.jsonl` on one machine and show that one person their own usage. They are good at what they do and CCMeter in particular is well built. They cannot do teams: the data never leaves the laptop, and the JSONL format is documented by Anthropic as internal and version-dependent.

**Gateways and observability platforms** — LiteLLM, Portkey, Helicone, Grafana stacks. These do multi-user attribution properly, but they sit in the request path as proxies and assume a platform team to run them.

ccledger occupies the gap: multi-machine team attribution, no proxy, no platform team. The technical reason it can do this is that it consumes Claude Code's OpenTelemetry export rather than local log files, which means the data is already leaving the machine in a documented, stable format with a per-install identifier attached.

One lesson worth stealing from CCMeter's README: they found that naive summing of session logs inflates token totals by 2–3× because the same API response appears in streaming chunks, sub-agent transcripts, and `/compact` retries. They dedupe on `requestId`. Our idempotency key in §9 is the same defence applied to a different transport.

## 3. Goals

- A teammate goes from zero to reporting in under two minutes, on macOS, Linux, WSL, or Windows.
- The admin sees per-person token counts, session counts, and model breakdown, with charts over time.
- Alerts fire when one person's share of the pool crosses a threshold.
- Nothing runs in the request path. No credentials are read, stored, or relayed.
- Uninstall reverts cleanly.

## 4. Non-goals

| Not doing | Why |
|---|---|
| Proxying Claude Code traffic | Requires relaying subscription credentials. Prohibited, technically blocked, and unnecessary for usage tracking. |
| "Login with Claude" | No public OAuth for third-party apps, and offering Claude.ai login is specifically disallowed. |
| Tracking claude.ai browser or desktop usage | Closed product, no hook, and on a shared account there's no identity to attribute to anyway. |
| Enforcing limits | We observe. Blocking would require sitting in the request path. |
| Prompt or response content | Never. See §11. |
| Multi-tenant SaaS | Single team per instance. |

## 5. What Claude Code gives us

**Verified against Claude Code 2.1.241 on Windows, 2026-08-23.** Everything below is from a live OTLP/HTTP JSON capture, not from the docs.

Claude Code has native OpenTelemetry support. With telemetry enabled it emits events over the OTLP logs protocol. The one we care about is `claude_code.api_request`, fired per API call. A real record's attributes:

```
user.id, session.id, organization.id, user.email,
user.account_uuid, user.account_id, terminal.type,
event.name, event.timestamp, event.sequence, prompt.id,
model, input_tokens, output_tokens,
cache_read_tokens, cache_creation_tokens,
cost_usd, cost_usd_micros, duration_ms,
request_id, client_request_id, speed, effort, query_source
```

Resource block carries only `host.arch`, `os.type`, `os.version`, `service.name`, `service.version`. **No identity on the resource** — everything you attribute on is on the record.

`service.version` is the Claude Code version. Store it per install; it's your early warning when a schema changes under you.

### Things the capture taught us that the docs didn't

**Use `cost_usd_micros`, not `cost_usd`.** Both are emitted (`963` alongside `0.000963`). The integer micros version avoids float accumulation error across a month of `SUM()`. Store micros as INTEGER, divide for display.

**`query_source` is a free-form subsystem string, not the three-value enum the metrics carry.** Observed: `sdk`, `generate_session_title`. Also expect `repl_main_thread`, `compact`, and subagent names.

**Not every `api_request` is user work.** A single `claude -p` produced two: one on Haiku with `query_source: generate_session_title` (Claude Code naming the session, $0.00096), one on Opus with `query_source: sdk` (the actual work, $0.0996). Keep both — auto-compaction can be expensive and hiding it would misattribute real consumption — but let the dashboard group by `query_source` so overhead is visible separately.

**`prompt.id` is nullable.** Absent on the title-generation request, present on the real one.

**Model strings are not normalised.** `claude-haiku-4-5-20251001` (dated) and `claude-opus-5` (alias) both appear. Normalise to a family for the by-model chart, keep the raw string.

**Optional attributes really are absent, not null.** `effort` appeared only on the Opus request. `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name` didn't appear at all in a simple session.

**Batching:** one HTTP POST carries many records of mixed event types. Two POSTs held six and four records respectively, spanning `plugin_loaded`, `mcp_server_connection`, `api_request`, `assistant_response`, and `user_prompt`. Always iterate every record; never assume one event per request. `resourceLogs` had one entry each time, but loop it anyway.

**Not gzipped** in this capture. Accept gzip regardless — it's configurable.

### Two properties that shape the design

**`user.id` is per-installation.** A random identifier generated on first run and stored in `~/.claude.json`, carrying no personal information and not derived from the Claude account. Six teammates on one shared account produce six distinct values — that's the device key, for free.

**Account fields are useless on a shared account.** `user.email`, `user.account_uuid`, `user.account_id`, and `organization.id` are identical across everyone. Never key on them, and see §11 — they're PII we deliberately discard.

### Two constraints to design around

Telemetry config is read once at startup, so setup always ends with "restart Claude Code." Expect this to be the number one support question.

Cost figures are approximations — Anthropic's own docs say so, and point to the provider console for real billing. On a subscription these are notional API-equivalent prices, not money anyone spent. This shapes the alerting model in §10.

## 6. Architecture

```
teammate laptop                        server (laptop or VPS)
┌──────────────────┐                   ┌────────────────────────┐
│ Claude Code CLI  │                   │  POST /v1/logs         │
│  (OTel exporter) │ ──── HTTPS ────▶  │    ↓                   │
└──────────────────┘   OTLP/JSON       │  SQLite                │
                       + bearer token  │    ↓                   │
┌──────────────────┐                   │  Dashboard + API       │
│ npx ccledger setup│ ──── join ─────▶  │  POST /join            │
│  (runs once)     │                   └────────────────────────┘
└──────────────────┘
```

No daemon on the teammate's machine. The setup command runs, writes config, and exits. Claude Code's own exporter does the sending.

### Server modes

**Laptop mode** — admin runs `ccledger serve` on their own machine. Binds to an mDNS hostname (`ccledger.local`) rather than an IP so DHCP reassignment doesn't silently break every teammate. Plain HTTP; the token crosses the LAN unencrypted. Documented as office-network-only.

**VPS mode** — docker-compose with Caddy in front for automatic TLS. The admin should never touch a certificate.

The join code encodes both endpoint and secret so there's one string to paste.

## 7. Config contract

Written to `~/.claude/settings.json` under the `env` key. This is the whole cross-platform story: Claude Code reads the file directly, so the config applies no matter how `claude` was launched — terminal, VS Code, Cursor, JetBrains. No shell profile surgery, no Windows registry, no difference between platforms except the home directory path.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://meter.example.com/v1/logs",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS": "Authorization=Bearer ccm_xxxxxxxx"
  }
}
```

Five keys. All logs-scoped except the master switch, which is why an existing metrics or traces export somewhere else keeps working untouched.

Rules for writing it:

- Read, parse, merge, write. Never overwrite the file.
- Back up to `~/.claude/settings.json.ccledger-backup-<ts>` first.
- If any of the five keys already exist with different values, stop and report rather than clobbering.
- Record exactly which keys were added, in `~/.ccledger/state.json`, so uninstall removes only those.

## 8. Data model

```sql
members (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
)

installs (
  id             TEXT PRIMARY KEY,     -- claude user.id
  member_id      TEXT NOT NULL REFERENCES members(id),
  hostname       TEXT,
  os_type        TEXT,                 -- resource os.type
  os_version     TEXT,                 -- resource os.version
  arch           TEXT,                 -- resource host.arch
  cc_version     TEXT,                 -- resource service.version
  terminal_type  TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
)

requests (
  id                     TEXT PRIMARY KEY,  -- client_request_id, else request_id, else hash
  ts                     INTEGER NOT NULL,  -- epoch ms, from event.timestamp
  member_id              TEXT NOT NULL REFERENCES members(id),
  install_id             TEXT,
  session_id             TEXT,
  prompt_id              TEXT,              -- nullable
  model                  TEXT,
  model_family           TEXT,              -- normalised: opus | sonnet | haiku | other
  input_tokens           INTEGER DEFAULT 0,
  output_tokens          INTEGER DEFAULT 0,
  cache_read_tokens      INTEGER DEFAULT 0,
  cache_creation_tokens  INTEGER DEFAULT 0,
  cost_micros            INTEGER DEFAULT 0, -- cost_usd_micros, NOT the float
  duration_ms            INTEGER,
  query_source           TEXT,
  speed                  TEXT,
  effort                 TEXT               -- nullable
)

alert_rules (
  id           TEXT PRIMARY KEY,
  member_id    TEXT,              -- null = applies to everyone
  window       TEXT NOT NULL,     -- 'day' | 'week'
  metric       TEXT NOT NULL,     -- 'share_pct' | 'tokens' | 'cost_usd'
  threshold    REAL NOT NULL,
  webhook_url  TEXT,
  enabled      INTEGER DEFAULT 1
)

alert_fires (
  id, rule_id, member_id, fired_at, value, window_start
)
```

Indexes on `requests(ts)`, `requests(member_id, ts)`, `requests(model)`.

`INSERT OR IGNORE` on `requests.id` is what makes ingest idempotent.

`installs` keyed on `user.id` is what lets one person have a laptop and a desktop and still roll up as one member.

## 9. Ingest

`POST /v1/logs`, OTLP/HTTP with JSON encoding.

- Auth: `Authorization: Bearer <token>`. Hash and look up in `members`. 401 on miss, 403 if revoked.
- Accept gzip; Claude Code may or may not compress.
- Body shape is nested: `resourceLogs[] → scopeLogs[] → logRecords[]`. Attributes are `{key, value: {stringValue|intValue|doubleValue|boolValue}}` arrays. Verified: identity attributes are on the **record**, and the resource carries only host and version info. Flatten both anyway; record wins on collision.
- **Number encoding is inconsistent — coerce everything.** My earlier assumption that proto3 JSON always quotes 64-bit integers was wrong. In the 2.1.241 capture, `timeUnixNano` arrives as a *string* (`"1787503991194000000"`) while `intValue` arrives as a bare *number* (`898`). The serializer appears to quote only values that would lose precision as JSON numbers. Write one `toInt()` helper that accepts both and never trust the JSON type.
- Prefer `event.timestamp` — an unambiguous ISO 8601 string — over `timeUnixNano`. Keep the nano field as fallback only.
- Take `cost_usd_micros` (integer), not `cost_usd` (float).
- Filter on `event.name == "api_request"`. Note the record `body` is the prefixed form (`claude_code.api_request`) while `event.name` is bare (`api_request`) — match on `event.name`.
- One POST carries many records of mixed types. Iterate everything; log unknown event names at debug level with a counter.
- **Drop PII at parse time.** Never persist `user.email`, `user.account_uuid`, `user.account_id`, or `organization.id`. They're identical across a shared account so they carry no information, and not storing them makes `privacy.md` true by construction.
- Derive `id` from `client_request_id` (present in 2.1.241), falling back to `request_id`, falling back to a hash of `(session_id, ts, input_tokens, output_tokens)`.
- Upsert `installs` from `user.id`, plus `terminal.type` from the record and `os.type` / `os.version` / `host.arch` / `service.version` from the resource.
- Respond `200 {"partialSuccess":{}}` on success. Exporters retry on 5xx, so return 400 for malformed bodies rather than 500, or you'll get a retry storm.

**Fixture:** `test/fixtures/` holds two real captures from 2.1.241 — six and four records, spanning `plugin_loaded`, `mcp_server_connection`, `api_request`, `assistant_response`, and `user_prompt`. Build the parser against these.

## 10. Dashboard and alerts

### Views

**Overview** — date range picker (today / 7d / 30d / custom). Per-member table: total tokens, input/output/cache split, request count, session count, estimated cost, share of period as a percentage. Sortable, share descending by default.

**Charts** — stacked area of tokens per member over time; bar chart of tokens by model; per-member sparkline in the table.

**Member detail** — that person's sessions, models, requests over time, and their installs with last-seen.

**Settings** — members list with revoke, join code generation, alert rules.

### Alerts

Primary metric is **share of pool**, not dollars. On a subscription nobody is actually spending $47 — they're consuming a slice of a flat plan. "Rahim is at 52% of this week's tokens" is the number people argue about; "$47.30" is a number they'd have to mentally translate first.

Absolute token and notional-cost thresholds are available as secondary options for teams on API billing, where the dollars are real.

- Evaluate on ingest, not on a cron. Cheap at this volume and gives near-real-time firing.
- Debounce: one fire per rule per window. Record in `alert_fires` and check before firing.
- Delivery: webhook only. One URL field, JSON payload that works as-is with Slack and Discord incoming webhooks. Plus a badge in the dashboard.
- No SMTP in v0. Email configuration is a support burden out of all proportion to its value here.

## 11. Privacy and security

This is a product feature, not a compliance footnote. People are being asked to install monitoring at a manager's request. What makes that feel acceptable is being able to see exactly what it does and doesn't send.

**Never enable content logging.** `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and `OTEL_LOG_RAW_API_BODIES` are all off by default in Claude Code and ccledger must never set any of them. If `doctor` finds one set by something else, warn loudly — it means content is leaving the machine.

**Show a disclosure screen during setup**, before writing anything:

```
ccledger will send, per API request:
  model name, token counts, duration, timestamp, session id

It will NOT send:
  prompts, responses, file contents, file paths,
  command text, or repository names

Config written to: ~/.claude/settings.json
Remove any time with: npx ccledger uninstall
```

**Attribution is honor-system.** The token is stronger than an env var, but anyone with shell access to their own machine can edit the config or unset telemetry. Say this in the README. It's fine for a team splitting a bill; it is not audit tooling and must not be described as such.

**Tokens** are stored hashed server-side, shown once at join. Join codes are single-use and expire in 24 hours.

## 12. CLI surface

| Command | Purpose |
|---|---|
| `ccledger serve` | Start server. Flags for port, db path, mode. |
| `ccledger invite <name>` | Generate a join code. |
| `npx ccledger setup --code <code>` | Join, write config, print restart reminder. |
| `npx ccledger doctor` | Diagnose. See below. |
| `npx ccledger uninstall` | Remove only the keys ccledger added, restore backup on request. |

### `doctor` checks, in order

1. Is `~/.claude/settings.json` present and does it contain our five keys?
2. Has Claude Code been restarted since the config was written? (compare config mtime to newest file in `~/.claude/projects/`)
3. Is the endpoint reachable? (`GET /health`)
4. Is the token valid and unrevoked?
5. Are conflicting `OTEL_*` variables set in the shell environment?
6. Are any content-logging variables enabled?

Build this in stage 3, not stage 8. Every support question you get will be "it's not showing up," and it will nearly always be number 2.

## 13. Stack

- TypeScript, Node 20+. One npm package, subcommands. Single version number, one install story.
- Fastify for the server. Schema validation is useful for the ingest route.
- better-sqlite3. Synchronous, no connection pool, fast enough for six people by several orders of magnitude.
- Commander for the CLI.
- Vite + React + Recharts for the dashboard, built to static assets shipped in the tarball. No build step for the user.
- Vitest.

**Verify before committing to npx:** Claude Code now ships native installers, so Node is no longer guaranteed on every teammate's machine. Check across your actual five people in stage 0. If two of them don't have Node, ship binaries via `pkg` or Bun compile earlier than planned.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Endpoint URL is baked into each config; moving the server breaks everyone silently | mDNS hostname in laptop mode; stable domain in VPS mode; `doctor` reports unreachable endpoints clearly |
| No local buffering — telemetry lost while server is down | Accepted for v0. It's the main argument for a local agent in v2. |
| OTel attribute names change between Claude Code versions | Pin tested versions in the README; parser tolerates missing attributes rather than throwing |
| Someone edits their config to stop reporting | Honor-system by design. Documented. |
| Cost numbers misread as real spend | Label every cost column "est." and explain in the README |
| Nobody restarts Claude Code | `doctor` check #2, plus a loud reminder as the last line of setup |

## 15. Later

Local agent with offline buffering. Metrics ingest for commits, lines of code, and active time. Error and refusal rates from `api_error` and `api_refusal`. Per-project breakdown. CSV export. Multiple servers or teams in one instance.