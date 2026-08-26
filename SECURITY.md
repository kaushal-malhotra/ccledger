# Security policy

ccledger runs an HTTP listener, issues bearer tokens, and edits a file in every
teammate's home directory. That is a real attack surface for a small tool, and
reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue.**

Two private channels, either is fine:

1. **GitHub private advisory** — the Security tab on
   [github.com/shakibbinkabir/ccledger](https://github.com/shakibbinkabir/ccledger/security/advisories/new),
   which is preferred because the discussion, the fix and the CVE all stay in
   one place.
2. **Email** — capecconsulting@gmail.com, with `ccledger security` in the
   subject line.

Useful in a report:

- What an attacker gets, and what access they need to start
- Affected version — `ccledger --version`
- Whether the server is in laptop or VPS mode
- Steps to reproduce, or a proof of concept
- `ccledger doctor --json` if the client side is involved (it masks tokens)

Do not include a real token. If one has leaked, say so and rotate it: a
teammate's token is revoked from the dashboard, and the admin token with
`ccledger serve --rotate-admin-token`.

## What to expect

|                            |                                             |
| -------------------------- | ------------------------------------------- |
| Acknowledgement            | Within 5 days                               |
| First assessment           | Within 14 days                              |
| Fix, or a plan with a date | Within 30 days for anything I can reproduce |
| Credit                     | Yes, unless you would rather not be named   |

This is a project maintained by one person in their own time. Those windows are
what I can honour, not a corporate SLA. If a deadline passes without a word
from me, chasing is welcome and not rude.

Please give me a reasonable window before disclosing publicly. If we disagree
about severity or timing, say so — I would rather have the argument than have
you sit on something.

## Supported versions

Pre-1.0, only the latest published minor gets fixes. Upgrading is
`npm install -g ccledger@latest`, or `git pull && docker compose up -d --build`
for VPS mode. Migrations run on boot and the database carries forward.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

This table changes at 1.0. Until then the config contract — which keys ccledger
writes into `~/.claude/settings.json` — may still change, and a change there is
breaking even when no function signature moved.

## Scope

**In scope**

- Authentication and authorisation: the ingest token, the admin token, join
  codes, revocation
- The OTLP ingest path, including anything a hostile payload can do
- The read API and the dashboard: injection, XSS, CSRF, token leakage
- The settings-file writer and `uninstall` — path traversal, symlink attacks,
  clobbering something that is not ours, leaving a token readable by other users
- Anything that causes ccledger to store or transmit prompt or response content
- Backup and the database file

**Out of scope**

- **Laptop mode being unencrypted.** It is plain HTTP by design, warned about
  in the banner, the README, the invite output, and `docs/install.md`. Sniffing
  a token on a network you are already on is the documented trade-off. Use VPS
  mode.
- **Attribution being forgeable.** A teammate can edit their own config, share
  their token, or turn telemetry off. Attribution is honor-system and the
  README says so. This is not an audit tool.
- **An admin seeing everyone's totals.** That is the product.
- **Vulnerabilities in Claude Code itself.** Report those to Anthropic.
- Missing hardening headers on a page with no session, rate limiting on `/health`,
  and similar findings from an automated scanner with no described impact.

## What ccledger does not have

Worth stating, because it narrows what a compromise can reach:

- It never sees or stores Claude credentials. It is not in the request path.
- It never receives prompt or response content, and cannot be configured to.
- It drops `user.email`, `user.account_uuid`, `user.account_id` and
  `organization.id` in the parser, before storage.
- Tokens are stored as SHA-256 hashes, never in plaintext.

A full compromise of a ccledger server gets an attacker token counts, model
names, timestamps, session ids, and the display names and machine names people
gave at join. That is the whole blast radius, and it is deliberately small.
