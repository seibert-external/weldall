# ADR 0001: CLI-approved browser SPA connections

- Status: Accepted
- Date: 2026-08-17
- Security profiles: RFC 8628, RFC 9449, RFC 9700, RFC 8693, RFC 7638, Weldall's pinned ID-JAG draft

## Context

A first-party SPA hosted by a registered Weldall resource must be able to obtain a durable, sender-constrained Weldall session without inheriting the CLI credential or requiring another identity-provider login. Browser script cannot safely hold a client secret. An HTTP `Origin` header is useful browser/CORS metadata but is forgeable outside a browser and is not application authentication.

## Decision

Each enabled resource owns a stable public client named `weldall-browser:<immutable-resource-key>`. Its exact origins are derived from the origins of the resource authorization server and request prefixes. Business scopes are never put on this client; they remain live policy inputs when an ID-JAG is requested.

The SPA creates a non-exportable P-256 WebCrypto private key and sends an RFC 9449 proof to the device authorization endpoint. Weldall stores the resulting JKT with a high-entropy, browser-held device secret and a separate, short, human-entered code. The CLI uses its own DPoP-bound Weldall session to inspect the server-authoritative resource and origin and record one explicit decision. Only the browser key can poll and receive the resulting browser credential family.

The OAuth token endpoint uses the RFC 8628 grant identifier:

```text
urn:ietf:params:oauth:grant-type:device_code
```

RFC 8628 defines the device code, user code, expiry, polling, `authorization_pending`, `slow_down`, `access_denied`, and `expired_token` behavior. Two aspects are Weldall profile extensions:

1. approval is recorded by the authenticated first-party CLI instead of a verification web page; and
2. the pending grant is bound to a DPoP JKT at device-authorization time.

These extensions do not change the standard token endpoint grant identifier or polling errors. PKCE is not used by the device flow; it belongs to the later top-level authorization-code browser strategy.

Better Auth remains the provider-token issuer. Device token issuance is registered only through its exported OAuth Provider extension API and uses its supported `issueTokens` capability. Application code owns pending-state authorization and durable coordination; it does not import or reproduce private provider signing functions. Milestone 1 prepares and advertises this branch-internal seam; the branch is not releasable until Milestone 2 registers that supported grant handler, and no release artifact is produced between those serial milestones.

## Protocol state

Weldall stores only keyed hashes of device and user codes. Pending requests expire after five minutes and move atomically through:

```text
PENDING -> APPROVED | DENIED | EXPIRED -> ISSUING -> CONSUMED
```

A durable issuance journal records claim, provider issuance, local binding creation, commit, or failure without raw credentials. A unique request/connection/family relationship makes retries and reconciliation idempotent. Each durable connection retains an immutable provider reference independently of the short-lived pending row, so bounded pending cleanup cannot break refresh, exchange, or revocation. The token response is buffered until the provider token records, local refresh binding, browser connection, and consumed request are durably linked.

Fixed-window creation and decision limits are stored in PostgreSQL. Active-request quota checks take a PostgreSQL transaction advisory lock, so concurrent application instances cannot exceed the global or per-resource/origin/client caps. Cleanup is bounded. Rejected starts do not create pending rows. Entrance limits use the final proxy-managed `X-Forwarded-For` hop only when `X-Weldall-Proxy-Attestation` matches a deployment secret shared with the edge. Without valid attestation, every request shares one fail-closed untrusted bucket. Deployments keep the application origin private; the secret is never exposed to browser code, responses, logs, or audit.

## Credential and policy boundaries

CLI and browser credentials are separate sender-constrained families:

```text
user
+- weldall-cli: CLI DPoP key + CLI refresh family
+- weldall-browser:<resource-key>: WebCrypto JKT + browser refresh family
```

The CLI writes only a decision. It never receives or transports browser tokens. Every browser refresh binding has a mandatory browser connection at the service boundary. Browser connection revocation revokes the complete local/provider family atomically.

Approval verifies current `weldall:login`. Consumption and every later refresh and ID-JAG request verify it again. Refresh and exchange also require exact equality of browser client, origin, source resource, connection, refresh family, provider token, and JKT. ID-JAG policy resolves current direct and group-derived assignments and current resource-supported scopes; approval does not snapshot business authorization.

A resource-origin update revokes connections for removed origins. Disablement or deletion revokes all linked connections and pending work. Durable connection snapshots survive resource/user/client deletion for audit, but cannot become active again.

## CORS profile

Browser-facing Weldall routes use dynamic exact-origin CORS based only on current enabled resources. No wildcard and no credentialed cookie mode are permitted. Preflight is answered before authentication, DPoP verification, replay consumption, rate-limit allocation, or persistent pending-state allocation. It permits only the route method and the request headers actually used by the SDK (`Authorization`, `DPoP`, `Content-Type`, request/correlation IDs), exposes `WWW-Authenticate` and reserved `DPoP-Nonce`, and varies on origin, requested method, and requested headers. Allowed-origin success and OAuth-error responses carry the same exact `Access-Control-Allow-Origin`.

Actual request handlers must still validate client/resource/origin/connection context. CORS is not authorization.

## Threat model

### Protected assets

- browser and CLI refresh families;
- non-exportable browser private key and CLI credential-store key;
- Weldall identity assertions and downstream access tokens;
- the user's approval intent and current business policy;
- code, proof, token, and authorization-header confidentiality;
- audit integrity and availability of replay/rate-limit state.

### Trust boundaries

- SPA script and same-origin dependencies;
- browser storage/WebCrypto implementation;
- untrusted networks and reverse proxies;
- Weldall application instances and PostgreSQL;
- Better Auth's supported OAuth Provider surface;
- downstream resource authorization servers and replay stores;
- CLI process and OS credential storage.

### Threats and controls

| Threat                           | Control                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged `Origin`                  | Registered enabled resource, exact derived origin, high-entropy device secret, browser JKT binding, explicit CLI display/approval, and live revalidation.                                                                 |
| User-code guessing/enumeration   | Typo-resistant short-lived one-use code, keyed hash at rest, generic unavailable responses, network/code/account/resource/origin/client limits.                                                                           |
| Device-code theft                | 256-bit random secret, keyed hash at rest, five-minute expiry, and mandatory pre-bound DPoP proof.                                                                                                                        |
| DPoP replay or wrong key         | ES256 proof validation with exact `htu`/`htm`, PostgreSQL replay store, stored JKT equality, and `ath` for access-token requests.                                                                                         |
| Refresh token theft/reuse        | DPoP binding, rotation, sliding inactivity window, and proof-before-family-revocation on valid reuse. An invalid proof cannot revoke a victim family.                                                                     |
| Concurrent polling/response loss | Row locks, unique issuance invariants, durable journal, buffered response, reconciliation, and kill-point tests.                                                                                                          |
| Stale permission or origin       | Live login, assignment, group-provider, resource, supported-scope, origin, client, connection, and target checks. Provider resolution fails closed.                                                                       |
| Cross-resource use               | Connection stores one source resource; token exchange requires the requested resource to equal it.                                                                                                                        |
| XSS/supply-chain script          | Non-exportability prevents raw WebCrypto export but same-origin script can ask the key to sign. Integrations require HTTPS, strict CSP, controlled third-party scripts, lockfile/dependency hygiene, and prompt patching. |
| Storage loss/corruption          | Schema-versioned IndexedDB record; missing key is invalid, never disconnected; recovery deletes the local family material and starts a fresh connection.                                                                  |
| Secret leakage                   | Codes only in POST bodies; proxy/application logging redacts codes, tokens, proofs, and authorization; audit schemas reject secret-bearing fields.                                                                        |
| Resource deletion                | Transactional revocation before mutation; retained snapshots cannot authorize without a current enabled resource/client/origin.                                                                                           |
| Horizontal deployment gaps       | PostgreSQL replay, rate-limit, quota, and pending state. Downstream deployments must use an atomic shared replay store.                                                                                                   |

## Browser key boundary

The browser generates an ECDSA P-256 pair with `privateKey.extractable === false`, exports only the public JWK, calculates the RFC 7638 thumbprint, and persists the private `CryptoKey` by IndexedDB structured clone. Refresh tokens and the key persist; access tokens, ID-JAGs, and downstream tokens remain in memory. `navigator.locks` serializes refresh rotation across tabs. Capability probing fails visibly before discovery, storage access, or network work when any required primitive is missing.

Non-exportability does not defend against malicious same-origin script. That limitation is accepted and must remain explicit in SDK and integration documentation.

## Consequences

- A regularly used SPA can maintain its own durable session without sharing CLI credentials.
- Origin changes, resource disablement, and live policy changes take effect at the next online protocol operation.
- More durable state and reconciliation tests are required than for a simple device-code table.
- Later browser OAuth/SSO approval can feed the same `BrowserConnection` issuance boundary without changing refresh, exchange, downstream, storage, or revocation behavior.
- Existing CLI, machine, IaC, admin, and server SDK flows remain non-browser callers and do not require `Origin`.
