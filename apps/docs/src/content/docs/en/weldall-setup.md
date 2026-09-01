---
title: "How to: Set up Weldall"
description: Deploy a Weldall instance and configure it for first use.
sidebar:
  label: "How to: Set up Weldall"
---

Running Weldall yourself means operating a single container. The repository contains a [Dockerfile](https://github.com/seibert-external/weldall/blob/main/Dockerfile) that builds the authorization server and the administration interface into one image. The image requires a PostgreSQL database, a defined set of environment variables, and a publicly reachable HTTPS URL. Once these requirements are met, the instance is operational: the administration interface, the OAuth endpoints, and the first administrator account are set up automatically on startup.

This page assumes basic knowledge of Weldall. The [introduction](../) describes the product.

## What the container contains

The image runs the Weldall server as a standalone Next.js application. Startup performs the following steps:

1. The database migrations run with Prisma.
2. The production database is initialized, and published skill catalogs are refreshed.
3. If an email address is configured, the first administrator account is created.
4. The server starts on port 3000.

The container runs as a non-root user and exposes a health check on `/.well-known/openid-configuration`. It can therefore be connected directly to the readiness checks of your container platform.

## Prerequisites

Before building and starting the image, the following requirements must be met:

- **A PostgreSQL database** – Weldall stores configuration and audit records in PostgreSQL.
- **A public HTTPS URL** – Employees sign in through this URL; it must be reachable and use HTTPS. The same URL is used for `WELDALL_ISSUER` and for the login redirect.
- **A Google OAuth client** – Sign-in uses Google as the SSO provider. The client is created in the Google Cloud Console; `<WELDALL_ISSUER>/api/auth/callback/google` is registered as the redirect URL.
- **A signing key pair** – Weldall signs its JWTs (ID-JAGs) with an ES256 (P-256) key pair.

## Environment variables

If a required variable is missing, the container aborts startup. This behavior is intentional: a partially configured instance is not operational and should not start in the first place.

| Variable                                                    | Purpose                                      |
| ----------------------------------------------------------- | -------------------------------------------- |
| `POSTGRES_URL`                                              | Connection string for PostgreSQL.            |
| `WELDALL_ISSUER`                                            | Public HTTPS URL of the instance.            |
| `BETTER_AUTH_SECRET`                                        | Secret used to sign browser session cookies. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                  | The Google OAuth client for SSO sign-in.     |
| `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK` | The ES256 signing key pair as JWK.           |
| `WELDALL_SIGNING_KID`                                       | Key ID that identifies the signing key.      |

:::note[Signing keys]
The ES256 key pair is generated once and kept in your secret manager. The JWKs and the key ID must remain stable: rotating the key would invalidate already-issued identity assertions.
:::

Optional variables:

| Variable                            | Purpose                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `WELDALL_BOOTSTRAP_ADMIN_EMAIL`     | Email of the first administrator, created on first start.              |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY` | AES key for storing write-only group-provider credentials.             |
| `OAUTH_PROXY_SECRET`                | Shared secret for the optional [discovery proxy](../discovery-proxy/). |
| `LOG_LEVEL`                         | Log verbosity, defaults to `INFO`.                                     |

## Build and run

The image is built from the [Dockerfile](https://github.com/seibert-external/weldall/blob/main/Dockerfile) in the repository root and started with the respective configuration:

```sh
docker build -t weldall .

docker run -d --name weldall \
  -p 3000:3000 \
  -e POSTGRES_URL=postgresql://user:password@db:5432/weldall \
  -e WELDALL_ISSUER=https://weldall.example.com \
  -e BETTER_AUTH_SECRET=... \
  -e GOOGLE_CLIENT_ID=... \
  -e GOOGLE_CLIENT_SECRET=... \
  -e WELDALL_SIGNING_PRIVATE_JWK='...' \
  -e WELDALL_SIGNING_PUBLIC_JWK='...' \
  -e WELDALL_SIGNING_KID=... \
  -e WELDALL_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  weldall
```

The container listens on port 3000. Alternatively, a container platform can build the Dockerfile directly from the repository; the production instance is deployed this way.

## After first start

1. Open `https://weldall.example.com` and sign in with the Google account that matches `WELDALL_BOOTSTRAP_ADMIN_EMAIL`. The bootstrap step grants this account the administrator role and the `weldall:login` scope.
2. In the administration interface, scopes are created, resources are registered, and permissions are assigned. [How to: Integrate a service](../service-configuration/) describes the procedure.
3. On an employee device, the CLI is pointed at the instance and signed in:

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
