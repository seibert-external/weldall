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
console.log(`WELDALL_TRUSTED_PROXY_SECRET=${randomBytes(32).toString("base64url")}`);
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
| `LOG_LEVEL`                                 | `INFO` (`DEBUG` for temporary diagnostics)               |
| `ENABLE_DEV_LOGIN`                          | `false`                                                  |
| `BETTER_AUTH_SECRET`                        | Generated secret                                         |
| `WELDALL_TRUSTED_PROXY_SECRET`              | Generated edge-attestation secret                        |
| `GOOGLE_CLIENT_ID`                          | Production Google OAuth client ID                        |
| `GOOGLE_CLIENT_SECRET`                      | Production Google OAuth client secret                    |
| `WELDALL_SIGNING_PRIVATE_JWK`               | Generated private JWK JSON                               |
| `WELDALL_SIGNING_PUBLIC_JWK`                | Generated public JWK JSON                                |
| `WELDALL_SIGNING_KID`                       | Generated key ID                                         |
| `WELDALL_BOOTSTRAP_ADMIN_EMAIL`             | Email address of the initial administrator               |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY`         | Base64-encoded 32-byte key for provider tokens           |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION` | Positive key version, initially `1`                      |

Lock `POSTGRES_URL`, `BETTER_AUTH_SECRET`, `WELDALL_TRUSTED_PROXY_SECRET`, `GOOGLE_CLIENT_SECRET`, `WELDALL_SIGNING_PRIVATE_JWK`, and `WELDALL_CREDENTIAL_ENCRYPTION_KEY` in Coolify. `OAUTH_PROXY_SECRET` and the Development IdP variables are local-development settings and must not be configured in production.

### Authenticate the Coolify proxy boundary

Browser-connection entrance limits accept a network source only when the request carries both the proxy-managed `X-Forwarded-For` chain and an `X-Weldall-Proxy-Attestation` value equal to `WELDALL_TRUSTED_PROXY_SECRET`. Weldall uses the final `X-Forwarded-For` hop added by the edge. Without a valid attestation it deliberately puts every request in one `untrusted-proxy-source` bucket; it never trusts a client-supplied forwarding header by itself.

Configure this at the Coolify Traefik edge, not in browser code:

1. In **Servers → Proxy → Dynamic Configurations**, add a file-provider middleware:

   ```yaml
   http:
     middlewares:
       weldall-source-attestation:
         headers:
           customRequestHeaders:
             X-Weldall-Proxy-Attestation: "<WELDALL_TRUSTED_PROXY_SECRET>"
   ```

2. Attach `weldall-source-attestation@file` to the generated HTTPS router for the Weldall application. In Coolify's generated labels this is the router's `traefik.http.routers.<router-name>.middlewares` value; preserve any existing middleware names and append `weldall-source-attestation@file`.
3. Keep port `3000` private to the Coolify network so requests cannot bypass Traefik. Confirm Traefik remains the component that appends the connected client to `X-Forwarded-For`.
4. Rotate the middleware value and locked application variable together. Never put this secret in SPA configuration, response headers, logs, or audit metadata.

The repository `Caddyfile` and Docker E2E Caddy configuration implement the same contract by overwriting `X-Forwarded-For` with `{remote_host}` and injecting the local/test-only attestation secret.

Register this exact Google OAuth redirect URI:

```text
https://<WELDALL-HOST>/api/auth/callback/google
```

The container validates its environment, applies Prisma migrations, bootstraps the configured initial administrator with `weldall:login` and `weldall:administer`, and then starts Weldall. Bootstrap reruns are idempotent only while that first assignment still has both protected scopes; they do not restore revoked CLI login. Once another administrator should take over, delegate both required scopes in the Admin UI before changing or removing `WELDALL_BOOTSTRAP_ADMIN_EMAIL`.

Production logs are structured JSON on stdout and appear in Coolify's application logs. `INFO` records successful API and tRPC operations; `WARN` records rejected requests and degraded dependencies; `ERROR` includes unexpected failures. Every API response carries an `x-request-id`, and the same ID is attached to logs and request-bound audit records. Set `LOG_LEVEL=DEBUG` temporarily for request-start and health-check records. Request bodies, credentials, and authentication headers are not logged.

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

Before non-bootstrap users run `weldall login`, assign `weldall:login` to their email address or to a matching provider group in the Admin UI. Weldall does not derive CLI access from Google alone. Group-derived access is resolved live and fails closed when the provider is disabled, unavailable, changed during resolution, or no longer reports the membership; direct grants remain independent.

Browser connection start, CLI approval, polling, refresh/exchange facade checks, rate limits, quotas, and browser DPoP replay markers use PostgreSQL. The pinned provider's native interactive OAuth DPoP replay store and downstream services configured with `inMemory()` remain process-local, so the supported Weldall deployment stays at one replica until those provider-native markers are shared. Production downstream resources that scale horizontally must configure an atomic Redis or PostgreSQL `ReplayStore`.

## Browser-connection migration and operations

The container applies the dedicated browser-connection migrations before startup. Production initialization then reconciles a derived `weldall-browser:<resource-key>` public client for every existing resource and reconciles incomplete provider issuance attempts before serving traffic. Do not create or edit these OAuth clients manually.

Before deployment, back up PostgreSQL and verify that resource authorization-server and request-prefix URLs contain the intended SPA origins. After deployment:

1. run the normal metadata and CLI checks above;
2. inspect an existing resource and confirm its derived browser client is enabled only when the resource is enabled;
3. open the user or resource detail administration page to inspect/revoke connections;
4. verify `browser_connection.requested`, `.approved`, `.issued`, and `.revoked` audit events contain IDs/origin/resource/JKT but no code, token, proof, or authorization value.

Changing an origin, disabling a resource, or deleting it transactionally revokes affected browser connections and refresh families for both admin and IaC mutations. A connection stores no business-scope snapshot: the next refresh and ID-JAG request applies current login, group, resource, origin, connection, and supported-scope policy. Already-issued offline-verifiable downstream tokens retain only their signed short lifetime.
