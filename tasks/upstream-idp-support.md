# Wider upstream identity-provider support

## Goal

Allow Weldall deployments to authenticate users through Microsoft Entra ID and other standards-based upstream identity providers, in addition to Google and the development IdP.

Weldall links accounts by email and maps scopes to it, so every provider must deliver a verified email. Group synchronization and provider-backed scope assignments remain separate from upstream user authentication.

## Done

- Login providers are database rows (installer, administration UI and IaC), each an OIDC provider with discovery, PKCE/state/nonce and exact issuer checks.
- The login page renders buttons from the configured provider metadata.
- Tenant-bound Microsoft Entra ID: for issuers `https://login.microsoftonline.com/<tenant GUID>/v2.0`, Weldall requires `tid` to match, rejects guests (`acct`/`idp`) and accepts the email only when `xms_edov` is `true`. The login page, the provider test result and the installer explain these rejections. Setup guide: `apps/docs/src/content/docs/entra-id.md`. The tenant-boundary checks are unit-tested (`apps/weldall/test/oidc-entra.test.ts`).
- Confirmed against a real test tenant (the portal offers `xms_edov`/`email`/`acct` as optional ID claims):
  - `xms_edov` is a JSON boolean.
  - A member whose `mail` is in a tenant-verified domain gets `xms_edov: true`, `acct` as number 0 and no `idp`: accepted.
  - A member whose `mail` is in a domain the tenant does not own still gets `email`, but with `xms_edov: false`: rejected.
  - A guest with a personal Microsoft account gets `acct: 1`, `idp` = `https://sts.windows.net/<consumer tenant>/` and `xms_edov: true`: rejected by the `acct`/`idp` check.
  - End to end through Weldall: the provider test, browser login and CLI login passed.

## Open

- Integration tests for Entra tenant boundaries beyond the guest rejection covered in `apps/weldall/test/login-installation.integration.test.ts`.
- Multi-tenant Entra ID (`/organizations` with a tenant allowlist). Needs the per-tenant `iss` stored per account and the `{tenantid}` issuer substitution in `oidc-runtime.ts`.
- Guest (B2B) accounts. Microsoft treats a guest as a new identity per tenant, and `xms_edov` alone does not distinguish guests.
- A generic per-provider "trust email" switch for IdPs without `email_verified`, coupled to mandatory allowed domains. Changes the provider contract (schema, IaC, CLI), so it needs cross-version tests.
- `oid` + `tid` instead of the per-app `sub` as the stable Entra identifier. Changing it after rollout is a data migration.
- National clouds (other hosts than `login.microsoftonline.com`).

## Acceptance criteria

- A production deployment can enable Google, Entra ID, and at least one generic OIDC provider independently or together.
- Each configured provider appears correctly on the login page and completes browser and CLI authorization flows.
- Entra tenant boundaries and generic OIDC issuer/audience checks are covered by integration tests.
- Users without the required stable identity or verified email are rejected with a clear error.
- Existing Google login and development-only OIDC behavior remain compatible.
