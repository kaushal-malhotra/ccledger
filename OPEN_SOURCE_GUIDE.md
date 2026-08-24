# Releasing ccledger as a Proper Open Source Project

For `github.com/shakibbinkabir/ccledger`.

Most small OSS projects fail on the same three things: nobody can tell what it does in ten seconds, nobody can run it in ten minutes, and nobody knows what the maintainer will and won't accept. Everything below is aimed at those three.

---

## 1. The name

`ccledger`. Free on npm as of this draft. Two things still to do before the first push: confirm `github.com/shakibbinkabir/ccledger` is clear, and search the `claude-code` and `token-counter` GitHub topic tags. That second check is the one that matters — the previous candidate died because a same-niche project held the name on GitHub while npm looked clear. npm availability alone is not a name check.

Why this name holds up:

**No "Claude" in it.** Trademark policies generally permit referential use ("for Claude Code") but not names implying endorsement. `cc-` is an established community abbreviation that claims nothing. Put the association in the tagline instead: *"Team usage ledger for Claude Code."*

**"Ledger" frames it as accounting, not surveillance.** This matters more than it sounds. People are installing this because a manager asked them to, and the *meter / watch / track / monitor* family of words frames the tool as watching a person rather than fairly dividing a shared resource. Same software, different reception in the team Slack. Keep this in mind for feature names too — call it "share of pool," not "usage monitoring."

**Say you're unaffiliated, prominently.** Not in a footer — near the top of the README:

> ccledger is an independent open source project. It is not affiliated with, endorsed by, or sponsored by Anthropic.

Reserve the npm name early with a stub publish if you're worried about losing it during the build.

## 2. License

**MIT** unless you have a reason otherwise. It's what developer tooling in this space uses, it's short, and nobody has to ask their legal team.

**Apache-2.0** if you want an explicit patent grant and a contributor patent clause. Slightly heavier, more common in projects courting corporate contributors.

Pick one, put the full text in `LICENSE`, put your name and the year in it, and add an SPDX line to `package.json`. Do this in the first commit. Retroactively relicensing after other people have contributed means chasing everyone for permission.

## 3. Repository layout

```
ccledger/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug.yml
│   │   ├── feature.yml
│   │   └── config.yml
│   ├── workflows/
│   │   ├── ci.yml
│   │   └── release.yml
│   ├── pull_request_template.md
│   └── FUNDING.yml
├── docs/
│   ├── install.md
│   ├── setup.md
│   ├── privacy.md
│   ├── troubleshoot.md
│   └── architecture.md
├── docker/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── .env.example
├── src/
├── web/
├── test/
├── .gitattributes
├── .gitignore
├── CHANGELOG.md
├── CLAUDE.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
└── SECURITY.md
```

The repository exists from stage 1, not from stage 7 when CI arrives — `BUILD_STAGES.md` has the commit conventions and the per-stage breakdown. Two files in that tree are easy to leave until too late:

`.gitattributes` pins `* text=auto eol=lf`. You develop on Windows with `core.autocrlf` true, Prettier is `endOfLine: "lf"`, and the CI matrix below has a Windows leg — without it a clean clone fails the format check before it runs a test.

`.gitignore` excludes `captures/`, the raw OTLP payloads from stage 0. They contain the capturing account's real email address, `organization.id`, and account identifiers. A project whose pitch is "we never collect your PII" cannot ship a fixture directory containing the author's. Commit sanitised copies under `test/fixtures/` and record the substitutions in a README beside them.

## 4. README structure

The README is the product. Someone gives you thirty seconds.

```markdown
# ccledger

Team usage dashboard for Claude Code. See who's using how many tokens.

[badges: ci, npm version, license, node version]

![dashboard](docs/images/dashboard.png)

ccledger is an independent open source project, not affiliated with or
endorsed by Anthropic.

---

## What it does

Claude Code emits OpenTelemetry data. ccledger collects it from everyone on
your team and shows per-person token usage, model breakdown, and trends.

Built for teams of 2–10 who share Claude Code access and can't see who's
using what. Anthropic's per-user analytics is Enterprise-only; this fills
the gap for everyone else.

## ccledger vs ccusage / CCMeter

Those read your local session logs and show you your own usage on one
machine. Excellent for that. ccledger is the team version: every machine
reports to one server, so you get per-person attribution across the whole
team. If you just want to see your own numbers, use ccusage or CCMeter —
they're simpler and they don't need a server.

## Quick start

[server: three lines]
[teammate: two lines]

## What it is not

- Not a proxy. ccledger never sits between Claude Code and Anthropic, and
  never reads, stores, or relays your credentials.
- Not content capture. No prompts, no responses, no file paths, no commands.
  See docs/privacy.md.
- Not an audit tool. Attribution is honor-system — anyone can edit their
  own config. Fine for splitting a bill; don't use it for compliance.
- Not real billing. Costs are Claude Code's own estimates. On a subscription
  they're notional API-equivalent prices, not money anyone spent.
- Does not track claude.ai browser or desktop usage. CLI only.

## How it works
[the ASCII diagram, four sentences]

## Requirements
[Node version, Claude Code versions tested, OS support table]

## Documentation
[links]

## Contributing
[link + one sentence on what you're looking for]

## License
MIT
```

Put the limitations in the README, not buried in `docs/`. Being upfront about what a tool doesn't do is the single strongest trust signal a small project has, and it filters out the issues you don't want.

## 5. The screenshot matters more than you think

Take it seriously. Seed realistic data — plausible names, a week of varied usage, one person clearly ahead. Not `test1`, `test2`, `asdf`. Light mode, 1440px, cropped tight. This image is the entire pitch for most visitors.

Second image: the terminal output of `ccledger setup` finishing successfully. That's the "oh, that's actually easy" moment.

## 6. Docs that answer real questions

Five files. Keep each one focused.

| File | Answers |
|---|---|
| `install.md` | How do I run the server? Both modes, every command, expected output shown |
| `setup.md` | I'm a teammate, what do I do? Two minutes, with the disclosure explained |
| `privacy.md` | What is this sending about me? Table of sent vs not-sent |
| `troubleshoot.md` | Why is there no data? The six `doctor` checks with remedies |
| `architecture.md` | I want to contribute. Data flow, schema, where things live |

Write `privacy.md` as though a skeptical teammate is reading it, because one will be. A two-column table of "sent" and "not sent" beats three paragraphs of reassurance.

Every command block shows its output. `npm install -g ccledger` followed by nothing tells the reader nothing about whether it worked.

## 7. Contributor files

**CONTRIBUTING.md** — clone-to-running-tests in under ten commands. State your PR expectations: tests for new behaviour, conventional commits, one concern per PR. Say plainly what you will and won't merge. "Content capture features will not be merged under any circumstances" belongs here, because someone will propose it.

**CODE_OF_CONDUCT.md** — Contributor Covenant 2.1, verbatim, with a real contact address.

**SECURITY.md** — a private email or GitHub's private advisory feature, a response time you can actually honour, and which versions get fixes. ccledger handles bearer tokens and runs an HTTP listener; treat this as real.

**Issue templates as YAML forms**, not markdown. Forms let you make `ccledger doctor --json` output a required field, which will resolve most bug reports before you read them.

## 8. CI

`ci.yml` on push and PR: install, lint, typecheck, test, build. Matrix across ubuntu / macos / windows and Node 20 / 22. Windows is not optional — you're writing to a home-directory path and manipulating JSON files, which is precisely where cross-platform bugs live.

`release.yml` on tag: build, `npm publish --provenance`, create a GitHub Release. Provenance is a free supply-chain signal; turn it on from the first publish.

Branch protection on `main`: require CI, require one review even if it's your own on a second pass.

## 9. Versioning and changelog

Semver, honestly applied. Pre-1.0 while the config contract might change — you're writing keys into other people's `~/.claude/settings.json`, and changing which keys you own is a breaking change even if no API signature moved.

`CHANGELOG.md` in Keep a Changelog format, updated in the same PR as the change. Either adopt Changesets or write entries by hand, but don't generate it from commit messages — nobody reads "fix: fix".

Tag `v0.1.0` when stage 7 passes. Don't wait for perfect.

## 10. Launch

Order matters. Ship, then tell people, and give it a week between the two so the first wave doesn't hit a broken install path.

Before announcing, have someone who isn't you install it from scratch on a machine you've never touched, following only the README. Watch them without helping. Every place they hesitate is a docs bug.

Where to post: the Claude Code and self-hosted communities on Reddit, Hacker News Show HN, and the `awesome-claude-code` list. Lead with the problem, not the tech — "Anthropic's per-user usage analytics is Enterprise-only, so I built the small version" is a better opening than "an OTLP collector for Claude Code."

Answer every issue in the first month, even the bad ones. Early responsiveness is what decides whether a project gets a second contributor.

## 11. Things that will bite you

**Claude Code changes.** Attribute names and event schemas evolve. Keep a "tested with Claude Code v2.1.x" line in the README, parse defensively, and add a `doctor` check that flags when zero `api_request` events have parsed successfully despite traffic arriving — that's your early warning that a schema moved.

**Someone will ask for prompt logging.** The capability exists in Claude Code; people will find the flags and ask you to expose them. Decide now, write it in CONTRIBUTING.md, and don't relitigate it per-issue. Once ccledger can capture prompts it becomes surveillance software and the trust argument in your README stops being true.

**Someone will ask for claude.ai tracking.** It isn't possible without credential interception. Have a canned, friendly answer with the reason.

**Support load is doctor-shaped.** Almost every "not working" report will be a missing restart. Make `doctor` output a required field in the bug template and most of them close themselves.

## 12. Pre-launch checklist

- [x] Name free on npm (`ccledger`)
- [ ] Name checked on GitHub and against the `claude-code` topic tag
- [x] Repo initialised on `main`, LF pinned by `.gitattributes`
- [x] `captures/` gitignored; only sanitised fixtures committed
- [ ] npm name reserved with a stub publish
- [ ] LICENSE with your name, SPDX in package.json
- [ ] Unaffiliated-with-Anthropic notice near the top of the README
- [ ] Dashboard screenshot with realistic seeded data
- [ ] Setup terminal screenshot
- [ ] Limitations stated in the README, not only in docs
- [ ] All five docs written, every command block showing output
- [ ] CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and PR templates
- [ ] CI green on all three OSes
- [ ] `npm pack --dry-run` ships only what it should
- [ ] Clean-machine install test by someone else, unassisted
- [ ] Uninstall verified to restore `~/.claude/settings.json` exactly
- [ ] SECURITY.md contact address is one you actually read
- [ ] v0.1.0 tagged and published with provenance