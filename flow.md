# Weldall OAuth, DPoP, and ID-JAG flow

This document describes the implemented flow. Tokens and codes are shortened in the HTTP examples.

## 1. Systems and URLs

```text
┌──────────────────────────┐
│ Weldall CLI              │
│ Public native client     │
│ client_id = weldall-cli  │
└────────────┬─────────────┘
             │ Browser + HTTP requests
             ▼
┌──────────────────────────┐          ┌──────────────────────────┐
│ Weldall                  │─────────►│ Google                   │
│ OAuth/OIDC IdP and AS    │  Login   │ Upstream identity       │
│ Next.js + Better Auth    │◄─────────│ provider                 │
└────────────┬─────────────┘          └──────────────────────────┘
             │ ID-JAG
             ▼
┌──────────────────────────┐
│ Expenses authorization   │
│ server                   │
│ Hono, without a database │
└────────────┬─────────────┘
             │ Expenses access token
             ▼
┌──────────────────────────┐
│ Expenses resource server │
│ GET/POST/DELETE API      │
└──────────────────────────┘
```

| System                         | Public URL                                                   |
| ------------------------------ | ------------------------------------------------------------ |
| Weldall                        | `https://weldall.seibert.localdev`                           |
| Weldall authorization endpoint | `https://weldall.seibert.localdev/api/auth/oauth2/authorize` |
| Weldall token endpoint         | `https://weldall.seibert.localdev/api/auth/oauth2/token`     |
| Weldall revocation endpoint    | `https://weldall.seibert.localdev/api/auth/oauth2/revoke`    |
| Weldall API                    | `https://weldall.seibert.localdev/api`                       |
| Expenses authorization server  | `https://expenses.seibert.localdev`                          |
| Expenses token endpoint        | `https://expenses.seibert.localdev/oauth/token`              |
| Expenses API                   | `https://expenses.seibert.localdev/api`                      |

Caddy terminates local TLS and proxies Weldall to port `3000` and Expenses to port `3001`. Protocol comparisons always use the public HTTPS URLs.

The only HTTP exceptions are:

- Google's local callback at `http://localhost:3000/api/auth/callback/google`
- the random native CLI callback at `http://127.0.0.1:<port>/callback`

## 2. Complete flow

```text
CLI                  Browser          Weldall          Google       Expenses AS      Expenses API
 │                      │                 │                │              │                │
 │ weldall login        │                 │                │              │                │
 │─ authorization URL ─►│                 │                │              │                │
 │                      │─ authorize ────►│                │              │                │
 │                      │                 │─ Google login ─►│              │                │
 │                      │                 │◄─ identity ─────│              │                │
 │                      │◄─ CLI code ─────│                │              │                │
 │◄─ loopback callback ─│                 │                │              │                │
 │                                        │                │              │                │
 │─ code + PKCE + DPoP ──────────────────►│                │              │                │
 │◄─ access + ID + refresh token ─────────│                │              │                │
 │                                        │                │              │                │
 │ weldall request                        │                │              │                │
 │─ refresh token + DPoP ────────────────►│                │              │                │
 │◄─ Weldall access + new refresh token ──│                │              │                │
 │─ GET /api/me/scopes + DPoP ──────────►│                │              │                │
 │◄─ resource registry + scopes ──────────│                │              │                │
 │                                        │                │              │                │
 │─ refresh token as subject_token ─────►│                │              │                │
 │◄─ ID-JAG ──────────────────────────────│                │              │                │
 │                                                                         │                │
 │─ ID-JAG + DPoP ────────────────────────────────────────────────────────►│                │
 │◄─ Expenses access token ────────────────────────────────────────────────│                │
 │                                                                                          │
 │─ access token + DPoP ──────────────────────────────────────────────────────────────────►│
 │◄─ API response ─────────────────────────────────────────────────────────────────────────│
```

## 3. DPoP basics

Each CLI installation creates its own ES256 P-256 key pair during login.

```text
macOS Keychain
├── device private JWK
├── device public JWK
└── current Weldall refresh token
```

The private key never leaves the device. Weldall and Expenses store or carry only the RFC 7638 thumbprint of the public key:

```json
{
  "cnf": {
    "jkt": "base64url-sha256-jwk-thumbprint"
  }
}
```

Every protected request contains a fresh `DPoP` header:

```http
DPoP: <proof-jwt>
```

Proof JWT header:

```json
{
  "typ": "dpop+jwt",
  "alg": "ES256",
  "jwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "...",
    "y": "..."
  }
}
```

Token-endpoint proof payload:

```json
{
  "htm": "POST",
  "htu": "https://weldall.seibert.localdev/api/auth/oauth2/token",
  "iat": 1780000000,
  "jti": "unique-proof-id"
}
```

An API request also includes `ath`:

```json
{
  "htm": "GET",
  "htu": "https://expenses.seibert.localdev/api/expenses",
  "ath": "base64url-sha256-of-access-token",
  "iat": 1780000010,
  "jti": "another-unique-proof-id"
}
```

| Claim | Purpose                                                     |
| ----- | ----------------------------------------------------------- |
| `htm` | Binds the proof to the HTTP method                          |
| `htu` | Binds the proof to the public target URL without query/hash |
| `iat` | Enforces a narrow validity window                           |
| `jti` | Enables replay detection                                    |
| `ath` | Binds the proof to one access token                         |

Token endpoints do not accept `ath` because no access token is presented as the API credential. Protected resource requests always require `ath`.

## 4. `weldall login`

### 4.1 Local preparation

The CLI:

1. creates an ES256 device key pair,
2. creates `state`, an OIDC `nonce`, and a PKCE verifier,
3. computes `code_challenge = BASE64URL(SHA-256(code_verifier))`,
4. starts an HTTP server on `127.0.0.1` with a random port,
5. opens the browser.

### 4.2 CLI authorization request

```http
GET /api/auth/oauth2/authorize?
  response_type=code&
  prompt=consent&
  client_id=weldall-cli&
  redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback&
  scope=openid%20profile%20email%20offline_access%20weldall%3Ascopes&
  state=<random-state>&
  nonce=<random-nonce>&
  code_challenge=<pkce-challenge>&
  code_challenge_method=S256&
  resource=https%3A%2F%2Fweldall.seibert.localdev%2Fapi&
  dpop_jkt=<device-key-thumbprint>
Host: weldall.seibert.localdev
```

Important parameters:

| Parameter        | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `prompt`         | Requires an approval screen for every CLI login          |
| `client_id`      | Fixed public client `weldall-cli`                        |
| `redirect_uri`   | Dynamic native loopback callback                         |
| `scope`          | Requests identity claims, offline access, and CLI access |
| `state`          | CSRF protection and request/response binding             |
| `nonce`          | Binds the ID token to this login                         |
| `code_challenge` | PKCE protection for the authorization code               |
| `resource`       | Requested audience for the Weldall access token          |
| `dpop_jkt`       | Binds the code and tokens to the device key              |

The client is registered without a secret by the Prisma migrations. PKCE and DPoP are mandatory.

### 4.3 Google login inside Weldall

If no Weldall browser session exists, Better Auth redirects to `/login`. The login button starts Google social login.

A simplified Google request looks like this:

```http
GET https://accounts.google.com/o/oauth2/v2/auth?
  client_id=<GOOGLE_CLIENT_ID>&
  redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fcallback%2Fgoogle&
  response_type=code&
  scope=openid%20email%20profile&
  state=<better-auth-state>
```

After login, Google calls:

```http
GET http://localhost:3000/api/auth/callback/google?
  code=<google-authorization-code>&
  state=<better-auth-state>
```

The Google authorization code is not the later Weldall authorization code. Better Auth exchanges the Google code server-side with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, creates or loads the user, Google account, and browser session, and resumes the original Weldall authorization flow.

Google does not accept `.localdev` callbacks, so Better Auth's OAuth proxy plugin carries the result in a short-lived encrypted value from `localhost:3000` back to `https://weldall.seibert.localdev`.

### 4.4 Authorization response to the CLI

Weldall sends its own single-use authorization code to the loopback callback:

```http
GET http://127.0.0.1:43123/callback?
  code=<weldall-authorization-code>&
  state=<random-state>&
  iss=https%3A%2F%2Fweldall.seibert.localdev
```

The CLI verifies:

- callback path `/callback`,
- exact `state` match,
- exact issuer in `iss`,
- single use and timeout.

### 4.5 Code exchange with PKCE and DPoP

```http
POST /api/auth/oauth2/token HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <proof-for-weldall-token-endpoint>

grant_type=authorization_code
&client_id=weldall-cli
&code=<weldall-authorization-code>
&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback
&code_verifier=<pkce-verifier>
```

Weldall and Better Auth verify:

- client and redirect URI,
- active, unused authorization code,
- PKCE S256 verifier,
- DPoP signature, `htm`, `htu`, `iat`, and `jti`,
- DPoP key against the authorization request's `dpop_jkt`.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "token_type": "DPoP",
  "access_token": "<weldall-access-token>",
  "id_token": "<weldall-id-token>",
  "refresh_token": "<opaque-refresh-token>",
  "expires_in": 3600,
  "scope": "openid profile email offline_access weldall:scopes"
}
```

The Weldall access token includes:

```json
{
  "iss": "https://weldall.seibert.localdev",
  "sub": "<weldall-user-id>",
  "aud": [
    "https://weldall.seibert.localdev/api",
    "https://weldall.seibert.localdev/api/auth/oauth2/userinfo"
  ],
  "scope": "openid profile email offline_access weldall:scopes",
  "cnf": { "jkt": "<device-key-thumbprint>" }
}
```

The CLI validates the access token, ID token, signatures, issuer, audiences, time claims, ID-token `nonce`, and `cnf.jkt`.

It then stores only the device key and refresh token in Keychain. Access and ID tokens are not stored persistently.

### 4.6 Weldall persistence during login

Better Auth stores records including:

```text
User
Account (Google)
Session (browser)
OauthRefreshToken
```

The token facade adds:

```text
OAuthDeviceRefreshBinding
├── refresh-token hash
├── user ID
├── client_id = weldall-cli
├── familyId
├── dpopJkt
├── expiresAt
├── rotatedAt / revokedAt
└── replacementHash
```

The raw refresh token is not stored in this sidecar table.

## 5. Refresh and `weldall scopes`

Each CLI command is a new process, so it reads the current refresh token and device key from Keychain.

### 5.1 Refresh request

```http
POST /api/auth/oauth2/token HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <new-proof>

grant_type=refresh_token
&refresh_token=<current-refresh-token>
&client_id=weldall-cli
```

In addition to Better Auth validation, Weldall verifies:

- active sidecar binding,
- refresh token has not already been rotated,
- DPoP thumbprint matches `dpopJkt`,
- token family has not been revoked.

Response:

```json
{
  "token_type": "DPoP",
  "access_token": "<new-weldall-access-token>",
  "refresh_token": "<rotated-refresh-token>"
}
```

The CLI atomically replaces the previous refresh token in Keychain while holding its cross-process lock.

```text
Refresh token A ──refresh──► Refresh token B
      │                           │
      └─ rotatedAt set            └─ same familyId
```

If token A is used again, the entire family is revoked.

### 5.2 Scope request

```http
GET /api/me/scopes HTTP/1.1
Host: weldall.seibert.localdev
Authorization: DPoP <weldall-access-token>
DPoP: <proof-with-ath>
```

Weldall verifies:

- access-token signature, issuer, and audience,
- `weldall:scopes` scope,
- `cnf.jkt` against the proof key,
- `ath` against the access token,
- `htm=GET`, canonical `htu`, `iat`, and replay `jti`,
- user exists and has a verified email address.

The response is also the CLI resource registry:

```json
[
  {
    "key": "expenses",
    "name": "Expenses",
    "resourceIdentifier": "https://expenses.seibert.localdev/api",
    "authorizationServer": "https://expenses.seibert.localdev",
    "downstreamClientId": "weldall-cli-at-expenses",
    "requestPrefixes": ["https://expenses.seibert.localdev/api"],
    "supportedScopes": ["expenses:create", "expenses:delete", "expenses:read", "expenses:write"],
    "grantedScopes": ["expenses:create", "expenses:delete", "expenses:read", "expenses:write"]
  }
]
```

Resource definitions, prefixes, and supported scopes come from the downstream registry in PostgreSQL. `grantedScopes` is derived independently from direct email assignments and live provider-group membership. Every active resource is returned; protected system scopes such as `weldall:administer` can also be configured as supported scopes. Provider errors, provider deactivation, version changes, or removed memberships revoke group-based scopes fail-closed while independent direct grants remain active.

## 6. `weldall request`

Example:

```bash
weldall request --scope expenses:read \
  https://expenses.seibert.localdev/api/expenses
```

The CLI performs four stages:

```text
1. Refresh the Weldall access token, load the registry, match the target URL, and check scopes
2. Request an ID-JAG from Weldall
3. Exchange the ID-JAG at the registered authorization server
4. Call the complete HTTPS URL directly with a DPoP proof bound to the access token
```

### 6.1 Stage 1: refresh and registry

`weldall request` uses the same refresh and `GET /api/me/scopes` flow as `weldall scopes`. The target URL comes directly from the CLI command; it is not assembled from an endpoint catalog. Before token exchange, its exact origin and a path-segment boundary must match exactly one registered prefix. Only then does the CLI check supported and granted scopes. Redirects are not followed.

### 6.2 Stage 2: request an ID-JAG from Weldall

```http
POST /api/auth/oauth2/token HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <proof-for-weldall-token-endpoint>

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&requested_token_type=urn:ietf:params:oauth:token-type:id-jag
&audience=https%3A%2F%2Fexpenses.seibert.localdev
&resource=https%3A%2F%2Fexpenses.seibert.localdev%2Fapi
&scope=expenses%3Aread
&subject_token=<current-weldall-refresh-token>
&subject_token_type=urn:ietf:params:oauth:token-type:refresh_token
&client_id=weldall-cli
```

In this profile, `subject_token` is the current Weldall refresh token. It proves the existing Weldall login. Weldall checks both Better Auth's `OauthRefreshToken` and the `OAuthDeviceRefreshBinding`.

ID-JAG draft 04 primarily shows an ID token as `subject_token`, but section 4.3.2 also permits the refresh-token variant implemented here when the identity provider supports it.

Weldall verifies:

- active, unrotated, unrevoked refresh token,
- matching Better Auth and sidecar records,
- user, public client, and device-key binding,
- target audience and resource resolve to the same active database resource,
- requested scopes are supported by that resource and granted to the user,
- valid, unused DPoP proof.

Token-exchange response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "issued_token_type": "urn:ietf:params:oauth:token-type:id-jag",
  "access_token": "<signed-id-jag>",
  "token_type": "N_A",
  "expires_in": 300,
  "scope": "expenses:read"
}
```

The response field is named `access_token` for protocol compatibility even though the ID-JAG is not an API access token.

The ID-JAG contains:

```json
{
  "iss": "https://weldall.seibert.localdev",
  "sub": "<weldall-user-id>",
  "email": "<verified-email>",
  "email_verified": true,
  "aud": "https://expenses.seibert.localdev",
  "client_id": "weldall-cli-at-expenses",
  "resource": "https://expenses.seibert.localdev/api",
  "scope": "expenses:read",
  "cnf": { "jkt": "<device-key-thumbprint>" },
  "jti": "<one-time-grant-id>",
  "iat": 1780000020,
  "exp": 1780000320,
  "urn:weldall:id-jag-draft": "draft-ietf-oauth-identity-assertion-authz-grant-04"
}
```

JWT header:

```json
{
  "alg": "ES256",
  "kid": "<weldall-signing-kid>",
  "typ": "oauth-id-jag+jwt"
}
```

### 6.3 Stage 3: exchange the ID-JAG at the Expenses authorization server

```http
POST /oauth/token HTTP/1.1
Host: expenses.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <new-proof-for-expenses-token-endpoint>

grant_type=urn:ietf:params:oauth:grant-type:jwt-dpop
&assertion=<signed-id-jag>
```

Expenses verifies:

- ID-JAG signature with Weldall's public key,
- `typ=oauth-id-jag+jwt` and `alg=ES256`,
- exact Weldall issuer,
- non-empty `email` with `email_verified=true`,
- `aud=https://expenses.seibert.localdev`,
- `resource=https://expenses.seibert.localdev/api`,
- `client_id=weldall-cli-at-expenses`,
- `iat`, `exp`, maximum lifetime, and `jti`,
- all scopes are supported locally,
- DPoP signature and request binding,
- proof-key thumbprint matches `ID-JAG.cnf.jkt`,
- proof `jti` and ID-JAG `jti` have not been used.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "token_type": "DPoP",
  "access_token": "<expenses-access-token>",
  "expires_in": 600,
  "scope": "expenses:read"
}
```

The Expenses access token contains:

```json
{
  "iss": "https://expenses.seibert.localdev",
  "sub": "<weldall-user-id>",
  "email": "<verified-email>",
  "email_verified": true,
  "aud": "https://expenses.seibert.localdev/api",
  "client_id": "weldall-cli-at-expenses",
  "scope": "expenses:read",
  "cnf": { "jkt": "<device-key-thumbprint>" },
  "jti": "<access-token-id>",
  "iat": 1780000030,
  "exp": 1780000630
}
```

The token is signed with the Expenses signing key and has `typ=at+jwt`.

### 6.4 Stage 4: call the Expenses API directly

#### GET

CLI command:

```bash
weldall request --scope expenses:read \
  https://expenses.seibert.localdev/api/expenses
```

HTTP request:

```http
GET /api/expenses HTTP/1.1
Host: expenses.seibert.localdev
Authorization: DPoP <expenses-access-token>
DPoP: <proof-with-ath>
```

Required scopes:

```text
expenses:read
```

#### POST

CLI command:

```bash
weldall request --method POST \
  --scope expenses:create \
  --json '{"description":"Train","amount":24}' \
  https://expenses.seibert.localdev/api/expenses
```

HTTP request:

```http
POST /api/expenses HTTP/1.1
Host: expenses.seibert.localdev
Content-Type: application/json
Authorization: DPoP <expenses-access-token>
DPoP: <proof-with-ath>

{
  "description": "Train",
  "amount": 24
}
```

Required scopes:

```text
expenses:create
```

#### DELETE with all-of scopes

CLI command:

```bash
weldall request --method DELETE \
  --scope expenses:delete \
  --scope expenses:write \
  https://expenses.seibert.localdev/api/expenses/expense-1
```

HTTP request:

```http
DELETE /api/expenses/expense-1 HTTP/1.1
Host: expenses.seibert.localdev
Authorization: DPoP <expenses-access-token>
DPoP: <proof-with-ath>
```

Both scopes must be present in the token:

```text
expenses:delete AND expenses:write
```

For every API request, the shared Hono middleware verifies:

```text
Expenses access-token signature
+ exact issuer and audience
+ client_id
+ expiration and required all-of scopes
+ access-token cnf.jkt
+ DPoP proof signature
+ htm / canonical public htu
+ ath
+ narrow iat window
+ unique proof jti
```

Weldall is not involved in this API call and sees neither the Expenses access token nor the request or response.

## 7. `weldall logout`

```http
POST /api/auth/oauth2/revoke HTTP/1.1
Host: weldall.seibert.localdev
Content-Type: application/x-www-form-urlencoded
DPoP: <proof-for-revocation-endpoint>

token=<current-refresh-token>
&token_type_hint=refresh_token
&client_id=weldall-cli
```

The revocation facade:

1. finds the binding by refresh-token hash,
2. verifies the DPoP key against `dpopJkt`,
3. delegates token revocation to Better Auth,
4. marks the entire sidecar family as revoked.

The CLI then removes the Keychain entry containing the device key and refresh token. It also removes the local entry if the remote revocation request fails and reports the error.

## 8. Weldall facade split

```text
POST /api/auth/oauth2/token
            │
            ▼
      tokenFacade
       ├── grant_type=authorization_code
       │     └── Better Auth
       │           └── facade verifies response and creates device binding
       │
       ├── grant_type=refresh_token
       │     ├── sidecar/DPoP preflight
       │     ├── Better Auth rotation
       │     └── sidecar rotation / family revocation
       │
       └── grant_type=...:token-exchange
             └── custom ID-JAG issuance

POST /api/auth/oauth2/revoke
            │
            ▼
    revocationFacade
       ├── sidecar/DPoP verification
       ├── Better Auth revocation
       └── sidecar family revocation

all other /api/auth/* requests
            │
            ▼
      Better Auth catch-all
```

Better Auth remains responsible for standard OAuth grants, sessions, and Google login. The facades add the Weldall-specific ID-JAG and DPoP profile.

## 9. Discovery and JWKS endpoints

### Weldall

```http
GET /.well-known/oauth-authorization-server
GET /.well-known/openid-configuration
GET /.well-known/oauth-protected-resource/api
GET /api/oauth/jwks
```

### Expenses

```http
GET /.well-known/oauth-authorization-server
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/api
GET /.well-known/jwks.json
```

For each request, the CLI uses the registry generated from PostgreSQL by `GET /api/me/scopes`. It does not perform downstream-service discovery; the downstream token endpoint is contractually `<authorizationServer>/oauth/token`. The demo well-known endpoints still document issuer, resource, and JWKS metadata.

## 10. Persistence and lifetime

```text
macOS Keychain
├── device private/public key
└── current Weldall refresh token

CLI memory
├── Weldall access token
├── Weldall ID token
├── ID-JAG
├── Expenses access token
└── DPoP proofs

Weldall PostgreSQL
├── Better Auth user / account / session
├── OAuth client / resource
├── OauthRefreshToken
├── OAuthDeviceRefreshBinding
└── ReplayMarker for token/revocation DPoP, machine assertions, and IaC DPoP

Weldall process memory
├── /api/me/* CLI API DPoP replay store
└── Better Auth native OAuth DPoP replay store

Expenses process memory
├── DPoP-jti replay store
└── ID-JAG-jti replay store
```

| Object                | Persistence                                  |
| --------------------- | -------------------------------------------- |
| Device private key    | macOS Keychain                               |
| Weldall refresh token | macOS Keychain and hashed at Weldall         |
| Weldall access token  | CLI memory only                              |
| ID token              | CLI memory during login only                 |
| ID-JAG                | CLI memory only                              |
| Expenses access token | CLI memory only                              |
| DPoP proof            | Not stored; only replay markers are retained |

The Weldall token and revocation facades, machine assertions, and IaC DPoP verification use shared PostgreSQL `ReplayMarker` rows. Those checks survive restarts and work across Weldall instances. DPoP verification for `/api/me/*`, Better Auth's native OAuth DPoP checks, and the Expenses demo replay stores remain process-local and are cleared on restart. Only those remaining paths need shared atomic replay storage before they can be scaled safely across multiple processes.
