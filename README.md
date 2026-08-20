# Weldall

Weldall is an access-control system for letting employees, software agents, and backend machines use company APIs without handing credentials to the agent. Employees authenticate through the organization's identity provider; machines authenticate as their own registered identities; administrators define scopes, assignments, resources, machine access with independent resource and scope allowlists, and agent-facing skills; the local CLI discovers those capabilities and sends DPoP-authenticated requests directly to registered services.

The CLI is one important component, not the whole system:

```text
employee + browser ──sign-in──> Weldall authorization server
administrator ──policy/admin──> Weldall web app ──> PostgreSQL
agent ──commands──> Weldall CLI ──grants / ID-JAG──> Weldall
                              └──token exchange + API request──> resource server + @weldall/sdk
machine ──private_key_jwt + DPoP──> Weldall ──machine JWT──> resource server
```

## Major components

- **Weldall server and admin UI** — a Next.js authorization server and control plane backed by PostgreSQL. It handles upstream sign-in, native CLI OAuth, machine client administration, scope policy, the resource registry, skill catalogs, assignments, and audit events.
- **Weldall CLI** — a cross-platform npm package with experimental standalone executables for Ubuntu x64, Windows x64, and macOS ARM64/x64. It supports native YAML IaC, interactive OAuth, capability discovery, and authenticated user requests while keeping sessions in the operating system's secure credential store.
- **Pi extension** — the published `@weldall/pi` package loads the signed-in user's administrator-managed skills through the npm-installed CLI and exposes them as namespaced Pi commands.
- **Resource-server SDK** — the published `@weldall/sdk` package for Fetch, Hono, Next.js, and Astro services. It verifies DPoP-bound requests, exposes OAuth metadata and token endpoints, and can publish service-owned skills.
- **Supporting services** — the Prisma database package, a local Development IdP, an Expenses resource-server example, documentation, framework examples, and the Playwright/Docker E2E system.

For a protocol-level walkthrough, read [A complete agent run](apps/docs/src/content/docs/en/agent-run.mdx). For service integration, see [How to integrate a service](apps/docs/src/content/docs/en/service-configuration.md), [Machine authentication](apps/docs/src/content/docs/en/machine-authentication.mdx), and the [`@weldall/sdk` reference](packages/sdk/README.md).

## Workspace map

[`pnpm-workspace.yaml`](pnpm-workspace.yaml) includes every directory under `apps/*`, `examples/*`, `packages/*`, and `tooling/*`.

| Workspace                                       | Purpose                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@weldall/cli`](apps/cli/)                     | Cross-platform npm CLI with experimental standalone binaries for IaC automation and interactive user sessions. See its [package README](apps/cli/README.md).          |
| [`@weldall/dev-idp`](apps/dev-idp/)             | Local-only Hono OpenID Connect provider that offers passwordless selection among test identities from `DEV_IDP_USERS_JSON`.                                           |
| [`@weldall/docs`](apps/docs/)                   | Astro Starlight documentation site with German pages and English translations. See its [README](apps/docs/README.md).                                                 |
| [`@weldall/e2e`](apps/e2e/)                     | Playwright black-box tests for the Docker Compose stack, browser authorization flow, real CLI, and protected APIs.                                                    |
| [`@weldall/expenses`](apps/expenses/)           | Hono demo resource server protected by `@weldall/sdk`; implements read, create, and all-of-scope delete operations and publishes the `expenses.review` skill.         |
| [`@weldall/weldall`](apps/weldall/)             | Private Next.js authorization server, employee APIs, and administration UI for users, scopes, assignments, resources, groups, skills, CLI settings, and audit events. |
| [`@weldall/example-astro`](examples/astro/)     | Astro 7 Node SSR example using SDK middleware, request-local auth, and endpoint handlers.                                                                             |
| [`@weldall/example-basic`](examples/basic/)     | Framework-neutral Fetch example exporting `verify` and `verifyNoThrow`.                                                                                               |
| [`@weldall/example-hono`](examples/hono/)       | Standalone Hono example that registers SDK infrastructure routes and protects an Expenses endpoint.                                                                   |
| [`@weldall/example-next`](examples/next/)       | Next.js 16 App Router example using Node.js route handlers and the SDK's Next.js adapter.                                                                             |
| [`@weldall/db`](packages/db/)                   | Private Prisma package containing the PostgreSQL schema, generated client export, migrations, production initialization, and development seed data.                   |
| [`@weldall/pi`](packages/pi/)                   | Published Pi extension for loading and activating administrator-managed Weldall skills. See its [package README](packages/pi/README.md).                              |
| [`@weldall/sdk`](packages/sdk/)                 | Published resource-server SDK and Fetch, Hono, Next.js, and Astro adapters. See its [package README](packages/sdk/README.md).                                         |
| [`@weldall/eslint-config`](tooling/eslint/)     | Shared ESLint flat configuration for TypeScript workspaces.                                                                                                           |
| [`@weldall/prettier-config`](tooling/prettier/) | Shared Prettier configuration, including Astro formatting support.                                                                                                    |
| [`@weldall/tsconfig`](tooling/typescript/)      | Shared TypeScript configuration bases used by repository packages and apps.                                                                                           |

## Install and use the CLI

### npm (recommended)

The npm package supports Ubuntu, Windows 10 version 1809 or newer, Windows Server 2019 or newer, and current macOS releases. It requires Node.js 22.15 or newer.

```sh
npm install --global @weldall/cli@latest
weldall --version
weldall config set-issuer https://weldall.example.com
weldall login
```

### Experimental standalone binaries

Standalone binaries require no Node.js, npm, or Bun. Initial targets are Linux x64, Windows x64, and macOS ARM64/x64. They are currently unsigned. Download the appropriate asset from [GitHub Releases](https://github.com/seibert-external/weldall/releases).

```sh
# macOS, after downloading the trusted binary
xattr -d com.apple.quarantine ./weldall
chmod +x ./weldall

# Linux
chmod +x ./weldall
```

Windows PowerShell: `Unblock-File .\\weldall.exe`.

### Command overview

Run `weldall --help` or any command with `--help` for the authoritative installed-version help.

| Command                                    | What it does                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `weldall` / `weldall --help`               | Shows command help and a cached organization-provided CLI appendix.                  |
| `weldall config set-issuer <https-origin>` | Validates and saves the platform's non-secret issuer preference.                     |
| `weldall config get-issuer [--json]`       | Prints the effective issuer and whether it came from the environment or preferences. |
| `weldall config reset-issuer`              | Removes the saved preference; it does not unset `WELDALL_ISSUER`.                    |
| `weldall login`                            | Opens a browser for native OAuth login and explicit consent.                         |
| `weldall logout`                           | Attempts remote revocation, then removes the current issuer's saved session.         |
| `weldall status [--json]`                  | Shows the signed-in identity, assigned scopes, and available APIs.                   |
| `weldall whoami [--json]`                  | Shows the signed-in name, verified email, issuer, and account ID.                    |
| `weldall scopes [--json]`                  | Lists assigned scopes; JSON also exposes the live resource/grant registry.           |
| `weldall skills [--json]`                  | Lists visible skills.                                                                |
| `weldall skills list [--json]`             | Explicit form of `weldall skills`.                                                   |
| `weldall skills show <skill-id> [--json]`  | Prints one complete organization- or resource-published skill document.              |
| `weldall request [options] <url>`          | Sends an authenticated request to a registered HTTPS target.                         |

A typical inspection flow is:

```sh
weldall status
weldall whoami --json
weldall scopes
weldall scopes --json
weldall skills
weldall skills show expenses.review
```

### Authenticated requests

Every request requires an absolute HTTPS URL and at least one repeatable `--scope` (`-s`). Supported methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`; the default is `GET`.

```sh
# Read JSON
weldall request \
  --scope expenses:read \
  https://expenses.example.com/api/expenses

# Send JSON
weldall request \
  --method POST \
  --scope expenses:create \
  --json '{"description":"Train","amount":24}' \
  https://expenses.example.com/api/expenses

# Require multiple scopes (all listed scopes are requested)
weldall request \
  -X DELETE \
  -s expenses:delete \
  -s expenses:write \
  https://expenses.example.com/api/expenses/expense-1
```

Request options are:

| Option                              | Meaning                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `-X, --method <method>`             | HTTP method; defaults to `GET`.                                                                              |
| `-s, --scope <scope>`               | Required permission; repeat for multiple scopes.                                                             |
| `-H, --header 'Name: value'`        | Additional header; repeatable. Weldall owns `Authorization`, `DPoP`, `Host`, `Content-Length`, and `Cookie`. |
| `-d, --data <text>`                 | Raw text body.                                                                                               |
| `-j, --json <json>`                 | Parsed JSON body.                                                                                            |
| `-T, --upload-file <path>`          | Binary-safe raw file body; defaults to `application/octet-stream`.                                           |
| `-F, --form 'name=value'`           | Multipart text field. Repeatable.                                                                            |
| `-F, --form 'name=@path;type=MIME'` | Multipart file field. Weldall generates `Content-Type` and its boundary.                                     |
| `-o, --output <path>`               | Atomically replace a file with the successful response body; use `-` for stdout.                             |

The four body modes (`--data`, `--json`, `--upload-file`, and `--form`) are mutually exclusive, and `GET`/`HEAD` cannot carry a body. Binary responses require `--output`. Target URLs cannot contain credentials or fragments. Query strings are allowed.

Before sending a token or body, the CLI matches the URL's exact origin and path-segment prefix against one enabled Resource Registry entry, verifies that every requested scope is supported and granted, and rejects ambiguous or unregistered targets. It never follows redirects.

The protected system scope `weldall:login` must be effective for CLI authorization, CLI token refresh, and ID-JAG issuance. It may be assigned directly to an email or through a provider group, and it does not gate browser UI login or browser sessions. Group-derived access is resolved live without a server-side provider or membership cache; provider failures, disabled providers, membership removal, and provider-version changes fail closed for group-derived scopes while independent direct grants remain effective. Revocation blocks new CLI login, refresh, and ID-JAG issuance; already-issued CLI access tokens expire normally. Protected system scopes are also available as downstream-resource supported scopes and as manual or resource-published skill requirements. Their protected metadata still prevents scope-definition changes and deletion. The fixed public `weldall-cli` client also requires explicit approval for every native login. The CLI sends `prompt=consent`, the authorization route enforces that prompt server-side, and the client registration refuses to skip consent. A process with access to an existing browser session therefore cannot silently mint a new CLI session by omitting the prompt.

## Local development

### Prerequisites

- Ubuntu, macOS, or Windows for native CLI development; the secure-store flow uses Secret Service/keyutils, Keychain, or Credential Manager respectively
- Node.js 22.15.0 or newer
- pnpm 11.15.1 (the version declared in [`package.json`](package.json))
- PostgreSQL reachable at `localhost:5433`
- Caddy, with permission to trust its local CA and update `/etc/hosts`
- Docker with Compose only for `pnpm test:e2e`

### One-time setup

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm secrets:generate > .env
```

The generated file enables the Development IdP and creates local OAuth, encryption, and ES256 signing secrets. For local development without Google, delete the generated `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` placeholder lines. To test Google too, replace both placeholders and register exactly `http://localhost:3000/api/auth/callback/google`.

Prepare local DNS/TLS, the database, the test data, and workspace outputs:

```sh
scripts/setup-hosts.sh
sudo caddy trust
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed:development
pnpm --filter @weldall/weldall admin:bootstrap --email alice@example.com
pnpm build:dev
```

The development seed includes the Expenses scopes and resource described below, plus 100 demonstration skills across finance, human resources, contract management, sales, support, procurement, compliance, operations, marketing, and engineering. It also registers the read-only `dev-expenses-reader` machine using the public half of the `DEV_M2M_SIGNING_*` key pair generated in `.env`; production seeding does not create this machine. `admin:bootstrap` grants the first administrator the protected `weldall:login` and `weldall:administer` scopes; after that first assignment, CLI access and administration are delegated through normal email or provider-group assignments. Rerunning bootstrap does not restore a revoked login scope.

Start long-running processes in two foreground terminals:

```sh
# Terminal 1: Weldall, Expenses, Development IdP, and documentation
pnpm dev

# Terminal 2: local HTTPS proxy
caddy run --config Caddyfile
```

Open `https://weldall.seibert.localdev`, choose the Development Login identity `alice@example.com`, and inspect the admin pages. The three Caddy-proxied endpoints are:

- Weldall: `https://weldall.seibert.localdev`
- Expenses: `https://expenses.seibert.localdev`
- Development IdP: `https://dev-idp.seibert.localdev`

Exercise the seeded machine's complete client-credentials and DPoP flow against Expenses:

```sh
pnpm m2m:demo
```

The command reads the machine's private key from the gitignored `.env`, requests an `expenses:read` machine token from Weldall, calls the Expenses API, and verifies the returned machine identity. It does not print credentials or tokens.

Build and invoke the repository CLI directly:

```sh
pnpm --filter @weldall/cli build
./apps/cli/dist/index.js --help
./apps/cli/dist/index.js config set-issuer https://weldall.seibert.localdev
./apps/cli/dist/index.js login
```

The built executable's shebang enables Node's system CA store. If you instead run `node apps/cli/dist/index.js` or `tsx src/index.ts`, set `NODE_USE_SYSTEM_CA=1`. On macOS, `pnpm cli:link` builds and links the same executable as `weldall`; run it before the shorter `weldall ...` examples below, or keep using `./apps/cli/dist/index.js`.

### Reset the local database

These commands are intentionally destructive:

```sh
# Development data: production initialization plus demo resources
pnpm db:reset:hard -- development

# Production-safe initialization only
WELDALL_DEPLOYMENT_MODE=production \
  pnpm db:reset:hard -- production --confirm-production-reset
```

When `WELDALL_DEPLOYMENT_MODE` is set, it must match the positional mode.

## Example company workflow: controlled expense operations

Imagine a company giving Alice's agent limited access to its Expenses service. This is not an invented model: it uses the repository's development seed and the policies enforced by `apps/expenses`.

The seed creates four **global scopes**:

| Scope                                | Protected operation                                  |
| ------------------------------------ | ---------------------------------------------------- |
| `expenses:read`                      | `GET /api/expenses`                                  |
| `expenses:create`                    | `POST /api/expenses`                                 |
| `expenses:delete` + `expenses:write` | `DELETE /api/expenses/:id`; both scopes are required |

It also registers this **downstream resource**:

| Resource field            | Seeded value                            |
| ------------------------- | --------------------------------------- |
| Key / name                | `expenses` / `Expenses`                 |
| Resource identifier       | `https://expenses.seibert.localdev/api` |
| Authorization server      | `https://expenses.seibert.localdev`     |
| Downstream client ID      | `weldall-cli-at-expenses`               |
| Request prefix            | `https://expenses.seibert.localdev/api` |
| Supported scopes          | all four `expenses:*` scopes above      |
| Enabled / discover skills | yes / yes                               |

The Expenses service publishes a local skill ID `review`; Weldall prefixes it with the resource key and exposes `expenses.review`.

1. In `https://weldall.seibert.localdev/assignments`, edit Alice's bootstrapped assignment. Keep `weldall:login` and `weldall:administer`, and add only `expenses:read` and `expenses:create`.
2. Sign in and inspect the effective policy:

   ```sh
   weldall login
   weldall status
   weldall scopes --json
   weldall skills
   weldall skills show expenses.review
   ```

3. Read and create expenses:

   ```sh
   weldall request --scope expenses:read \
     https://expenses.seibert.localdev/api/expenses

   weldall request --method POST --scope expenses:create \
     --json '{"description":"Train","amount":24}' \
     https://expenses.seibert.localdev/api/expenses
   ```

4. Try the delete policy while Alice lacks its scopes:

   ```sh
   weldall request --method DELETE \
     --scope expenses:delete \
     --scope expenses:write \
     https://expenses.seibert.localdev/api/expenses/expense-1
   ```

   The CLI rejects the request before the Expenses handler runs because the assignment does not grant both requested scopes.

5. In the assignment UI, retain Alice's existing scopes and add `expenses:delete` and `expenses:write`. Run `weldall scopes` to inspect the live change, then repeat the delete command. The resource server independently enforces the same all-of-scope policy.

This flow separates capability description from authorization: the skill explains how to review expenses, the assignment grants Alice scopes, the resource limits where those scopes can be used, and the service still protects each route.

## Key concepts

- **Issuer** — the Weldall authorization-server HTTPS origin selected by the CLI.
- **Scope** — a global permission key with lowercase `namespace:permission` syntax, for example `expenses:read`. A scope does nothing until it is both assigned to an identity and supported by a resource.
- **Assignment** — a set of scopes attached directly to a normalized email address. Weldall can also union scopes from configured external group assignments; see the [group-provider HTTP contract](apps/docs/src/content/docs/en/group-provider-http-interface.md).
- **Resource** — a registered downstream service contract: immutable key and resource identifier, authorization-server origin, downstream client ID, allowed request prefixes, supported scopes, enabled state, and optional skill discovery.
- **Machine client** — a registered machine identity that uses RFC 7523 `private_key_jwt` and DPoP to obtain five-minute Weldall-issued access tokens when the resource and scopes are independently selected and the resource supports every requested scope. See [Machine authentication](apps/docs/src/content/docs/en/machine-authentication.mdx).
- **Request prefix** — an allowed HTTPS origin/path prefix matched on path-segment boundaries. It constrains where the CLI may send a resource token or request data.
- **Skill** — administrator- or resource-published Markdown instructions with required scopes. `DEFAULT` skills remain visible and report missing scopes; `HIDDEN_IF_UNALLOWED` skills are hidden until all required scopes are granted. Visibility never replaces route authorization.
- **Effective scopes** — the sorted union of direct email grants and currently resolved group grants. Resource grants are the intersection of effective scopes and that resource's supported scopes.
- **ID-JAG and DPoP** — Weldall issues a short-lived identity assertion for one resource, client, scope set, and device key. The resource exchanges it and requires DPoP-bound requests. The agent never receives the token material.

The [`@weldall/sdk` README](packages/sdk/README.md) is the deeper reference for route protection, skill catalogs, framework adapters, signing keys, and replay stores.

## Build and test

After installing dependencies and generating `.env`, prepare PostgreSQL as shown in [One-time setup](#one-time-setup). The repository's standard checks are:

```sh
pnpm format:check
pnpm check
pnpm typecheck
pnpm test
pnpm build:dev
```

`build:dev` builds all normal workspace outputs except the Weldall production Next.js app, whose build performs live OIDC discovery. Use `pnpm build` only when its configured issuer and identity-provider dependencies are reachable.

Useful targeted commands:

```sh
pnpm --filter @weldall/cli test
pnpm --filter @weldall/cli pack:check
pnpm --filter @weldall/pi test
pnpm --filter @weldall/pi pack:check
pnpm --filter @weldall/sdk test
pnpm --filter @weldall/sdk pack:check
pnpm --filter @weldall/docs build
```

With Docker running, the hermetic E2E command creates PostgreSQL, fresh signing material, the Development IdP, Caddy, Chromium, Weldall, Expenses, and the real CLI, then removes containers and volumes:

```sh
pnpm test:e2e
```

Set `KEEP_E2E_ARTIFACTS=1` only when you intentionally want to retain Playwright artifacts for debugging. See [`testing.md`](testing.md), [`security-testing.md`](security-testing.md), and [the CI workflow](.github/workflows/ci.yml) for the test layers and current automation.

## Operations and contributing

- Production deployment: [Coolify deployment guide](docs/coolify.md)
- Audit event semantics and privacy boundary: [Audit logs](docs/audit-logs.md)
- Documentation development: [`apps/docs/README.md`](apps/docs/README.md)
- Resource SDK and production constraints: [`packages/sdk/README.md`](packages/sdk/README.md)

Changes to a published package need a Changeset when they affect the release:

```sh
pnpm changeset
pnpm changeset:status
```

Select the affected package (`@weldall/cli`, `@weldall/pi`, or `@weldall/sdk`), choose the SemVer bump, and commit the generated `.changeset/*.md`. Documentation, tests, and internal-only changes that do not alter a published package do not need an empty Changeset.

The published CLI, Pi extension, and SDK packages declare Apache-2.0 licensing in their package manifests; the CLI and SDK also carry package-local license copies at [`apps/cli/LICENSE`](apps/cli/LICENSE) and [`packages/sdk/LICENSE`](packages/sdk/LICENSE).
