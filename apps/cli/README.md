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

The issuer is not a credential. Validated discovery metadata and public signing keys are cached in owner-only files under `~/.weldall`; use `weldall config refresh` after an administrator changes endpoints. Sessions, refresh tokens, short-lived central access tokens, and DPoP keys remain in the native secure store: Windows Credential Manager, macOS Keychain, or Linux Secret Service with the keyutils fallback provided by `@napi-rs/keyring`. There is no plaintext credential fallback. On macOS, refresh and profile updates modify the existing Keychain item without deleting it first. Explicit login still recreates the item to bind its access controls to the current binary; npm and standalone installations retain separate credential namespaces.

On Ubuntu desktop, sign in to a normal user session and ensure the keyring is unlocked. On a headless Linux host, provide a user D-Bus session with an unlocked Secret Service implementation (for example `gnome-keyring-daemon`) or a usable kernel keyring/keyutils environment. If neither backend is usable, `login` and session commands fail closed and report the secure-store error; do not bypass this by writing credentials to files.

Before `weldall login` can complete, a Weldall administrator must assign the user the `weldall:login` scope for that server, either directly by email or through a matching provider group. Identity-provider sign-in alone does not grant CLI access, and group-derived access is resolved live and fails closed when its provider is unavailable or no longer reports the membership.

On macOS, MDM can deploy the `Issuer` key in the existing preference domain. For local development:

```sh
defaults write dev.seibert.weldall-cli Issuer -string "https://weldall.example.com"
```

## Native YAML infrastructure as code

Use Weldall YAML to manage configuration through the CLI, including connector definitions without secrets. The CLI applies each manifest as one atomic configuration update. For each connector, set `envelopeProvider` to `LOCAL_ENV` or `OPENBAO`; you cannot change it after creation. You can still edit settings in the UI, but applying an approved manifest restores its values. See [the IaC guide](../docs/src/content/docs/infrastructure-as-code.mdx).

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

## Managed connections

Connector commands and connector IaC declarations require a server with managed-connector support. Upgrading the CLI does not require upgrading the server for existing login, scopes, skills, `request --scope`, or connector-free IaC workflows.

Provider credentials stay encrypted on Weldall, never in the CLI. Connect once and use the same owner-only connection from any signed-in device. Browser setup must use the initiating Weldall account; optional permissions can be unticked before provider consent.

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

Atlassian Cloud connectors support Jira and Confluence through `api.atlassian.com` gateway URLs. Admins configure resource-level OAuth credentials, allowed cloud IDs, products, and product scopes in the UI or IaC. Users authorize one allowed site per connection, and `connections show` includes provider-generated request examples and pagination guidance. Atlassian does not offer targeted token revocation for one connection, so disconnect deletes the Weldall connection locally and prints the provider-account cleanup warning instead of failing the cleanup.

`connections status <attempt-id>` recovers setup status after interruption; `connections cancel <attempt-id>` cancels or retries cleanup of an unused grant. `connections show <name-or-id>` reports selected/granted permissions and health. Administrative deletion is local-only and does not revoke provider access; ask owners to disconnect first when best-effort revocation is desired. Connection lists render as terminal tables by default. Connector discovery renders one card per connector with grouped permission descriptions and the signed-in owner's current connections. Use `--json` for stable machine-readable data or `--agentic` for compact TOON. `show` and `status` support the same output flags. Existing Weldall login/session storage is unchanged.

## Git credential helper

`weldall git-credential <get|store|erase>` implements git's credential helper protocol for Weldall's git proxy (`https://<weldall>/git/<connector>/<owner>/<repository>.git`). Git runs it; people do not. On `get` it answers only for the configured Weldall host and a git proxy path, asks Weldall for a short-lived git credential with the existing CLI login, and prints it to git. For any other host it prints nothing, so git asks its other helpers. When no credential can be obtained (no or expired login, unknown app, repository not ready, rate limit, unreachable server, or a server without git credentials) it prints `quit=1`, so git stops without prompting, and explains on stderr. `store` and `erase` do nothing: the helper stores nothing. It requests read access unless `WELDALL_GIT_ACCESS=write` is set. The helper needs `credential.useHttpPath=true` and a cleared helper list for the proxy URL only, so the credential never reaches another helper such as the macOS keychain.

## Publishing an app

`weldall app publish` publishes a locally built app through Weldall for a person without a Git account; an agent usually runs it with `--json`. `weldall app sync` only brings the app repository's state into the folder and publishes nothing. Both need git 2.39 or newer (the git macOS ships, Apple Git 2.39.3, works) and run git non-interactively through the git proxy.

**The app folder** (agreed with app templates, INV-185): the folder is a git repository without a Weldall remote whose first commit is the template state, and its local git config records `weldall.template` (the template's name on the Git host connector) and `weldall.templateCommit` (that first commit). Whoever creates the folder sets both. Publish refuses a folder where they are missing or wrong and never guesses a starting point. Publish keeps its own state in the same repository: the app under `weldall.*` config keys, the state last agreed with the repository in `refs/weldall/base`, the state the open pull request started from in `refs/weldall/pr-base`, and a conflict resolution in `.git/weldall/conflict.json`.

The first publish (`--name`, `--purpose`) creates the repository from the template; a retry continues with the same repository. Every publish fetches the repository's state, merges it with the folder by content (base: the last agreed state), and pushes the result as one commit on top of the fetched state to a `weldall/publish-*` branch, without force. While the previous pull request is open, publish updates its branch; after it is merged or closed, the next publish opens a new one. Only after the push does the folder take over the merged result as a new local commit; the person's own commits stay in the local history. The published commit is authored by the Git host integration (for GitHub the App's bot account, as Weldall reports it) and carries the trailer `Weldall-App: <app id>`.

Publish includes committed and uncommitted changes and untracked files that `.gitignore` does not exclude. It refuses, lists, and publishes nothing when a file it would send looks like a secret or data: `.env` files (examples such as `.env.example` are fine), private keys and keystores, credential files, database files and dumps, files over 10 MB, and text containing a credential or conflict markers. Remove such files or add them to `.gitignore`. Files under the Git host's protected paths (for GitHub `.github/workflows`) always come from the repository; local changes to them are not published and are named in a notice.

When the folder and the repository changed the same lines, publish stops (exit code 3) and publishes nothing. `--resolve` writes the merge result with conflict markers into the folder; then publish again with one `--decide <path>=folder|local|repo` per listed file (`folder`: the file as edited, without markers; `local`/`repo`: that side's version). Binary and modify/delete conflicts need `local` or `repo`. If the folder no longer holds the repository's changes from the merge result (for example after a reset), the merge starts over instead of undoing them. Refused files exit with code 4. With `--json` the result is `{ outcome, app, pullRequest, commit, files, folder, notices, warnings, links, conflict, refused }`, and an error is `{ outcome: "error", error: { code, message, hint } }`.

## Commands

```sh
weldall login
weldall status
weldall whoami
weldall policy
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

`weldall status --json` includes `organizationInstructions` alongside `identity`, `assignedScopes`, and `grants`. This is the current organization-instructions text loaded from Weldall, not the cached help header: an empty string means no instructions are configured; `null` means the settings could not be loaded (including older servers without that endpoint). Existing identity/permission failures still fail the command. Clients that require organizational context should distinguish these states rather than silently substituting cached text or assuming an empty configuration.

`weldall policy --json` prints the client policy that applies to the signed-in account as `{ version, policy, updatedAt, etag, cached }`. The server merges the organization default with the policies of the account's groups. The `etag` changes whenever the merged policy changes. The CLI keeps the last policy it loaded for the signed-in account. When the live load fails, for example offline or while a group provider is unavailable, the command prints that copy with `cached: true` and a warning on stderr. Without a copy it fails, for example against a server that has no policy endpoint. Signing out or switching accounts drops the copy. `weldall status --json` also includes the merged document as `policy`, or `null` when it could not be loaded.

Use `--json` with `status`, `whoami`, `policy`, `scopes`, and `skills` for machine-readable output. Human-facing
output is rendered with Ink in bordered account, access, skill, notice, and configuration panels. ANSI
colors are only emitted to an interactive terminal and respect `NO_COLOR`; JSON, documents, response
bodies, and piped scope lists remain plain output. Help shows a rounded purple Weldall panel with the
effective host and cached name and email of the signed-in account. Root help stacks it above the
yellow organization-instructions panel, capped assigned-scope and connector/connection previews, and a cached skill-discovery instruction. The connector/connection preview names available capability groups, marks ready connections using provider-neutral connector metadata, and links the relevant request command. Root help is strictly local and works offline: it never performs discovery, token refresh, or background networking. Successful login, status, scopes, skills, connector discovery, and connection listing refresh the local snapshot for later invocations.

`--agentic` prints the same data shaped for a model instead of a parser: TOON, tab-delimited, with every array's length declared in its header so a truncated read is visible. The bytes come from the format's reference encoder, `@toon-format/toon`, so the output is what a strict TOON decoder expects. It is available on `skills list`, `skills show`, `skills find`, `scopes`, and managed-connection list, discovery, detail, setup-status, connect, reconnect, and disconnect output. `skills list` writes a table of slug, title, preview, tags, `available`, `missingScopes`, and source, roughly 40 percent smaller than `--json` on a catalog of 47 skills. `skills show` writes one object carrying slug, title, tags, `available`, `missingScopes`, source, and the rendered document. Everything else `--json` reports is left out: `content` and `preview`, which the document already repeats, plus `requiredScopes`, `visibility`, `updatedAt`, and `involvedResources`. That is 54 percent smaller than `--json`. `skills find` reads the local cache, so its table is the cached fields and nothing more: slug, title, preview, tags, `available`, owner, and one source column holding the resource name, or its key when the name was never cached. There is no `missingScopes` column, because the cache does not hold one, and `--json` has none here either. It saves least, 26 percent on 27 matches, because the cached previews are most of what it prints. `scopes` writes the assigned scopes inline and one row per resource with its granted scopes, supported scopes, and request prefixes; the OAuth identifiers stay in `--json`, which is most of why it saves 63 percent on an account holding 16 resources. Connection lists carry selectors, connector keys, account names, status, granted scopes, usage metadata, and issuer; connection detail adds selected and granted scopes plus lifecycle timestamps. Connector discovery carries connector key, name, type, available scopes, and default scopes, while database ownership and version fields stay in `--json`. Unlike `--json` none of this is a contract and it may change in any release, so do not write scripts against it. Passing `--json` and `--agentic` together is an error rather than a silent win for one of them.

Set `WELDALL_DEBUG_TIMINGS=1` to print optional phase timings to standard error. Timing output contains phase names and elapsed milliseconds, not tokens or response data.

On interactive terminals, the CLI checks at most once per day whether a newer `@weldall/cli` version is published and prints a stderr-only notice with the upgrade command for your install method (npm or standalone).
The check is silent for piped output, `--json`, and non-interactive runs, and it never blocks or fails when the registry is unreachable.

## Shared discovery (development branch)

Build the server, SDK, CLI and extension from this branch together; there is no published minimum
version yet. Explicit selection, query search and skill dependencies use the same resolver:

```sh
weldall discover --resource expenses --connector-type atlassian-mcp --json
weldall discover --query "expenses" --json
weldall discover --skill expenses.review --json
weldall discover --resource expenses --catalog-only --json
weldall mcp native tools expenses --json
weldall mcp native call expenses list_expenses --arguments '{}' --json
weldall mcp native read-resource expenses --uri expenses://current --json
```

For the local demo, follow the repository's local-development setup and start/restart `pnpm dev`
after building the SDK. Use `WELDALL_ISSUER=https://weldall.seibert.localdev` on each command
(or export it for that terminal) and log in locally. This override does not change your saved
issuer. Build with `pnpm --filter @weldall/sdk build && pnpm --filter @weldall/cli build`, then
replace `weldall` above with `./apps/cli/dist/index.js`.

Discovery resolves definitions; a terminal command does not install tools in an existing chat.
The compatible extension publishes successful sources in its own live session. `--catalog-only`
fetches descriptions without schemas, skill documents, account selection or native token exchange.
Results distinguish `resolved`, `catalog`, `incomplete`, `selection_required` and `unavailable`.
Failures carry sanitized codes; independent failures preserve successful sources. `nextCursor`
paginates search hits, not dependencies; use `--cursor` with the same query. Query search includes
only authorized resource advertisements and connector/skill catalog entries, matching their keys,
names, descriptions and skill metadata. Old servers without this opt-in metadata omit native search
hits; existing HTTP/connector commands remain unchanged.

Ambiguous connector accounts return recognizable choices. Continue with the same selectors plus
`--selection '{"connectorKey":"work","connection":"<offered-id>"}'`. The extension manages
this through `select_mcp_connection`; authors must not put connection IDs in skill dependencies.
A missing bound account fails rather than selecting a replacement.

Admission is capped at eight source selectors, 200 tools, 200 resources, 1 MiB of results and
32 KiB of instructions, four workers and a 35-second deadline. These are enforced safety limits,
not yet a measured model-context recommendation.

Native endpoints come only from the registered resource's protected-resource metadata, must
share its authorization-server origin, and must fall under its approved request prefixes.
Discovery requires all explicitly configured scopes. Calls obtain declared operation scopes
before execution; a missing grant prevents invocation. Calls are never automatically replayed.
The `--expected-*` native options let hosts reject stale identity/origin/audience/revision
bindings; they grant no permission.

Native discovery uses two bounded caches, not database records. Weldall keeps validated resource
metadata in process-local memory for 60 seconds and shares concurrent fetches; current grants are
checked on every lookup. Each server replica warms its own cache. The CLI keeps validated tool and
resource definitions for five minutes in owner-only files under `~/.weldall/native-mcp/`, keyed by
issuer, subject, resource registration, granted scopes and advertised revision. Both caches are
limited to 128 entries / 16 MiB with least-recently-used eviction. The CLI still fetches current
metadata and checks grants before using a catalog, and obtains operation tokens for every call.
Changed revisions cannot reuse old catalogs; failed native requests invalidate their catalog without
retrying the operation. Neither cache stores tokens or business results. Disk cache failures fall
back to live discovery; deleting `~/.weldall/native-mcp/` clears the local catalog cache.

The shared resolver and whole-source skill dependencies are implemented. Full semantic parity,
performance evidence and packaged-host/next-model validation remain release gates.
Existing connector `weldall mcp` commands and exact-tool skill dependencies retain their semantics.
See the [SDK preview contract](../../packages/sdk/README.md#native-mcp-development-preview).

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
