# Technical debt: simplify browser OIDC login

## Goal

Replace handwritten upstream OIDC protocol handling with a maintained integration. This is standard browser sign-in; Weldall should own its application policy, not a custom OIDC client stack.

This covers normal browser login, first-installation login, setup tests, and admin provider tests. It does **not** replace the CLI's OAuth protocol: CLI login encounters this flow only when its browser needs to authenticate to Weldall first.

**No backward compatibility is required for this unreleased feature in this branch.** Replace the implementation directly. Do not add legacy adapters, dual flows, fallback verification, feature flags, or compatibility readers for old attempt payloads. In-flight attempts may be invalidated and restarted. Branch-internal interfaces, fixtures, and tests may change to fit the new design; do not preserve old implementation details merely to keep tests unchanged. This does not authorize unrelated changes to released contracts, historical migrations, or existing user data.

## Current implementation

- `apps/weldall/src/server/auth/oidc-runtime.ts` implements discovery and caching, authorization URL construction, PKCE parameters, code exchange, and ID-token/nonce/claim validation. `jose` supplies JWT cryptography, not the complete OIDC client lifecycle.
- `apps/weldall/src/server/auth/login-service.ts` stores transaction state, nonce, verifier, provider configuration and browser binding; consumes attempts atomically; and applies identity-linking and installation policy.
- `apps/weldall/src/server/auth/oidc-plugin.ts` owns cookies, callbacks, setup/test endpoints, and Better Auth session creation.
- `apps/weldall/src/server/auth/oidc-transport.ts` implements bounded HTTPS transport. Application-layer destination filtering is intentionally deferred to a separate egress-policy decision.

The browser cookie is transaction correlation, not fingerprinting or a second PKCE implementation. In the current design, state selects a database attempt containing the verifier and nonce. Without browser binding, a forwarded attacker-initiated callback could log the recipient into the attacker's account. Preserve this protection; hashing the random cookie before storage is optional hardening, not the core requirement.

## Decision and ownership

Use `openid-client` for upstream OIDC and retain Better Auth for local sessions and downstream OAuth. The source-level assessment examined `openid-client` 6.8.8 and its `oauth4webapi` 3.8.8 dependency; runtime compatibility is not yet proven. Pin the initial integration version and review its resolved dependencies so the behavior below has a reproducible baseline.

The installed Better Auth Generic OAuth integration already supports signature/nonce verification, but its normal successful callback proceeds into account/session handling. Its initialization-time provider configuration and lack of a straightforward unsaved, side-effect-free test flow make it a poorer fit for this feature. Do not describe its callback categorically as "unverified." Do not add Passport, replace Better Auth, or reopen framework selection as part of implementation unless a concrete blocker is found.

- **Library owns:** PKCE helpers, authorization URL construction, callback protocol validation, client authentication, code exchange, token-response parsing, standard OIDC claim validation, signature verification, JWKS fetching/key selection/cache, and protocol errors.
- **Weldall owns:** provider/draft configuration, bounded configuration caching, initiation authorization, browser-bound one-time attempts, encryption, current verified-email/domain policy, identity linking, provider-version checks, installation transactions/grants/audit, admin-test session binding, resource limits, and safe redirects.
- **Better Auth owns:** session creation/cookies after successful application completion. Test modes never enter this step.

Target flow: authorized initiation → browser-bound database attempt → library verification → Weldall identity/setup policy → test result or committed completion → optional Better Auth session.

UserInfo fetching is being removed separately. Coordinate with that work; the target adapter uses signed ID-token identity claims only. Do not reintroduce UserInfo fallback, claim merging, or upstream token persistence. The IdP must supply the required email claims in its ID token.

## Implementation plan

### 1. Establish the adapter contract and regression cases

- Re-read the live auth files before implementation: another agent may have simplified them. Keep changes scoped to the upstream OIDC replacement and its tests/docs.
- Add the pinned dependency to `apps/weldall/package.json` and update the lockfile. Keep `jose` wherever other features still use it.
- Design one small adapter in `oidc-runtime.ts`: obtain a configured client, build a login authorization URL, and verify a complete callback into `VerifiedIdentity`. Keep library tokens/configuration objects inside the server adapter; return no upstream tokens to routes or persistence.
- Write adapter integration cases against the actual library, using Fetch-compatible mocked responses rather than mocking `authorizationCodeGrant()`. Cover the non-default policies below before deleting their existing implementation.
- Change internal signatures directly. Do not retain the old code-only `exchange(config, callback, code, nonce, verifier)` interface as a compatibility wrapper; the library needs the full authorization response to own callback validation.

### 2. Replace HTTPS plumbing with bounded Fetch

- Replace the handwritten `node:https` event handling in `oidc-transport.ts` with a small Fetch-compatible implementation supplied through `[openid.customFetch]`. It returns `Response`, not parsed protocol JSON; do not parse and rebuild every protocol response around the library.
- Preserve HTTPS/TLS verification, URL restrictions on credentials/fragments, no redirects, the 256 KiB response limit, and the strict JSON media-type policy for the endpoints used. Enforce the byte cap while reading, including chunked responses; `Content-Length` alone is insufficient. Cancel failed/oversized bodies.
- Preserve the library-provided abort signal and manual redirect setting. Configure an eight-second timeout on discovery and reusable configurations; the library default is 30 seconds. Test slow response bodies as well as stalled connection establishment. This is a per-request limit, not a promised eight-second deadline for the whole login sequence.
- Let the library handle endpoint-specific status/error parsing and authentication headers. Do not add general retries around authorization-code exchange.
- Private HTTPS destinations remain permitted, matching the current feature decision. Neither HTTPS nor `customFetch` supplies SSRF protection. Application-layer destination filtering remains a separate egress-policy task; do not restore the removed public-only restriction or claim the library replaces it.

### 3. Build lazy, policy-constrained configurations

- Load saved providers from the database at initiation; load draft providers from authorized form input. Persist the configuration snapshot with the attempt so another process can reconstruct it at callback. Never serialize a library `Configuration` object into the attempt.
- Use library discovery for ordinary issuer-derived metadata URLs. For an arbitrary explicit discovery URL, use bounded Fetch plus the public `Configuration` constructor; do not rely on `discovery()` recognizing arbitrary document paths. Its direct-document detection uses `/.well-known/`.
- Require exact equality between the configured issuer string and discovered `issuer` for both paths. The library's normal discovery comparison uses URL normalization; direct-document discovery does not establish our expected issuer.
- Keep a small provider-policy preflight: required authorization/token/JWKS endpoints, code flow, configured token authentication method, and S256 compatibility. Discovery success alone is not proof that all endpoints or advertised capabilities are suitable. Preserve the existing missing-auth-method default of `client_secret_basic` and the policy of sending S256 even when its metadata advertisement is absent.
- Preserve useful discovery metadata, particularly `authorization_response_iss_parameter_supported`; avoid a stripping schema that discards security-relevant metadata before library validation.
- Validate discovered endpoint parameters before URL construction. Preserve fixed routing query parameters; reject conflicting/reserved protocol parameters instead of retaining the old repair/normalization behavior. The library appends authorization parameters and will not remove conflicts for us. Update fixtures accordingly; backward compatibility with malformed endpoint metadata is not required.
- Narrow the effective server metadata's signing algorithms to the intersection of advertised algorithms and `RS256`, `ES256`, `EdDSA`; reject an empty intersection. Do not pass an array to the public `id_token_signed_response_alg` client field, which accepts one algorithm, or arbitrarily pin one algorithm from a multi-algorithm provider.
- Select `ClientSecretBasic(secret)` or `ClientSecretPost(secret)` explicitly. Do not rely on the library's default of Post.
- Enable `enableNonRepudiationChecks(configuration)` for every configuration, including unsaved tests, and set clock tolerance explicitly to 30 seconds. Apply the same fetch, timeout, and verification policy regardless of configuration construction path.
- Cache configurations lazily with a bounded size/lifetime and eviction of failed initialization. The cache identity must cover issuer/discovery URL, client ID, secret identity, authentication method, and verification policy. Use a non-public digest/key rather than logging raw secrets. Do not reuse today's metadata-only cache key for secret-bearing client objects or key draft configurations only by provider ID.
- Reuse the configured client to benefit from the library's JWKS cache. Do not add a parallel JWKS cache/fetcher or database-backed JWKS persistence for the long-running Node deployment. Keep provider availability/version checks independent of cache hits. No discovery at module initialization or during builds; one failed provider must not break neutral endpoints or another provider.

### 4. Switch initiation and callback processing

- Generate fresh state, nonce, and verifier using the library helpers; derive S256 with `calculatePKCECodeChallenge()`. Build authorization URLs through `buildAuthorizationUrl()` with server-owned client/callback/scope values and explicit code/query response settings. Always use PKCE and nonce, not only when provider metadata suggests a fallback is necessary.
- Retain the current signed browser cookie and atomic database attempt consumption. Do not combine this change with a cookie-only transaction redesign: configuration snapshots, concurrent attempts, setup invalidation, and cross-process one-time consumption already justify the shared store.
- On callback, validate route/request bounds and unambiguous state, require the browser cookie, then atomically consume the matching unexpired provider/browser attempt. Consumption remains one-time even if upstream exchange fails.
- Construct the callback URL from the configured Weldall origin and server-owned provider callback path, preserving the received query parameters and duplicates. Never derive the token exchange redirect URI from an untrusted `Host` header or collapse the response into just code/state/issuer.
- Call `authorizationCodeGrant()` with the authenticated transaction state, stored nonce/verifier, and `idTokenExpected: true`. Passing unvalidated callback state back as `expectedState` is not browser binding; the authenticated database claim must happen first.
- Let the library validate response issuer, required advertised `iss`, duplicate protocol parameters, cancellation/error responses, and token exchange. Keep only request-boundary checks needed before consuming an attempt, not a second full callback parser.
- After the grant and enabled signature checks finish, read `tokens.claims()`. Retain narrowly scoped stricter policies on those verified claims: `iat` no more than 600 seconds old with existing 30-second tolerance and no more than 30 seconds in the future; any present `azp` must equal the configured client ID, even for a single audience. Do not use `maxAge` as a replacement: it constrains `auth_time`, not token issuance age.
- Run existing verified-email/domain/subject policy on signed claims. Keep pre/post-exchange setup authorization and provider checks, final transactional version checks, identity collisions, installation locking, and admin-session rechecks. Tests return a result after verification without saving a provider or creating/linking a user/account/session.
- Map library failures into bounded, stable Weldall error categories. Do not return or log raw tokens, claims, callback URLs, response bodies, or library error causes that can contain those values.

### 5. Delete superseded machinery

- Remove manual PKCE hashing for the protocol, token request/client-secret encoding, JWT verification, nonce/issuer/audience/expiry duplication, and manual JWKS handling once the library-backed tests cover them. Do not retain old-path fallback or dual verification.
- Retire the old JSON transport API and redundant metadata/cache code. For each remaining check, identify whether it is application policy, a resource bound, or already library-owned. Do not retain arbitrary per-field/JWKS-count checks solely for compatibility; document the effective replacement bound or retain a narrow check where genuinely needed.
- Remove UserInfo-related adapter code/tests if still present after the other agent's work. Do not fabricate access-token fields in production to accommodate incomplete mock responses.
- Keep the custom Better Auth endpoint/session integration, updating the misleading "unverified upstream callback" comment to describe application-policy ownership instead.
- Update feature documentation and `plan.md` where this decision changes the described implementation. Record the ownership boundary, ID-token email requirement, test behavior, network-policy limits, and key-rotation expectations. Do not expand unrelated auth scope.

### 6. Run the integration and deployment gates

- **Protocol:** complete OAuth token responses, valid signatures for all allowed algorithms, missing/invalid ID token, wrong issuer/audience/nonce, missing advertised callback `iss`, duplicate parameters, unsupported algorithm, stale/future `iat`, and wrong `azp` for single and multiple audiences.
- **Configuration:** issuer paths and exact spelling, arbitrary custom discovery paths/query strings, required metadata/capabilities, fixed routing queries, rejection of reserved endpoint parameters, both authentication methods, and client IDs/secrets containing characters requiring form encoding.
- **Transactions/policy:** browser mismatch/forwarded callback, missing state, expiration, replay/concurrent consumption, provider changes during exchange, identity collisions, competing installation completion, setup token invalidation, and admin-session changes during tests. Assert absence of unauthorized provider/user/account/session/grant/audit writes, not merely an HTTP error.
- **Transport/cache:** TLS and private HTTPS compatibility, no redirects or credential forwarding, strict media types, malformed/oversized/slow responses, bounded client cache, failure eviction/outage isolation, secret/configuration changes, and JWKS rotation. The assessed dependency caches JWKS for five minutes and permits unknown-key refetch after one minute; replace tests demanding unconditional immediate refetch with tests of the supported rotation behavior. Do not manipulate library internals to retain old cache semantics.
- **Real integration:** run through the development IdP's actual authorize/login/token/JWKS handlers with PKCE enforcement, not only a signed-token stub. The current dev IdP supports Post; cover Basic with a suitable protocol fixture. Update token mocks to include `access_token` and `token_type`, which the library requires even when the application uses only the ID token. Use a standards-compliant IdP over HTTPS to verify deployment trust and redirects as well; no temporary production bypasses.
- **Application/deployment:** run adapted `oidc-runtime.test.ts`, `oidc-transport.test.ts`, `login-installation.integration.test.ts`, and setup/provider/test-result UI tests, plus relevant auth regressions, typecheck, formatting, and production build. Use the real PostgreSQL integration prerequisites documented in the repository. Prove zero-provider startup, offline-safe build, and unchanged downstream CLI/DPoP and machine-auth behavior. Manually verify setup/login/test flows against a running development stack without expanding the existing E2E suite.
- Report actual commands/results, remaining integration caveats, and deleted custom protocol responsibilities. Compare the final adapter footprint against the starting code; installing a library underneath an intact custom client is not completion.

## Acceptance criteria

- Normal login and setup completion still create sessions only after verified identity and successful application-policy checks.
- Setup tests and admin provider tests neither save provider configuration nor create/refresh the initiating login session; admin tests remain bound to the initiating admin session.
- Browser mismatch, expired/replayed attempts, invalid state/nonce/PKCE, wrong issuer/audience, invalid signatures, and unverified email are rejected.
- Installation concurrency, provider-version checks, identity-collision handling, and encrypted persistence of secrets retain their intended guarantees.
- Relevant coverage in `apps/weldall/test/login-installation.integration.test.ts`, `oidc-runtime.test.ts`, `oidc-transport.test.ts`, and setup/provider UI tests is adapted to the new integration and passes, including real-provider/development-IdP integration checks.
- The resulting implementation has materially less custom protocol code and a documented division of responsibility, with no legacy path, dual validation stack, or attempt-format compatibility layer.
- All four flow modes use the same configured protocol adapter. Provider failures are isolated, builds stay offline-safe, and downstream OAuth/session behavior remains unchanged.
- Source-level suitability is not reported as runtime verification: the library-backed tests and real-IdP/deployment checks above have recorded results before completion.

The simplification is architectural, not weaker login validation. Remove duplicate implementations when responsibility has a tested replacement; preserve or explicitly document the policy/boundary behind every remaining check.

## Assessment references

These references describe the assessed versions, not an assumption about future defaults:

- [`openid-client` 6.8.8 implementation](https://github.com/panva/openid-client/blob/v6.8.8/src/index.ts)
- [`oauth4webapi` 3.8.8 implementation](https://github.com/panva/oauth4webapi/blob/v3.8.8/src/index.ts)
- [Supported runtime and conformance information](https://github.com/panva/openid-client/blob/v6.8.8/README.md)
- [Library threat model and application responsibilities](https://github.com/panva/openid-client/blob/v6.8.8/SECURITY.md)
- [JWKS cache guidance](https://github.com/panva/openid-client/blob/v6.8.8/docs/functions/getJwksCache.md)
