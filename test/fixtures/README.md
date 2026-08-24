# Fixtures

Two real OTLP/HTTP JSON log payloads captured from **Claude Code 2.1.241** on
Windows 11 (VS Code terminal) on 2026-08-23, using `capture.mjs` at the repo
root. `001.json` holds six log records, `002.json` holds four.

They are byte-for-byte the captured payloads **except** for four attribute
values, which were replaced with obvious sentinels so the capturing account's
identity is not committed to a public repo:

| Attribute           | Sentinel in fixtures                   |
| ------------------- | -------------------------------------- |
| `user.email`        | `teammate@example.invalid`             |
| `user.account_uuid` | `22222222-2222-4222-8222-222222222222` |
| `user.account_id`   | `user_012FIXTUREACCOUNTID000`          |
| `organization.id`   | `11111111-1111-4111-8111-111111111111` |

Those four attributes are exactly the ones ccledger drops at parse time
(PRD §9, §11), so the substitution costs no test coverage — and the sentinels
are distinctive enough to grep a whole SQLite file for, which is how
`test/ingest.integration.test.ts` proves no PII is persisted.

The unmodified captures stay in `captures/` (gitignored).

## What these payloads contain

- One `resourceLogs` entry, one `scopeLogs` entry (scope
  `com.anthropic.claude_code.events`), records nested beneath.
- Resource attributes: `host.arch`, `os.type`, `os.version`, `service.name`,
  `service.version` only. No identity on the resource.
- Record bodies are the prefixed form (`claude_code.api_request`); the
  `event.name` attribute is bare (`api_request`).
- `timeUnixNano` / `observedTimeUnixNano` are **quoted strings**, `intValue`
  is a **bare number**, and `prompt_length` arrives as a numeric **string**
  inside `stringValue`. Coerce; never trust the JSON type.
- Event names present: `plugin_loaded` (1), `mcp_server_connection` (4),
  `api_request` (2), `assistant_response` (2), `user_prompt` (1).
- The `prompt` and `response` attributes are present on `user_prompt` /
  `assistant_response` records with the value `<REDACTED>`, because content
  logging was off. The keys ship regardless, so ccledger drops them by name.
