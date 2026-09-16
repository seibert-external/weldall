---
title: "How to: Develop locally"
description: Run the authorization server, development identity provider, demo API, and documentation site from this repository.
sidebar:
  label: "How to: Develop locally"
---

The repository runs as four local processes: the authorization server with the administration interface, the demo expenses API, a passwordless development identity provider, and this documentation site. Use a disposable database; the development seed writes demo records.

## Prerequisites

- macOS or Linux (WSL2 on Windows).
- Git and Node.js 24. The minimum version is in the root `package.json`.
- pnpm in the pinned `packageManager` version. `corepack enable` installs it.
- Docker with a running daemon, and [Caddy](https://caddyserver.com/docs/install) for local HTTPS.
- Free ports 80/443, 3000–3002, 4321, and 5433.

## 1. Install and configure

```sh
git clone https://github.com/seibert-external/weldall.git
cd weldall
pnpm install --frozen-lockfile

# Signing keys and secrets. Refuses to overwrite an existing .env.
(umask 077; set -C; pnpm --silent secrets:generate > .env)
```

Keep an existing `.env`: its keys belong to your database. `.env.example` lists the variables but contains no usable values.

Start a database that listens on localhost only:

```sh
docker run --name weldall-dev-postgres \
  -e POSTGRES_PASSWORD=weldall-development \
  -p 127.0.0.1:5433:5432 \
  -v weldall-dev-postgres:/var/lib/postgresql/data \
  -d postgres:16-alpine
```

Point `POSTGRES_URL` in `.env` at it:

```dotenv
POSTGRES_URL=postgresql://postgres:weldall-development@127.0.0.1:5433/postgres
```

Later sessions need only `docker start weldall-dev-postgres`. Keep `WELDALL_DEPLOYMENT_MODE=development` and `NODE_USE_SYSTEM_CA=1`.

## 2. Initialize the database

```sh
pnpm db:generate
pnpm --filter @weldall/db build
pnpm --filter @weldall/sdk build
pnpm db:migrate:deploy
pnpm db:seed:development
```

The seed writes demo resources and skills, installs the "Development login" provider, and completes setup for `alice@example.com` with admin and login scopes.

## 3. Start the stack

```sh
# /etc/hosts entries for *.seibert.localdev. May ask for sudo.
sh scripts/setup-hosts.sh

# Terminal 1: local HTTPS. Run `caddy trust` once if the browser or Node rejects the CA.
caddy run --config Caddyfile

# Terminal 2
pnpm dev
```

| Application                      | Address                             |
| -------------------------------- | ----------------------------------- |
| Administration interface and API | `https://weldall.seibert.localdev`  |
| Demo expenses API                | `https://expenses.seibert.localdev` |
| Development identity provider    | `https://dev-idp.seibert.localdev`  |
| Documentation                    | `http://localhost:4321`             |

Open `https://weldall.seibert.localdev`, choose **Development login**, and confirm the prefilled `alice@example.com`. Only this address receives scopes from the development seed. Every other `@example.com` address also gets a session, but without scopes, so the administration interface and the CLI stay closed to it.

:::note
The development identity provider is passwordless and verifies whatever address you enter. Keep it reachable on your machine only.
:::

Provider callbacks use `https://weldall.seibert.localdev/api/auth/callback/<provider-id>`. Restart the processes after changing `.env`; editing a provider in the administration interface takes effect immediately.

## 4. Log in with the CLI

```sh
pnpm --filter @weldall/cli build
export NODE_USE_SYSTEM_CA=1
./apps/cli/dist/index.js config set-issuer https://weldall.seibert.localdev
./apps/cli/dist/index.js login
```

This changes the issuer the CLI stores. Switch it back before you point the CLI at another installation.

## 5. Test the real installer

To walk through `/setup` the way an operator does, use a second, empty database. Export its URL as `POSTGRES_URL`, run the commands from step 2, and seed with `pnpm db:seed:production` instead of `pnpm db:seed:development`. Then enter the values described in [How to: Set up Weldall](../weldall-setup/): the setup token from `.env`, `alice@example.com`, the issuer `https://dev-idp.seibert.localdev`, `DEV_IDP_CLIENT_ID`, `DEV_IDP_CLIENT_SECRET`, `client_secret_post`, the scopes `openid profile email`, and the domain `example.com`. The first provider keeps the fixed callback ID `00000000-0000-4000-8000-000000000001`.

## Checks

`pnpm test` writes to the database it points at.

```sh
pnpm format:check
pnpm check
pnpm typecheck
pnpm test
pnpm build:dev
pnpm test:e2e
```

:::note[Test database]
Export a disposable test database as `POSTGRES_URL` and migrate and seed it before running `pnpm test`. The PostgreSQL OIDC suite additionally needs `psql` and `OIDC_TEST_SERVER_URL`; it creates and drops uniquely named databases and skips without that variable. CI requires it.
:::

`pnpm test:e2e` brings up its own Docker stack with the production Next build. It needs neither Caddy nor trust-store changes on the host.

## Shutdown

Ctrl+C stops `pnpm dev` and Caddy. `docker stop weldall-dev-postgres` stops the database; the named volume keeps its data.

## Next steps

- [How to: Set up Weldall](../weldall-setup/) — deploy an instance.
- [Documentation site](https://github.com/seibert-external/weldall/blob/main/apps/docs/README.md) — work on this site alone.
- [Python SDK](https://github.com/seibert-external/weldall/blob/main/packages/python-sdk/README.md) — uses uv instead of pnpm.
