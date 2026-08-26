<!--
Thanks for the pull request.

One concern per PR, please. A fix and a refactor in one diff take much longer
to review and cannot be reverted independently.

If this adds content capture, a proxy, or claude.ai tracking, please read
CONTRIBUTING.md first — those will not be merged, and I would rather you knew
before spending the time than after.
-->

## What this changes

<!-- One or two sentences. Assume the reader has not seen the issue. -->

## Why

<!--
The problem, not the patch. If it fixes an issue, link it: "Fixes #12".
-->

## How it was tested

<!--
Which tests you added or changed, and what you ran by hand. For anything
touching `setup`, `uninstall`, or the settings writer, say which platform you
ran it on — those paths edit somebody's real config file.
-->

## Checklist

- [ ] The gate is green locally: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`
- [ ] New behaviour has tests; a bug fix has the test that failed without it
- [ ] Commits are conventional and scoped (`feat(server):`, `fix(cli):`, `docs:` …), one per component
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`, written for someone deciding whether to upgrade
- [ ] Exported functions have a JSDoc line; comments say why, not what
- [ ] No `any`

## Things this PR does not do

<!-- Delete any line that does not apply. Leaving the rest is the point. -->

- [ ] It does not set `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, or `OTEL_LOG_RAW_API_BODIES`
- [ ] It does not store `user.email`, `user.account_uuid`, `user.account_id`, or `organization.id`
- [ ] It does not overwrite `~/.claude/settings.json`, and still backs it up before writing
- [ ] It does not edit a migration that has already been published
- [ ] It does not make ingest non-idempotent — a redelivered batch still inserts nothing
- [ ] It does not return 5xx for a malformed ingest body

## Anything the reviewer should know

<!--
A trade-off you made, something you were unsure about, a follow-up you left
out on purpose. This section is more useful than it looks.
-->
