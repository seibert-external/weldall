# OpenBao envelope provider

## Goal

Add OpenBao Transit as an envelope provider for managed connector credentials. Each connector gets an independent Transit key, created lazily by the first encryption request. OpenBao availability affects only operations that use an OpenBao-backed connector; it must not affect Weldall startup, connector administration, or `LOCAL_ENV` connectors.

## Product contract

- `OPENBAO` is always a valid envelope-provider option in the UI, API, CLI, and declarative manifests.
- Connector definitions can be created, enabled, inspected, updated, and deleted without checking OpenBao configuration or connectivity.
- The envelope provider remains immutable after connector creation.
- OpenBao is contacted only when Weldall needs to encrypt or decrypt connector connection material.
- A missing configuration, unavailable OpenBao server, invalid token, timeout, or malformed response fails only the affected connection operation with a sanitized `503` error.
- Weldall does not enable the Transit secrets engine, rotate keys, or delete keys. Those remain operator responsibilities.

## Deployment configuration

Use two server-only environment variables:

```env
WELDALL_OPENBAO_HOST=https://openbao.example.com
WELDALL_OPENBAO_TOKEN=...
```

`WELDALL_OPENBAO_HOST` is the OpenBao origin, without credentials, query parameters, or a fragment. Require HTTPS in production; allow loopback HTTP in development and test environments so `http://127.0.0.1:8200` works locally. Normalize one trailing slash before constructing API paths.

`WELDALL_OPENBAO_TOKEN` is a deployment credential and must never enter connector configuration, PostgreSQL, client responses, logs, or errors. Missing either variable means OpenBao is unavailable when an OpenBao-backed connection operation is attempted; it does not invalidate the stored connector definition.

Keep the initial integration deliberately fixed:

- Transit mount: `transit/`
- Key prefix: `weldall-connector-`
- Key type: `aes256-gcm96`
- No namespace, custom mount, AppRole login, token renewal, or provider-specific connector fields
- No OpenBao client dependency; use the Node.js `fetch` implementation already available in the supported runtimes

Operators must enable the Transit engine before use and grant the Weldall token only these data-plane capabilities:

```hcl
path "transit/encrypt/weldall-connector-*" {
  capabilities = ["create", "update"]
}

path "transit/decrypt/weldall-connector-*" {
  capabilities = ["update"]
}
```

The token does not need access to `transit/keys/*`, secret values, mounts, policies, or administration endpoints.

## Key identity and lifecycle

Derive each key name from the immutable connector UUID:

```text
weldall-connector-<connector UUID>
```

Do not derive it from the connector's display name, declarative address, provider type, owner, connection ID, or OAuth account.

The first call to `POST /v1/transit/encrypt/<key>` supplies both `create` and `update` authorization. OpenBao atomically creates the missing key with the requested `aes256-gcm96` type and encrypts the DEK in the same request. Do not issue a key lookup or a separate key-creation request. Later encryption calls use the same endpoint and key.

Concurrent first connection attempts rely on OpenBao's idempotent key upsert. Weldall must not add an in-process key-existence cache or lock. This keeps behavior correct across multiple Weldall instances.

Key deletion is never automatic. Deleting a connector removes Weldall's connection state and encrypted values, but leaves the Transit key for explicit operator cleanup. This avoids unrecoverable data loss from a failed or reordered cross-system deletion. OpenBao key rotation is transparent: new wraps use the latest version and old ciphertext continues to identify the version required for decryption.

## Request count

| Operation                                              |                              OpenBao requests |
| ------------------------------------------------------ | --------------------------------------------: |
| Create, update, list, or delete a connector definition |                                             0 |
| Begin the first connection authorization attempt       | 1 encrypt request, which also creates the key |
| Later secret write or replacement                      |                             1 encrypt request |
| Secret read                                            |                             1 decrypt request |

The key is created when the first OAuth authorization attempt needs encrypted attempt state. This happens before the final `Connection` row exists, but it is the first point at which connector-specific secret material must be protected.

## Envelope format and cryptography

Keep the existing data-encryption design:

1. Generate a fresh random 32-byte DEK for every complete credential-object write.
2. Encrypt the serialized credential object locally with AES-256-GCM.
3. Build authenticated wrapping metadata from the envelope format version, provider, stable record/purpose context, and expected per-connector key name.
4. Send the base64 DEK as `plaintext` and the base64 wrapping metadata as `associated_data` to Transit encrypt.
5. Persist only the local ciphertext fields and the opaque Transit ciphertext.
6. On read, derive the expected key name from the caller-supplied connector UUID, send the Transit ciphertext and identical `associated_data` to Transit decrypt, strictly decode the returned 32-byte DEK, and decrypt the credential object locally.

Do not use Transit `context`: a non-empty `context` would create a derived key. Use `associated_data` to authenticate Weldall's entity and purpose metadata while retaining one ordinary Transit key per connector.

The OpenBao provider's `wrappedDek` shape is:

```json
{
  "ciphertext": "vault:v1:..."
}
```

Validate this object strictly. Do not persist the host, token, connector UUID, or key path in `wrappedDek`; the expected key is derived from the authorized connector relation. No database migration is required because `EnvelopeProvider.OPENBAO` and the JSON `wrappedDek` column already exist.

Do not cache plaintext DEKs. Every credential read performs one bounded Transit decrypt request, limiting key exposure and preserving immediate operator control through OpenBao.

## OpenBao client

Create a small internal client with two operations: `encryptDek` and `decryptDek`.

For each request:

- Read and validate `WELDALL_OPENBAO_HOST` and `WELDALL_OPENBAO_TOKEN` at operation time.
- Use `POST` with `Content-Type: application/json` and `X-Vault-Token`.
- URL-encode the derived key name.
- Apply a fixed, bounded timeout; do not allow a connection operation or database lock to wait indefinitely.
- Do not automatically retry. A caller may safely retry the complete connection operation, while hidden retries would multiply latency and complicate failure attribution.
- Strictly validate the success response before using it.
- Never include the token, request body, response body, DEK, ciphertext, associated data, host, or path in an error or log record.

Map failures to fixed diagnostic reasons such as missing configuration, invalid configuration, timeout, unavailable service, rejected request, and malformed response. Return one safe user-facing connector error. Preserve the existing rule that only fixed labels are written to `connector.encryption.failed` logs.

## Transaction boundaries

OpenBao is remote I/O and must not run inside the existing serializable database transactions. Split the current encryption helpers into preparation and persistence stages:

- `prepareSecretEnvelope(...)`: generate/encrypt locally and wrap the DEK remotely; no database client
- `persistSecretEnvelope(...)`: create or replace the `EncryptedValue` using an already prepared envelope; database only
- `loadSecretEnvelope(...)`: load ciphertext and its authorized connector identity; database only
- `decryptSecretEnvelope(...)`: unwrap and decrypt outside a transaction

For each connection workflow:

1. Read and authorize the current row/state.
2. Perform the required OpenBao operation outside the transaction.
3. Enter a serializable transaction, reload the row, and repeat all version, status, ownership, expiry, and connector-policy checks.
4. Persist the prepared envelope or commit the state transition using existing compare-and-set predicates.
5. Discard prepared ciphertext when revalidation loses a race.

Apply this structure to authorization-attempt creation and claiming, callback credential retention, final connection creation, refresh, revocation, and execution-time credential reads. Add a regression test that would fail if the mocked OpenBao request runs while the transaction callback is active.

## Failure and recovery semantics

OpenBao failure must be scoped to the affected operation:

- Weldall startup and global readiness remain healthy.
- Connector administration remains available.
- `LOCAL_ENV` connectors continue to work.
- The affected OpenBao-backed operation returns a sanitized `503` and does not commit a partial database transition.
- A later retry works without repair after OpenBao becomes available again.

Failure before redirecting to an OAuth provider leaves the authorization attempt in its prior retryable state and exposes no provider credential.

At callback time, decrypting the saved authorization attempt already proves OpenBao availability immediately before exchanging the authorization code. If wrapping newly issued provider credentials nevertheless fails afterward, attempt immediate provider revocation using the in-memory credentials, mark the authorization failed through a database-only transition, clear plaintext from reachable buffers where practical, and never log or persist it. If provider revocation also fails, emit only fixed audit/error metadata; do not weaken storage guarantees by writing plaintext or using another envelope provider.

Do not make startup verification decrypt all OpenBao-backed rows. Existing `verifyConnectorEncryption` behavior must retain fail-fast validation for local deployment keys while treating OpenBao as an operation-time dependency.

## Product surfaces

Keep provider availability simple and unconditional:

- Change the server connector contract from `z.literal("LOCAL_ENV")` to an explicit `LOCAL_ENV | OPENBAO` enum.
- Enable the existing OpenBao option in the admin selector and display the selected provider correctly in connector tables.
- Keep the field immutable for existing connectors.
- Accept `OPENBAO` in CLI manifest validation and the JSON schema without adding capability negotiation, provider configuration blocks, or discovery endpoints.
- Let the server remain authoritative for operation-time errors.

This is not an IaC feature project. IaC only needs to accept and round-trip the already existing enum value exactly as the UI and API do.

## Implementation areas

Primary files and responsibilities:

- `apps/weldall/src/server/connectors/envelope-providers.ts`
  - OpenBao configuration parsing, strict wrapped-DEK schema, client calls, connector-key derivation, and provider selection
- `apps/weldall/src/server/connectors/envelope-errors.ts`
  - Fixed OpenBao diagnostic codes and safe messages
- `apps/weldall/src/server/connectors/encryption.ts`
  - Connector identity in provider operations and separation of remote preparation/decryption from persistence
- `apps/weldall/src/server/connectors/core/connections.ts`
  - Move remote crypto outside transactions and preserve lifecycle compare-and-set guarantees
- `apps/weldall/src/server/connectors/configuration.ts`
  - Accept OpenBao definitions without remote readiness or key creation
- `apps/weldall/src/server/deployment.ts`
  - Prevent OpenBao outages from failing global startup readiness
- `apps/weldall/src/server/connectors/contracts.ts`
  - Accept both envelope providers
- `apps/weldall/src/app/admin/connectors/envelope-provider-field.tsx`
  - Enable OpenBao unconditionally
- `apps/weldall/src/app/admin/connectors/configuration-page.tsx`
  - Display provider-specific labels instead of always showing the local provider
- `apps/cli/src/iac/manifest.ts` and `schemas/weldall-manifest-v1.schema.json`
  - Accept and round-trip `OPENBAO` without additional configuration
- `.env.example`, setup documentation, connector documentation, and German equivalents
  - Deployment variables, Transit policy, lazy key lifecycle, rotation, deletion, and outage behavior
- `AGENTS.md`
  - Replace the statement that OpenBao and key rotation are unsupported with the new operational boundaries

## Tests

### Unit and contract tests

- `OPENBAO` parses and round-trips through server, CLI, schema, UI, and IaC contracts with no environment variables present.
- Connector create/update/list/delete performs zero OpenBao requests.
- Missing host or token fails only an attempted OpenBao encryption/decryption.
- Host validation permits local development HTTP but rejects unsafe production URLs.
- Encrypt sends exactly one request with the expected key path, headers, plaintext, associated data, and key type.
- The first encrypt succeeds without a prior key lookup or creation call.
- Subsequent encrypt still makes exactly one request.
- Decrypt makes exactly one request and requires a canonical 32-byte plaintext DEK.
- Connector A ciphertext cannot be unwrapped through connector B's derived key path or metadata.
- Malformed `wrappedDek`, malformed responses, non-2xx responses, timeouts, and network failures produce safe fixed errors and logs.
- Tokens, DEKs, credentials, ciphertext, associated data, hosts, paths, and raw response bodies never appear in errors or logs.
- OpenBao calls occur outside transaction callbacks.
- An operation can be retried successfully after a simulated outage without manual state repair.
- A post-OAuth wrap failure invokes immediate provider revocation and commits no plaintext or partial ready connection.

### Live OpenBao integration

Run focused integration coverage against a pinned OpenBao 2.7 container:

1. Enable `transit/` and install the restricted policy.
2. Assert the connector key does not exist before use.
3. Start the first connection encryption and assert the key appears and the DEK round-trips.
4. Start concurrent first encryptions for one connector and verify both succeed with one shared key.
5. Create a second connector and verify it receives a distinct key.
6. Rotate one connector key, verify new writes use the new version, and verify old ciphertext still decrypts.
7. Stop OpenBao, verify only OpenBao-backed operations fail, restart it with preserved test state, and verify recovery.

Keep this integration focused rather than adding OpenBao to unrelated test suites or the E2E product stack.

## Documentation and release

Document:

- Required environment variables
- Transit enablement and least-privilege policy
- One key per connector and lazy first-use creation
- The absence of automatic key deletion
- OpenBao-managed rotation behavior
- The requirement to back up and operate OpenBao independently from PostgreSQL
- Operation-scoped `503` behavior during outages
- The fact that OAuth client secrets remain under fixed application encryption; OpenBao protects connection/authorization credential envelopes only

Add the appropriate changeset for the CLI-visible manifest capability and regenerate any generated schema or documentation artifacts required by existing repository checks.

## Acceptance criteria

- An administrator can create an `OPENBAO` connector while OpenBao variables are absent or the server is offline.
- That connector remains visible and manageable without OpenBao.
- Starting its first connection with missing or unavailable OpenBao fails safely with a sanitized `503` and no partial transition.
- With valid `HOST` and `TOKEN`, the first connection attempt creates exactly one per-connector Transit key through the encrypt request itself.
- Every credential write performs one Transit encrypt; every credential read performs one Transit decrypt.
- No remote OpenBao request runs inside a serializable database transaction.
- OpenBao outages do not fail Weldall startup or affect local-envelope connectors.
- Connector keys are isolated, rotatable in OpenBao, and never deleted automatically by Weldall.
- Existing `LOCAL_ENV` behavior and ciphertext remain compatible.
