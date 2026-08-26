# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0, the config contract counts. The five keys ccledger writes into
`~/.claude/settings.json` are part of the public interface, and changing which
keys it owns is a breaking change even when no function signature moves.

## [Unreleased]

## [0.1.1] - 2026-08-26

### Added

- **A guide and a bootstrap script for AWS.** `docs/deploy-aws.md` and
  `deploy/lightsail.sh` put ccledger on a Lightsail instance for $5 a month,
  with Caddy in front for TLS and systemd keeping it up. Prices in the guide
  come from the Lightsail and EC2 pricing APIs rather than from memory, and it
  says why EC2 is not cheaper — a public IPv4 address has been billable since
  February 2024 and costs more than the instance it is attached to.

  The script installs the published npm package rather than building the
  Docker image, because the $5 machine has 512 MB of RAM and building means
  compiling a native SQLite addon and running a Vite build. Both run out of
  memory. Anyone who wants the container needs the $7 tier.

  Lambda, App Runner and Fargate-on-EFS are documented as out of scope, with
  the reasoning: they take away the single SQLite file, and with it the
  idempotent ingest key, the transactional alert debounce, and a backup that
  is one file.

### Fixed

- The README on the registry. The 0.1.0 page was published before the scoped
  name resolved, so its badges pointed at a package npm was still returning
  404 for and rendered as "package not found". npm serves the README from
  inside the tarball, frozen at publish time, so only a release can correct it.

## [0.1.0] - 2026-08-26

First release.

Published as `@thisissbk/ccledger`. The registry refused the unscoped name
as too close to an unrelated package; the command it installs is plain
`ccledger`, and nothing else about the project is scoped.

### Added

- **OTLP ingest.** `POST /v1/logs` accepts OTLP/HTTP JSON log batches from
  Claude Code, with or without gzip. Malformed bodies get 400 rather than 500,
  because exporters retry on 5xx and a 500 on a body that will never parse
  produces a retry storm from the whole team at once.
- **Idempotent storage.** Rows are keyed on `client_request_id`, falling back to
  `request_id`, falling back to a hash of the session, timestamp and token
  counts. OTLP delivery is at-least-once, so a redelivered batch has to be a
  no-op; storing one twice would silently inflate every number on the dashboard.
- **Identity attributes dropped at parse time.** `user.email`,
  `user.account_uuid`, `user.account_id` and `organization.id` never reach the
  database, and neither do the `prompt` and `response` keys. This is asserted
  by searching the SQLite file byte by byte, not by inspecting the parser.
- **Per-member tokens and join codes.** `ccledger invite <name>` issues a
  single-use code that expires in 24 hours, bundled with the endpoint into one
  paste-able invite. Tokens are stored as SHA-256 hashes and shown once.
- **`ccledger setup`.** Joins a server and writes exactly five environment keys
  into `~/.claude/settings.json`, after a timestamped backup, showing the
  disclosure and requiring a yes before anything is written. Refuses rather
  than overwriting when those keys already hold something else, and does that
  check before spending the join code.
- **`ccledger doctor`.** Six checks with a specific remedy on each failure:
  config keys, whether Claude Code has restarted, endpoint reachability, token
  acceptance, conflicting `OTEL_*` variables, and content-logging switches set
  by anything at all. `--json` for bug reports, and it never prints a token.
- **`ccledger uninstall`.** Removes only the keys its own record says it added,
  offers the backup instead, offers to tell the server so the token can be
  revoked, and leaves a key that has since been edited alone.
- **Dashboard.** Date range picker, per-member table sorted by share, stacked
  area of tokens over time, tokens by model, per-member sparklines, and a member
  detail view with sessions and installs. Costs are stored as integer micros and
  labelled `est.` everywhere. The admin token is held in memory, never in
  `localStorage`.
- **Overhead separation.** Requests Claude Code makes on its own behalf —
  `generate_session_title`, `compact` — can be shown separately from work, so a
  comparison between two people is not distorted by housekeeping.
- **Alerts.** Rules on share, tokens or estimated cost over a calendar day or
  week, evaluated on ingest, debounced to one fire per rule per member per
  window, delivered by webhook with a top-level `text` field so Slack and
  Discord accept it unmodified. Alert evaluation can never fail an ingest.
- **Laptop mode.** `ccledger serve` advertises `ccledger.local` over mDNS,
  falls back to printing LAN addresses, and refuses to guess when several
  addresses are plausible. It warns clearly that the mode is unencrypted.
- **VPS mode.** `docker/` holds a multi-stage non-root image and a compose stack
  with Caddy in front for automatic TLS. Two values in `.env` and one command.
- **`ccledger backup`.** SQLite's online backup API, safe while the server runs,
  written to a temporary file and renamed into place so an interrupted backup
  cannot leave a truncated file at the path someone will later reach for.
- **Health and version endpoints,** and `--version`.
- **CI** on ubuntu, macOS and Windows against Node 22 and 24, plus a job that
  asserts what `npm pack` would actually ship.

### Known limitations

- Attribution is honor-system. A teammate can edit their own config.
- Costs are Claude Code's own estimates, not billed amounts.
- claude.ai browser and desktop usage is not tracked, and cannot be.
- Laptop mode is plain HTTP and belongs only on a network you trust.
- Tested against Claude Code 2.1.241. Telemetry attribute names are not a
  stable API.

[unreleased]: https://github.com/shakibbinkabir/ccledger/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/shakibbinkabir/ccledger/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shakibbinkabir/ccledger/releases/tag/v0.1.0
