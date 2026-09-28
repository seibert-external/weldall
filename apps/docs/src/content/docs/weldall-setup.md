---
title: "How to: Set up Weldall"
description: Deploy a Weldall instance and configure it for first use.
sidebar:
  label: "How to: Set up Weldall"
---

Running Weldall yourself means operating a single container. The image `docker.io/seibertmediagmbh/weldall` contains the authorization server and the administration interface; [Docker images](../docker/) covers tags, upgrades and the database. The image requires a PostgreSQL database, a defined set of environment variables, and a publicly reachable HTTPS URL. Once these requirements are met, the instance serves the web installer: it connects your identity provider and creates the first administrator account. [How to: Run the installer](../installer/) walks through it.

This page assumes basic knowledge of Weldall. The [introduction](../) describes the product.

## What the container contains

The image runs the Weldall server as a standalone Next.js application. Startup performs the following steps:

1. The database migrations run with Prisma.
2. The production database is initialized, and published skill catalogs are refreshed.
3. The server starts on port 3000 and serves the installer under `/setup` until an installation is complete.

The container runs as a non-root user and exposes a health check on `/.well-known/openid-configuration`. It can therefore be connected directly to the readiness checks of your container platform.

## Prerequisites

Before building and starting the image, the following requirements must be met:

- **A PostgreSQL database** – Weldall stores configuration and audit records in PostgreSQL.
- **A public HTTPS URL** – Employees sign in through this URL; it must be reachable and use HTTPS. The same URL is used for `WELDALL_ISSUER` and for the login redirect.
- **A central identity provider** – Weldall has no local accounts; employees sign in through your company's IdP. Any OIDC provider works. The installer asks for its issuer and a client, see [How to: Run the installer](../installer/).
- **A signing key pair** – Weldall signs its JWTs (ID-JAGs) with an ES256 (P-256) key pair.

## Environment variables

If a required variable is missing, the container aborts startup. This behavior is intentional: a partially configured instance is not operational and should not start in the first place.

| Variable                                                    | Purpose                                      |
| ----------------------------------------------------------- | -------------------------------------------- |
| `POSTGRES_URL`                                              | Connection string for PostgreSQL.            |
| `WELDALL_ISSUER`                                            | Public HTTPS URL of the instance.            |
| `BETTER_AUTH_SECRET`                                        | Secret used to sign browser session cookies. |
| `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK` | The ES256 signing key pair as JWK.           |
| `WELDALL_SIGNING_KID`                                       | Key ID that identifies the signing key.      |

:::note[Signing keys]
The ES256 key pair is generated once and kept in your secret manager. The JWKs and the key ID must remain stable: rotating the key would invalidate already-issued identity assertions.
:::

Required for the installer:

| Variable                            | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `WELDALL_SETUP_TOKEN`               | Base64url token from at least 32 random bytes that authorizes setup. |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY` | Base64-encoded 32-byte AES key that encrypts provider credentials.   |

The first start needs both: without them the installer stays closed.

For [connectors](../connectors/) using the default `LOCAL_ENV` setting, you also need `WELDALL_CONNECTOR_KEK`. Generate a separate key from 32 random bytes and encode it as base64. Keep it unchanged in your secret manager, separate from database backups. Anyone with both the database and the key can decrypt the stored connection credentials.

If you choose `OPENBAO` for a connector, it uses the two OpenBao variables below instead. See [Connectors](../connectors/#set-up-openbao) for setup instructions.

Optional variables – leave both OpenBao variables unset if you do not use OpenBao:

| Variable                | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `WELDALL_OPENBAO_HOST`  | OpenBao server address without a path, e.g. `https://openbao.example.com`.                |
| `WELDALL_OPENBAO_TOKEN` | Access token for OpenBao. Used only on the server; never written to the database or logs. |
| `LOG_LEVEL`             | Controls how much detail Weldall logs. Defaults to `INFO`.                                |

## Generate the secrets

Without a repository checkout, generate the secrets with the command in [Docker images](../docker/#generate-the-secrets). With a checkout, they come from the repository:

```sh
pnpm install --frozen-lockfile
pnpm secrets:generate
```

The command prints environment lines for the whole workspace. For the container, take `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK`, `WELDALL_SIGNING_KID`, `BETTER_AUTH_SECRET`, `WELDALL_SETUP_TOKEN` and `WELDALL_CREDENTIAL_ENCRYPTION_KEY` into your secret manager. Set `POSTGRES_URL` and `WELDALL_ISSUER` yourself.

:::note[Development entries]
Leave the rest of the output out: `WELDALL_DEPLOYMENT_MODE=development`, `NODE_USE_SYSTEM_CA`, `DEV_IDP_*`, `EXPENSES_*` and `DEV_M2M_*` belong to the local development stack. The container requires `WELDALL_DEPLOYMENT_MODE=production` and refuses to start with any other value.
:::

## Run

Start the published image with the configuration. Replace `X.Y.Z` with the version you install; [Docker images](../docker/#tags-and-versions) explains the tags:

```sh
docker run -d --name weldall \
  -p 3000:3000 \
  -e POSTGRES_URL=postgresql://user:password@db:5432/weldall \
  -e WELDALL_ISSUER=https://weldall.example.com \
  -e BETTER_AUTH_SECRET=... \
  -e WELDALL_SETUP_TOKEN=... \
  -e WELDALL_CREDENTIAL_ENCRYPTION_KEY=... \
  -e WELDALL_SIGNING_PRIVATE_JWK='...' \
  -e WELDALL_SIGNING_PUBLIC_JWK='...' \
  -e WELDALL_SIGNING_KID=... \
  docker.io/seibertmediagmbh/weldall:X.Y.Z
```

The container listens on port 3000. To build the image yourself, use the [Dockerfile](https://github.com/seibert-external/weldall/blob/main/Dockerfile) in the repository root with BuildKit enabled, which current Docker versions do by default.

## Run the installer

Open `https://weldall.example.com`. While no installation is complete, Weldall shows the installer: it asks for the operator setup token, the first administrator, and one OIDC client. [How to: Run the installer](../installer/) explains every field, the callback URL, and the optional test login.

The installer needs `WELDALL_SETUP_TOKEN` and `WELDALL_CREDENTIAL_ENCRYPTION_KEY`. Without them the page stays closed and names the missing variables.

The installer saves the provider, creates the first administrator with `weldall:administer` and `weldall:login`, and closes itself for good.

## After the installation

1. Create scopes, register resources and assign permissions in the administration interface. [How to: Integrate a service](../service-configuration/) describes the procedure.
2. Point the CLI at the instance on an employee device and sign in:

```sh
weldall config set-issuer https://weldall.example.com
weldall login
```

:::note
Weldall never grants `weldall:login` automatically from the identity provider. Assign the scope to users before their first CLI login.
:::

## Next steps

- Secure your own services with the SDK: [How to: Integrate a service](../service-configuration/).
- Manage settings, scopes, resources, and assignments as code: [Infrastructure as code](../infrastructure-as-code/).
- Understand the security flow implemented by this instance: [Security](../oauth-security/).
