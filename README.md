# Weldall tracer bullet

Public native OAuth CLI → Weldall/Google → database-backed downstream resource registry → ID-JAG draft-04 → JWT-DPoP draft-01 → DB-free APIs. `better-auth` and `@better-auth/oauth-provider` are pinned to `1.7.0-rc.2`. Weldall alone uses PostgreSQL; the demo downstream services have no database.

The same environment-provided Weldall ES256 key signs OAuth access tokens, ID tokens, and ID-JAGs and is published at `/api/oauth/jwks`. Expenses uses its own independent ES256 key. Device keys are generated per installation and stored with the rotating Weldall refresh token in macOS Keychain.

## Setup

1. Install Node 22.15.0 or newer, pnpm, PostgreSQL on port 5433, Caddy, and trust the Caddy local CA in macOS Keychain. The CLI requires macOS Keychain and uses Node's system CA store.
2. Run `pnpm install --frozen-lockfile` and `pnpm secrets:generate > .env`. The generator creates a complete local configuration, including PostgreSQL and a passwordless Development IdP test identity.
3. To enable Google, replace both `<<insert or delete line>>` placeholders in `.env`; otherwise delete both lines. Register exactly `http://localhost:3000/api/auth/callback/google`; `oAuthProxy` performs the encrypted, 60-second handoff to `https://weldall.seibert.localdev`.
4. Run `scripts/setup-hosts.sh`, then `pnpm db:generate && pnpm db:migrate:deploy`. The greenfield baseline registers the fixed public `weldall-cli` client, seeds the global scope catalog (including `weldall:administer`), and registers the Expenses downstream resource and its trusted `/api` request prefix.
5. Bootstrap the first administrator before opening the UI: `pnpm --filter @weldall/weldall admin:bootstrap --email alice@example.com`. The command is idempotent only for that first assignment and is permanently disabled afterwards. Further administrators are delegated through normal scope assignments; the final administrator cannot be removed.
6. Run `pnpm build:dev` once so the workspace package exports and CLI exist before starting the apps. This intentionally skips the production Next.js build, which would otherwise try OIDC discovery before the local Development IdP is running.

Use two separate foreground terminals (never background servers). Turbo starts Weldall, Expenses, and the Development IdP together:

```sh
pnpm dev
caddy run --config Caddyfile
```

Link the built macOS CLI, then smoke-test the actual `weldall` command:

```sh
(cd apps/cli && npm link)
weldall login
weldall scopes
weldall scopes --json
weldall skills
weldall skills show expenses.list
weldall request --scope expenses:read https://expenses.seibert.localdev/api/expenses
weldall request --method POST --scope expenses:create --json '{"description":"Train","amount":24}' https://expenses.seibert.localdev/api/expenses
weldall request --method DELETE --scope expenses:delete --scope expenses:write https://expenses.seibert.localdev/api/expenses/expense-1
weldall logout
```

For `pnpm --filter @weldall/ci dev ...` or direct `node apps/cli/dist/index.js ...` invocations, set `NODE_USE_SYSTEM_CA=1`; the linked `weldall` bin already starts Node with `--use-system-ca`.

Run the hermetic browser/CLI suite with `pnpm test:e2e`. Docker Compose creates fresh signing keys and secrets, PostgreSQL, the Development IdP, Caddy, Chromium, Weldall, and Expenses, then removes containers and volumes after the run.

The E2E stack uses generated identities, keys, and OAuth values and destroys its containers and volumes after each run. `request` calls Expenses directly; Weldall is not in the API data path.

## Prototype security boundary

There is no DPoP nonce. Proof and one-time-grant replay state is bounded and process-local, so each server must run as one process; restart resets replay state and horizontal scaling would partition it. OAuth Provider rc.2 hardcodes a database-backed DPoP store, so `patches/@better-auth__oauth-provider@1.7.0-rc.2.patch` narrowly replaces its two native DPoP call sites with one module-scoped `createInMemoryDpopReplayStore()` singleton. Re-review this patch before changing the pinned prerelease.

User policy and the downstream resource registry are database-backed. `/resources` manages immutable resource keys and identifiers, authorization-server origins, downstream client IDs, trusted request prefixes, supported global scopes, and enabled state. `/scopes` manages immutable global scope keys and descriptions; `/assignments` independently replaces normalized email-to-scope sets. `/skills` contains the agent-facing Skill Registry. Resource changes never create or remove user grants, use optimistic locking, and are audited. Scope deletion is blocked while a skill or resource references the scope. `weldall:administer` is a protected system scope, and all admin reads and mutations run through authenticated tRPC procedures with shared authorization and request-origin middleware.

`weldall request` resolves the complete target URL against the live registry before token exchange. Origins must match exactly and paths match on segment boundaries; query strings are allowed. The CLI never follows redirects and refuses unregistered, ambiguous, or disabled targets before sending a downstream token or request body. Human-readable `weldall scopes` output contains only service names and granted scopes; `--json` exposes the technical registry contract.

## Change intents and CLI releases

This workspace uses pnpm 11's native change intents. Release-affecting pull requests run
`pnpm change` at the repository root and commit the generated `.changeset/*.md` file. Use
`pnpm change status` (or `pnpm changes:status`) to review the pending workspace release plan. A
`none` intent can record that a change deliberately requires no package release.

Prepare versions with `pnpm version -r --dry-run`, then `pnpm release:version` and `pnpm install`.
Commit the resulting package versions, repository changelogs, `.changeset/ledger.yaml`, and lockfile.
Only `@weldall/ci` is published to npm; a protected `ci-v<version>` tag triggers the Forgejo workflow.
The tag must match `apps/cli/package.json` exactly.

## Validation

See [`security-testing.md`](security-testing.md) for the standards traceability and attack matrix.

```sh
pnpm db:generate
POSTGRES_URL=postgresql://postgres@localhost:5433/postgres pnpm db:migrate:deploy
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
caddy validate --config Caddyfile
bash -n scripts/setup-hosts.sh
```
