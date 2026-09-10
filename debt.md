# Technical debt: simplify browser OIDC login

## Goal

Replace handwritten upstream OIDC protocol handling with a maintained integration. This is standard browser sign-in; Weldall should own its application policy, not a custom OIDC client stack.

This covers normal browser login, first-installation login, setup tests, and admin provider tests. It does **not** replace the CLI's OAuth protocol: CLI login encounters this flow only when its browser needs to authenticate to Weldall first.

## Current implementation

- `apps/weldall/src/server/auth/oidc-runtime.ts` implements discovery and caching, authorization URL construction, PKCE parameters, code exchange, and ID-token/nonce/claim validation. `jose` supplies JWT cryptography, not the complete OIDC client lifecycle.
- `apps/weldall/src/server/auth/login-service.ts` stores transaction state, nonce, verifier, provider configuration and browser binding; consumes attempts atomically; and applies identity-linking and installation policy.
- `apps/weldall/src/server/auth/oidc-plugin.ts` owns cookies, callbacks, setup/test endpoints, and Better Auth session creation.
- `apps/weldall/src/server/auth/oidc-transport.ts` implements bounded HTTPS transport. Application-layer destination filtering is intentionally deferred to a separate egress-policy decision.

The browser cookie is transaction correlation, not fingerprinting or a second PKCE implementation. In the current design, state selects a database attempt containing the verifier and nonce. Without browser binding, a forwarded attacker-initiated callback could log the recipient into the attacker's account. Preserve this protection; hashing the random cookie before storage is optional hardening, not the core requirement.

## Task

1. Assess the installed Better Auth integration first: can it support database-configured providers, unsaved provider tests, and verified callbacks without premature account or session writes?
2. If that cannot cleanly meet the requirements, evaluate a maintained OIDC client such as `openid-client` for upstream protocol handling, keeping Better Auth for local sessions. Compatibility has not yet been verified; this is not a presumed drop-in replacement.
3. Define ownership explicitly: the library handles supported protocol operations; Weldall retains setup authorization, provider configuration, verified identity-linking policy, test-only behavior, and local session creation after successful application checks.
4. Preserve browser-bound, expiring, one-time transactions. Check what the chosen integration actually owns: a protocol library may still require application-managed cookies and transaction storage.
5. Verify support for custom discovery URLs, both configured client-secret authentication methods, provider changes during login, and unsaved test configurations. Decide the egress policy explicitly: the current transport permits private HTTPS destinations so internal corporate IdPs work, leaving application-layer SSRF policy as a separate concern.
6. Delete superseded protocol code and redundant validation/cache/transport machinery where the integration genuinely replaces it. Avoid layering a library under the entire existing implementation.

## Acceptance criteria

- Normal login and setup completion still create sessions only after verified identity and successful application-policy checks.
- Setup tests and admin provider tests neither save provider configuration nor create/refresh the initiating login session; admin tests remain bound to the initiating admin session.
- Browser mismatch, expired/replayed attempts, invalid state/nonce/PKCE, wrong issuer/audience, invalid signatures, and unverified email are rejected.
- Installation concurrency, provider-version checks, identity-collision handling, and encrypted persistence of secrets retain their intended guarantees.
- Relevant coverage in `apps/weldall/test/login-installation.integration.test.ts`, `oidc-runtime.test.ts`, `oidc-transport.test.ts`, and setup/provider UI tests is adapted to the new integration and passes, including real-provider/development-IdP integration checks.
- The resulting implementation has materially less custom protocol code and a documented division of responsibility.

Do not treat this task as permission to remove individual security checks without a replacement. The simplification is architectural, not weaker login validation.
