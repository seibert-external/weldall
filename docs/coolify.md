# Coolify deployment

Weldall runs as one Coolify application plus one PostgreSQL database. The CLI and SDK continue to be released through npm.

## 1. Create the Coolify resources

1. Create a project and a `production` environment.
2. Create a PostgreSQL database in that environment.
3. Create an application from the private GitHub App repository `seibert-external/weldall`.
4. Configure the application:
   - Branch: `main`
   - Build pack: `Dockerfile`
   - Dockerfile: `/Dockerfile`
   - Exposed port: `3000`
   - Domain: the stable Weldall hostname (Coolify may show it as `http://...`; the public URL and `WELDALL_ISSUER` must use `https://`)
   - Auto-deploy: enabled
   - Replicas: exactly `1`
   - Preview deployments: disabled

Merges to `main` are deployed by the Coolify GitHub App webhook. The GitHub deploy workflow only waits for that deployment and reports its result.

## 2. Generate production secrets

Run this locally and copy the output directly into locked Coolify runtime variables:

```sh
node --input-type=module <<'NODE'
import { randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
console.log(`BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`);
console.log(`WELDALL_SIGNING_PRIVATE_JWK=${JSON.stringify(await exportJWK(privateKey))}`);
console.log(`WELDALL_SIGNING_PUBLIC_JWK=${JSON.stringify(await exportJWK(publicKey))}`);
console.log(`WELDALL_SIGNING_KID=${randomUUID()}`);
NODE
```

Do not commit or put this output into GitHub Actions. Keep the signing key stable across deployments; replacing it invalidates existing Weldall tokens.

## 3. Configure Coolify runtime variables

None of these variables needs to be available during the Docker build.

| Variable                                    | Value                                                    |
| ------------------------------------------- | -------------------------------------------------------- |
| `POSTGRES_URL`                              | Internal URL of the Coolify PostgreSQL database          |
| `WELDALL_ISSUER`                            | Stable public origin, e.g. `https://weldall.example.com` |
| `WELDALL_DEPLOYMENT_MODE`                   | `production`                                             |
| `ENABLE_DEV_LOGIN`                          | `false`                                                  |
| `BETTER_AUTH_SECRET`                        | Generated secret                                         |
| `GOOGLE_CLIENT_ID`                          | Production Google OAuth client ID                        |
| `GOOGLE_CLIENT_SECRET`                      | Production Google OAuth client secret                    |
| `WELDALL_SIGNING_PRIVATE_JWK`               | Generated private JWK JSON                               |
| `WELDALL_SIGNING_PUBLIC_JWK`                | Generated public JWK JSON                                |
| `WELDALL_SIGNING_KID`                       | Generated key ID                                         |
| `WELDALL_BOOTSTRAP_ADMIN_EMAIL`             | Email address of the initial administrator               |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY`         | Base64-encoded 32-byte key for provider tokens           |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION` | Positive key version, initially `1`                      |

Lock `POSTGRES_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `WELDALL_SIGNING_PRIVATE_JWK`, and `WELDALL_CREDENTIAL_ENCRYPTION_KEY` in Coolify. `OAUTH_PROXY_SECRET` and the Development IdP variables are local-development settings and must not be configured in production.

Register this exact Google OAuth redirect URI:

```text
https://<WELDALL-HOST>/api/auth/callback/google
```

The container validates its environment, applies Prisma migrations, bootstraps the configured initial administrator with `weldall:login` and `weldall:administer`, and then starts Weldall. Bootstrap reruns are idempotent only while that first assignment still has both protected scopes; they do not restore revoked CLI login. Once another administrator should take over, delegate both required scopes in the Admin UI before changing or removing `WELDALL_BOOTSTRAP_ADMIN_EMAIL`.

## 4. Configure GitHub

Set this repository variable:

```sh
gh variable set COOLIFY_APP_UUID \
  --repo seibert-external/weldall \
  --body '<Coolify application UUID>'
```

The reusable `seibert-external/vibe-ci` workflow also needs these Actions secrets:

- `COOLIFY_API_URL` — for example `https://coolify.seibert.tools/api/v1`
- `COOLIFY_API_TOKEN` — token with at least read/deployment-status access

They are normally inherited from the `seibert-external` organization. Only add them as repository secrets if the organization secrets are not already available to this repository. The token is used for status polling; the actual deployment is triggered by Coolify's GitHub webhook.

## 5. Verify the first deployment

1. Merge to `main` and confirm both the Coolify deployment and GitHub `Deploy` check finish successfully.
2. Open `https://<WELDALL-HOST>/.well-known/openid-configuration`.
3. Confirm every issuer and endpoint uses the production hostname.
4. Sign in through Google with the bootstrap administrator email.
5. Run `weldall config set-issuer https://<WELDALL-HOST>` and complete `weldall login`.

Before non-bootstrap users run `weldall login`, assign `weldall:login` directly to their email address in the Admin UI. Weldall does not derive CLI access from Google or group membership.

Weldall currently uses process-local replay protection, so horizontal scaling beyond one replica is not safe yet.
