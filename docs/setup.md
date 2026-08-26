# Joining a ccledger server

For the teammate who was sent an invite. Two minutes, one command, one restart.

Before you run anything, it is worth knowing what this does, because you are
being asked to install it and you are entitled to an answer.

**What it sends.** For each API call Claude Code makes: the model name, token
counts, how long it took, a timestamp, and a session id.

**What it does not send.** Your prompts. Claude's responses. File contents.
File paths. Command text. Repository names. Your email address. None of that
leaves your machine, and it is not that ccledger chooses to discard it — the
switches in Claude Code that would export any of it are off, and ccledger never
turns them on. The full list is in [privacy.md](privacy.md).

**What it changes on your machine.** Five keys under `env` in
`~/.claude/settings.json`, after backing that file up. Nothing else. It is not
a proxy, it does not touch your Claude login, and Claude Code keeps working
exactly the same when the ccledger server is unreachable.

**How to undo it.** `npx @thisissbk/ccledger uninstall`, any time, no permission needed.

---

## 1. Run the line you were sent

It looks like this. The long string is the invite; it bundles the server
address and a single-use join code.

```console
$ npx @thisissbk/ccledger setup --code eyJ2IjoxLCJlbmRwb2ludCI6Imh0dHA6Ly9jY2xlZGdlci5sb2NhbDo0MzE4Iiwi…
```

You need Node 22 or newer:

```console
$ node --version
v22.14.0
```

`npx` downloads ccledger, runs it once, and does not install it. If you would
rather have the command permanently — worth it, because `ccledger doctor` is
the thing you will want later — use `npm install -g @thisissbk/ccledger` and drop the
`npx`.

## 2. Read the disclosure and say yes

Nothing is written before you answer. This is the whole run:

![ccledger setup: the disclosure, the confirmation prompt, the four paths it wrote, and the restart notice](images/setup.png)

```console
$ npx @thisissbk/ccledger setup --code eyJ2IjoxLCJlbmRwb2ludCI6Imh0dHA6Ly9jY2xlZGdlci5sb2NhbDo0MzE4Iiwi…

ccledger will send, per API request:
  model name, token counts, duration, timestamp, session id

It will NOT send:
  prompts, responses, file contents, file paths,
  command text, or repository names

Config written to: ~/.claude/settings.json
Remove any time with: npx @thisissbk/ccledger uninstall

On this machine that file is: /home/alice/.claude/settings.json
Joining also tells the server this machine name and operating system, once.

Send this to http://ccledger.local:4318? [y/N] y

Joined acme as Alice Chen.

  config      /home/alice/.claude/settings.json
  backup      /home/alice/.claude/settings.json.ccledger-backup-1787724689
  ingest      http://ccledger.local:4318/v1/logs
  record      /home/alice/.ccledger/state.json

  Five keys were added under "env". Nothing else in that file was touched.
  Checked: the server accepted a test batch from this machine.

  ──────────────────────────────────────────────────────────────────
   RESTART CLAUDE CODE for any of this to take effect.
   Telemetry configuration is read once, when Claude Code starts, so a
   session that is already open will keep reporting nothing.
  ──────────────────────────────────────────────────────────────────
```

Answering anything but yes stops the run and changes nothing.

If you want a different display name than the one in the invite, it asks — or
pass `--name "Your Name"`. On the dashboard your name is what identifies you;
your email address is never involved.

The `Checked:` line means setup posted an empty batch with your new token and
the server accepted it. That is the whole round trip proven before you restart
anything.

## 3. Restart Claude Code

This is the step people skip, and skipping it produces exactly the symptom you
would expect from a broken install: perfect config, no data. Claude Code reads
telemetry configuration once, when it starts. A session that is already open
will keep reporting nothing forever.

Quit Claude Code completely and start it again. In an IDE, that means reloading
the window or restarting the extension host, not just closing the panel.

## 4. Check it worked

```console
$ ccledger doctor

ccledger doctor 0.1.0

  PASS  config keys       all five keys are in /home/alice/.claude/settings.json
  PASS  restart           Claude Code has written a session since the config was last changed
  PASS  endpoint          http://ccledger.local:4318/health answered in 35 ms
  PASS  token             the server accepted an empty batch from this machine
  PASS  environment       no OTEL variable in this shell contradicts the config
  PASS  content logging   no content-capture variable is on

  6 passed, 0 failed, 0 skipped · reporting to http://ccledger.local:4318
```

Six passes and you are done. Anything else is covered check by check in
[troubleshoot.md](troubleshoot.md), and every failure prints its own remedy.

Use Claude Code for a few minutes, then ask your admin whether you have shown
up. There is no client-side buffer worth worrying about — batches are exported
as work happens.

---

## What was written

Exactly five keys, under `env`, in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://ccledger.local:4318/v1/logs",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS": "Authorization=Bearer ccm_aJlGTdOJY0tJFEeYUC3hgb9rYm1r9AF9"
  }
}
```

The last one is your token. It identifies you to the server and nothing else —
it is not a Claude credential and it grants no access to Claude, only the
ability to report usage as you.

Note what is not there: no `OTEL_RESOURCE_ATTRIBUTES`, no metrics exporter, no
generic `OTEL_EXPORTER_OTLP_*` keys that would redirect traces or metrics, and
none of the five content-logging switches.

Everything else in that file — your permissions, hooks, model choice,
statusline — is untouched. If you had no `env` block, one is added; if you had
one, the five keys are merged into it.

A timestamped backup is taken before the write:

```console
$ ls ~/.claude/settings.json*
/home/alice/.claude/settings.json
/home/alice/.claude/settings.json.ccledger-backup-1787724689
```

## If setup refuses

It stops rather than overwriting when those keys already hold something else:

```console
$ npx @thisissbk/ccledger setup --code eyJ2IjoxLCJlbmRwb2ludCI6…

These keys are already set in /home/alice/.claude/settings.json:

  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
      is       http://otel-collector.internal:4318/v1/logs
      would be http://ccledger.local:4318/v1/logs

Something other than ccledger is using these keys — another OTLP collector, most
likely. ccledger will not overwrite them. Remove or rename them if you want
ccledger to take over, or point that collector somewhere else.

ccledger: nothing was changed
```

This check runs before the join code is spent, so your invite is still good
once you have sorted the conflict out.

If the existing keys are ccledger's own — you are already set up and pointing
somewhere else — it says so and tells you to run `ccledger uninstall` first.

## Removing it

```console
$ npx @thisissbk/ccledger uninstall

These keys will be removed from /home/alice/.claude/settings.json:

  CLAUDE_CODE_ENABLE_TELEMETRY
  OTEL_LOGS_EXPORTER
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  OTEL_EXPORTER_OTLP_LOGS_HEADERS

Remove them? [Y/n] y
Put the backup at /home/alice/.claude/settings.json.ccledger-backup-1787724689 back instead, undoing anything else changed since? [y/N] n
Removed 5 keys from /home/alice/.claude/settings.json.
  A copy of the previous file is at /home/alice/.claude/settings.json.ccledger-backup-1787724910.
Tell the server, so it can revoke the token? [Y/n] y
  The server has revoked this token.
Removed /home/alice/.ccledger.

Restart Claude Code to stop it exporting; it reads this configuration once, at startup.
```

Three things are offered, not assumed. It removes only the keys its own record
says it added, and leaves a key you have since edited alone. Telling the server
is optional — say no and it prints your member id so your admin can revoke it
by hand. `--yes` takes every default; `--no-notify` keeps it to your machine.

Restart Claude Code afterwards for the same reason as before.

## Questions your admin cannot answer for you

**Can they see what I am working on?** No. Repository names, file paths, and
command text are not in what is sent. A session id is, which lets the dashboard
count distinct sessions; it is a random id, not a name.

**Can they see my prompts?** No, and `ccledger doctor` check 6 exists so that
you can verify it rather than take anyone's word — it fails loudly if any
content-capture variable is set anywhere on your machine, whoever set it.

**Can I turn it off?** Yes. Run `ccledger uninstall`, or delete the five keys
yourself. Attribution here is honor-system by design; it exists to divide a
shared bill fairly, not to keep you honest.

**Does it slow Claude Code down?** The exporter batches in the background. If
the ccledger server is down, the export fails and Claude Code carries on.
