# Weldall CLI

A macOS CLI for Weldall's DPoP-bound OAuth flow.

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
pnpm --filter @weldall/cli typecheck
pnpm --filter @weldall/cli test
pnpm --filter @weldall/cli build
```

## Local release

Bun is required to create standalone macOS executables:

```sh
pnpm --filter @weldall/cli release
```

Artifacts for macOS arm64 and x64, compressed archives, and `SHA256SUMS` are written to
`apps/cli/dist/release/`. Executables receive an ad-hoc signature by default. Set
`WELDALL_CODESIGN_IDENTITY` to a macOS signing identity when producing distributable builds.

Install or remove an extracted executable with:

```sh
install -m 0755 weldall /usr/local/bin/weldall
rm /usr/local/bin/weldall
```
