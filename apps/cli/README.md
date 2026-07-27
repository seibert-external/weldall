# Weldall CLI

A macOS CLI for Weldall's DPoP-bound OAuth flow.

## Installation

Node.js 22.15 or newer is required. Install the public package globally:

```sh
npm install --global @weldall/cli
weldall --version
```

The npm package supports macOS only. npm installs the matching native Keychain binding for the
current Mac; no local compiler, Bun installation, or standalone release binary is required.

## Configuration

The CLI resolves its Weldall issuer in this order:

1. `WELDALL_ISSUER` environment variable
2. macOS Preference `dev.seibert.weldall-cli/Issuer`
3. Interactive first-run prompt

The environment variable is an ephemeral override and is never persisted. The issuer must be an
HTTPS origin. Weldall validates authorization-server and protected-resource discovery before using or
saving it.

```sh
weldall config set-issuer https://weldall.example.com
weldall config get-issuer
weldall config reset-issuer

WELDALL_ISSUER=https://weldall-dev.example.com weldall login
```

MDM can deploy the same `Issuer` key in the `dev.seibert.weldall-cli` preference domain. Sessions are
stored separately per issuer in macOS Keychain. For local development, the equivalent preference is:

```sh
defaults write dev.seibert.weldall-cli Issuer -string "https://weldall.example.com"
```

## Commands

```sh
weldall login
weldall status
weldall whoami
weldall scopes
weldall skills
weldall skills show expenses.list
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
then groups scopes that are currently usable by enabled APIs. It explains common permission names
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

Before token exchange, the CLI requires the exact origin and path segments to match one active Resource
Registry prefix, then checks supported and granted scopes. It never follows redirects. Unregistered or
ambiguous targets receive neither a token nor request data. Weldall then obtains the matching resource
token and adds the DPoP authorization headers. `weldall skills` and `weldall skills show` expose
administrator-managed Markdown instructions for agents.

Use `--json` with `status`, `whoami`, `scopes`, and `skills` for machine-readable output. ANSI colors
are only emitted to an interactive terminal and respect `NO_COLOR`. Help starts with a compact framed
header that shows the effective Weldall host, or makes clear that no host is configured. Root help
renders a non-empty cached administrator-provided appendix in a separate, prominent instructions
frame with wrapped, justified prose, then refreshes it for the next invocation. Discovery has a
2.5-second total deadline; an authenticated refresh that has already begun is allowed to finish so
refresh-token rotation is not interrupted.

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
