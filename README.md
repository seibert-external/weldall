# Weldall tracer bullet

Public native OAuth CLI → Weldall/Google → ID-JAG draft-04 → JWT-DPoP draft-01 → DB-free Expenses API. `better-auth` and `@better-auth/oauth-provider` are pinned to `1.7.0-rc.2`. Weldall alone uses PostgreSQL; Expenses has no database.

The same environment-provided Weldall ES256 key signs OAuth access tokens, ID tokens, and ID-JAGs and is published at `/api/oauth/jwks`. Expenses uses its own independent ES256 key. Device keys are generated per installation and stored with the rotating Weldall refresh token in macOS Keychain.

## Setup

1. Install Node 22.15.0 or newer, pnpm, PostgreSQL on port 5433, Caddy, and trust the Caddy local CA in macOS Keychain. The CLI requires macOS Keychain and uses Node's system CA store.
2. Run `pnpm install --frozen-lockfile` and `pnpm secrets:generate > .env`. The generator creates a complete local configuration, including PostgreSQL and a passwordless Development IdP test identity.
3. To enable Google, replace both `<<insert or delete line>>` placeholders in `.env`; otherwise delete both lines. Register exactly `http://localhost:3000/api/auth/callback/google`; `oAuthProxy` performs the encrypted, 60-second handoff to `https://weldall.seibert.localdev`.
4. Run `scripts/setup-hosts.sh`, then `pnpm db:generate && pnpm db:migrate:deploy`. The migrations register the fixed public `weldall-cli` client and seed the global scope catalog, including the built-in `weldall:administer` scope.
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
weldall scopes --resource expenses
weldall skills
weldall skills show expenses.list
weldall request --scope expenses:read https://expenses.seibert.localdev/api/expenses
weldall request --method POST --scope expenses:create --json '{"description":"Train","amount":24}' https://expenses.seibert.localdev/api/expenses
weldall request --method DELETE --scope expenses:delete --scope expenses:write https://expenses.seibert.localdev/api/expenses/expense-1
weldall logout
```

For `pnpm --filter @weldall/cli dev ...` or direct `node apps/cli/dist/index.js ...` invocations, set `NODE_USE_SYSTEM_CA=1`; the linked `weldall` bin already starts Node with `--use-system-ca`.

Run the hermetic browser/CLI suite with `pnpm test:e2e`. Docker Compose creates fresh signing keys and secrets, PostgreSQL, the Development IdP, Caddy, Chromium, Weldall, and Expenses, then removes containers and volumes after the run.

The E2E stack uses generated identities, keys, and OAuth values and destroys its containers and volumes after each run. `request` calls Expenses directly; Weldall is not in the API data path.

## Prototype security boundary

There is no DPoP nonce. Proof and one-time-grant replay state is bounded and process-local, so each server must run as one process; restart resets replay state and horizontal scaling would partition it. OAuth Provider rc.2 hardcodes a database-backed DPoP store, so `patches/@better-auth__oauth-provider@1.7.0-rc.2.patch` narrowly replaces its two native DPoP call sites with one module-scoped `createInMemoryDpopReplayStore()` singleton. Re-review this patch before changing the pinned prerelease.

User policy is database-backed. `https://weldall.seibert.localdev/scopes` manages immutable global scope keys and descriptions; `/assignments` atomically replaces normalized email-to-scope sets. `/skills` contains the admin-managed Skill Registry exposed to agents through `weldall skills`. Scope deletion cascades through assignments while incrementing their versions and writing before/after audit events. `weldall:administer` is a protected system scope, and all admin reads and mutations run through authenticated tRPC procedures with shared authorization and request-origin middleware.

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
