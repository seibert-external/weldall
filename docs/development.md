# Local development

This guide runs the authorization server, development identity provider, demo expenses API, and documentation site locally. Use a dedicated development database: the demo seed changes records and must not run against production.

## Prerequisites

Use macOS or Linux (WSL2 on Windows), with:

- Git and Node.js 24. The minimum supported Node version is recorded in the root `package.json`.
- pnpm at the version in the root `package.json` (`packageManager`). With Corepack installed, run `corepack enable`; otherwise install that exact pnpm version.
- Docker with a running daemon, and [Caddy](https://caddyserver.com/docs/install) for local HTTPS.
- Free ports 80/443 (Caddy), 3000–3002 (applications), 4321 (docs), and 5433 (database).

Run the following commands from the repository root.

## Install and configure

```sh
git clone https://github.com/seibert-external/weldall.git
cd weldall
pnpm install --frozen-lockfile

# Creates fresh development keys and enables the local-only login provider.
# Refuses to overwrite an existing .env. Keep that file private.
(umask 077; set -C; pnpm --silent secrets:generate > .env)
```

If `.env` already exists, keep it rather than replacing keys used by your database. A failed generation can leave a partial file; inspect it locally before retrying. `.env.example` documents the available variables but does not contain usable keys.

Start a database bound only to localhost:

```sh
docker run --name weldall-dev-postgres \
  -e POSTGRES_PASSWORD=weldall-development \
  -p 127.0.0.1:5433:5432 \
  -v weldall-dev-postgres:/var/lib/postgresql/data \
  -d postgres:16-alpine
```

This password is for this local development container only. On later sessions, use `docker start weldall-dev-postgres` instead. Wait until `docker exec weldall-dev-postgres pg_isready -U postgres` succeeds.

In the generated `.env`, replace the `POSTGRES_URL` line with:

```dotenv
POSTGRES_URL=postgresql://postgres:weldall-development@127.0.0.1:5433/postgres
```

Keep `WELDALL_DEPLOYMENT_MODE=development`, `ENABLE_DEV_LOGIN=true`, and `NODE_USE_SYSTEM_CA=1`. Google credentials are unnecessary for the development provider; the generated placeholders are ignored. Never expose the passwordless development identity provider to an untrusted network.

## Initialize the database

```sh
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed:development
pnpm --filter @weldall/db build
pnpm --filter @weldall/sdk build
pnpm admin:bootstrap --email alice@example.com
```

The seed installs demonstration resources and skills. Bootstrap grants the generated development identity, `alice@example.com`, the administrator and login scopes. It does not grant access to every demo resource; assign those scopes in the administration UI as needed.

## Configure local HTTPS and start the stack

```sh
# Adds the three *.seibert.localdev names to /etc/hosts; may request sudo.
sh scripts/setup-hosts.sh

# Keep running in a separate terminal; use the checked-in Caddyfile.
caddy run --config Caddyfile
```

Caddy's local CA must be trusted by your browser and Node. Caddy attempts to install it automatically; if needed, run `caddy trust` while Caddy is running and approve the trust-store prompt. Use the same user for Caddy and its trust command. Port binding may require platform-specific permission for ports 80/443. Do not disable certificate verification to work around trust errors.

In another terminal, from the repository root:

```sh
pnpm dev
```

Open <https://weldall.seibert.localdev> and choose the development login provider, then Alice. The other applications are:

| Application                   | Address                             |
| ----------------------------- | ----------------------------------- |
| Demo expenses API             | `https://expenses.seibert.localdev` |
| Development identity provider | `https://dev-idp.seibert.localdev`  |
| Documentation                 | `http://localhost:4321`             |

The local login callback intentionally uses `http://localhost:3000`; keep that port accessible. `pnpm dev` builds workspace dependencies before starting the applications. Restart the development processes after changing `.env`.

To try the CLI, run `pnpm --filter @weldall/cli build`, then:

```sh
./apps/cli/dist/index.js config set-issuer https://weldall.seibert.localdev
./apps/cli/dist/index.js login
```

This changes the CLI's saved issuer; switch it back before using a different installation.

## Checks and shutdown

```sh
pnpm format:check
pnpm check
pnpm typecheck
pnpm test
pnpm build:dev
pnpm test:e2e
```

The E2E command uses a separate Docker stack and production Next build. Its hostnames and certificate trust are configured inside the containers; it does not need the local Caddy process or host trust-store changes.

Stop `pnpm dev` and Caddy with Ctrl+C; stop the development database with `docker stop weldall-dev-postgres`. The named volume retains its data.

For documentation-only work, see [`apps/docs/README.md`](../apps/docs/README.md). The Python SDK uses uv rather than pnpm; its setup and checks are in [`packages/python-sdk/README.md`](../packages/python-sdk/README.md). Production deployment is documented in the [deployment guide](../apps/docs/src/content/docs/weldall-setup.md), not this development recipe.
