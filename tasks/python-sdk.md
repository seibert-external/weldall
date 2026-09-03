# Weldall Python SDK (`weldall-sdk`)

## Status

Not started. This is the execution plan for a port of `@weldall/sdk` (TypeScript) to Python. The TypeScript package is the authoritative behavior reference; every Python module in this plan maps 1:1 to a TypeScript source file. **Read the authoritative files listed in [Current state and authoritative files](#current-state-and-authoritative-files) before writing any code** — where this plan and the TypeScript source disagree, the TypeScript source wins.

The repository license was changed to FSL-1.1-ALv2 (commit `b11c870` on `main`). The Python package must carry the same FSL-1.1-ALv2 license.

## Decision

Port `@weldall/sdk` to Python with feature parity on the resource-server and machine-client protocol surface, using the modern Python packaging stack. Specific decisions (all already discussed and accepted):

1. **JOSE/crypto:** build on **`joserfc`** (the actively-maintained JOSE library: JWS/JWK/JWKS/ES256/RFC 7638 thumbprints) + **`cryptography`** underneath. Use joserfc for _crypto primitives only_ — replicate all claim validation explicitly (see below), mirroring how the TS SDK hand-checks claims instead of relying on library claim features.
2. **DPoP is hand-rolled.** No mainstream Python library implements RFC 9449 DPoP proofs end-to-end (Authlib issue #315 still open). Port `dpop.ts` faithfully — it is already hand-rolled on top of `jose`.
3. **HTTP client:** `httpx` for the machine-client token request and discovery/JWKS fetches.
4. **Sync-first core.** The core (`init`, `verify`, `verifyNoThrow`, DPoP sign/verify, token issuance) is implemented as **plain synchronous functions**. ES256 verify is ~50µs of CPU — async adds nothing to the hot path and would break Django. Network I/O (discovery, machine token) is isolated in a small `httpx.Client`-backed layer guarded by `threading.Lock` single-flight. FastAPI adapters may call the sync core directly (sync endpoints run in a threadpool) or wrap in `asyncio.to_thread`.
5. **Framework-agnostic core + thin adapters**, mirroring the TS architecture (`core.ts` + `hono.ts`/`next.ts`/`astro.ts`):
   - **FastAPI (primary adapter)** — dependency `require_auth(policy)` + route registration for the protocol endpoints.
   - **Django (secondary adapter)** — middleware + views for the protocol endpoints.
   - No Hono/Next/Astro (JavaScript frameworks, not applicable). Starlette/FastAPI covers the async mainstream.
6. **Packaging:** `uv` + `hatchling`, `src/` layout, `py.typed`, PEP 621 metadata, PEP 639 `license = "FSL-1.1-ALv2"`, ship the FSL `LICENSE` file, pure-Python wheels + sdist.
7. **Publishing:** TestPyPI first, then PyPI via **trusted publishing** (GitHub Actions OIDC — no API token secrets), matching the repo's existing GitHub Actions CI.
8. **Naming:** PyPI distribution name `weldall-sdk`, import package `weldall`. Verify both are available on PyPI before proceeding; if `weldall` is taken, fall back to import `weldall_sdk` and record the decision here.
9. **Python support:** >= 3.11 (test on 3.11/3.12/3.13).

## Goals

- Port every public module of `@weldall/sdk` with behavior parity: configuration validation, ID-JAG assertion verification, user (`at+jwt`) and machine (`weldall-machine+jwt`) access-token verification, DPoP proof sign + strict verify, discovery + JWKS caching/rotation, replay protection, scope policy, OAuth authorization-server + protected-resource metadata endpoints, token endpoint (`urn:ietf:params:oauth:grant-type:jwt-dpop`), skills catalog endpoint + assertion, machine-client token request (RFC 7523 client assertion + DPoP).
- Ship FastAPI and Django adapters with the same `protect`/`getAuth`/route-registration semantics as the TS adapters.
- Port the TS test behaviors (core, machine, adapters, resource-registry) plus the RFC 7638 JWK thumbprint vector, as pytest suites.
- Publishable to PyPI with a fully automated trusted-publishing pipeline and a changelog that tracks the TS release cadence.

## Non-goals

- No algorithms other than ES256 / P-256 (same as TS). No JWE, no RS256, no symmetric JWT.
- No CLI port, no browser/OAuth-code flows, no refresh-token handling, no token exchange (constants exist in TS but the SDK does not implement an exchange endpoint).
- No native/compiled wheels (pure Python; `cryptography` supplies the native layer).
- No license-key / FCL-style monetization.
- No performance optimization of signature verification beyond the obvious.
- Not adding the Python package to the pnpm/turbo build graph (it is `uv`-managed; see layout).

## Current state and authoritative files

The implementation must start by reading these files rather than relying only on this plan:

**TS SDK (behavior source of truth):**

- `packages/sdk/src/core.ts` — `initWeldall`, token endpoint, `verify`/`verifyNoThrow`, metadata handlers, skills handler (540 lines — read fully)
- `packages/sdk/src/dpop.ts` — `createDpopProof`, `verifyStrictDpop`, `normalizeHtu`
- `packages/sdk/src/crypto.ts` — `base64urlSha256`, `safeEqual`, `isSha256JwkThumbprint`, `publicJwk`, `generateEs256KeyPair`, `assertPublicP256`, `validateEs256KeyPair`
- `packages/sdk/src/jwt.ts` — `signEs256`, `verifyEs256`, `parseJwkEnv`, `loadEs256KeyPairFromEnv`
- `packages/sdk/src/id-jag.ts` — `issueIdJag`, `verifyIdJag`
- `packages/sdk/src/machine.ts` — machine client assertion + `requestMachineToken`
- `packages/sdk/src/resource-as.ts` — `issueAccessToken`, `verifyAccessToken`
- `packages/sdk/src/discovery.ts` — `WeldallDiscovery`
- `packages/sdk/src/signing.ts` — direct key vs provider, `validatedJwks`, `signWithProvider`
- `packages/sdk/src/skills.ts` — `parseSkillCatalog`, `loadSkillCatalog`, catalog caps
- `packages/sdk/src/resource-registry.ts` — URL normalization helpers
- `packages/sdk/src/replay.ts`, `scope.ts`, `identity.ts`, `errors.ts`, `constants.ts`, `types.ts`
- `packages/sdk/test/core.test.ts`, `machine.test.ts`, `adapters.test.ts`, `resource-registry.test.ts`
- `packages/sdk/README.md` — API surface, protocol routes, production checklist

**Usage references:**

- `apps/weldall/src/server/oauth/facade.ts`, `apps/weldall/src/server/oauth/machine-api.ts`, `apps/weldall/src/server/oauth/cli-api.ts`, `apps/weldall/src/server/oauth/jwt.ts` — how the issuer actually signs (`getWeldallSigningKey`) and verifies machine tokens
- `examples/next`, `examples/hono`, `examples/basic` — consumer expectations
- `LICENSE` (root) — FSL-1.1-ALv2 text to reproduce verbatim in the package

## Protocol pins (from `constants.ts` / `machine.ts` — do not change)

| Constant                                        | Value                                                          |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `JWT_DPOP_GRANT`                                | `urn:ietf:params:oauth:grant-type:jwt-dpop`                    |
| `ID_JAG_DRAFT` claim `urn:weldall:id-jag-draft` | `draft-ietf-oauth-identity-assertion-authz-grant-04`           |
| `JWT_DPOP_DRAFT` (metadata)                     | `draft-parecki-oauth-jwt-dpop-grant-01`                        |
| `PRIVATE_KEY_JWT_ASSERTION_TYPE`                | `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`       |
| `MACHINE_TOKEN_TYP`                             | `weldall-machine+jwt`                                          |
| `MACHINE_TOKEN_LIFETIME_SECONDS`                | 300                                                            |
| `DPOP_MAX_AGE_SECONDS`                          | 60                                                             |
| `DPOP_FUTURE_SKEW_SECONDS`                      | 5                                                              |
| Token typ headers                               | `at+jwt`, `dpop+jwt`, `oauth-id-jag+jwt`, `weldall-skills+jwt` |
| `SKILL_CATALOG_PATH`                            | `/.well-known/weldall-skills`                                  |
| Access token lifetime / ID-JAG lifetime         | 600s / 300s                                                    |
| JWKS cache TTL / unknown-kid refresh throttle   | 60s / 5s                                                       |
| Discovery timeout                               | default 5000ms, allowed 100–30000                              |

## Repository layout

Place the package at **`packages/python-sdk/`** (next to `packages/sdk` for discoverability). It has no `package.json`, so pnpm/turbo ignore it (pnpm and turbo key off `package.json` presence); it is `uv`-managed. Confirm turbo ignores it in `turbo.json`/CI — if the root `pnpm`/`turbo` commands error on the directory, move it to a top-level `python-sdk/` instead and record that here.

```
packages/python-sdk/
  pyproject.toml            # PEP 621 metadata + hatchling + extras
  uv.lock
  README.md                 # mirrors packages/sdk/README.md API surface
  LICENSE                   # byte-identical copy of repo root LICENSE (FSL-1.1-ALv2)
  src/weldall/
    __init__.py             # public re-exports + __version__
    py.typed                # empty marker (typing)
    constants.py            # Protocol pins table
    errors.py               # WeldallAuthError, error response builder
    scope.py                # parse_scope
    identity.py             # has_verified_email
    crypto.py               # base64url_sha256, safe_equal, thumbprint helpers, keygen, P-256 asserts
    jwt.py                  # sign_es256, verify_es256, env JWK loading
    dpop.py                 # create_dpop_proof, verify_strict_dpop, normalize_htu
    replay.py               # ReplayStore protocol, in_memory store, consume_replay
    discovery.py            # WeldallDiscovery (metadata + JWKS caching/rotation)
    id_jag.py               # issue_id_jag, verify_id_jag
    resource_as.py          # issue_access_token, verify_access_token
    machine.py              # machine client assertion + request_machine_token
    signing.py              # direct key + provider, validated_jwks, sign_with_provider
    skills.py               # parse_skill_catalog, load_skill_catalog
    resource_registry.py    # URL normalization / prefix helpers
    core.py                 # init_weldall, token endpoint, verify/verify_no_throw, handlers
    adapters/
      __init__.py
      fastapi.py            # require_auth dependency, get_auth, register_routes
      django.py             # middleware + views + urls helper
  tests/
    test_core.py            # port of core.test.ts behaviors
    test_machine.py         # port of machine.test.ts
    test_adapters.py        # FastAPI + Django adapter tests (port of adapters.test.ts)
    test_resource_registry.py
    test_crypto.py          # RFC 7638 vector + ES256 keygen/round-trip
    test_dpop.py
    test_skills.py
  .github/                  # (if separate CI file needed; prefer wiring into root ci.yml)
```

## Module-by-module specification

### `errors.py` (port `errors.ts`)

- `WeldallAuthError(code: str, message: str = code, status: int = 400, required_scopes: list[str] = [], reason: str | None = None)` — dataclass/class mirroring the TS class exactly (including `reason="replay_detected"` marker).
- `oauth_error_response(error) -> (status, headers, body)` builder — JSON `{"error": code, "error_description": message}`; headers `cache-control: no-store`, `pragma: no-cache`; on 401/403 add `WWW-Authenticate: DPoP error="<code>"` plus `, scope="<scopes joined by space>"` when `required_scopes` is non-empty. Unknown errors map to `server_error` / 500.

### `scope.py` + `identity.py` (ports of the same)

- `parse_scope(value) -> list[str] | None`: split on single space; each token must match `^[\x21\x23-\x5b\x5d-\x7e]+$`; tokens must be unique; empty/non-string → `None`.
- `has_verified_email(claims) -> bool`: `email` is a non-empty string ≤320 chars, equals its trimmed value, matches `^[^\s@]+@[^\s@]+$`, and `email_verified is True`.

### `crypto.py` (port `crypto.ts`)

- `base64url_sha256(value: bytes|str) -> str` (URL-safe, no padding).
- `safe_equal(a, b) -> bool` via `hmac.compare_digest` after length check (must return `False` on length mismatch, never raise).
- `is_sha256_jwk_thumbprint(value) -> bool`: `^[A-Za-z0-9_-]{43}$`.
- `public_jwk(jwk) -> jwk`: P-256 EC only, extract `kty/crv/x/y`.
- `generate_es256_key_pair() -> DpopKeyPair` (`private_jwk`, `public_jwk`, `jkt`).
- `assert_public_p256(jwk) -> None`: exactly `kty=EC, crv=P-256, x, y` present, no `d`; `alg` if present must be `ES256`; `use` if present `sig`; `key_ops` if present exactly `["verify"]`; no unknown keys beyond `{kty,crv,x,y,use,key_ops,kid,alg}`. Also verify the JWK actually loads as an EC key (fail on invalid point).
- `validate_es256_key_pair(private_jwk, configured_public_jwk)`: private must be P-256 with `d`; derive public from private; RFC 7638 thumbprint of derived public must equal thumbprint of configured public (timing-safe).

### `jwt.py` (port `jwt.ts`)

- `sign_es256(payload, key: {kid, private_jwk, typ="JWT"})`: ES256, header `alg=ES256, kid, typ`.
- `verify_es256(token, {kid, public_jwk, issuer, audience, max_token_age_s?, typ, error_code, error_status})`: verify signature + header (`kid`, `typ` must match) + `iss`/`aud`/`exp`/`iat` (required), clock tolerance 5s, max age when provided → wrap all failures in `WeldallAuthError`.
- `load_es256_key_pair_from_env(private_name, private_value, public_name, public_value)`: JSON JWK parsing + `validate_es256_key_pair`.

### `dpop.py` (port `dpop.ts`) — **the risk center**

- `normalize_htu(input)`: only `https:` (or `http:` for `127.0.0.1`/`localhost`/`::1`); reject credentials; drop query + hash; lowercase hostname; drop default ports (443/80); produce canonical string.
- `create_dpop_proof({private_jwk, public_jwk, method, url, access_token?, now?, jti?})`: JWT with header `{typ:"dpop+jwt", alg:"ES256", jwk: public_jwk}`, claims `htm` (uppercased method), `htu` (normalized), `iat`, `jti` (uuid4); `ath` = `base64url_sha256(access_token)` only when binding a token.
- `verify_strict_dpop(proof, {method, url, replay, access_token?, expected_jkt?, now?}) -> VerifiedDpop`:
  1. decode header: `typ=="dpop+jwt"`, `alg=="ES256"`, no `crit`, `jwk` present → else `invalid_dpop_proof`.
  2. `assert_public_p256(header.jwk)`.
  3. verify signature against the embedded public JWK.
  4. claims: `htm` == method uppercased; `htu` parses as URL with no query/hash and `normalize_htu(htu) == normalize_htu(input.url)`; `iat` integer in `[now-60, now+5]`; `jti` string 1–128 chars.
  5. `jkt` = RFC 7638 thumbprint (SHA-256) of the header JWK; if `expected_jkt` given it must match timing-safe.
  6. if `access_token` given: `ath` must equal `base64url_sha256(access_token)`; else `ath` must be absent.
  7. consume replay on key `"dpop:{jkt}:{jti}"` with expiry `iat + 60 + 1`; replay → `invalid_dpop_proof` with `reason="replay_detected"`.
  - Return `{payload, public_jwk, jkt}`.

### `replay.py` (port `replay.ts`)

- `ReplayStore` protocol: `consume(key: str, expires_at: datetime) -> bool` (atomic; `True` = first use).
- `in_memory(max_entries=10000, suppress_warning=False)`: process-local map with expiry sweep; capacity → raise (must fail closed in callers).
- `consume_replay(store, namespace, key, expires_at, replay_error)`: prefix `"{namespace}:{key}"`; store failure → `temporarily_unavailable` (503); not-first → the configured replay error with `reason="replay_detected"`; `None`/"disabled" → no-op. One-time warning for `in_memory` unless suppressed (mirror TS `console.warn` behavior).

### `discovery.py` (port `discovery.ts`)

- `WeldallDiscovery(issuer, fetch_origin, timeout_ms)`.
- Discover `/.well-known/oauth-authorization-server` (fetched via `fetch_origin`): require `issuer` == canonical issuer; `jwks_uri` same-origin (no creds/query/hash). Fetch JWKS at `fetch_origin + jwks_uri.pathname` (proxy path-rewrite support): `application/json` or `application/jwk-set+json`, body ≤256KB, 1–20 keys, unique `kid`, each `assert_public_p256` and loadable as ES256.
- Caching: JWKS TTL 60s; **single-flight** (shared promise/lock) for metadata and JWKS; unknown-`kid` → force refresh, throttled to once per 5s; refresh-on-verification-failure path; revalidate after `jwks_uri` metadata re-fetch if cache expired.
- `get_signing_key(token, expected_typ, refresh_on_failure=False)`: read + validate header (`alg ES256`, `typ` match, no `crit`, `kid` string) → errors as `invalid_grant`.
- All fetch/parse failures map to `temporarily_unavailable` / 503 (never leak HTTP errors).
- Sync implementation with `threading.Lock` single-flight; `httpx.Client(timeout=...)`, `follow_redirects=False`.

### `signing.py` (port `signing.ts`)

- `DirectSigningKey = {kid, private_jwk, public_jwk}`; `SigningKeyProvider = {current() -> {kid, public_jwk, sign(payload, header)}, jwks() -> list[JWK]}`.
- `assert_signing_config(signing)`: direct key shape validation (private P-256 with `d`, public P-256 without `d`, derived public x/y match configured timing-safe) or provider with callables.
- `validated_jwks(provider) -> list[JWK]`: 1–20 keys, unique kids, `assert_public_p256`, tag `alg=ES256, use=sig`; any failure → `server_error` 500.
- `sign_with_provider(provider, payload, typ)`: `current()` → assert public P-256 → confirm the key's thumbprint is present in `provider.jwks()` (active-key-in-JWKS check) → sign → **re-verify** the returned token (signature, `typ`, header `kid/alg/typ`, payload deep-equals the input payload). Any mismatch → `server_error` 500 ("signing provider returned an invalid signature"). This is the KMS-safety check — port it exactly.

### `id_jag.py` (port `id-jag.ts`)

- `issue_id_jag(...)` and `verify_id_jag(token, {issuer, audience, resource, client_id, kid, public_jwk, allowed_scopes})`.
- Verify: ES256 + `typ=oauth-id-jag+jwt`, max age 5m, clock tolerance 5s; then explicit claims: `aud`==audience, `resource`==resource, `client_id`==client_id, `sub` non-empty string, `has_verified_email`, `jti` 1–128, integer `iat`/`exp`, `exp>iat`, `exp-iat<=300`, `cnf` object with `jkt` matching `^[A-Za-z0-9_-]{43}$`, `urn:weldall:id-jag-draft` == `draft-ietf-oauth-identity-assertion-authz-grant-04`, `parse_scope(scope)` truthy; unsupported scope → `invalid_scope`.

### `resource_as.py` (port `resource-as.ts`)

- `issue_access_token(...)` (issuer, sub, email, resource, client_id, scopes, jkt, kid, private_jwk, now): `at+jwt`, exp `now+600`.
- `verify_access_token(token, {issuer, resource, kid, public_jwk, client_id, required_scopes?})`: `typ=at+jwt`, max age 10m; explicit claims: `aud`==resource, `cnf.jkt` 43-char, `sub` non-empty, `has_verified_email`, `client_id` match, `jti` 1–128, integer times, `exp-iat<=600`, valid scope; missing required scope → `insufficient_scope` / 403 with `required_scopes`.

### `machine.py` (port `machine.ts`)

- `create_machine_client_assertion({client_id, token_endpoint, kid, private_jwk, now?, jti?})`: RFC 7523 JWT, header `{alg ES256, typ JWT, kid}`, claims `iss=sub=client_id`, `aud=token_endpoint` (normalized HTTPS, no query/fragment), `iat`, `exp=iat+60`, `jti`. Client ID / kid must match `^[A-Za-z0-9._:-]{1,128}$`.
- `request_machine_token({issuer, client_id, resource, scopes, kid, key, token_endpoint?, http_client?})`: POST form to token endpoint (`grant_type=client_credentials`, `client_id`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `client_assertion`, `resource`, `scope` joined by space) with a fresh DPoP proof (no `ath`). Response must be `{access_token: str, token_type: "DPoP", expires_in: 300, scope: str}` exactly — else `server_error` 500. Non-2xx → `WeldallAuthError(body.error, …, status)`.
- Default token endpoint `"{issuer}/api/auth/oauth2/token"` (note: **not** `/oauth/token` — this is the issuer's machine-token endpoint).

### `skills.py` (port `skills.ts`)

- Constants: `SKILL_CATALOG_SCHEMA_VERSION=1`, `SKILL_CATALOG_PATH="/.well-known/weldall-skills"`, `SKILL_ASSERTION_TYPE="weldall-skills+jwt"`, `SKILL_TAG_LIMIT=20`, `SKILL_TAG_LENGTH_LIMIT=40`.
- `parse_skill_catalog(value, expected_resource?)`: strict key-set validation (catalog/skill/meta keys), `schemaVersion==1`, `resource` match, ≤100 skills, unique `id` matching `^[a-z0-9]+(?:[_-][a-z0-9]+)*$` (≤120), title 1–200, content 1–100000, requiredScopes ≤100 each matching `^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$` and unique, visibility ∈ `{DEFAULT, HIDDEN_IF_UNALLOWED}`, meta rules (tags ≤20 non-empty ≤40-char; owner str; appearance string→string). Port every check verbatim.
- `load_skill_catalog(provider, resource)`: provider is `{items:[...]}` or `{load: callable}`; JSON-encode → ≤1 MiB → `parse_skill_catalog(parsed, resource)`.

### `resource_registry.py` (port `resource-registry.ts`)

- `normalize_resource_identifier`, `normalize_authorization_server`, `normalize_request_prefix` (reject percent-encoding, strip trailing slashes), `normalize_request_target`, `request_prefix_accepts`, `request_prefixes_overlap`, `resolve_resource_for_target`. All HTTPS-only, no credentials.

### `core.py` (port `core.ts`) — the orchestrator

- `init_weldall(host, options)` — a class (or closure) holding validated config:
  - Validation (all synchronous, `TypeError` on bad config, mirroring TS): `host` required absolute HTTPS URL (origin only, no creds/query/hash/fragment); `allow_insecure_loopback` permits `http://` only for `localhost`/`127.0.0.1`/`::1`; `discovery_proxy_origin` (origin only, defaults to host); `public_origin` (origin only); `resource` absolute HTTPS URL, path allowed, **no query**; `client_id` non-empty string; `supported_scopes` unique valid scope tokens; `discovery_timeout_ms` int 100–30000 (default 5000); `replay_store` required unless `"disabled"`; `skills` configures exactly one of `items`/`load`, and requires replay protection; `signing_key` via `assert_signing_config`.
  - Derived: `issuer = public_origin.origin`, `resource = resource_url`, `client_id`, `token_endpoint = "{issuer}/oauth/token"`, `skills_endpoint = "{issuer}/.well-known/weldall-skills"`.
  - `ready()`: run discovery + `validated_jwks` (fail early at startup).
  - `token_endpoint_handler(request)`: POST only; `application/x-www-form-urlencoded`; body ≤64KB; exactly one `grant_type` and one `assertion`; no other form keys; `grant_type == "urn:ietf:params:oauth:grant-type:jwt-dpop"` else `unsupported_grant_type`; exactly one `DPoP` header (no comma). Verify ID-JAG assertion (with refresh-once retry), then `verify_strict_dpop` with `expected_jkt = jag.cnf.jkt`, then consume replay on `"id-jag:{jti}"` (expiry `exp+6`). Issue `at+jwt` via signing provider: `iss=issuer, sub=jag.sub, email, email_verified=true, aud=resource, client_id, scope=jag.scope, cnf={jkt}, jti=uuid4, iat, exp=now+600`. Response `{access_token, token_type:"DPoP", expires_in:600, scope}` with no-store.
  - `verify(request) -> AuthContext` and `verify_no_throw(request, policy?)`:
    1. Authorization header must be exactly `DPoP <token>` (one token); DPoP header required, no comma → else 401 `invalid_token`.
    2. Decode header `typ`: `at+jwt` → user profile; `weldall-machine+jwt` → machine profile; anything else → 401 `invalid_token` (no profile fallback — "dispatches by exact typ without token confusion").
    3. User: `verify_user_token` (local signing keys, `iss=issuer, aud=resource`, required claims, max age 10m, header `alg ES256, typ at+jwt, no crit, kid string`). Machine: `verify_machine_token` (discovery keys, refresh-once on failure).
    4. Profile claim checks (exact, from `core.ts`): user → `client_id` match, verified email, `sub` string not starting `machine:`, no `identity_type`/`token_type`; machine → `client_id` string matching `^[A-Za-z0-9._:-]{1,128}$`, `sub == "machine:{client_id}"`, `azp == client_id`, `identity_type == "machine"`, `token_type == "machine"`, no `email`/`email_verified`.
    5. Global checks: `aud==resource`, `sub` non-empty, `jti` 1–128, integer `iat`/`exp`, `exp>iat`, `exp-iat <= (600 user | 300 machine)`, valid unique scopes all ∈ `supported_scopes`, `cnf.jkt` is 43-char thumbprint.
    6. DPoP: build public URL (`issuer` origin + incoming pathname/search — **network-path requests must not escape the configured public origin**, see test at core.test.ts:514), then `verify_strict_dpop(proof, {method, url, replay, access_token, expected_jkt=cnf.jkt})`.
    7. Scope policy: every scope in `policy.scopes` required; if `policy.any_scopes` non-empty, at least one required; missing → 403 `insufficient_scope` with the full required list. Empty policy still requires a valid Weldall request.
    8. Return `AuthContext`: discriminated by identity type — user `{identity_type:"user", identity:{type:"user", subject, email, email_verified:true}, subject, email, email_verified:true, scopes, token_id, client_id}`; machine `{identity_type:"machine", identity:{type:"machine", subject, client_id}, subject, client_id, scopes, token_id}`.
  - Handlers dict: `token`, `authorization_server_metadata`, `protected_resource_metadata`, `jwks`, `skills`. Metadata JSON must match `core.ts` exactly (see the `handlers` object), including `urn:weldall:jwt-dpop-draft` and conditional `weldall_skills_endpoint`.
  - `skills(request)`: GET only (405 with `Allow: GET`); exactly one `Bearer` assertion (no comma) → `verify_skill_assertion` (typ `weldall-skills+jwt`, `iss==sub==host origin`, `aud==skills_endpoint`, `resource==resource`, `purpose=="skills:read"`, `jti` 1–128, integer times, `exp-iat<=60`, replay consume `"skills:{jti}"` expiry `exp+6`), then `load_skill_catalog` and return JSON `{schemaVersion, resource, skills}` with `cache-control: private, no-store`. No `skills` configured → 404.

### `adapters/fastapi.py` (port `hono.ts` semantics)

- `init_weldall(host, options)` returns a wrapper around `core` exposing:
  - `require_auth(policy=None)` → a FastAPI dependency that runs `verify_no_throw` against `fastapi.Request` (method, URL, headers), returns `AuthContext` or raises a `HTTPException` built from `oauth_error_response` (status, headers incl. `WWW-Authenticate`, body as `JSONResponse`).
  - `get_auth(...)` — reads the value the dependency stored in `request.state`.
  - `register_routes(app)` — mounts: `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource` + `/{path:path}`, `GET /.well-known/jwks.json`, `GET /.well-known/weldall-skills` (only when skills configured), `POST /oauth/token`. Reads raw body for the form parser (respect the 64KB cap).
- Port the `adapters.test.ts` behaviors.

### `adapters/django.py`

- `WeldallMiddleware` — runs `verify_no_throw` (sync) on incoming requests for protected paths; sets `request.weldall_auth` or returns the error response (401/403 with `WWW-Authenticate`) before the view runs.
- Views for the six protocol endpoints + a `urls` helper mirroring `register_routes`.

### Machine client / HTTP

- `request_machine_token` uses `httpx.Client`. Keep the `http_client` injectable for tests (port `machine.test.ts` which fakes the HTTP layer).

## Test strategy

Port the TS suites behavior-for-behavior as `pytest`:

| TS suite                    | Python suite                                       | Must cover                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.test.ts`              | `test_core.py`                                     | config validation, discovery-proxy retrieval, skills publication + replay-safe assertion, RFC 7638 thumbprint vector, ID-JAG exchange + local token verify without network, wrong issuer/audience rejection, 401/403 + proof replay, no network-path escape, ID-JAG audience/client/resource/scope pinning, atomic ID-JAG consumption, JWKS rotation (unknown kid, reused kid, same-kid concurrent, removed key after TTL), fail-closed replay, KMS-style async signer |
| `machine.test.ts`           | `test_machine.py`                                  | strict RFC 7523 assertion (no private material in claims), DPoP-bound client-credentials token request, OAuth error + malformed response + resource-query rejection, machine principal discrimination + replay rejection, disabled replay validity, capacity fail-closed, exact-typ dispatch (no token confusion), wrong method/URL/ath rejection, wrong audience + foreign-machine-key proof rejection                                                                |
| `adapters.test.ts`          | `test_adapters.py`                                 | FastAPI dependency behavior + route registration; Django middleware/views                                                                                                                                                                                                                                                                                                                                                                                              |
| `resource-registry.test.ts` | `test_resource_registry.py`                        | normalization + prefix acceptance/overlap/resolve                                                                                                                                                                                                                                                                                                                                                                                                                      |
| —                           | `test_crypto.py`, `test_dpop.py`, `test_skills.py` | ES256 keygen/round-trip; DPoP sign/verify incl. skew bounds, `ath`, jkt mismatch, replay; skill catalog caps                                                                                                                                                                                                                                                                                                                                                           |

**Cross-validation requirement:** generate a DPoP proof + access token with the TS SDK (a small Node fixture in `tests/fixtures/` generated by a committed script) and verify it with the Python SDK, and vice versa — proving interop at the bytes level (ES256 JWK thumbprints, DPoP `ath`/`htu` normalization, claim encoding). Add this as `test_interop.py` and keep the fixture-generating script committed.

**RFC 7638 vector:** the exact official example thumbprint must pass (core.test.ts:352 asserts it against `jose`; replicate with joserfc).

Tooling: `pytest`, `pytest-asyncio` (only if an async wrapper is added), `mypy` (or `pyright`) + `ruff` in `check`. CI runs on 3.11/3.12/3.13.

## Packaging and publishing

`pyproject.toml` (PEP 621 + PEP 639):

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "weldall-sdk"
version = "0.1.0"            # or dynamic from __version__; align with changesets later
description = "Weldall resource-server SDK for Python (FastAPI, Django)"
readme = "README.md"
requires-python = ">=3.11"
license = "FSL-1.1-ALv2"     # PEP 639 SPDX-style string; FSL is not SPDX-listed → PyPI shows "Other"
license-files = ["LICENSE"]
dependencies = ["joserfc>=…", "cryptography>=…", "httpx>=…"]

[project.optional-dependencies]
fastapi = ["fastapi>=…", "starlette>=…"]
django = ["Django>=…"]
dev = ["pytest", "pytest-asyncio", "mypy", "ruff", "httpx"]

[tool.hatch.build.targets.wheel]
packages = ["src/weldall"]

[tool.hatch.build.targets.sdist]
include = ["src", "LICENSE", "README.md", "py.typed"]
```

Notes for the executor:

- **`license = "FSL-1.1-ALv2"` is a deliberate choice** consistent with the monorepo — PEP 639 accepts arbitrary SPDX expressions but FSL isn't in the SPDX list, so PyPI displays "Other". Ship the `LICENSE` file (byte-identical to repo root) via `license-files` so the text is in the wheel.
- Ship **sdist + wheel**; pure Python, so no platform wheels.
- **`uv` workflow:** `uv sync` (dev), `uv build` → `dist/`, `uv publish --publish-url https://test.pypi.org/legacy/` for dry runs, `uv publish` for real.
- **Trusted publishing:** add a `publish` job to `.github/workflows/ci.yml` using `pypa/gh-action-pypi-publish@release/v1` with `attestations: true`, triggered on the Changesets release event / tag (align with `release-cli-assets.yml` conventions). No API token secrets.
- **Version sync:** decide between static version vs `dynamic = ["version"]` from a `__version__` attribute. Keep it simple (static 0.1.x) and revisit when a release flow lands; do not invent a Python-specific release automation in this task.
- Add the package to the root `README.md` and `apps/docs` (small section) only after it is publishable.
- Do not add `packages/python-sdk` to `pnpm-workspace.yaml`, `turbo.json`, or the root `pnpm` scripts.

## Milestones and exit criteria

1. **Scaffold** — `packages/python-sdk/` with `pyproject.toml`, `uv` env, `src/` layout, `pytest`, `ruff`, `mypy` wired; `uv run pytest` passes on an empty suite.
2. **Crypto + DPoP** — `crypto.py`, `jwt.py`, `dpop.py` with `test_crypto.py` + `test_dpop.py` incl. RFC 7638 vector and TS-interop fixture. **Exit:** DPoP proof created by TS verifies in Python and vice versa.
3. **Core verify + discovery** — `errors/scope/identity/replay/discovery/signing` + `verify`/`verify_no_throw`; `test_core.py` ported (all `verify`/discovery/rotation behaviors). **Exit:** `core.test.ts` behaviors green except endpoint/adapter-specific ones.
4. **Token endpoint + issuance + skills** — `id_jag.py`, `resource_as.py`, `skills.py`, token/skills/metadata handlers; remaining `core.test.ts` behaviors. **Exit:** full `test_core.py`.
5. **Machine client + registry** — `machine.py`, `resource_registry.py`, `test_machine.py`, `test_resource_registry.py`. **Exit:** full machine parity.
6. **Adapters** — `adapters/fastapi.py`, `adapters/django.py`, `test_adapters.py`. **Exit:** FastAPI + Django smoke apps (from `examples/` analog) authenticate end-to-end against a running weldall dev stack.
7. **Packaging + CI** — `LICENSE`, `py.typed`, `pyproject` extras, trusted-publishing workflow, README. **Exit:** `uv build` produces sdist+wheel containing `LICENSE` + `py.typed`; `twine check`/`uv publish` to TestPyPI succeeds; CI matrix (3.11/3.12/3.13 + lint + typecheck + tests) green.
8. **Interop gate (final)** — run the cross-language DPoP/JWT fixtures both directions; document any deviations from the TS SDK in the README.

## Risks and sharp edges

- **DPoP correctness** is the highest-risk item — the TS `verifyStrictDpop` ordering (header → public-JWK assert → signature → claims → thumbprint → ath → replay) must be replicated exactly, including error codes (`invalid_dpop_proof` everywhere in this path) and the 401-status remap inside `verify()`.
- **`normalize_htu` equivalence** is subtle (default ports, lowercase host, query/hash stripping). Interop fixtures must lock it down.
- **URL handling differences:** Python `urllib.parse` vs WHATWG `URL` differ (e.g., default-port handling, percent-encoding normalization). Port `core.ts`'s URL parsing behavior deliberately; use tests (incl. the network-path-escape test) to catch mismatches.
- **Single-flight concurrency:** the TS discovery uses promise memoization; the Python port must use `threading.Lock`/condition so concurrent first requests don't stampede JWKS fetches (test: "shares a same-kid rotation refresh across concurrent exchanges").
- **Timing-safe comparisons** must never raise on length mismatch (`safe_equal` semantics) — `hmac.compare_digest` does, so guard it.
- **`sign_with_provider` KMS guard** must re-verify the provider's output token and deep-compare the payload (protects against a misbehaving KMS/vault signer).
- **Form parsing** on the token endpoint must be strict: reject duplicate/unknown params, enforce the 64KB cap, and reject non-form content types — port `core.ts`'s exact `URLSearchParams` checks.
- **sync core in async frameworks:** document that adapters calling sync `verify` from async handlers should use `asyncio.to_thread` only if profiling shows blocking matters (verify is CPU-only; discovery is the only network path and is single-flight).
- **PyPI name availability** must be checked before committing to `weldall` as the import name.
- **FSL license on PyPI** displays as "Other" (not SPDX-listed) — benign, but document it in the README to avoid surprise.

## Open questions for the executor

- Confirm PyPI availability of `weldall-sdk` / import name `weldall`.
- Confirm whether `packages/python-sdk/` is tolerated by the root pnpm/turbo/CI tooling (no `package.json`); if not, relocate to a top-level `python-sdk/` and update this plan's layout section.
- Decide static vs dynamic version and whether to sync with the Changesets release flow now or later.
- Confirm the Django adapter is in scope for this first port or should be cut to a FastAPI-only milestone 6.
