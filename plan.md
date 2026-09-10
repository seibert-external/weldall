# Build: OIDC-only login, one-time installer, provider administration

We are replacing Weldall's Google/dev-login authentication with a system where **OIDC is the only
upstream authentication contract**. Administrators configure one or more OIDC providers — the first
one through a one-time installer, the rest through a slim admin page — and no source change or
restart is needed to add a provider. This is an intentional breaking change for the single existing
deployment; its cutover is an operator task, not a backward-compatibility feature.

## Goals

- OIDC-only login: no built-in Google provider, Google preset, Google fallback, Google environment
  variables, or provider-specific login logic.
- 1–n configurable OIDC providers sharing one Weldall user namespace. One normalized email = one
  Weldall user; multiple verified external identities can attach to that user (identity linking, no
  merge UI). An identity is keyed by exact issuer + stable subject.
- A **one-time installer** creates the first OIDC provider and nominates the first admin email. A
  matching, verified OIDC login must succeed before installation completes. Setup never reopens
  after completion.
- A slim `/admin/login-providers` page manages providers 2..n: list, add, edit, enable/disable,
  reorder, with a **Test login** button. The test runs the real one-time OIDC flow against the
  current (possibly unsaved) form values and persists nothing; saving the configuration is the
  admin's responsibility.
- OIDC proves identity; existing Weldall login/admin scopes and resource policy still determine
  access. Upstream roles/groups never grant permissions.
- Development uses ordinary configured OIDC providers. The insecure dev IdP stays a dev
  fixture, not a production auth mode.

## Non-goals

SAML, plain OAuth-only providers, password/magic-link, LDAP, provider presets, claim-mapping
scripts, JS adapters, SCIM, upstream group/role mapping, upstream global logout, IaC for login
providers, and enterprise network allowlists are out of scope. We do not alter the downstream
OAuth/DPoP contract, CLI token formats, machine auth, SDK contracts, or group-provider
integrations. Historical Prisma migrations remain immutable.

## OIDC configuration contract

| Field | Contract |
| --- | --- |
| `id` | Server-generated immutable opaque provider ID; used in callbacks/audit. Never reused. |
| `name` | Required internal display name. |
| `buttonLabel` | Required plain text, bounded length. |
| `buttonColor` | Validated hex color with computed accessible foreground contrast. |
| `sortOrder` | Bounded integer, deterministic tie-breaker. |
| `issuer` | Required HTTPS issuer, path-bearing allowed, no credentials/query/fragment, exact spelling preserved. Immutable after creation; a different authority = a new provider. |
| `discoveryUrl` | Default derived from issuer per OIDC rules; explicit HTTPS override. Returned issuer must exactly match configured issuer. |
| `clientId` | Required. Never taken from browser-controlled params. |
| `clientSecret` | Write-only, encrypted. Omitted on update = unchanged; replacement must be nonempty. |
| `tokenEndpointAuthMethod` | `client_secret_basic` or `client_secret_post`, validated against discovery. |
| `scopes` | Default `openid profile email`; `openid`+`email` mandatory. Bounded extra scopes allowed; `offline_access` rejected. |
| `allowedEmailDomains` | Optional exact normalized domain list; empty = trust all verified emails. |
| `enabled` | Whether the provider is offered on the login page. Set by the admin on save; the test button does not change it. |

Callback URL is not editable: we display `${WELDALL_ISSUER}/api/auth/callback/${providerId}` with
copy controls, derived from deployment config, not request `Host` headers. Response type =
authorization code, PKCE S256, query response mode. No arbitrary token/userinfo params, mappers,
verification bypass, issuer overrides, or PKCE/nonce switches.

### DTOs

- Public login metadata: provider ID, button label/color/order for enabled providers only. Pending
  config never appears on the public page.
- Admin responses: nonsecret config, enabled state, `hasClientSecret`, validation timestamp.
- Never expose client secrets, ciphertext, codes, nonce, verifier, or raw upstream
  responses. We bound provider counts, input sizes, and discovery/JWKS sizes.

### Trust statement

A configured provider is an identity authority. Verified email is its assertion, not independent
proof. Domain restrictions constrain authority; they don't make a malicious provider safe. We
require clear acknowledgement before enabling/broadening a provider.

## Persistence

Additive Prisma migrations only; every existing migration stays byte-for-byte.

- `LoginInstallation`: singleton, `UNINITIALIZED` / `COMPLETED`, references completed admin user.
  An unmigrated/initial DB gets the singleton idempotently; a DB error is a service error, never an
  installer.
- `LoginProvider`: stable ID, presentation fields, issuer, client auth, scopes, allowed domains,
  enabled state, version, audit timestamps.
- `LoginAttempt`: short-lived server-side OIDC state/PKCE/nonce bound to provider, mode
  (`login`/`setup`/`provider-test`), browser, expiry, single-use consumption.
- An admin **test login** binds a transient attempt to the config submitted with the button (which
  may not yet be saved). Nothing is written to `LoginProvider`, no enabled state changes, and no
  test history is kept; the attempt is consumed after the flow.
- Setup stores the normalized nominated admin email + draft first provider transiently; nothing
  survives completion. Completed installation keeps no reusable setup capability.

Setup completion atomically: activates the tested provider, grants the nominated verified user
login/admin scopes additively, writes audit, marks `COMPLETED`. Interrupted attempts are retryable;
two admins can't both win setup. The privileged browser session is issued only after completion.

### Google cleanup migration

One new forward-only data migration: `DELETE FROM Account WHERE providerId='google' AND
issuer='https://accounts.google.com'`. It preserves all users/IDs, verification, grants,
application data, and non-Google bindings. No env-secret dependency, no credential import, no
replacement provider. It is a safe no-op on fresh DBs. We test populated-upgrade, no-Google, and
full-history replay. Legacy session/refresh revocation is a separate operator cutover step.

## Installer

- Flow: `/` and `/login` route an uninitialized install to `/setup`; CLI authorize gets an explicit
  setup-required outcome. The form asks for the first provider + first admin email → discovery
  preflight with sanitized errors → real OIDC authorization-code test bound to the nominated email →
  atomic completion.
- Wrong email, cancellation, failed exchange, replay, or competing completion produce no admin
  grants or sessions. Completed setup stays closed regardless.
- A completed installation with no enabled providers shows a normal login page; an operator with an
  existing admin session manages providers as usual.

## Runtime OIDC

- A provider registry resolves the selected provider per request from authoritative DB state; no
  module-time provider config. Discovery failure for one provider must not break others, session
  lookup, metadata, or machine/CLI endpoints. We cache initialization with bounded lifetime and
  evict failed promises. Availability decisions read the DB per attempt; caches never keep a
  disabled provider usable.
- Strict current-assertion validation before any write: verified signature/JWKS, RS256/ES256,
  issuer/audience/azp, expiry with bounded skew, nonce, nonempty subject, and boolean
  `email_verified: true` with domain match on every login, including already-bound identities.
- One normalized email = one user. We bind by (issuer, subject); same-email different issuers /
  pairwise subjects link to one verified user. Changed-email bindings and unverified local conflicts
  fail with diagnostics; no silent reassignment, no verification bypass.
- `login` state is single-use and checked against the provider's current enabled/config state before
  any write; in-flight login is rejected when its provider is disabled or re-enabled with a
  different config.
- We reuse one hardened outbound transport for discovery/token/userinfo/JWKS: connection-time DNS
  validation, no redirects, no credential leakage across origins, bounded time/bytes/shape, TLS
  verification always on. Public IdPs only; the dev fixture allows only its own fixture host. Fail
  closed; classified errors only.
- We do not request upstream refresh/offline access or persist upstream tokens. Downstream OAuth
  plugins and session/metadata/token handling stay provider-neutral and work with zero providers.
  No upstream network or DB contact during `next build`.

## Admin page (slim)

`/admin/login-providers` using existing admin patterns: list (name, button preview, issuer, state,
order) + create/edit form (appearance, connection, email authority, callback display).

- A **Test login** button runs the real one-time OIDC flow against the current form values in a
  new tab/overlay and reports pass/fail (no user/link/session created, admin session untouched). It
  persists nothing — not a provider row, not an enabled state, not a test result. Saving the
  configuration is the admin's explicit action, taken only if the test passes.
- Create/edit saves config and runs discovery preflight. Enable/disable, reorder. Disabling a
  provider just stops login for it; existing sessions and downstream tokens are not revoked by a
  provider edit (stated in UI).
- We remove a provider from login on request; identity bindings and audit are retained.
- All mutations are admin-authorized, versioned (`expectedVersion`), CSRF/origin-protected, and
  audited. We warn explicitly before disabling the last enabled provider, since login may become
  impossible.

## Removing Google and old configuration

- We delete Google provider code/settings/buttons/env validation/fixtures. We remove
  `ENABLE_DEV_LOGIN`, the special `devOidc` runtime branch, `oAuthProxy`, `OAUTH_PROXY_SECRET`, and
  the localhost callback flow. We remove `WELDALL_BOOTSTRAP_ADMIN_EMAIL` and the `admin:bootstrap`
  scripts; the installer is the only first-admin path.
- Dev IdP fixtures stay for the dev ordinary provider. Production never consumes dev env vars as
  a provider source. Builds stay offline and need no real secrets/DB/IdP.
- Cutover (operator task, not a feature): back up and drain, configure the encryption key,
  revoke legacy browser/CLI auth, deploy (Prisma applies schema + Google cleanup), verify, run the
  installer. Old access JWTs may outlive DB revocation; account for their lifetime. We do not run
  production remediation as part of implementation.

## Development and testing

- Empty dev DBs support the real installer (generated setup/encryption secrets, documented OIDC
  fixture values). Seeded dev fixtures use an ordinary provider + explicit completed state via a
  clearly dev-only helper; production seed leaves setup uninitialized.
- We add a second independent issuer/test identity to exercise same-email linking, subject
  collisions across issuers, and one failed provider not breaking another.
- No E2E coverage: the existing `apps/e2e` suite stays untouched and is not extended for this
  feature. Instead we write the unit/integration tests in the matrix below early, alongside the
  code, and verify the installer and admin flows manually once the feature is done.

## Test matrix

| Area | Positive | Negative/concurrency |
| --- | --- | --- |
| Config | path issuer, explicit discovery URL, both auth methods, deterministic buttons | issuer mismatch, bad metadata/color/domain, unsupported auth/algorithms, secrets in DTOs/logs |
| Network | public IdP, key rotation | private/loopback IPs, redirects, DNS rebinding, huge/slow discovery/JWKS |
| Tokens | signed ID token, nonce/PKCE/state, matching UserInfo subject | missing/unsigned ID token, wrong issuer/audience, stale time claims, replay, provider mix-up |
| Identity | new user, repeat login, second issuer same email, pairwise subject | false/string `email_verified`, changed email, unverified local conflict, concurrent create/link |
| Access | admin/login grants apply across providers | identity grants no scopes, CLI code/refresh denial, upstream roles ignored, blocked alt auth/link routes |
| Installer | exact-email test, fresh DB, existing verified user, retry | CSRF, wrong email, replay, competing setup, setup after completion |
| Admin | add/edit/enable/reorder, test login from unsaved form values | non-admin, stale versions, last-provider lockout warning, test persisting nothing |
| Runtime | two instances, multiple issuers, outage isolation | cached disabled provider, cached failed init, unbounded cache, IdP outage breaking neutral paths |
| Migration | full-history replay, populated upgrade, no-Google no-op, preserved users/grants | overbroad deletion, user/data loss, history rewrite, failed transaction |

Tests must assert absence of unauthorized DB/session/audit side effects, not just HTTP errors.
Real-DB tests prove uniqueness and locking; mocks alone don't establish concurrency safety.

## Completion checklist

- [ ] Zero-provider production image starts and exposes protected setup with no Google creds or
      reachable upstream IdP; offline build works.
- [ ] Installer only completes after a matching verified OIDC login and transactional admin/login
      grants; completed state cannot be reset via HTTP/provider mutations or inferred from errors.
- [ ] No built-in Google/provider-specific fallback or env-only dev login path remains.
- [ ] Forward-only migration deletes only legacy Google bindings/tokens; users/IDs/grants/data and
      all migration history stay intact; upgrade + replay tests pass.
- [ ] 2+ providers configurable live; same verified email resolves to the same user ID; strict
      verification, issuer/subject stability, domain authority, and conflicts are tested.
- [ ] Provider edits are admin-authorized, versioned, audited, and safe across instances; the test
      login button runs against unsaved values and persists nothing; secrets and upstream tokens are
      minimized/protected.
- [ ] Path-bearing issuer + explicit discovery URL works.
- [ ] Production build offline-safe; no E2E coverage added; installer/admin flows verified by the
      early unit/integration tests and by manual testing when done.
- [ ] CLI/DPoP, machine auth, downstream tokens, and resource/scope policy retain their contract.
- [ ] Cutover docs treat session/refresh revocation, outstanding JWTs, env removal, and external
      Google client retirement separately from account cleanup.
