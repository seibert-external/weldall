# Weldall CLI

A cross-platform CLI for Weldall user sessions, authenticated requests, and native YAML infrastructure as code.

> **Security note:** Weldall uses pinned draft protocols. Machine and IaC replay checks use shared PostgreSQL storage; native user OAuth and demo resource-server replay checks still include process-local stores. Review your deployment's security boundary before production use. Every `weldall login` opens a browser approval screen; approve only when you started that login on the same device.

## Choose an installation

### npm (recommended)

The npm package supports Ubuntu, Windows 10 version 1809 or newer, Windows Server 2019 or newer, and current macOS releases. It requires Node.js 22.15 or newer.

```sh
npm install --global @weldall/cli@latest
weldall --version
```

### Experimental standalone binaries

Standalone binaries require no Node.js, npm, or Bun. Initial targets are Linux x64, Windows x64, and macOS ARM64/x64. The macOS binaries are signed with a Developer ID certificate and notarized by Apple, so Gatekeeper runs them without a warning. Linux and Windows binaries are not signed yet; that work is in progress. Download the appropriate asset from [GitHub Releases](https://github.com/seibert-external/weldall/releases), then:

```sh
# macOS and Linux
chmod +x ./weldall
```

On Windows PowerShell, after downloading the trusted binary:

```powershell
Unblock-File .\weldall.exe
```

## Configuration and credential storage

The CLI resolves its Weldall issuer in this order:

1. `WELDALL_ISSUER` environment variable
2. Saved non-secret preference
3. Interactive first-run prompt

The environment variable is an ephemeral override and is never persisted. The issuer must be an HTTPS origin. Weldall validates authorization-server and protected-resource discovery before using or saving it.

```sh
weldall config set-issuer https://weldall.example.com
weldall config get-issuer
weldall config refresh
weldall config reset-issuer
WELDALL_ISSUER=https://weldall-dev.example.com weldall login
```

```powershell
weldall config set-issuer https://weldall.example.com
weldall config get-issuer
$env:WELDALL_ISSUER = "https://weldall-dev.example.com"
weldall login
Remove-Item Env:WELDALL_ISSUER
```

Saved issuer locations are:

- Linux: `~/.weldall/config.json`
- Windows: `%USERPROFILE%\.weldall\config.json`
- macOS: Preferences domain/key `dev.seibert.weldall-cli/Issuer` (preserved for MDM and existing installations)

The issuer is not a credential. Validated discovery metadata and public signing keys are cached in owner-only files under `~/.weldall`; use `weldall config refresh` after an administrator changes endpoints. Sessions, refresh tokens, short-lived central access tokens, and DPoP keys remain in the native secure store: Windows Credential Manager, macOS Keychain, or Linux Secret Service with the keyutils fallback provided by `@napi-rs/keyring`. There is no plaintext credential fallback.

On Ubuntu desktop, sign in to a normal user session and ensure the keyring is unlocked. On a headless Linux host, provide a user D-Bus session with an unlocked Secret Service implementation (for example `gnome-keyring-daemon`) or a usable kernel keyring/keyutils environment. If neither backend is usable, `login` and session commands fail closed and report the secure-store error; do not bypass this by writing credentials to files.

Before `weldall login` can complete, a Weldall administrator must assign the user the `weldall:login` scope for that server, either directly by email or through a matching provider group. Identity-provider sign-in alone does not grant CLI access, and group-derived access is resolved live and fails closed when its provider is unavailable or no longer reports the membership.

On macOS, MDM can deploy the `Issuer` key in the existing preference domain. For local development:

```sh
defaults write dev.seibert.weldall-cli Issuer -string "https://weldall.example.com"
```

## Native YAML infrastructure as code

Native Weldall YAML manages one atomic configuration snapshot through the existing CLI, including non-secret `connectors` definitions with explicit immutable `envelopeProvider: LOCAL_ENV`. UI edits remain possible; approved applies restore manifest values. See [the IaC guide](../docs/src/content/docs/infrastructure-as-code.mdx).

```sh
weldall init --name platform-access --issuer https://weldall.example.com
weldall validate
weldall plan --json
weldall up --yes
weldall import scope expenses:read --as scope.expenses_read
weldall import skill expenses.review --as skill.review_expenses
weldall unmanage scope.expenses_read --yes
weldall state pull
weldall state mv scope.old scope.new
```

These commands appear in `weldall --help` only while `WELDALL_M2M_CLIENT_ID`, `WELDALL_M2M_KID`, and the `WELDALL_M2M_PRIVATE_JWK`/`WELDALL_M2M_PUBLIC_JWK` pair are set, because a browser login never makes them usable.

## Managed Google connections

Provider credentials stay encrypted on Weldall, never in the CLI. Connect once and use the same owner-only connection from any signed-in device. Browser setup must use the initiating Weldall account; optional permissions can be unticked before Google consent.

```sh
weldall connectors
weldall connections connect google --name my-google
weldall connections list
weldall request --connection my-google \
  https://www.googleapis.com/calendar/v3/calendars/primary/events
weldall connections reconnect my-google
weldall connections disconnect my-google
```

These commands use the existing Weldall API session, not downstream token exchange. Use `--connection` without `--scope`; normal resource requests still require `--scope`. Google pagination uses `pageToken` in subsequent provider URLs, not `--paginate offset`. Connector transfers use bounded buffering up to 10 MiB. Arbitrary paths and query parameters are accepted only on server-reviewed Google origins; Google authorizes operations using the exact granted scopes. The CLI sends the provider URL as untrusted metadata to Weldall, never as a direct authenticated fetch target. Disconnect blocks requests, attempts provider revocation, then always deletes the connection and encrypted retry material so its name can be reused immediately. It exits nonzero and directs the user to Google account settings if revocation is unconfirmed. Google revocation may affect other authorizations for the same account/client.

`connections status <attempt-id>` recovers setup status after interruption; `connections cancel <attempt-id>` cancels or retries cleanup of an unused grant. `connections show <name-or-id>` reports selected/granted permissions and health. The admin UI's separate Disconnect action uses the same best-effort revocation and permanent local removal. Connection and connector lists render as terminal tables by default; use `--json` for stable machine-readable data or `--agentic` for compact TOON. `show` and `status` support the same output flags. See the [managed connector guide](../docs/src/content/docs/managed-connectors.md) for administration and limits. Existing Weldall login/session storage is unchanged.

## Commands

```sh
weldall login
weldall status
weldall whoami
weldall scopes
weldall skills
weldall skills find expense
weldall skills expenses.review # alias for `skills show`
weldall request --scope expenses:read https://expenses.example.com/api/expenses
weldall request -X PUT --scope files:write --upload-file ./report.pdf \
  -H 'Content-Type: application/pdf' https://files.example.com/api/report.pdf
weldall request --scope files:read --output ./report.pdf \
  https://files.example.com/api/report.pdf
weldall logout
```

`weldall status` gives people the friendly overview: the signed-in display name and verified email,
which Weldall host is active, and what that account is allowed to do. `weldall scopes` shows every
scope assigned to the account, including host permissions and scopes without an enabled resource,
then groups scopes that are currently usable through enabled resources. It explains common permission names
such as `expenses:read` while still showing the exact scope needed by scripts and API requests.

`weldall request` accepts an absolute HTTPS URL, explicit repeatable `--scope` values, an optional
`--method`, additional headers, and text, JSON, raw file, or multipart request bodies. Use
`-T, --upload-file <path>` for a binary-safe raw upload. It defaults to `application/octet-stream`;
set a more specific `Content-Type` with `--header` when the API requires one. Use repeatable
`-F, --form 'name=value'` and `-F, --form 'name=@path;type=MIME'` arguments for multipart fields and
files. Weldall generates the multipart boundary, so multipart requests must not set `Content-Type`
manually. The body modes are mutually exclusive, and `GET` and `HEAD` requests cannot have a body.

Use `-o, --output <path>` to stream any successful response body to a file without text decoding.
The destination is replaced atomically only after the complete response has been written. Use
`--output -` for binary-safe stdout, for example when piping to another process. Binary responses
without `--output` are rejected instead of being printed to a terminal.
For non-2xx responses, the error includes the HTTP status and a bounded readable detail from the
response body when one is available.

Before token exchange, the CLI requires the exact origin and path segments to match one active Resource
Registry prefix, then checks supported and granted scopes. It never follows redirects. Unregistered or
ambiguous targets receive neither a token nor request data. Weldall then obtains the matching resource
token; before forwarding its ID-JAG, the CLI verifies the bound subject and verified email alongside
the audience, resource, scopes, and device key. It then adds the DPoP authorization headers.
`weldall skills list` refreshes a searchable local catalog. `weldall skills find <keywords>` searches cached slugs, titles, catalog previews, tags, owners, and resource names without networking after initialization. Multi-word queries rank skills matching more terms first; on no match, try fewer or broader system, resource, or action words, or browse with `weldall skills list`. `weldall skills <skill-id>` is an alias for `weldall skills show <skill-id>`.

For offset-paginated JSON APIs, one process can prepare authorization once and request bounded pages concurrently:

```sh
weldall request \
  --scope personio:read \
  --paginate offset \
  --page-size 100 \
  --total-pages-pointer /metadata/total_pages \
  --max-pages 20 \
  --concurrency 3 \
  --page-output jsonl \
  'https://gateway.example/personio/employees?limit=100&offset=0'
```

Pagination is GET-only, manages `limit` and `offset`, emits pages in deterministic JSON Lines order only after all pages succeed, and enforces page-count, concurrency, and 50 MiB aggregate response limits. It does not follow server-provided next links or retry failed pages.

Use `--json` with `status`, `whoami`, `scopes`, and `skills` for machine-readable output. Human-facing
output is rendered with Ink in bordered account, access, skill, notice, and configuration panels. ANSI
colors are only emitted to an interactive terminal and respect `NO_COLOR`; JSON, documents, response
bodies, and piped scope lists remain plain output. Help shows a rounded purple Weldall panel with the
effective host and cached name and email of the signed-in account. Root help stacks it above the
yellow organization-instructions panel, a capped assigned-scope preview, and a cached skill-discovery instruction. Root help is strictly local and works offline: it never performs discovery, token refresh, or background networking. Successful login, status, scopes, and skill commands refresh the local snapshot for later invocations.

`--agentic` prints the same data shaped for a model instead of a parser: TOON, tab-delimited, with every array's length declared in its header so a truncated read is visible. The bytes come from the format's reference encoder, `@toon-format/toon`, so the output is what a strict TOON decoder expects. It is available on `skills list`, `skills show`, `skills find`, `scopes`, and managed-connection list, discovery, detail, setup-status, connect, reconnect, and disconnect output. `skills list` writes a table of slug, title, preview, tags, `available`, `missingScopes`, and source, roughly 40 percent smaller than `--json` on a catalog of 47 skills. `skills show` writes one object carrying slug, title, tags, `available`, `missingScopes`, source, and the rendered document. Everything else `--json` reports is left out: `content` and `preview`, which the document already repeats, plus `requiredScopes`, `visibility`, `updatedAt`, and `involvedResources`. That is 54 percent smaller than `--json`. `skills find` reads the local cache, so its table is the cached fields and nothing more: slug, title, preview, tags, `available`, owner, and one source column holding the resource name, or its key when the name was never cached. There is no `missingScopes` column, because the cache does not hold one, and `--json` has none here either. It saves least, 26 percent on 27 matches, because the cached previews are most of what it prints. `scopes` writes the assigned scopes inline and one row per resource with its granted scopes, supported scopes, and request prefixes; the OAuth identifiers stay in `--json`, which is most of why it saves 63 percent on an account holding 16 resources. Connection lists carry selectors, connector keys, account names, status, granted scopes, usage metadata, and issuer; connection detail adds selected and granted scopes plus lifecycle timestamps. Connector discovery carries connector key, name, type, available scopes, and default scopes, while database ownership and version fields stay in `--json`. Unlike `--json` none of this is a contract and it may change in any release, so do not write scripts against it. Passing `--json` and `--agentic` together is an error rather than a silent win for one of them.

Set `WELDALL_DEBUG_TIMINGS=1` to print optional phase timings to standard error. Timing output contains phase names and elapsed milliseconds, not tokens or response data.

On interactive terminals, the CLI checks at most once per day whether a newer `@weldall/cli` version is published and prints a stderr-only notice with the upgrade command for your install method (npm or standalone).
The check is silent for piped output, `--json`, and non-interactive runs, and it never blocks or fails when the registry is unreachable.

## Development

```sh
pnpm --dir apps/cli exec tsx src/index.ts --help
pnpm --filter @weldall/cli typecheck
pnpm --filter @weldall/cli test
pnpm --filter @weldall/cli build
pnpm --filter @weldall/cli pack:check
```

## Releasing

Release-affecting pull requests add a standard Changeset from the repository root:

```sh
pnpm changeset
pnpm changeset:status
```

Select `@weldall/cli`, choose the SemVer bump, and describe the user-visible change. After CI succeeds
on `main`, the official Changesets GitHub Action opens or updates the shared release pull request.
Merging that reviewed PR publishes the verified npm package and creates the standard Changesets Git
tag and GitHub release. Repository secrets and the initial npm publication are documented in the
root README.
