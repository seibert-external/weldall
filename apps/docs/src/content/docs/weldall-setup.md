---
title: "How to: Set up Weldall"
description: Deploy Weldall, complete the one-time OIDC installer, and manage login providers.
sidebar:
  label: "How to: Set up Weldall"
---

Weldall runs as a single [container](https://github.com/seibert-external/weldall/blob/main/Dockerfile) with PostgreSQL and a public HTTPS origin. Startup applies additive Prisma migrations, initializes production resources, refreshes published catalogs, and starts Next.js on port 3000. It does **not** create an administrator. With no login providers, the server serves the protected one-time installer; downstream discovery and machine authentication remain provider-neutral.

## Prerequisites and secrets

- A backed-up PostgreSQL database and a stable public origin such as `https://weldall.example.com`.
- An OIDC identity authority supporting authorization code, PKCE S256, signed RS256/ES256 ID tokens, a stable subject, and a boolean `email_verified: true` assertion. Plain OAuth is not sufficient.
- The provider's HTTPS issuer, client ID and client secret. Register the exact **server-generated callback URL displayed by the installer** before testing. Do not guess a provider ID or use a localhost callback.

| Runtime variable                                                                   | Purpose                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_URL`                                                                     | PostgreSQL connection string.                                                                                            |
| `WELDALL_ISSUER`                                                                   | Public HTTPS origin; callback URLs never use request Host headers.                                                       |
| `BETTER_AUTH_SECRET`                                                               | Browser cookie signing secret.                                                                                           |
| `WELDALL_SIGNING_PRIVATE_JWK`, `WELDALL_SIGNING_PUBLIC_JWK`, `WELDALL_SIGNING_KID` | Stable ES256 JWK signing key pair and key ID for downstream JWTs.                                                        |
| `WELDALL_CREDENTIAL_ENCRYPTION_KEY`                                                | Canonical base64-encoded 32-byte AES key shared by OIDC credentials/attempts, group-provider tokens and chat API keys.   |
| `WELDALL_SETUP_TOKEN`                                                              | Server-only operator token, base64url generated from at least 32 random bytes; needed only until installation completes. |
| `WELDALL_DEPLOYMENT_MODE`                                                          | Set to `production`. Never expose development fixtures in production.                                                    |

Keep the credential-encryption key and setup token **different**. Reuse your existing `WELDALL_CREDENTIAL_ENCRYPTION_KEY`; only generate one if it does not exist:

```sh
openssl rand -base64 32                         # WELDALL_CREDENTIAL_ENCRYPTION_KEY (only if absent)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' # WELDALL_SETUP_TOKEN
```

Keep the encryption key stable and back it up separately from the database. Losing or replacing it prevents decryption of provider secrets; automatic key rotation/recovery is not provided. Do not reuse the cookie secret or setup token as the credential-encryption key. Never paste secrets into URLs, logs, or browser storage. After completion remove the setup token from runtime secrets; possession of it cannot reopen completed setup.

`WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION` defaults to `1` for group-provider and chat credential envelopes; it does not automatically rotate the key. `LOG_LEVEL` defaults to `INFO`. Missing database/migration state is a service error, never a reason to reopen setup.

## Build and start

Builds need no reachable database, upstream IdP, provider credentials, setup token, or credential-encryption key. Inject runtime secrets through your container platform, not image layers:

```sh
docker build -t weldall .
# Operator-managed runtime environment file, readable only by its owner:
docker run --name weldall --env-file /secure/weldall-runtime.env -p 3000:3000 weldall
```

Terminate HTTPS at your trusted proxy and forward to port 3000. `/.well-known/openid-configuration` is the image health-check endpoint; it does not prove an upstream provider is available. The production seed leaves the installer uninitialized on a fresh database. Do not run development seed helpers in production.

## One-time installation

1. Open `https://weldall.example.com/setup`. `/` and `/login` redirect here until installation completes. CLI authorization returns `setup_required` during this time.
2. Enter the operator token, the normalized email of the first administrator, and the first provider's connection, button, scopes, and optional allowed email domains. Register the displayed callback URL upstream. Issuer spelling must match discovery exactly; HTTPS path-bearing issuers and explicit discovery URL overrides are supported. Use `client_secret_basic` or `client_secret_post` as supported by the provider. `openid` and `email` are mandatory; `offline_access` is forbidden upstream.
3. Acknowledge that this provider can assert identities for its permitted email domains. Verified email is **the provider's assertion**, not independent proof. Empty domains trust all verified email assertions; domain restrictions cannot make a malicious provider safe.
4. Optionally choose **Test login (optional)** to try the configuration on your own responsibility in a new tab. The operator-token/browser-bound test checks the nominated verified email and reports pass/fail. It creates no provider, user, account, grants, session, audit, completion or test history. Allow popups; if the provider removes the opener, read the result in the test tab. The original form retains its configuration only in memory, never browser storage; edits invalidate test status.
5. Choose **Complete installation** when ready, without needing a prior test or even after a failed one. This starts its **own** OIDC login as the nominated email; a previous test result never authorizes completion. Discovery, signatures, issuer/audience, nonce, PKCE, current verified email, and domains must all pass.
6. Only that matching verified login transaction enables the first provider, preserves or creates the Weldall user, grants `weldall:login` and `weldall:administer` additively, records audit, and permanently completes setup. Only then is an administrator session issued; outstanding setup and setup-test attempts are removed.

The callback URL is allocated once for the installation and remains identical across reloads, tabs, long configuration sessions and provider activation. Merely opening the form starts no login attempt and requires no draft cookie. Each button action starts a single-use, browser-bound OIDC attempt lasting ten minutes; removing or changing the operator token invalidates outstanding attempts. Cancellation, wrong email, expired or replayed attempts, conflicts and failed exchange cannot grant administrator access. Retry from `/setup`. Completed setup never reopens, including when every provider is disabled. Preserve an existing admin session while changing login options.

## Manage providers live

Open `/admin/login-providers` as a Weldall administrator. Add, edit, enable/disable or set order without a restart. IDs and issuers are immutable; a new authority requires a new provider. Secret fields are write-only: leave blank on edit to retain the stored value. Disabled providers do not appear on `/login`, but their identity bindings and audit remain. Provider count is bounded at 100.

**Test login** opens a new tab and uses the current, possibly unsaved form values. It consumes a short-lived encrypted browser/admin-session-bound attempt, but creates no provider, user, link, grants, new session, audit record or test history. It does not replace the administrator's session, even when testing a different identity. Return to the form for pass/fail. Allow popups; if an upstream browser isolation policy removes the opener, read the result in the test tab and retry as needed. Closing the tab or losing the initiating session cannot authorize a save on your behalf.

Test before saving. Test status is invalidated by edits, and late results from older forms are ignored. **Saving is the administrator's explicit responsibility**, not gated by a stored proof of test success. Saves preflight discovery and are admin-authorized, CSRF-protected, versioned and audited; reload after a stale-version error. Re-enabling, creating, or changing connection/credential/identity-authority settings always preflights. Disabling, reordering and presentation-only edits with unchanged authority can succeed during an IdP outage; these retain the previous validation timestamp, not a claim of fresh validation.

Every enabled save requires a fresh trust acknowledgement. Disabling the last enabled provider requires a separate lockout acknowledgement. It may prevent new logins; it does not reset installation. Disabling or editing does **not** revoke existing sessions, CLI refresh tokens, or downstream access tokens. In-flight ordinary logins fail if their provider version changes.

OIDC grants no ordinary-user permissions. Assign `weldall:login` before users' first CLI authorization, and assign resource scopes separately. Upstream groups/roles never grant Weldall scopes. Same normalized verified email across trusted issuers links to the same user ID; conflicting legacy emails, unverified local users, and changed-email bindings fail rather than merge or reassign. No upstream access/refresh tokens are stored.

All upstream requests use verified TLS, connection-time DNS filtering, bounded time/bytes and no redirects. Only public addresses are allowed in production. Discovery failure for one provider does not block others or neutral downstream endpoints.

## Cut over an existing deployment (operator task)

This is an intentional breaking change. Rehearse with a **copy** of the database before the production maintenance window. The application and migrations do not perform the following operational revocation for you:

1. Back up the database, stable signing/cookie secrets and credential keys. Inventory user IDs, scope assignments, provider bindings, browser sessions and CLI authorization; confirm your nominated admin email matches a verified identity without normalized legacy duplicates.
2. Drain **all old application instances** and stop new browser/CLI authorization. Ensure the existing credential-encryption key is available and prepare the setup token in runtime secrets; keep the same public origin.
3. Explicitly revoke legacy browser and CLI authentication before reopening traffic. Review `Session`, `OauthRefreshToken` (including rotation replay state), user `OauthAccessToken`, `OAuthDeviceRefreshBinding`, and outstanding authorization-code `Verification` state with your operator tooling. Do not delete users, grants, business records, machine identities, or unrelated verification data indiscriminately. Cookie-secret rotation alone is not CLI refresh revocation.
4. Account separately for already-issued self-contained JWTs/ID-JAGs and downstream service tokens: deleting database rows does not invalidate them at offline verifiers. Wait out the **maximum configured lifetime across downstream services** or coordinate signing-key retirement and verifier/JWKS cache invalidation. Do not assume database revocation is immediate global logout.
5. Deploy the new image; Prisma adds installation/provider/attempt state and deletes only `Account` rows with the exact pair `providerId='google' AND issuer='https://accounts.google.com'`, including tokens on those rows. Users/IDs, verification, grants, sessions, nonmatching bindings and business data are preserved. Existing migration history stays untouched; no replacement provider is imported.
6. Remove old Google credentials, dev-login flags, bootstrap-admin email and OAuth proxy secrets/configuration. The old first-admin command, Google button/preset, runtime dev branch and localhost callback flow no longer exist. Production never reads dev fixture variables as a provider source.
7. Verify health and setup-required behavior, run the installer, confirm the preserved admin ID/grants, add/test additional providers, and check browser and CLI authorization. Retire the external legacy Google OAuth client and upstream credentials separately after confirming no other application uses them. Exact account cleanup is not external-client revocation.
8. Reopen traffic only after revoked legacy refresh/code flows fail and the new OIDC login works. Remove the setup token. Keep backup/rollback handling within the maintenance plan; restoring an old database also restores its old authorization state.

## Next steps

- [Integrate a service](../service-configuration/) and assign resource scopes.
- [Infrastructure as code](../infrastructure-as-code/) for supported resources and assignments; login providers are deliberately UI-managed, not IaC.
- [Security](../oauth-security/) for the unchanged downstream OAuth/DPoP contract.
- [Local development](https://github.com/seibert-external/weldall/blob/main/docs/development.md) for ordinary configured dev OIDC fixtures and the real installer recipe.
