# Why is there no data?

Run `ccledger doctor` first. It runs six checks in the order that answers this
question fastest, and every failure prints its own remedy.

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

It exits non-zero if any check failed, so it works in a script. `--json` prints
the whole report as machine-readable output, and it is the first field in the
bug report template:

```console
$ ccledger doctor --json
{
  "ok": true,
  "version": "0.1.0",
  "settingsPath": "/home/alice/.claude/settings.json",
  "checks": [
    {
      "id": "config",
      "title": "config keys",
      "status": "pass",
      "detail": "all five keys are in /home/alice/.claude/settings.json"
    },
    ...
  ],
  "endpoint": "http://ccledger.local:4318"
}
```

The report never contains a token. Values that look like one are masked before
they are printed, so `--json` output is safe to paste into a public issue.

---

## Check 1 — config keys

**Asks:** are ccledger's five keys in `~/.claude/settings.json`, and do they
say what they should?

### The file does not exist

```
FAIL  config keys       /home/alice/.claude/settings.json does not exist
                        Run `ccledger setup --code <invite>` with the invite your admin sent
                        you.
```

You have not run setup on this machine, or you ran it as a different user.
Claude Code creates that file itself once it has any settings, so an absent
file usually means an untouched install. Ask your admin for an invite and see
[setup.md](setup.md).

### None of the five are there

```
FAIL  config keys       none of ccledger's five keys are in /home/alice/.claude/settings.json
                        Run `ccledger setup --code <invite>` with the invite your admin sent
                        you.
```

Same remedy. If you are sure you ran setup, check you are looking at the same
home directory — `sudo`, a different shell user, or WSL against Windows will
each give you a different `~`. The path in the message is the one that was
examined.

### Some of them are there

```
FAIL  config keys       2 of five keys are missing: OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, OTEL_EXPORTER_OTLP_LOGS_HEADERS
                        The config is half written. Run `ccledger uninstall` and then `ccledger setup` again.
```

Something edited the file after setup — a merge, a sync tool, or a hand edit.
A half-written config exports nothing. Remove and redo.

### They are there but wrong

```
FAIL  config keys       CLAUDE_CODE_ENABLE_TELEMETRY is off; OTEL_LOGS_EXPORTER is not otlp
                        Run `ccledger uninstall` and then `ccledger setup` again to rewrite the five keys.
```

The keys exist with values that switch the exporter off or point it at another
protocol. Rewrite them.

### The file will not parse

```
FAIL  config keys       /home/alice/.claude/settings.json is not valid JSON (Expected double-quoted property name in JSON at position 21 (line 3 column 1)). ccledger has changed nothing. Fix or move the file, then run this again.
                        ccledger will not edit a settings file it cannot parse. Fix the JSON,
                        then run this again.
```

ccledger refuses to touch a settings file it cannot read, on the way in and on
the way out. A trailing comma is the usual cause. Fix it in an editor that
shows you JSON errors, or restore one of the `settings.json.ccledger-backup-*`
files sitting beside it.

---

## Check 2 — restart

**Asks:** has Claude Code started since the config was written?

This is the answer most of the time. Read it first when something is wrong.

```
FAIL  restart           the config is 10 hours newer than anything Claude Code has written, so it has almost certainly not been read yet
                        RESTART CLAUDE CODE. This is the answer nearly every time: telemetry
                        configuration is read once, when Claude Code starts, so an open session
                        keeps reporting nothing.
```

Telemetry configuration is read once, at startup. A Claude Code session that
was already open when setup ran has a perfect config and will keep exporting
nothing until it restarts.

**Quit Claude Code completely and start it again.** In an IDE that means
reloading the window or restarting the extension host — closing the panel is
not enough. Then use it for a minute and run `doctor` again.

The evidence is indirect and worth knowing about: the check compares the
config's modification time against the newest file under `~/.claude/projects`.
That says Claude Code has _written_ since then, not that it _started_ since
then, so a session that was already open and kept working can make this check
pass without a restart having happened. If it passes and you still have no
data, restart anyway before looking further.

```
SKIP  restart           nothing has been written under /home/alice/.claude/projects to compare against
```

A skip means Claude Code has never written a transcript on this machine, so
there is nothing to compare. Use Claude Code once, then re-run.

---

## Check 3 — endpoint

**Asks:** does the server answer `GET /health` within five seconds?

```
FAIL  endpoint          http://ccledger.local:4318/health did not answer within 5000 ms
                        Check the server is running and that this machine can reach it. On a laptop
                        server both machines have to be on the same network, and the name in the
                        endpoint has to resolve from here.
```

In order of likelihood:

1. **The server is not running.** `ccledger serve` runs in the foreground and
   dies with its terminal. Ask whoever runs it.
2. **A firewall on the server machine.** Windows prompts once for
   private-network access and denies it forever if that prompt was dismissed.
   Check inbound TCP on the port, usually 4318.
3. **`ccledger.local` does not resolve from here.** mDNS is not universal —
   some corporate networks and most VPNs block multicast. Test it directly:

   ```console
   $ curl -sS http://ccledger.local:4318/health
   curl: (6) Could not resolve host: ccledger.local

   $ curl -sS http://192.168.1.24:4318/health
   {"status":"ok","version":"0.1.0","uptimeSeconds":8134}
   ```

   If the IP works and the name does not, ask your admin to reissue invites
   with `ccledger serve --public-url http://192.168.1.24:4318`.

4. **You are on a different network.** Laptop mode only works on the LAN. If
   people work remotely, the answer is VPS mode; see
   [install.md](install.md#vps-mode).

```
FAIL  endpoint          http://ccledger.example.com/health answered 502
                        Something is answering at that address but it is not a healthy ccledger
                        server. Check the URL, and any proxy in front of it.
```

502 or 504 from a VPS deployment means Caddy is up and the ccledger container
is not. On the server: `docker compose ps` and `docker compose logs ccledger`.

---

## Check 4 — token

**Asks:** does the server accept this machine's token? It posts an empty but
valid OTLP envelope, which stores nothing.

```
FAIL  token             the server does not recognise this token
                        The token is unknown to that server — it may have been rebuilt from an
                        empty database. Ask your admin for a new invite, then run `ccledger
                        uninstall` and set up again.
```

A 401 means the server has no member with that token hash. Almost always the
database was replaced — moved machines, a fresh `--db` path, a container
without a volume. Everyone re-joins.

```
FAIL  token             this token has been revoked
                        Your admin revoked this token. Ask them for a new invite, then run
                        `ccledger uninstall` and set up again.
```

A 403 is deliberate: someone revoked you, or you ran `ccledger uninstall`
somewhere and told the server. Ask for a new invite.

---

## Check 5 — environment

**Asks:** is anything in this shell overriding the settings file?

```
FAIL  environment       OTEL_EXPORTER_OTLP_ENDPOINT is set in this shell to http://otel-collector.internal:4318
                        Remove these from your shell profile, or make them match the config. A
                        variable in the environment can take precedence over the settings file,
                        and this check only sees the shell doctor was run from — the one Claude
                        Code starts in may differ.
```

Generic `OTEL_EXPORTER_OTLP_*` variables apply to logs whenever the
logs-specific variable is unset, so one left in a shell profile is a live way
for your telemetry to go somewhere other than where you think. `OTEL_SDK_DISABLED`
turns the exporter off entirely and is reported the same way.

Find them:

```console
$ env | grep -i '^OTEL'
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.internal:4318
```

PowerShell:

```powershell
PS> Get-ChildItem Env: | Where-Object Name -like "OTEL*"

Name                           Value
----                           -----
OTEL_EXPORTER_OTLP_ENDPOINT    http://otel-collector.internal:4318
```

Then remove them from `.bashrc`, `.zshrc`, your PowerShell profile, or whatever
set them, and restart both the shell and Claude Code.

The caveat in the remedy is the important part: this check sees only the shell
you ran `doctor` in. Claude Code launched from an IDE, a desktop launcher, or a
different profile may have a different environment. If this passes and nothing
arrives, that gap is the place to look.

---

## Check 6 — content logging

**Asks:** is anything, anywhere, exporting prompt or response content?

```
FAIL  content logging   OTEL_LOG_USER_PROMPTS=1 in this shell — prompt or response content may be leaving this machine
                        ccledger never sets these and does not want the data. Something else
                        turned them on. Unset them unless you know exactly where that content is
                        going.
```

This one is not about ccledger working. It is about your machine.

ccledger never sets these five variables and never will — see
[privacy.md](privacy.md). If one is on, something else turned it on, and
whatever collector is receiving those logs is receiving your prompts. Find it
and unset it before you worry about anything else on this page.

It checks the settings file and the shell environment, so it catches a key
written by another tool as well as one exported in a profile.

---

## Doctor passes and there is still nothing

In this order:

**1. Has any Claude Code work happened since the restart?** Nothing is exported
until a request is made. Ask something, wait a few seconds.

**2. Is the admin looking at the right date range?** The dashboard opens on the
last seven days by default. Check "Today", and check the server's clock — if
the server's time is badly wrong, rows land outside every range.

**3. Is the admin looking at the right database?** `ccledger serve` defaults to
`./ccledger.db` in the current directory. Started from a different directory,
it creates a second, empty one. The banner prints the absolute path it opened:

```
  database    /home/you/ccledger.db
```

**4. Is anything arriving at all?** On the server, watch the log while a
teammate works:

```console
$ CCLEDGER_LOG_LEVEL=debug ccledger serve
```

Requests to `/v1/logs` appear as they land. If they arrive and no rows appear,
that is a parser problem worth an issue — include the Claude Code version from
`claude --version`.

**5. Does the row count move?** Directly, with the file:

```console
$ sqlite3 ccledger.db "SELECT COUNT(*), MAX(datetime(ts/1000,'unixepoch')) FROM requests"
1334|2026-08-26 09:41:12
```

---

## Other things that go wrong

### "port 4318 is already in use"

```console
$ ccledger serve
ccledger: port 4318 is already in use; pass --port to choose another
```

Another `ccledger serve`, or another OTLP collector. Use `--port`, and reissue
invites, since the port is part of the endpoint.

### Setup refuses because keys already exist

Covered in [setup.md](setup.md#if-setup-refuses). The check runs before the
join code is spent, so the invite is still usable afterwards.

### The dashboard says the bundle is missing

You are running from a source checkout that has never built the dashboard.
`npm run build` builds both halves. An installed package always ships it.

### The admin token is lost

```console
$ ccledger serve --rotate-admin-token
```

Prints a new one and invalidates the old. Member tokens are unaffected —
nobody has to re-join.

### Numbers stopped growing after a Claude Code update

That is the failure worth reporting. Claude Code's telemetry attribute names
are not a stable API, and if a release renames something ccledger reads, the
parser ignores what it does not recognise and the totals quietly flatten.

Confirm traffic is still arriving (`CCLEDGER_LOG_LEVEL=debug`), then open an
issue with your Claude Code version. This is the one case where the bug is
almost certainly ours.

---

## Filing a bug

Include `ccledger doctor --json` — it is a required field in the template and
it resolves most reports on its own. Also useful:

- `ccledger --version` and `claude --version`
- Your OS, and whether you are on WSL
- Laptop or VPS mode
- Whether the server and client are on the same machine

Bug reports: <https://github.com/shakibbinkabir/ccledger/issues>. Security
problems go to [SECURITY.md](../SECURITY.md) instead, never the issue tracker.
