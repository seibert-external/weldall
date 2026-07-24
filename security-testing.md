# Security and conformance testing

## Test layers

| Command          | Layer                           | Purpose                                               |
| ---------------- | ------------------------------- | ----------------------------------------------------- |
| `pnpm test`      | Unit and in-process integration | Protocol claims, policy, replay and negative cases    |
| `pnpm typecheck` | Static validation               | Type safety across every workspace package            |
| `pnpm test:e2e`  | Hermetic black-box E2E          | Real CLI, Chromium, proxy, services, database and TLS |

The E2E environment generates fresh Weldall, Expenses and Development-IdP keys
for every run. The CLI still generates its own per-installation DPoP key. The
Development IdP is a separate OIDC service and therefore does not bypass
Weldall's upstream login handling.

## Standards traceability

| Requirement                                                | Reference               | Coverage                                                       |
| ---------------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Native loopback redirect and issuer/state binding          | RFC 8252                | `apps/cli/test/session.test.ts`, Docker E2E login              |
| S256 PKCE                                                  | RFC 7636                | CLI unit test, Development-IdP PKCE and code-consumption tests |
| DPoP signature, JOSE header, claims, URI and time binding  | RFC 9449 §4             | OAuth malformed-input and boundary matrix                      |
| DPoP access-token hash, atomic replay and endpoint binding | RFC 9449 §§4, 9         | OAuth and Expenses tests                                       |
| `cnf.jkt` sender binding and malformed `cnf` rejection     | RFC 9449 §6.1, RFC 7800 | OAuth, CLI and Expenses tests                                  |
| JWK thumbprints and key-intent metadata                    | RFC 7638 / RFC 7517     | Official RFC 7638 vector, mismatch and JOSE metadata tests     |
| ID-JAG signature, target, client, scope and device binding | ID-JAG draft-04         | OAuth, CLI and Expenses tests                                  |
| JWT-DPoP grant and one-time ID-JAG use                     | JWT-DPoP draft-01       | Expenses integration tests and Docker E2E request              |
| Refresh rotation and family revocation                     | OAuth security BCP      | Weldall token-exchange tests                                   |
| Authorization-server metadata                              | RFC 8414                | Expenses and Docker E2E metadata tests                         |

## Negative cases currently covered

- Missing, malformed, stale, future, replayed or request-mismatched DPoP proofs
- Wrong/missing DPoP `typ`, `alg`, `jwk`, required claims and conflicting JWK metadata
- Empty/oversized JTI, exact clock boundaries, URI ports, credentials, dot segments and query/fragment rejection
- DPoP proofs made with another device key or carrying private JWK material
- Missing or incorrect `ath`; malformed compact JWTs and tampered signatures
- ID-JAG bearer downgrade, malformed `cnf`, empty JKT, extra audiences and wrong target/client/draft
- Invalid, duplicate, escalating or control-character ID-JAG scopes
- CLI-side verification of the returned ID-JAG signature, key rotation, target, scope and device binding
- Parallel DPoP and ID-JAG replay: exactly one request succeeds
- Missing, duplicate and unsupported OAuth form parameters
- Missing, duplicate, ambiguous or wrong-issuer native callback parameters
- PKCE `plain`, malformed challenges/verifiers and authorization-code replay
- Partial Google configuration, ambiguous Development-IdP issuers and Development Login in production
- Stolen refresh token with another DPoP key, refresh-token reuse and family revocation
- Idempotent unknown/already-revoked token revocation and duplicate revocation hints
- Unauthenticated and Bearer-style Expenses API requests

## Security findings with regression coverage

| Severity | Finding                                                              | Resolution                                                                  |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| High     | Empty ID-JAG `cnf.jkt` skipped DPoP key comparison                   | JKT shape is mandatory and `expectedJkt` is compared even when empty        |
| High     | CLI forwarded a returned ID-JAG without validating it                | CLI now verifies signature, JOSE header, target, scope, draft and `cnf.jkt` |
| Medium   | Development issuer paths were silently reduced to another issuer     | Configuration now requires an exact HTTPS origin                            |
| Medium   | Duplicate security-sensitive OAuth parameters had ambiguous handling | Weldall, Expenses, loopback and Development IdP reject duplicates           |
| Medium   | Malformed compact DPoP could escape as a generic parser error        | DPoP parser failures are normalized to `invalid_dpop_proof`                 |
| Medium   | Revocation exposed unknown/already-revoked token state               | RFC 7009-style revocation is idempotent for both cases                      |

## Remaining production limitations

The prototype replay stores are process-local. Restarting a service clears replay
state, and multiple instances do not share it. This is an explicitly accepted
prototype limitation; horizontal scaling still requires an atomic shared store
plus multi-instance and restart tests.

Weldall E2E still runs `next dev`, not a production image. The real Google path,
formal OpenID Foundation conformance, independent ID-JAG/JWT-DPoP implementations,
DPoP nonce support, fuzzing, mutation testing, restart/chaos behavior and proxy
request-smuggling coverage remain open. The CLI's file credential adapter is
available only when both its explicit E2E path and `NODE_ENV=test` are set, but it
is still compiled into the CLI and must not be enabled in a production launch.
Playwright tracing and screenshots are disabled for the authentication flow; the
console/JUnit scanner is a regression guard, not proof that every possible secret
encoding is detected.

ID-JAG and JWT-DPoP are pinned drafts, not stable RFCs; upgrades require updating
this matrix and the interoperability fixtures. No finite suite proves the absence
of every attack. Changes to authentication, token validation, proxy handling or
policy must add a negative regression test that fails when the corresponding
check is removed.
