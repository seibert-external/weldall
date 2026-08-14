# Wider upstream identity-provider support

## Goal

Allow Weldall deployments to authenticate users through Microsoft Entra ID and other standards-based upstream identity providers, in addition to Google and the development IdP.

## Scope

- Add first-class Microsoft Entra ID configuration, including explicit tenant selection and documented callback URLs.
- Generalize production configuration to support one or more trusted OpenID Connect providers through discovery.
- Consider provider-specific OAuth integrations only when they can supply a stable subject and verified email; prefer OIDC where available.
- Render login options from configured provider metadata instead of hard-coded Google/dev provider unions.
- Normalize account linking and claims (`sub`, issuer, name, email, `email_verified`) without trusting unverified profile data.
- Validate HTTPS issuers, discovery metadata, redirect URIs, PKCE/state/nonce handling, and provider-specific issuer behavior.
- Document environment variables, secret rotation, Entra app registration, tenant policy, and common troubleshooting steps.

Group synchronization and provider-backed scope assignments remain separate from upstream user authentication.

## Acceptance criteria

- A production deployment can enable Google, Entra ID, and at least one generic OIDC provider independently or together.
- Each configured provider appears correctly on the login page and completes browser and CLI authorization flows.
- Entra tenant boundaries and generic OIDC issuer/audience checks are covered by integration tests.
- Users without the required stable identity or verified email are rejected with a clear error.
- Existing Google login and development-only OIDC behavior remain compatible.
