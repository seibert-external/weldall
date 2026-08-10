# Machine-to-machine authentication architecture

## Decision

The MVP uses **access tokens issued directly by Weldall**. A machine authenticates to Weldall's existing OAuth token endpoint with the OAuth 2.0 client credentials grant and RFC 7523 `private_key_jwt`. Weldall returns a five-minute, resource-bound, DPoP-constrained JWT. The existing interactive flow remains unchanged: users still use the public `weldall-cli`, and Weldall still brokers their ID-JAG to a resource authorization server which issues a local user token.

The alternatives were considered:

- A **broker** best preserves a target's independent authorization domain, and matches the user ID-JAG flow. It would require another assertion profile, another exchange, and machine-aware local token claims at every target.
- A **hybrid** can support both direct and brokered machine tokens, but adds issuer selection and policy-equivalence surface without an MVP use case.
- **Direct issuance** reuses Weldall's signing key/JWKS and explicit resource registry, produces a standard client-credentials response, and removes one exchange. The existing resource verifier recognizes the distinct machine token profile by its protected token type.

A future resource that needs its own authorization domain can add a machine assertion/broker profile without changing machine subjects or access policy. RFC 8693 user delegation is a separate future flow. Client credentials never impersonate a user and no machine token contains user or email claims.

## Registration and authorization

Product-owned records keep the concepts separate:

- `MachineClient` is the stable identity. Its OAuth `client_id` is immutable.
- `MachineClientKey` stores one inline public ES256/P-256 JWK, `kid`, thumbprint, and revocation state. Keys are active immediately and remain valid until revoked. Thumbprints are globally unique so one private key cannot represent two machine identities. Multiple active keys provide rotation overlap.
- `MachineAllowedResource` selects registered target resources independently.
- `MachineAllowedScope` selects global scopes independently.

Client assertions and token-endpoint DPoP proofs are consumed by Weldall's bounded process-local replay store before policy evaluation. Replay markers survive later policy or audit failures within that process, but restart with the process and are not shared between replicas.

Creating a client, resource, or scope never creates access. The requested resource and every requested scope must be selected for the machine, and the requested resource must support every requested scope. A selected scope need not be supported by every selected resource; compatibility is checked at issuance.

Remote client JWKS and metadata URLs are intentionally unsupported. Administrators paste only public JWK material into the protected admin UI/API. This avoids a client-metadata SSRF path. Private keys belong in a machine secret store, KMS, or platform identity facility; they must not be put in Weldall, a manifest, source control, logs, or examples.

## Token request

`POST /api/auth/oauth2/token` uses `application/x-www-form-urlencoded`:

```text
grant_type=client_credentials
client_id=expenses-a
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion=<signed JWT>
resource=https://expenses-b.example/api
scope=expenses-b:read
```

The request also carries a `DPoP` header. The client assertion is ES256 with protected `typ=JWT` and a registered `kid`. Weldall requires:

- `iss` and `sub` equal the form `client_id`;
- `aud` is the exact canonical Weldall token endpoint;
- integer `iat`/`exp`, no more than 60 seconds apart;
- a bounded nonempty `jti` which has not been consumed;
- an enabled client and non-revoked key;
- a DPoP proof signed by that same registered key.

Assertions, tokens, proofs, and JWK coordinates are not included in audit events or errors.

## Machine token profile

The access token protected header is `typ=weldall-machine+jwt`. Its signed claims are:

| Claim                         | Meaning                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `iss`                         | Weldall HTTPS issuer                                          |
| `sub`                         | `machine:<client_id>` stable non-user namespace               |
| `client_id`, `azp`            | authenticated machine client ID                               |
| `aud`                         | one string, exactly the registered target resource identifier |
| `scope`                       | the selected, resource-supported requested scopes             |
| `identity_type`, `token_type` | both `machine`                                                |
| `iat`, `exp`                  | integer issue/expiry, at most 300 seconds apart               |
| `jti`                         | unique token identifier                                       |
| `cnf.jkt`                     | RFC 7638 thumbprint of the sender key                         |

The response uses `token_type=DPoP`, `expires_in=300`, and has no refresh token.

## Target validation

Every `initWeldall` resource verifier accepts both resource-local user tokens and direct machine tokens. Routes keep using the same `verify`/`protect` scope policy and receive one discriminated `AuthContext`: `identityType` and `identity.type` are either `user` or `machine`. A route only narrows the identity when it needs profile-specific fields such as user email or machine `clientId`; there is no separate machine middleware, opt-in, or client allowlist.

The verifier dispatches exactly once from the protected JWT `typ`: resource-local `at+jwt` uses the resource's signing domain, while `weldall-machine+jwt` uses pinned Weldall discovery/JWKS. Unknown token types, ID-JAGs, old profiles, and claim-shape confusion are rejected without fallback. Both profiles then share exact audience, route-scope, sender thumbprint, DPoP `htu`/`htm`/`ath`, freshness, and error handling.

With an enabled `ReplayStore`, every resource request needs a fresh DPoP proof and replay is rejected atomically. `replayStore: "disabled"` remains an explicit supported configuration and skips resource-side replay consumption; deployments choosing it accept the resulting replay risk. `inMemory()` is bounded and process-local, so its markers clear on restart and are not shared between replicas.

## Rotation, deactivation, and audit

Register a new public key, deploy the matching private key, allow an overlap, then revoke the old public key. Key revocation blocks new assertions immediately. Client deactivation and access-policy replacement block new issuance immediately. Issuance holds database row locks on the selected client, key, access row, and resource through signing and audit commit, so concurrent lifecycle changes have a deterministic order and cannot commit revocation or policy replacement before a later token issuance. Already-issued tokens remain usable until their `exp`, for no more than five minutes; emergency systems should account for this bounded revocation window.

Audit event families cover client create/update/deactivation, key registration/revocation, access replacement, and token issuance/denial/failure. Events contain client/resource/scope, `kid`/thumbprint, token `jti`, and times as applicable, never credentials or compact JWTs. Successful issuance fails closed if its audit event cannot be stored.

## Deliberate non-goals and extension points

The MVP has no client secrets, remote JWKS, mTLS, machine federation, self-service registration, user impersonation, or delegated token exchange. Federation can later authenticate into the same stable `MachineClient` and access model. A brokered machine assertion can reuse the same subject and claim discriminator. Delegated user calls must use an explicit RFC 8693-style flow and a distinct delegated token profile; they must never be inferred from client credentials.
