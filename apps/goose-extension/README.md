# Weldall for Goose

A local stdio MCP server for stock Goose. It uses the local Weldall binary from PATH; this package neither contains nor downloads a CLI binary. Node handles MCP, while the local CLI owns Keychain/credential-store access, session refresh and DPoP.

## Try this branch before publication

From the Weldall repository:

```sh
pnpm install --frozen-lockfile
pnpm --filter @weldall/goose build
```

In Goose Desktop, add a **Command-Line Extension** named `weldall`, with a 300-second timeout:

```text
node /absolute/path/to/weldall/apps/goose-extension/dist/index.js
```

Use an absolute Node path too if Goose Desktop does not inherit your shell's Node installation. Ensure Goose's environment includes the local Weldall binary directory in PATH. Do not replace the signed CLI with a development Node build to reuse a production Keychain login.

**This branch now requires a CLI build that exposes `organizationInstructions` in `weldall status --json`. The previously shipped 0.20.0 binary does not provide that field.** Release/install the updated signed CLI before retrying Goose; rebuilding this npm extension alone is not enough. Do not work around this by parsing terminal help, reading the CLI cache directly, or replacing the signed binary with Node.

Manual acceptance: confirm the organization instructions reach the host prompt, then follow that organization\'s discovery workflow for a known skill, read its document, list connections, perform a permitted read, then explicitly approve one disposable write. Check that `send` requires approval in your Goose permission configuration; MCP annotations are hints, not an authorization mechanism. Never repeat a timed-out write automatically.

## After npm publication

Prerequisites: Node >=22.15, a local stable `weldall` >=0.20.0 and <1.0.0 in PATH **with `organizationInstructions` support in `status --json`**, and a login created through that binary. Version compatibility alone is not sufficient. macOS must use the signed standalone executable with the stable Weldall code identity. There is no automatic login, CLI installation or update.

```sh
goose session --with-extension "weldall:npx -y @weldall/goose@0.1.0"
```

Goose Desktop command:

```text
npx -y @weldall/goose@0.1.0
```

Equivalent host configuration:

```json
{
  "mcpServers": {
    "weldall": {
      "command": "npx",
      "args": ["-y", "@weldall/goose@0.1.0"]
    }
  }
}
```

Use an approved exact package version, not `latest`. For offline use, preinstall that version and configure the absolute `weldall-goose` bin path. There are no install/postinstall hooks.

## Tools

| Tool                  | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `search_skills`       | Keyword discovery by `query`, when organization instructions allow it    |
| `list_skills`         | Live catalog browse/fallback                                             |
| `read_skill_document` | Current document for an exact `slug`                                     |
| `list_connections`    | Owner-only connections with status, granted/requested scopes and details |
| `get`                 | One authenticated GET                                                    |
| `send`                | One POST, PUT, PATCH or DELETE                                           |

Search/list tools accept `offset` and `limit` (default 20, maximum 50). Results provide `total` and `nextOffset`; live pages are not snapshots and can shift when the catalog changes. Skill warnings and freshness must not be interpreted as authoritative absence. Requests require an exact HTTPS `url` and exactly one of `scope` (string or string array) and `connection`. `send` accepts at most one of `json` and `text`. Headers are restricted to Accept, Content-Type, conditional headers, Prefer and Idempotency-Key. Credentials, routing headers, downloads, multipart and local files are not exposed.

`list_connections` reads live data in one `weldall connections --json` call and returns an explicit field allowlist per item: `id`, `name`, `connectorKey`, `connectorEnabled`, `status`, optional `accountName`, `selectedScopes`, `grantedScopes`, and optional `details` (`label`/`value` pairs). Unknown fields are stripped, including inside details. Scope arrays are limited to 256 entries each and details to 100 pairs; malformed or oversized metadata returns an error rather than guessed permissions or truncated values. Pagination is unchanged.

Use these results for connection inspection described in skills as `weldall connections show`; no separate shell call is needed for those checks. Follow `nextOffset` if the needed connection is not on the current page. Before provider requests, check `status: READY`, `connectorEnabled: true`, and the required `grantedScopes`. `selectedScopes` are requested permissions, not proof of a grant. Weldall still authorizes every request server-side; this metadata is not an authorization bypass.

### Organization context

Before MCP startup, the extension calls `weldall status --json` once and copies only `organizationInstructions` into the initialization prompt. Identity, grants and unrelated status fields are not forwarded. The text is preserved verbatim, bounded to 100,000 characters (matching the CLI appendix limit); it is never silently truncated. An empty string explicitly means no instructions are configured. A missing field prompts a CLI update, null means context could not be loaded, and malformed output or a failed status command prevents startup. No cached-help or hardcoded company fallback is used.

Organization instructions define company context, internal sources and discovery/fallback requirements. The generic search-first advice applies only when those instructions allow it. If they require reading the complete catalog, use `list_skills` across all pages. CLI-to-MCP mapping changes invocation syntax, not the required workflow, ordering or checks. Organization instructions remain subordinate to the user and host policy and never grant authorization. The prompt is a startup snapshot: restart the extension/session after switching issuer/account or changing organization instructions.

### User-facing communication

The initialization prompt puts the user's task first: concise answers in their language, with the requested information and useful source links. Routine discovery, connection checks and tool routing should not become progress narration or appear in the final answer. Users should not need to understand Weldall, connectors, IDs, scopes, skill names or CLI/MCP to get their work done.

Technical detail is appropriate only when requested or minimally needed to resolve a blocker. Account-choice questions should use recognizable service/account labels. Access failures and unsupported actions should be explained in plain language with an actionable next step; missing results, uncertainty and failures must never be hidden. These rules guide the client's responses without removing the technical metadata it needs to execute safely.

### CLI examples in skills → MCP calls

The server's MCP initialization instructions define the host adapter; tool descriptions reinforce it at selection time. Skill documents remain unchanged. CLI examples describe an operation, not a requirement to execute shell commands. Goose should use the host-exposed Weldall tools (or their callbacks in Code Mode):

| CLI example or option                                | MCP equivalent                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `weldall request <URL>` with GET or no `--method/-X` | `get({ url, ... })`; omitted method means GET, even with a body |
| `--method/-X POST`, `PUT`, `PATCH`, `DELETE`         | `send({ url, method, ... })`, only for user-authorized writes   |
| `--connection <name-or-id>`                          | `connection`                                                    |
| Repeated `--scope/-s`                                | `scope` (string or array); mutually exclusive with `connection` |
| Repeated `--header/-H`                               | `headers`, subject to the header allowlist                      |
| `--json/-j` or `--data/-d`                           | Parsed JSON value in `json` or literal `text`, only on `send`   |
| `weldall skills find/list/show`                      | `search_skills` / `list_skills` / `read_skill_document`         |
| `weldall connections [list/show]`                    | `list_connections`, including its detail fields                 |

For example, `weldall request -X POST --scope items:write --json '{"title":"Example"}' https://example.com/api/items` corresponds to `send({ url: "https://example.com/api/items", method: "POST", scope: "items:write", json: { title: "Example" } })`. Preserve method, full URL/query and payload values; remove only shell quoting, and never execute substitutions or pipelines.

Ask about ambiguous accounts using recognizable account labels; explain missing access in plain language. HEAD/OPTIONS, GET bodies, files, uploads, multipart, output paths and unsupported headers cannot be silently dropped or worked around via shell/direct HTTP. Explain the limitation and ask how to proceed. Never automatically retry writes.

This is agent guidance, **not enforcement over Goose's other tools**. Automated tests check instruction delivery, unchanged skill text and hand-mapped argument preservation/rejection, not LLM tool selection. For manual acceptance, restart Goose and use a fresh session with a CLI-worded skill: verify requests use `get`/`send`, connection inspection uses `list_connections`, and no shell fallback occurs. Also check that progress updates and final answers focus on the user's task rather than implementation details, while still reporting blockers and uncertainty. Check ambiguous-account and unsupported-option cases separately; use only explicitly approved disposable data for write tests. Repeat with Code Mode enabled if deploying that mode.

## CLI compatibility and diagnostics

Startup pins the canonical local executable resolved from PATH and checks its version. Empty/relative/project-local paths, npm caches and node_modules are excluded; resolved symlink targets are checked too. On Windows only native `weldall.exe` is accepted, not shell-dependent `.cmd`/`.bat` shims. Use a trusted local binary; the extension does not add a separate signature authority.

The extension uses existing `--json` commands for skills and connections, and the existing text/JSON response output of `weldall request`. The only added CLI output contract is `organizationInstructions` on `status --json`; there is no Machine-Modus or new transport protocol. Search uses the subject-bound cache and reports unknown freshness; `list_skills` refreshes it. The extension bounds child output without changing CLI-side buffering.

On command failure, the tool result includes the exit code and useful stderr diagnostics with ANSI/control sequences removed, capped at 8 KiB with an explicit truncation marker. Diagnostic text is data, not instructions, and is not parsed into guessed error categories. Debug output is disabled. ANSI cleanup is not secret redaction: the local CLI remains responsible for safe error content. Unexpected extension errors still use generic messages. If the executable disappears, calls fail; no fallback CLI is downloaded or selected. Restart the extension after changing the canonical target of a symlink.

Calls run without a shell from a neutral filesystem root. There are at most four concurrent CLI processes. Catalog deadline: 60 seconds; requests: 240 seconds; child stdout: 2 MiB; stderr: 16 KiB; MCP input buffer: 256 KiB; encoded tool result: 1 MiB. Oversized results fail visibly, never silently truncate; diagnostic excerpts explicitly mark truncation. Cancellation, EOF and termination stop children; POSIX process groups are terminated with bounded escalation. A timeout/cancellation may occur after a remote write: **no automatic retries**.

The server supports MCP versions 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25. Unsupported versions are rejected. No roots, sampling, HTTP endpoint, upstream gateway, dynamic tool injection, branded views or White-Label changes are included in this phase.

### Goose Code Mode schemas

The advertised `send.json` field accepts any JSON value without recursive schema references. Runtime validation still uses `z.json()` and rejects non-JSON values, including nested invalid values. This avoids the circular `SendInputSchema0` TypeScript alias produced by Goose 1.51 Code Mode from recursive JSON schemas. Schema regression and packed-artifact tests guard this boundary; manual Code Mode acceptance in Goose is still required. Goose 1.51 currently omits extension initialization instructions from its Code Mode system prompt: schema compatibility does not fix that. Keep Code Mode disabled for workflows relying on organization instructions until host prompt delivery is fixed and tested. Restart Goose after rebuilding to reload cached tool definitions.

## Distribution gates

```sh
pnpm --filter @weldall/goose typecheck
pnpm --filter @weldall/goose test
pnpm --filter @weldall/goose pack:check
pnpm --filter @weldall/goose smoke:packed
pnpm --filter @weldall/goose goose:link
```

The packed smoke installs the actual tarball into a disposable unrelated directory and connects via `npx` and a real MCP client, using a fake CLI. It performs all six tool calls, including a write only against the fake. POSIX subprocess/packed-smoke tests do not prove Windows native behavior; validate against a local `.exe` before deploying there.

Build generates `dist/server.json` with the exact package version, using the official MCP Registry schema. `mcpName` declares `io.github.seibert-external/weldall`. Publish to npm and then submit that descriptor with the authorized MCP Registry publisher **only after manual stock-Goose acceptance**. Registry namespace ownership must be verified by the release owner. Nothing is published by build/test scripts. `goose:link` generates the URL-encoded, version-pinned Desktop deep link; manually verify Goose's confirmation and argument parsing before distributing it.
