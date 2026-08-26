# Contributing to ccledger

Thanks for looking. This file says how to get the tests running, what a good
pull request looks like here, and — the part worth reading first — what will
not be merged, so you do not spend an evening on something that was never going
to land.

## What will not be merged

**Content capture, in any form.** Claude Code can export prompts, responses,
tool details, tool content and raw API bodies. Five environment variables turn
those on. ccledger will never set any of them: not by default, not behind a
flag, not opt-in, not in a test, and not as a suggestion in the docs.

This is not a default anyone can flip. The argument in the README — that this
is a fair way to divide a shared bill and not surveillance — stops being true
the moment ccledger can capture what people typed. A pull request adding it
will be closed with a link to this paragraph.

**Anything that puts ccledger in the request path.** No proxying, no wrapping
the Claude Code binary, no credential handling. ccledger is a passive consumer
of telemetry Claude Code already exports. If it can break Claude Code by being
down, the design is wrong.

**claude.ai browser or desktop tracking.** It is asked for regularly and it is
not possible without intercepting credentials. There is no version of this that
is in scope.

**Storing the identity attributes.** `user.email`, `user.account_uuid`,
`user.account_id` and `organization.id` are dropped in the parser. They are
identical across a shared account, so they buy nothing, and dropping them is
what makes `docs/privacy.md` true by construction.

Everything else is open. Bugs, platform fixes, better queries, better charts,
new `doctor` checks, docs.

## What is most useful right now

- **Claude Code compatibility reports.** Telemetry attribute names are not a
  stable API. If a new Claude Code release makes the numbers stop growing, that
  is a real bug and knowing about it quickly matters.
- **Cross-platform fixes for the settings writer.** `src/cli/settings.ts` edits
  a file in someone's home directory on four platforms. That is where the
  genuinely nasty bugs live.
- **`doctor` checks.** Every check that resolves a problem without a human is
  an issue thread that never happens.
- **Docs.** Especially if you hit something confusing during install; the place
  you hesitated is the bug.

## Setup

Node 22 or newer. `better-sqlite3` requires it, and on Node 20 the native addon
crashes the process on the first database open.

```console
$ git clone https://github.com/shakibbinkabir/ccledger.git
$ cd ccledger
$ npm install

added 309 packages in 24s

$ npm test

 Test Files  53 passed (53)
      Tests  983 passed | 1 skipped (984)
   Duration  16.66s
```

That is clone to green tests in three commands.

## Commands

| Command                  | What it does                                             |
| ------------------------ | -------------------------------------------------------- |
| `npm test`               | Vitest, once                                             |
| `npm run test:watch`     | Vitest, watching                                         |
| `npm run lint`           | ESLint                                                   |
| `npm run typecheck`      | `tsc --noEmit` over `src/` and `test/`, then over `web/` |
| `npm run format`         | Prettier, writing                                        |
| `npm run format:check`   | Prettier, checking — this is what CI runs                |
| `npm run build`          | Dashboard into `src/server/public`, then `dist/`         |
| `npm run verify:package` | Asserts what `npm pack` would ship                       |
| `npm run dev`            | Build, then `serve`                                      |
| `npm run dev:web`        | Vite dev server for the dashboard alone                  |

## Running it while you work

```console
$ npm run build
$ node dist/cli/index.js serve --db /tmp/dev.db

ccledger 0.1.0 · laptop mode · listening on http://localhost:4318
...
  Dashboard   http://localhost:4318/#token=cca_…
```

To exercise ingest without a Claude Code install, post a fixture at it. You
need a member token first, so issue an invite and join:

```console
$ node dist/cli/index.js invite dev --db /tmp/dev.db
...
  npx @thisissbk/ccledger setup --code eyJ2Ijox…

$ curl -s -X POST http://localhost:4318/v1/logs \
    -H "Authorization: Bearer ccm_…" \
    -H "Content-Type: application/json" \
    --data-binary @test/fixtures/001.json
{"partialSuccess":{}}
```

Send it twice. The row count must not change — that is the idempotency
guarantee, and it is easy to break.

For the dashboard, `npm run dev:web` gives you HMR against a `serve` running
separately.

## Conventions

- **Strict TypeScript. No `any` in committed code.** The config enforces it and
  so does the linter.
- **Every exported function has a JSDoc line.** Not a paragraph, a line saying
  what it does.
- **Comments say why, not what.** The diff already says what. The existing
  comments are the house style: they explain the decision, and usually what
  goes wrong without it.
- **Tests colocated** as `*.test.ts` beside the code they cover. Integration
  tests that need a real server and a real database go in `test/`.
- **LF line endings.** Pinned by `.gitattributes`, Prettier is
  `endOfLine: "lf"`, and CI has a Windows leg. A CRLF checkout fails
  `format:check` before it runs a test.
- **`src/cli/` may import `src/server/`, never the reverse.** Shared things go
  in `src/shared/`.

## Commits

Conventional commits, scoped to the layout: `db`, `server`, `cli`, `web`,
`shared`, plus unscoped `chore`, `test`, `docs`, `ci`.

```
feat(server): reject a batch whose resource block has no service.name

Claude Code has always sent it, but a batch without it comes through the
parser as an install with a null version, which is indistinguishable from
a Claude Code too old to report one. Rejecting is worse than useless data
here; this counts it instead and leaves the row out.
```

The subject is imperative and under about 72 characters. The body says why. One
commit per component, not one per build stage — if a change touches the parser
and the schema, that is two commits.

## Pull requests

**One concern per PR.** A bug fix and a refactor in the same diff take four
times as long to review and cannot be reverted independently.

**Tests for new behaviour.** A bug fix comes with the test that fails without
it. If it genuinely cannot be tested, say so in the description and why.

**The gate has to be green before you push:**

```console
$ npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
```

CI runs the same five on ubuntu, macOS and Windows against Node 22 and 24, plus
`verify:package` on the tarball. Windows is not optional here — ccledger writes
to a home-directory path and edits JSON files, which is exactly where
cross-platform bugs live.

**Update the changelog** in the same PR, under `## [Unreleased]`, in
[CHANGELOG.md](CHANGELOG.md). Write it for someone deciding whether to upgrade,
not for someone reading the diff.

**Say what you tested by hand.** For anything touching `setup`, `uninstall`, or
the settings writer, say which platform you ran it on. Those paths edit
somebody's real config file.

## Touching the settings writer

Special care, because it is the one place ccledger writes outside its own
directory.

- Never overwrite. Read, parse, merge, write.
- Always back up first, timestamped, beside the original.
- A file that will not parse aborts the command and changes nothing.
- Only ever touch the five keys ccledger owns; preserve everything else,
  including key order and formatting as far as practical.
- `uninstall` removes only what `~/.ccledger/state.json` records as added, and
  leaves a key that has since been edited alone.

The tests for this run against a temporary home directory. Keep it that way —
no test may be able to reach a real `~/.claude/settings.json`.

## Migrations

Forward-only, appended to `MIGRATIONS` in `src/db/migrate.ts`. Published
versions are immutable: a released migration is on other people's disks, so
changing one is not a change, it is a divergence. Add a new one.

New columns should be nullable or have a default. A `NOT NULL` column with no
default cannot be added to a table that already has rows.

## Fixtures

`test/fixtures/` holds two real OTLP captures from Claude Code 2.1.241, byte
for byte except for four identity values replaced with sentinels. They are in
`.prettierignore` and marked `-text` in `.gitattributes` because the parser
tests compare against them exactly.

If you capture new ones, sanitise the same four attributes, record the
substitutions in `test/fixtures/README.md`, and never commit anything to
`captures/` — that directory is gitignored because the raw payloads carry a
real email address and account identifiers.

## Reporting bugs

Use the [issue templates](https://github.com/shakibbinkabir/ccledger/issues/new/choose).
`ccledger doctor --json` is a required field on the bug form and it resolves
most reports on its own; it never contains a token.

Security problems do not go in the issue tracker. See [SECURITY.md](SECURITY.md).

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing

ccledger is MIT. Contributions are accepted under the same licence. There is no
CLA.
