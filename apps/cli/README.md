# Weldall CLI

A macOS CLI for Weldall's DPoP-bound OAuth flow.

## Installation

Node.js 22.15 or newer is required. Install the public package globally:

```sh
npm install --global @weldall/ci
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
weldall logout
```

`weldall status` gives people the friendly overview: the signed-in display name and verified email,
which Weldall host is active, and what that account is allowed to do. `weldall scopes` explains common permission names such
as `expenses:read` while still showing the exact scope needed by scripts and API requests.

`weldall request` accepts an absolute HTTPS URL, explicit repeatable `--scope` values, an optional
`--method`, additional headers, and raw or JSON request bodies. Before token exchange, the CLI requires
the exact origin and path segments to match one active Resource Registry prefix, then checks supported
and granted scopes. It never follows redirects. Unregistered or ambiguous targets receive neither a
token nor request data. Weldall then obtains the matching resource token and adds the DPoP authorization
headers. `weldall skills` and `weldall skills show` expose administrator-managed
Markdown instructions for agents.

Use `--json` with `status`, `whoami`, `scopes`, and `skills` for machine-readable output. The branded line and
ANSI colors are only emitted to an interactive terminal and respect `NO_COLOR`. Running bare
`weldall` briefly animates the line before showing help; set `WELDALL_NO_ANIMATION=1` to keep it static.

## Development

```sh
pnpm --dir apps/cli exec tsx src/index.ts --help
pnpm --filter @weldall/ci typecheck
pnpm --filter @weldall/ci test
pnpm --filter @weldall/ci build
pnpm --filter @weldall/ci pack:check
```

## Releasing

Release-affecting pull requests commit a pnpm change intent from the repository root:

```sh
pnpm change @weldall/ci --bump patch --summary "Describe the user-visible change"
pnpm change status
```

After the change reaches `main`, Forgejo opens or updates the shared `release/pnpm` PR using pnpm's
native `version -r` flow. Merging that reviewed PR triggers the non-cancellable publish workflow,
which rebuilds and verifies the immutable release commit, publishes the prepared CLI tarball, and
creates the matching `ci-v<version>` tag and Forgejo release. Interrupted runs are safely rerunnable.

Before the first release, create the `@weldall` npm scope and configure the protected Forgejo secrets
`NPM_TOKEN` and `RELEASE_BOT_TOKEN` plus the `RELEASE_BOT_USER` repository variable as documented in
the root README. Restrict the npm token to `@weldall/ci` and `@weldall/sdk`, and protect `ci-v*` tags
so only the release bot can create them.

The older standalone executable builder remains available for local testing with Bun:

```sh
pnpm --filter @weldall/ci release
```
