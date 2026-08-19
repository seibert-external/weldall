# CLI-assisted Weldall connections for browser SPAs

## Status

Approved product direction; implementation not started.

## Outcome

A browser SPA hosted by an enabled Weldall resource can establish a durable Weldall connection without another identity-provider login. The SPA displays a short code and the user approves it through their existing CLI session:

```sh
weldall connect ABCD-EFGH
```

Weldall then issues a separate browser session bound to a browser-generated, non-exportable DPoP key. The SPA uses that session to obtain just-in-time ID-JAGs and call the same DPoP-protected downstream APIs as `weldall request`.

The CLI approval and browser credential issuance are separate concerns. A later browser OAuth/SSO flow can replace the CLI approval while producing the same `BrowserConnection` and credential shape.

## Product decisions

- Every enabled downstream resource is automatically eligible as a first-party browser application.
- Allowed SPA origins are derived from the resource's authorization-server origin and request-prefix origins.
- A connection belongs to exactly one resource. It can request ID-JAGs only for that resource.
- `weldall connect CODE` approves the browser application, origin, resource, user, and browser key. It does not snapshot business scopes.
- Every ID-JAG request evaluates current user assignments, group-derived access, resource state, resource-supported scopes, and connection state live.
- The downstream API trusts the Weldall identity carried by the token independently from any existing downstream cookie identity.
- A regularly used browser connection remains active without repeated CLI approval. Browser refresh bindings use a sliding inactivity lifetime and rotate on refresh.
- Browser connections are visible and individually revocable by the user and administrators.
- Protected UI operations use the same Weldall-protected API routes as CLI operations.

## Architecture

```text
SPA                         Weldall                         CLI
 │                             │                             │
 │ generate WebCrypto key      │                             │
 │                             │                             │
 │ start device authorization  │                             │
 │ Origin + resource + DPoP ──>│                             │
 │<─ device_code + user_code ──│                             │
 │                             │                             │
 │ show:                       │                             │
 │ weldall connect ABCD-EFGH   │                             │
 │                             │<─ lookup CODE + CLI DPoP ──│
 │                             │─ app/resource context ─────>│
 │                             │<─ explicit approval ───────│
 │                             │                             │
 │ poll token endpoint + DPoP ─>                             │
 │<─ browser access/refresh ───│                             │
 │                             │                             │
 │ token exchange + DPoP ─────>│                             │
 │<─ ID-JAG for own resource ──│                             │
 │                                                           │
 │ ID-JAG + DPoP ───────────────> downstream /oauth/token     │
 │<─ downstream DPoP token ─────                              │
 │                                                           │
 │ Authorization: DPoP + proof ─> existing protected API     │
```

### Credential separation

```text
Weldall user
├── client: weldall-cli
│   ├── CLI DPoP key in OS credential storage
│   └── CLI refresh family
└── client: weldall-browser:<resource-key>
    ├── non-exportable WebCrypto DPoP key
    └── separate browser refresh family
```

The CLI writes only an approval decision to Weldall. Browser tokens are minted by Weldall for the browser JKT. CLI and browser refresh families are separately auditable and revocable.

## Standards profile

| Mechanism                           | Use                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| RFC 8628 Device Authorization Grant | `device_code`, `user_code`, token polling, polling errors, expiry, and backoff |
| RFC 9449 DPoP                       | Browser token requests, refresh, downstream exchange, and API requests         |
| RFC 9700 OAuth Security BCP         | Public-client and refresh-token security baseline                              |
| RFC 8693 OAuth Token Exchange       | Existing refresh-token-to-ID-JAG exchange seam                                 |
| Weldall's pinned ID-JAG draft       | Resource-specific identity assertion                                           |
| Web Cryptography API                | Browser P-256 key generation, persistence, and signing                         |
| Weldall extension                   | CLI approval of a pending browser grant                                        |
| Weldall extension                   | Pre-binding a pending device grant to the browser DPoP JKT                     |

Use the standard device-code grant type at the token endpoint:

```text
grant_type=urn:ietf:params:oauth:grant-type:device_code
```

The CLI approval route is a first-party approval extension. The polling and error contract follows RFC 8628. Weldall documentation must identify the CLI approval and initiation-time DPoP binding as Weldall profile extensions.

PKCE belongs to the later browser authorization-code flow. The device flow uses a high-entropy `device_code`, one-time state, and a pre-bound DPoP JKT.

## Security invariants

### Browser key binding

- The SPA generates ES256/P-256 keys with Web Crypto.
- The private `CryptoKey` is non-exportable.
- Weldall derives the JKT from a verified DPoP proof on connection start.
- Polling, refresh, and ID-JAG exchange require proofs from the same key.
- Downstream token exchange and API calls preserve the existing JKT, `htu`, `htm`, `ath`, issuer, audience, subject, client, resource, scope, and replay validation.
- New Weldall approval and connection routes use the shared PostgreSQL replay store.

### Origin and resource binding

An HTTP `Origin` header is browser and CORS metadata, not cryptographic proof of an application's identity. Non-browser clients can forge it. Security therefore comes from the combination of:

- a registered enabled resource;
- an exact allowed origin derived from that resource;
- a browser-key-bound pending request;
- a high-entropy browser-held device secret;
- explicit CLI confirmation showing the claimed origin and resource;
- a user instruction to approve only a connection they initiated in that exact application;
- live origin/resource/client checks throughout the refresh and ID-JAG lifecycle.

Weldall checks the stored origin against the resource's **current** derived origin set during polling, refresh, ID-JAG exchange, and revocation. A resource origin change transactionally revokes affected browser connections and refresh families. Resource disablement or deletion also blocks the connection immediately.

### Short-code and pending-request safety

- `device_code` is high entropy, browser-held, and stored only as a hash server-side.
- `user_code` is typo-resistant, short-lived, one-use, normalized, and stored only as a hash.
- Codes expire after five minutes by default.
- Start, lookup, approval, and polling are rate-limited.
- Limits exist per network source, browser client, resource, origin, user code, and account, plus a global active-request cap.
- Rejected starts do not allocate persistent state.
- Expired pending rows are cleaned up with bounded retention.
- State transitions are atomic: `pending → approved|denied|expired → issuing → consumed`.
- Concurrent polling produces at most one browser credential family.
- Unknown, expired, denied, and consumed codes use enumeration-resistant responses on unauthenticated and code-lookup paths.
- The authenticated CLI receives enough context for a useful terminal error only after safe lookup and authorization checks.

The human code is sent in a POST body on CLI lookup/approval APIs rather than URL paths or query strings. Proxy and application logging redact both code fields. The optional `verification_uri_complete` is omitted from the initial profile.

### Refresh and issuance safety

- Every browser refresh resolves a mandatory `BrowserConnection` relationship.
- Refresh checks connection, browser client, origin, resource, JKT, and current `weldall:login` access before rotation.
- Browser connection revocation atomically marks the connection revoked and revokes every local/provider refresh binding in its family.
- A reused rotated refresh token triggers family revocation only after a valid proof from the bound JKT has been verified. An invalid proof cannot revoke another session.
- Provider token issuance uses a durable issuance state machine with a unique request-to-connection/family invariant.
- The server buffers the token response until provider tokens, the Weldall binding, the browser connection, and consumed pending state are durably linked.
- Crash recovery reconciles attempts left after claim, provider issuance, local binding creation, and response loss.
- Kill-point tests cover every issuance boundary.

### Browser threat boundary

A non-exportable WebCrypto key prevents raw private-key export through the Web Crypto API. Same-origin script can still ask the key to sign. The browser SDK therefore exposes this accepted boundary clearly and the integration documentation requires HTTPS, a strict CSP, controlled third-party scripts, and dependency hygiene.

## Browser key and credential storage

Generate the key with Web Crypto:

```ts
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign", "verify"],
);
```

Expected properties:

```text
privateKey.extractable = false
publicKey.extractable  = true
```

- Export only the public key as JWK.
- Calculate the RFC 7638 JKT from the public JWK.
- Sign DPoP JWTs through browser-compatible `jose` APIs using the private `CryptoKey`.
- Persist the private `CryptoKey` through IndexedDB structured cloning.
- Persist a schema-versioned connection record and rotating DPoP-bound refresh token in IndexedDB.
- Keep Weldall access tokens, ID-JAGs, and downstream access tokens in memory.
- Coordinate refresh rotation across tabs with `navigator.locks` in the initial browser profile.
- A lost key or cleared browser storage starts a fresh connection.

## Browser capability detection

The browser package performs a capability check before discovery, pairing, credential reads, or network requests.

Required capabilities for the initial profile:

- secure context (`globalThis.isSecureContext`);
- `crypto.subtle`;
- ECDSA P-256 key generation and signing;
- a generated private key that reports `extractable === false`;
- public-JWK export;
- IndexedDB;
- IndexedDB structured cloning and reload of a non-exportable `CryptoKey`;
- `fetch`, `URL`, `TextEncoder`, `AbortController`, and `crypto.getRandomValues`/`randomUUID`;
- `navigator.locks` for cross-tab refresh serialization.

Expose both an inspection API and a throwing guard:

```ts
const support = await inspectWeldallBrowserSupport();

if (!support.supported) {
  renderUnsupportedBrowser(support.missingFeatures);
}

await requireWeldallBrowserSupport();
```

`createWeldallBrowserClient()` calls the guard automatically and throws a typed `WeldallBrowserUnsupportedError` containing stable capability codes and a user-facing recovery message. The Expenses development UI renders this error visibly instead of leaving a rejected promise or generic network failure.

Support is feature-detected rather than inferred from the user-agent string. CI runs the capability and end-to-end suite in current Playwright Chromium, Firefox, and WebKit. The support documentation names the tested browser versions and explains that private/incognito storage modes may fail the persistence probe.

## Session and revocation behavior

A durable browser connection stores identity and key binding, not business permission decisions.

### Live policy checks

- CLI approval checks the approver's current `weldall:login` access.
- Device-code consumption checks `weldall:login` again.
- Browser refresh checks `weldall:login` and the full connection binding.
- Every ID-JAG request checks:
  - connection is active;
  - browser JKT and refresh family match;
  - browser client remains enabled;
  - source resource remains enabled;
  - origin remains registered for that resource;
  - target resource equals the connection resource;
  - scopes remain assigned to the user;
  - scopes remain supported by the resource;
  - group-derived policy resolves successfully.

### Lifetimes

- Pending request: five minutes.
- Browser refresh binding: current 30-day lifetime applied as a sliding inactivity window on successful rotation.
- Browser connection record: retained until revocation and audit-retention cleanup.
- ID-JAG: requested just in time and exchanged immediately.
- Downstream access token: retains the current short resource-server lifetime.

Removing a business scope blocks the next ID-JAG. Removing `weldall:login` blocks refresh and ID-JAG issuance. Resource changes and browser-connection revocation block both refresh and new ID-JAG issuance.

Already-issued offline-verifiable artifacts expire according to their signed lifetime. The browser package never caches an ID-JAG and exchanges it immediately, keeping normal revocation latency bounded by the downstream access-token lifetime.

### Connection status and revocation APIs

Remote status inspection uses an authenticated, CORS-enabled connection endpoint:

```http
GET /api/me/browser-connections/current
Origin: https://contracts.example.com
Authorization: DPoP <browser access token>
DPoP: <browser proof>
```

It returns the current connection ID, state, origin, resource, Weldall subject, and relevant timestamps after validating browser client, origin, resource, access-token JKT, and connection state. A missing, expired, revoked, or origin-invalid connection returns a stable typed error that the browser package maps into `WeldallConnectionStatus`.

Browser disconnect uses the corresponding revocation endpoint:

```http
POST /api/me/browser-connections/current/revoke
Origin: https://contracts.example.com
Authorization: DPoP <browser access token>
DPoP: <browser proof>
```

It validates browser client, origin, resource, connection, access-token JKT, and current connection state before atomically revoking the connection and refresh family. Repeated revocation is idempotent. The browser clears IndexedDB after a successful or terminally revoked response.

User and administrator APIs can revoke one connection or all connections for a user, resource, or origin.

## Persistence boundaries

| Component           | Persistent state                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Browser             | Non-exportable private `CryptoKey`, public JWK/JKT, rotating refresh token, connection metadata                           |
| Weldall             | Pending requests, durable browser connections, hashed provider tokens/bindings, resource/origin association, audit events |
| Downstream resource | Stable signing key plus short-lived replay markers                                                                        |

The downstream SDK handles ID-JAG verification, one-time consumption, resource token issuance, DPoP verification, and route scopes. Protocol operation adds no browser session or Weldall user-token table to the downstream database.

A resource needs a stable ES256 signing key from deployment secrets, KMS, or Vault and an atomic `ReplayStore`. `inMemory()` remains suitable for local development and consciously single-process deployments. Horizontally scaled production deployments use a shared store such as Redis or PostgreSQL. Replay records contain only namespaced identifiers and expiry.

Domain-specific ownership may use `auth.identity.subject` or a local mapping independently from this protocol.

## Resource and browser-client lifecycle

Each resource gets a stable public browser client derived from its immutable resource key:

```text
weldall-browser:<resource-key>
```

The browser client receives only Weldall infrastructure scopes for identity, refresh, discovery, and token exchange. Business scopes remain live ID-JAG policy inputs.

Resource lifecycle code atomically maintains browser clients and connections:

- create resource → create/enable derived browser client;
- update origins → update client metadata and revoke connections whose origins were removed;
- disable resource → disable browser issuance and revoke/block linked connections;
- delete resource → revoke linked connections/families and remove/disable the browser client according to audit retention rules.

The implementation belongs in the authoritative resource mutation seam, especially `apps/weldall/src/server/domain/primitive-mutations.ts`, and must apply equally to admin and IaC resource changes. Production initialization and development seed remain consistent with that lifecycle.

The resource's existing `downstreamClientId` remains the ID-JAG target client and is distinct from the upstream browser client.

## Weldall server API

Discovery advertises the device authorization and browser connection endpoints.

### Start device authorization

```http
POST /api/auth/oauth2/device_authorization
Origin: https://contracts.example.com
DPoP: <proof bound to this POST URL>
Content-Type: application/x-www-form-urlencoded

client_id=weldall-browser:contracts
resource=https://contracts.example.com/api
```

Server behavior:

- enforce strict body-size and duplicate-parameter rules;
- resolve the exact enabled browser client and resource;
- validate the request origin against that resource;
- verify DPoP and store its JKT;
- apply creation rate limits and active-request quotas before persistence;
- create hashed, expiring pending state;
- fix infrastructure scopes server-side;
- return `Cache-Control: no-store`.

Response:

```json
{
  "device_code": "high-entropy-secret",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://weldall.example.com/connect",
  "expires_in": 300,
  "interval": 5
}
```

### CLI lookup and decision

Codes are carried in POST bodies:

```http
POST /api/me/browser-connections/pending/lookup
Authorization: DPoP <CLI access token>
DPoP: <CLI proof>
Content-Type: application/json

{"userCode":"ABCD-EFGH"}
```

```http
POST /api/me/browser-connections/pending/decision
Authorization: DPoP <CLI access token>
DPoP: <CLI proof>
Content-Type: application/json

{"userCode":"ABCD-EFGH","approve":true}
```

Requirements:

- require a token issued to exactly `weldall-cli`;
- use shared replay protection;
- require current `weldall:login` access;
- return server-authoritative origin, resource, expiry, and CLI identity on successful lookup;
- record one explicit approval or denial;
- redact codes and proofs from logs and audit records.

### Poll and token issuance

```http
POST /api/auth/oauth2/token
Origin: https://contracts.example.com
DPoP: <browser proof>
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:device_code
client_id=weldall-browser:contracts
device_code=<high-entropy-secret>
```

Behavior:

- use RFC 8628 polling errors and backoff;
- require exact stored origin, browser client, resource, and JKT;
- re-check current resource-origin membership and login policy;
- use the durable issuance state machine;
- issue DPoP-bound browser access, rotating refresh, and identity tokens through the pinned OAuth provider's supported grant/token extension;
- durably link provider tokens, `OAuthDeviceRefreshBinding`, `BrowserConnection`, and the consumed request before returning credentials.

### Refresh and ID-JAG exchange

Generalize the current token facade from fixed `weldall-cli` assumptions to validated interactive clients while preserving strict provider-token/client/binding equality.

Browser refresh and ID-JAG exchange require the browser request `Origin` to equal the stored connection origin. Refresh bindings for browser clients have a mandatory connection reference. ID-JAG exchange additionally requires the requested resource to equal the connection resource and evaluates current scopes.

## Weldall-side browser CORS

Weldall APIs are cross-origin from every resource SPA and require an explicit CORS layer in the first server milestone.

Apply dynamic exact-origin CORS to:

- OAuth and protected-resource metadata needed by the browser package;
- device authorization;
- device polling/token issuance;
- refresh;
- ID-JAG token exchange;
- userinfo and browser-visible grant/resource discovery;
- browser disconnect/revocation.

Contract:

- accept only current derived origins of enabled resources;
- validate browser client/resource/connection context again inside each actual request;
- answer `OPTIONS` before auth, DPoP verification, rate-limit allocation, or replay consumption;
- allow only required methods;
- allow `Authorization`, `DPoP`, `Content-Type`, and request/correlation headers actually used by the SDK;
- expose `WWW-Authenticate` and reserve `DPoP-Nonce`;
- emit `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`;
- add the same exact `Access-Control-Allow-Origin` to successful and error responses;
- use no wildcard and no credentialed cookie mode;
- test missing, malformed, removed, disabled-resource, and mismatched origins.

Better Auth `trustedOrigins` is not a CORS implementation.

## Database model

Use dedicated models for pending and durable state. `OAuthDeviceRefreshBinding` remains the refresh-family security record and gains a strongly validated browser connection relation.

Indicative schema:

```prisma
model BrowserConnectionRequest {
  id                 String   @id @default(cuid())
  deviceCodeHash     String   @unique
  userCodeHash       String   @unique
  browserClientId    String
  resourceId         String
  origin             String
  dpopJkt            String
  status             String
  attempts           Int      @default(0)
  issuanceAttemptId  String?  @unique
  issuanceClaimedAt  DateTime?
  connectionId       String?  @unique
  expiresAt          DateTime
  approvedAt         DateTime?
  approvedByUserId   String?
  deniedAt           DateTime?
  consumedAt         DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}

model BrowserConnection {
  id                 String    @id @default(cuid())
  browserClientId    String
  resourceId         String
  origin             String
  userId             String
  dpopJkt            String
  refreshFamilyId    String    @unique
  approvedVia        String
  createdAt          DateTime  @default(now())
  lastUsedAt         DateTime?
  revokedAt          DateTime?
  revokedBy          String?
  revocationReason   String?

  @@index([userId])
  @@index([resourceId])
  @@index([origin])
}
```

Use enums and explicit relations according to existing Prisma conventions. Browser refresh bindings require `browserConnectionId`; CLI bindings keep it null. Provider token identifiers or idempotency references needed for crash reconciliation are stored without raw token values.

## Weldall server implementation seams

Primary files and responsibilities:

- `apps/weldall/src/server/oauth/facade.ts`
  - generalize hard-coded `WELDALL_CLIENT_ID` checks for registered interactive clients;
  - require browser connection equality on refresh and exchange;
  - validate bound DPoP before refresh-reuse family revocation;
  - preserve CLI behavior.
- `apps/weldall/src/server/oauth/cli-api.ts`
  - add exact expected-client validation;
  - replace process-local replay with the shared PostgreSQL store.
- `apps/weldall/src/server/auth/auth.ts`
  - register the device grant through the pinned provider's extension mechanism;
  - keep browser client handling separate from CLI consent behavior.
- `apps/weldall/src/server/auth/login-policy.ts`
  - include device issuance and browser refresh in live `weldall:login` checks.
- `apps/weldall/src/server/policy/resources.ts`
  - reuse effective-scope/resource evaluation and enforce source-resource equality.
- `apps/weldall/src/server/domain/primitive-mutations.ts`
  - own browser-client provisioning and connection revocation for all resource mutations.
- `apps/weldall/src/server/oauth/metadata.ts`
  - advertise browser/device endpoints and supported grant.
- `apps/weldall/src/lib/audit.ts` and `apps/weldall/src/server/audit/service.ts`
  - add connection event types and strict metadata schemas.

Add a focused service such as:

```text
apps/weldall/src/server/oauth/browser-connections.ts
```

It owns code generation/hashing, quotas, origin/resource validation, DPoP pre-binding, state transitions, approval, issuance coordination, revocation, reconciliation, and audit orchestration. Token signing remains in the existing OAuth provider and ID-JAG issuer.

## CLI implementation

Add:

```sh
weldall connect <code>
```

Likely files:

- `apps/cli/src/commands.tsx`
- `apps/cli/src/index.ts`
- `apps/cli/src/config.ts`
- new `apps/cli/src/services/connect.ts`
- CLI README, tests, controlled mock server, and black-box harness

Requirements:

- normalize supported separators and case;
- reject malformed codes before discovery or network access;
- resolve issuer and use an explicit `withLock(() => withAccess(...))` sequence so CLI refresh rotation cannot race another process;
- look up server-authoritative origin, resource, expiry, and account;
- show the code, origin, resource, and anti-phishing instruction;
- require explicit interactive approval;
- return a clear terminal result for unavailable, expired, denied, or consumed requests without exposing state useful for code enumeration;
- redact codes after parsing and never log tokens, proofs, or internal hashes.

## Browser SDK package

Create a dedicated browser package:

```ts
import { createWeldallBrowserClient, inspectWeldallBrowserSupport } from "@weldall/browser";
```

A separate package avoids inheriting `@weldall/sdk`'s Node engine, server adapters, and Node-only dependency graph. It may share source only through modules that are proven browser-safe.

Indicative API:

```ts
const support = await inspectWeldallBrowserSupport();
if (!support.supported) showUnsupportedBrowser(support);

const weldall = await createWeldallBrowserClient({
  issuer: "https://weldall.example.com",
  resource: "https://contracts.example.com/api",
});

const status = await weldall.getConnectionStatus({ verify: "local" });
if (status.state === "disconnected") {
  const connection = await weldall.connect();
  console.log(`Run: weldall connect ${connection.userCode}`);
  await connection.connected;
}

const response = await weldall.request("https://contracts.example.com/api/contracts", {
  scopes: ["contracts:read"],
});

await weldall.disconnect(); // normal path: remote revoke, then local cleanup

// Recovery path while Weldall is unavailable or local state is invalid:
await weldall.clearLocalConnection();
```

Responsibilities:

- feature detection and typed visible failure;
- issuer/metadata discovery;
- current-origin/resource validation;
- WebCrypto key creation and JKT calculation;
- schema-versioned IndexedDB storage;
- explicit local and remotely verified connection-status inspection;
- RFC-compatible device polling/backoff;
- rotating refresh with `navigator.locks` and atomic IndexedDB updates;
- live resource/grant discovery where needed;
- just-in-time ID-JAG exchange;
- immediate downstream token exchange;
- fresh DPoP proof with `ath` for each API request;
- exact URL/method normalization matching server verification;
- redirect refusal while carrying authorization or request data;
- memory-only access tokens and ID-JAGs;
- remote disconnect/revocation and local cleanup;
- a local-only recovery reset that deletes the unusable key, tokens, and metadata without requiring network access;
- typed errors for unsupported browser, connection required, denied permission, rejected origin, disabled resource, key loss, refresh replay, CORS, and network failures.

### Connection status and cleanup contract

Expose one discriminated status result:

```ts
type WeldallConnectionStatus =
  | { state: "disconnected"; verified: "local" | "remote" }
  | {
      state: "connected";
      verified: "local" | "remote";
      connectionId: string;
      origin: string;
      resource: string;
      subject?: string;
    }
  | {
      state: "invalid";
      verified: "local" | "remote";
      reason: "corrupt-storage" | "missing-key" | "expired" | "revoked" | "origin-changed";
    };
```

```ts
await weldall.getConnectionStatus({ verify: "local" });
await weldall.getConnectionStatus({ verify: "remote" });
await weldall.disconnect();
await weldall.clearLocalConnection();
```

Semantics:

- `verify: "local"` performs no network request and no token rotation. It validates the IndexedDB schema, current origin/resource, key presence, public JWK/JKT consistency, and credential metadata.
- `verify: "remote"` starts with local validation, then performs a DPoP-authenticated Weldall status/refresh operation under the cross-tab lock. Any refresh-token rotation is persisted atomically before returning.
- `disconnect()` revokes the server-side `BrowserConnection` and refresh family, then removes local key, tokens, and metadata. A transient network failure leaves local credentials intact so revocation can be retried.
- `clearLocalConnection()` performs no network request. It atomically deletes the local private key, tokens, pending pairing state, and metadata. The abandoned server-side refresh family remains DPoP-bound to the deleted key and expires or can be revoked administratively.
- Corrupt or partial storage returns `state: "invalid"` rather than being interpreted as disconnected. The UI can show recovery and call `clearLocalConnection()` explicitly.
- Status inspection, refresh, disconnect, and local clearing use the same `navigator.locks` connection lock.

### Browser-only build guarantee

The package is ESM and contains no Node runtime imports or polyfills. CI enforces this at multiple levels:

- package source and emitted files contain no `node:` imports;
- emitted files do not reference `Buffer`, `process`, `require`, `__dirname`, or Node crypto APIs;
- package metadata has no Node engine requirement;
- browser exports resolve without importing `@weldall/sdk`'s server entry;
- an esbuild/Vite build with `platform=browser` succeeds with Node polyfills disabled;
- the bundle metafile/dependency graph is checked for Node built-ins;
- the packed tarball is installed into a minimal clean Vite fixture and production-built;
- Playwright loads the built fixture and performs a real WebCrypto/IndexedDB/DPoP operation;
- package verification fails when a transitive dependency introduces Node-only code.

Place the package under `packages/browser/` so the existing `packages/*` workspace rule discovers it, then add it to CI, Changesets, package documentation, and release configuration.

## Local development and manual testing

The browser package must be testable in the existing local development stack without publishing or linking it globally.

Use `apps/expenses` as the primary downstream resource and browser integration fixture. It already represents a Weldall-compatible resource at:

```text
https://expenses.seibert.localdev
```

Add a development-only Expenses page, for example:

```text
https://expenses.seibert.localdev/weldall-browser
```

The page imports `@weldall/browser` through the workspace and visibly supports:

- capability check and unsupported-browser diagnostics;
- start connection and display `weldall connect CODE`;
- local and remotely verified connection status plus current Weldall identity;
- explicit disconnect and local-only recovery reset;
- read/create expense requests through the same protected API routes as the CLI;
- displayed permission, origin, refresh, CORS, and revocation failures;
- disconnect and local credential cleanup.

The normal local commands remain sufficient:

```sh
pnpm build:dev
pnpm dev
caddy run --config Caddyfile
./apps/cli/dist/index.js login
./apps/cli/dist/index.js connect ABCD-EFGH
```

The workspace build must emit the browser package before Expenses starts, and development watch mode must rebuild it or consume its source safely. Document the exact workflow in the browser package README and root local-development guide.

Local verification uses a real browser page. A Node test or Playwright `APIRequestContext` is insufficient because WebCrypto, IndexedDB persistence, browser module resolution, preflight, and CORS are part of the contract.

## Downstream resource SDK

The existing resource SDK continues to handle ID-JAG verification, JKT binding, one-time consumption, resource token issuance, DPoP verification, route scopes, and identity exposure.

Add a safe browser-origin contract for cases where UI and API origins differ:

- exact allowed origins;
- preflight before auth and replay consumption;
- `Authorization`, `DPoP`, and `Content-Type` request headers;
- `WWW-Authenticate` and reserved `DPoP-Nonce` response headers;
- correct `Vary` values;
- CORS headers on success and OAuth errors;
- credentialless browser fetches;
- resource public origin as the same-origin default.

Cover Fetch, Hono, Next.js, and Astro adapters consistently. Expenses exercises the Hono path locally and in E2E.

## Audit and administration

Add events:

```text
browser_connection.requested
browser_connection.approved
browser_connection.denied
browser_connection.issued
browser_connection.revoked
browser_connection.failed
```

Audit metadata includes connection/request ID, actor, CLI source client for approval, browser client, origin, resource, JKT, expiry, outcome, revocation reason, and correlation IDs. Secret-bearing fields are redacted before logs and omitted from audit schemas.

Add user/admin views for active browser connections with account, origin, resource, created/last-used timestamps, approval method, and revoke action.

## Later browser OAuth without CLI

Keep one connection issuance boundary:

```ts
type BrowserConnectionApproval = {
  userId: string;
  browserClientId: string;
  origin: string;
  resourceId: string;
  dpopJkt: string;
  approvedVia: "cli-code" | "browser-oauth";
};
```

Approval methods feed the same issuer:

```text
CLI code approval ─┐
Browser OAuth/SSO ─┼─> BrowserConnection ─> DPoP refresh ─> ID-JAG
Future MDM method ─┘
```

The browser OAuth method uses top-level authorization code, exact redirect URI, state, nonce, PKCE, resource, and `dpop_jkt`. Weldall authenticates through its configured upstream IdP and returns the same browser credential shape. Existing SSO can make the redirect brief.

The browser package keeps a stable strategy API:

```ts
await weldall.connect({ method: "cli-code" });
await weldall.connect({ method: "browser-oauth" });
await weldall.connect({ method: "auto" });
```

All refresh, ID-JAG, downstream token, persistence, request, audit, and revocation behavior is shared.

## Implementation milestones

Implement serially with one writer and a fresh security/correctness review after each vertical slice.

### Milestone 1: Browser client lifecycle, protocol contract, pending flow, and Weldall CORS

- Write the RFC 8628/DPoP profile and threat model as an ADR.
- Add resource-derived browser-client lifecycle to the authoritative resource mutation seam.
- Add pending and durable connection models/migration.
- Add exact current origin/resource resolution.
- Add Weldall browser CORS and preflight handling.
- Add start, lookup, approval/denial, polling state, quotas, rate limits, cleanup, shared replay, and audit.
- Make transitions and concurrency tests green before token issuance.

### Milestone 2: Browser token issuance, refresh, exchange, and revocation

- Add the device grant through the pinned Better Auth extension.
- Add the crash-recoverable issuance state machine and reconciliation.
- Issue browser DPoP access/refresh/identity tokens.
- Create mandatory browser connection/refresh-binding relationships.
- Generalize refresh and ID-JAG exchange for validated interactive clients.
- Validate DPoP before refresh-reuse revocation.
- Add browser disconnect and user/admin revocation APIs.
- Add live login, origin, resource, connection, and scope revocation tests.

### Milestone 3: CLI command

- Implement `weldall connect CODE` with locked refresh, lookup, context display, anti-phishing prompt, approval/denial, and errors.
- Extend discovery, unit tests, controlled mock server, and packed/standalone black-box harness.
- Update CLI help and docs.

### Milestone 4: Browser package and capability contract

- Add `@weldall/browser` as a browser-only workspace/package.
- Implement feature detection, WebCrypto, IndexedDB, polling, refresh locking, exchange, DPoP request, disconnect, and typed errors.
- Add clean-browser bundle/package verification.
- Add Chromium, Firefox, and WebKit capability tests.

### Milestone 5: Local Expenses integration and resource browser support

- Add the development-only Expenses browser page.
- Add resource SDK CORS/preflight support across adapters.
- Exercise the workspace browser package directly in local dev/watch mode.
- Document manual setup and troubleshooting.

### Milestone 6: Administration, full E2E, release, and docs

- Add connected-browser list/revoke UI and complete audit rendering.
- Add a real browser path to the Docker/Playwright system.
- Exercise CLI approval, browser WebCrypto/IndexedDB, polling, refresh, ID-JAG, resource token, protected API, policy removal, origin removal, and revocation.
- Complete package/release configuration, Changesets, security documentation, and migration guidance for protected UI routes.

## Validation contract

### Server and database

Cover:

- exact origin/resource matching and current-origin revalidation;
- resource origin update, disable, and delete lifecycle;
- browser-client create/update/disable/delete lifecycle through admin and IaC mutations;
- malformed, duplicate, oversized, and throttled start requests;
- global/per-resource pending quotas and bounded cleanup;
- code normalization, hashing, expiry, attempts, and enumeration resistance;
- wrong, denied, expired, consumed, and replayed codes;
- wrong browser DPoP key and DPoP replay;
- approval token from a non-CLI client;
- approval after `weldall:login` removal;
- direct and group-derived login policy, including provider fail-closed behavior;
- concurrent approval and polling;
- crash points after issuance claim, provider issuance, binding creation, commit, and response loss;
- reconciliation after every crash point;
- browser refresh rotation and mandatory connection checks;
- obsolete refresh with wrong proof cannot revoke a family;
- valid refresh reuse revokes the family;
- business scope removal blocks the next ID-JAG;
- connection/resource/origin revocation blocks refresh and exchange;
- no codes, tokens, complete proofs, or authorization headers in logs/audits.

Likely tests:

- new `apps/weldall/test/browser-connections.test.ts`;
- extend `token-exchange.test.ts`;
- extend `login-policy.test.ts`;
- extend `oauth-metadata.test.ts`;
- extend resource mutation, deployment, audit, and admin tests.

### CLI

Cover:

- root and command help;
- accepted code formats and malformed input before network access;
- locked refresh behavior under concurrent CLI processes;
- successful lookup, context display, approval, and denial;
- unavailable, expired, consumed, wrong-issuer, and logged-out behavior;
- interactive confirmation;
- secret-free output;
- packed and standalone black-box behavior.

### Browser package

Cover:

- clean browser-platform build and packed Vite installation;
- absence of Node built-ins and polyfills in emitted dependency graph;
- visible typed failure for each required missing capability;
- non-exportable generated private key and exportable public JWK;
- IndexedDB persistence/reload of the private `CryptoKey`;
- JKT and DPoP proof interoperability;
- polling interval, `slow_down`, timeout, denial, and expiry;
- refresh rotation under concurrent tabs;
- atomic refresh-token storage and reuse failure cleanup;
- local connection status without network or token rotation;
- remote connection status with atomic refresh rotation;
- corrupt, missing-key, expired, revoked, and changed-origin status results;
- disconnect retry after transient network failure;
- local-only clearing while Weldall is unavailable;
- memory-only ID-JAG and access tokens;
- target/resource/path validation and redirect refusal;
- disconnect, revocation, storage clearing, and key-loss recovery;
- current Chromium, Firefox, and WebKit.

### Weldall and resource CORS

Cover:

- OPTIONS succeeds before authentication and replay consumption;
- exact allowed origin on success and OAuth error responses;
- wildcard, removed, missing, and mismatched origins rejected;
- correct allowed/exposed headers and `Vary` values;
- browser token, refresh, ID-JAG exchange, revocation, downstream token, and protected API requests;
- CLI and machine requests remain unaffected.

### Local development

A developer can:

1. build and start the normal local stack;
2. open the Expenses browser page;
3. see a successful capability check;
4. start a connection and copy the displayed command;
5. approve it with the repository CLI;
6. read and create expenses through the existing protected routes;
7. remove a scope and see the next ID-JAG fail visibly;
8. revoke/disconnect and see refresh fail;
9. inspect browser console/network without Node-module, CORS, or hidden promise errors.

### End-to-end

Use a real Playwright page rather than `APIRequestContext`. Prove:

1. browser package loads from its production browser build;
2. WebCrypto creates and IndexedDB reloads a non-exportable key;
3. real CLI approval succeeds;
4. browser receives and rotates its own DPoP-bound Weldall session;
5. browser obtains an ID-JAG for only its own resource;
6. browser exchanges it and calls the same Expenses API as `weldall request`;
7. different origin/resource/key and replay attempts fail;
8. scope removal blocks the next ID-JAG;
9. origin/resource/connection revocation blocks refresh and exchange;
10. existing CLI, machine, IaC, admin, and SDK flows remain green.

## Likely change surface

### Database

- `packages/db/prisma/schema.prisma`
- new migration under `packages/db/prisma/migrations/`
- `packages/db/prisma/seed.ts`

### Weldall server

- `apps/weldall/src/server/oauth/facade.ts`
- `apps/weldall/src/server/oauth/cli-api.ts`
- `apps/weldall/src/server/oauth/constants.ts`
- `apps/weldall/src/server/oauth/metadata.ts`
- new `apps/weldall/src/server/oauth/browser-connections.ts`
- `apps/weldall/src/server/auth/auth.ts`
- `apps/weldall/src/server/auth/login-policy.ts`
- `apps/weldall/src/server/policy/resources.ts`
- `apps/weldall/src/server/domain/primitive-mutations.ts`
- `apps/weldall/src/server/deployment.ts`
- new API routes under `apps/weldall/src/app/api/`
- audit definitions/service and connected-browser UI

### CLI

- `apps/cli/src/commands.tsx`
- `apps/cli/src/index.ts`
- `apps/cli/src/config.ts`
- new `apps/cli/src/services/connect.ts`
- CLI tests, mock server, black-box harness, README

### Browser and resource SDKs

- new `packages/browser/` workspace for `@weldall/browser`
- workspace lockfile, CI, release, and Changeset configuration
- resource SDK core/types/adapters for browser CORS
- `apps/expenses/src/app.ts` and browser development page
- package, SDK, and Expenses tests/docs

### E2E and docs

- Docker/Playwright browser path
- `docker-compose.e2e.yml`
- `e2e/Caddyfile`
- `apps/e2e/test/system.spec.ts`
- root README, CLI README, SDK/browser READMEs, and Starlight docs

## Repository checks

Run focused checks in each milestone, then:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build:dev
pnpm --filter @weldall/cli pack:check
pnpm --filter @weldall/sdk pack:check
pnpm --filter @weldall/browser pack:check
pnpm test:e2e
```

Published CLI, SDK, and browser-package behavior requires Changesets.

## Completion criteria

- An Expenses SPA in the standard local stack connects through the real repository CLI.
- The browser package imports and production-bundles without Node runtime code or polyfills.
- Unsupported browser capabilities produce a typed, visible error before any connection work.
- Browser and CLI credentials use separate sender-constrained key/refresh families.
- Browser private key export fails through Web Crypto.
- The browser calls the same ID-JAG/DPoP-protected routes as `weldall request`.
- A connected browser client can request only its own resource.
- Business scopes are evaluated live.
- Active connections refresh without repeated CLI approval and can be revoked centrally.
- Clients can distinguish disconnected, locally connected, remotely verified, and invalid local connection state.
- Remote disconnect and local-only recovery clearing have explicit, separately tested behavior.
- Current origin membership is enforced throughout refresh and exchange.
- Refresh reuse, polling, issuance, and crash recovery are race-safe.
- Downstream protocol persistence remains limited to signing key and replay markers.
- Audit explains request, approval, issuance, denial, and revocation without credentials.
- Real-browser E2E proves module loading, WebCrypto, IndexedDB, polling, CORS, token exchange, API access, and revocation.
- Existing CLI, machine, IaC, admin, and resource SDK behavior remains compatible.
- The connection issuer accepts a later authorization-code + PKCE browser approval method without downstream changes.

## Implementation invariants

- CLI and browser DPoP keys and refresh families remain separate.
- Every browser-issued assertion and token is bound to the browser JKT.
- Server-side policy selects origin, resource, client, and effective scopes.
- Human code and device secret serve separate lookup and polling roles.
- Replay protection fails closed and uses shared storage in horizontally scaled paths.
- Protected write routes require Weldall authorization consistently for browser and CLI callers.
- Better Auth remains the provider-token issuer through its supported extension surface.
- CLI consent and trusted-client behavior remain scoped to the CLI.
- Documentation distinguishes standard protocol behavior from Weldall approval extensions.
