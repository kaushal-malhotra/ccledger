# What ccledger sends, and what it does not

Written for the teammate who was asked to install this and would like to check
rather than be reassured. Everything below is verifiable from the source or
from your own machine, and this page says how.

## The short version

ccledger sends counters about API calls. It does not send anything you wrote,
anything Claude wrote back, or anything about what you were working on.

## Per API request

| Sent and stored                          | Not sent                                      |
| ---------------------------------------- | --------------------------------------------- |
| Model name (`claude-sonnet-5`)           | Your prompt                                   |
| Input tokens                             | Claude's response                             |
| Output tokens                            | System prompt or context                      |
| Cache-read tokens                        | File contents                                 |
| Cache-creation tokens                    | File paths                                    |
| Estimated cost, in integer micro-dollars | Directory or repository names                 |
| Duration in milliseconds                 | Command text or tool arguments                |
| Timestamp                                | Tool names or results                         |
| Session id (a random id)                 | Branch or commit information                  |
| Prompt id (a random id, not the prompt)  | URLs you visited or fetched                   |
| Request id, used to de-duplicate         | Environment variables                         |
| `query_source` (`sdk`, `compact`, …)     | Your email address                            |
| Speed and effort settings, when present  | Your Claude account or organization id        |
| A member id, which is you                | Your IP address, beyond the connection itself |

## Once, when you join

| Sent and stored            | Why                                              |
| -------------------------- | ------------------------------------------------ |
| The display name you chose | It is what identifies you on the dashboard       |
| Your machine's hostname    | So two people called Alex are distinguishable    |
| OS name and version        | The same reason, and it is useful in bug reports |

Nothing else about the machine, and none of it is re-sent later.

## Per installation, updated as you work

| Sent and stored                       | Notes                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| A per-installation random id          | Claude Code's `user.id`, from `~/.claude.json`. It identifies an install, not an account |
| OS type, OS version, CPU architecture | From the OTLP resource block                                                             |
| Claude Code version                   | Used to notice when a Claude Code release changes the telemetry format                   |
| Terminal type (`vscode`, `iTerm.app`) | From the OTLP record                                                                     |
| First seen, last seen                 | Timestamps                                                                               |

The `installs` table has a `hostname` column and telemetry never fills it —
OTLP carries no hostname. The only hostname ccledger holds is the one you sent
once, at join.

## The four identifiers that are thrown away

Claude Code's telemetry does carry account identity. ccledger drops all four
before anything reaches the database, at parse time, by name:

| Attribute           | Why it is dropped                                                           |
| ------------------- | --------------------------------------------------------------------------- |
| `user.email`        | Real PII, and useless here: on a shared account it is the same for everyone |
| `user.account_uuid` | Same                                                                        |
| `user.account_id`   | Same                                                                        |
| `organization.id`   | Same                                                                        |

Two more keys are dropped the same way: `prompt` and `response`. Claude Code
ships them with the value `<REDACTED>` while content logging is off, but the
keys arrive regardless, so ccledger removes them by name rather than trusting
an exporter it does not control.

None of these six ever reaches a `SELECT`, a log line, or a backup, because
they are removed in the parser rather than filtered in a query.

## The switches that would change this, and are never set

Claude Code can export content. Five variables control it, all off by default:

```
OTEL_LOG_USER_PROMPTS
OTEL_LOG_ASSISTANT_RESPONSES
OTEL_LOG_TOOL_DETAILS
OTEL_LOG_TOOL_CONTENT
OTEL_LOG_RAW_API_BODIES
```

**ccledger never sets any of them.** Not in `setup`, not behind a flag, not in
a test, and not as a suggestion in these docs. That is a project rule rather
than a current default: a pull request adding any of them will not be merged.
See [CONTRIBUTING.md](../CONTRIBUTING.md).

`ccledger doctor` check 6 exists so you can confirm this on your own machine
without reading the source, and it looks at your shell environment as well as
the settings file, so it catches one being set by something that is not
ccledger at all:

```console
$ ccledger doctor

ccledger doctor 0.1.0

  ...
  FAIL  content logging   OTEL_LOG_USER_PROMPTS=1 in this shell — prompt or response content may be leaving this machine
                          ccledger never sets these and does not want the data. Something else
                          turned them on. Unset them unless you know exactly where that content is
                          going.
```

## Check it yourself

**Read what was written to your machine.** Five keys, and you can see all five:

```console
$ cat ~/.claude/settings.json
{
  "permissions": {
    "allow": ["Bash(npm test)"]
  },
  "model": "opus",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://ccledger.local:4318/v1/logs",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS": "Authorization=Bearer ccm_aJlGTdOJY0tJFEeYUC3hgb9rYm1r9AF9"
  }
}
```

`OTEL_LOGS_EXPORTER`, not `OTEL_EXPORTER_OTLP_PROTOCOL` or
`OTEL_METRICS_EXPORTER`: only logs, only to that one URL. Nothing here
redirects traces or metrics anywhere.

**Watch the traffic.** The batches are plain JSON over plain HTTP in laptop
mode, so you can read exactly what leaves your machine. Point the endpoint at a
listener of your own for a minute — this one needs nothing installed:

```console
$ node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(b);s.writeHead(200).end('{}')})}).listen(4999)" &

$ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4999/v1/logs claude
```

Every batch Claude Code exports is printed in full. Search it for anything you
typed; it is not there.

**Read the parser.** `src/server/otlp.ts` is the only code that turns a payload
into anything stored, and the dropped keys are a constant in
`src/shared/constants.ts`:

```console
$ grep -A5 "^export const PII_ATTRIBUTE_KEYS" src/shared/constants.ts
export const PII_ATTRIBUTE_KEYS: readonly string[] = [
  'user.email',
  'user.account_uuid',
  'user.account_id',
  'organization.id',
];
```

**Read the test.** The fixtures in `test/fixtures/` are real captures with the
four identity values replaced by distinctive sentinels.
`test/ingest.integration.test.ts` ingests them and then searches the SQLite
file byte by byte:

```
it('has no sentinel anywhere in the database file on disk', …)
```

So "no PII is persisted" is asserted against the bytes on disk, not against
what the parser claims to have returned. The same test asserts a non-identity
value _is_ present, so a passing run cannot be a test that searched an empty
file.

## Who can see the data

The dashboard is behind an admin token, held in memory by the page and never
written to `localStorage`. Whoever runs the server has it, and by extension can
see everyone's totals. That is the point of the tool; it is worth being clear
that it is not anonymous between teammates.

Your own ingest token grants one thing: posting usage as you. It cannot read
the dashboard, cannot read anyone else's numbers, and is not a Claude
credential.

Tokens are stored as SHA-256 hashes. Join codes are single-use and expire in 24
hours.

## Limits worth knowing

**Attribution is honor-system.** Your token lives in a file you own. You can
edit it, share it, or delete it. ccledger is for dividing a shared bill fairly,
and it is not evidence of anything.

**Laptop mode is unencrypted.** Plain HTTP over the LAN means your token and
your counters are readable by anyone on that network. It is fine for an office
network you trust and wrong for a café. VPS mode puts TLS in front.

**Costs are estimates.** The figures are Claude Code's own per-request
estimates. On a subscription, no money changed hands per request, so they are
notional API-equivalent prices for comparison, not spend.

**claude.ai is not covered.** Browser and desktop usage exports no telemetry
and is invisible to ccledger. There is no way to add it that does not involve
intercepting credentials, so there is no plan to.

**Deletion.** Ask whoever runs the server. Everything is rows in one SQLite
file; deleting your member row and your requests is a `DELETE`. `ccledger
uninstall` stops new data but does not remove what was already sent.
