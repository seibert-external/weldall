# Audit logs

Weldall stores security-relevant events in the `AuditEvent` PostgreSQL table. Audit coverage starts when migration `0001_baseline` is deployed; historical activity cannot be reconstructed.

## Semantics

Schema version 1 defines these core events:

- `id_jag.issued`: a valid ID-JAG was generated, durably audited, and released for the HTTP response. It does not prove that the client received the response.
- `id_jag.denied`: an expected authentication or policy decision rejected the request.
- `id_jag.failed`: an internal dependency, signing, or audit-store failure prevented issuance.
- `workload_token.issued`: a valid workload access token was generated, durably audited, and released for the HTTP response.
- `workload_token.denied`: an expected workload authentication or policy decision rejected the request.
- `workload_token.failed`: an internal dependency, signing, or audit-store failure prevented workload token issuance.
- `workload_client.created|updated|deactivated`: a registered machine identity changed.
- `workload_key.registered|revoked`: a workload public key changed.
- `workload_access.replaced`: a workload's selected resources and scopes changed atomically.
- `user_scopes.created|replaced|deleted`: an email grant changed.
- `resource_scopes.created|replaced|deleted`: a registered resource or scope definition changed.

`outcome` is one of `success`, `denied`, or `failed`. Reason codes are controlled values defined in `src/server/audit/service.ts`. Metadata is validated by a strict, event-specific Zod schema before insert. Unknown fields are rejected.

Request and correlation IDs accept only 1–128 ASCII letters, digits, dots, underscores, colons, and dashes. Invalid inbound IDs are replaced or omitted. Server timestamps are UTC. Lists are sorted and de-duplicated before storage.

## Issuance fail-closed policy

Weldall signs an ID-JAG or workload access token, writes the matching `*.issued` event, and returns the token only after the audit insert succeeds. If the audit store is unavailable, no token is returned. ID-JAG issuance uses a hash of the verified actor context, request ID, and event type as the unique issuance deduplication key, so a retry cannot create a second successful issuance event without allowing one actor to reserve another actor's request ID.

Denied requests store only safely parsed audience, resource, and scope values plus already verified actor/client data. Audit records never include ID-JAGs, access or refresh tokens, subject tokens, DPoP proofs, authorization codes, secrets, private keys, request headers, or raw request bodies. The DPoP JKT is intentionally not retained.

## Access and immutability

The admin tRPC procedures `admin.auditEvents.list` and `admin.auditEvents.get` require the live `weldall:administer` grant. They expose stable pagination and filters for period, event type, and actor or affected-user email. There are no update, delete, or export procedures.

Application changes and their successful audit events share one database transaction. The migration revokes `UPDATE` and `DELETE` from `PUBLIC`; a production runtime role should receive only `SELECT` and `INSERT` on `AuditEvent`. Corrections are represented by later events. Database owners and privileged administrators remain outside this application-level trust boundary and can bypass grants, so database administration must be separately controlled and logged.

## Privacy, retention, and operations

Before production use, the operator must record the legal basis, purpose, authorized readers, and retention period for every event class. Actor email is retained only to make grant and issuance investigations usable; prefer `actorId` for correlation. IP addresses and user agents are not stored.

Retention must run as a separately authorized maintenance operation, never through the admin API, and must itself be logged operationally. Subject-access and deletion requests require a documented review because security evidence and personal-data obligations can conflict.

Application logs and metrics must not copy audit metadata. They may report aggregate counts, latency, and a generic audit-write failure signal, but must not use email, subject, resource, or scope values as metric labels. Alert on unusual denial/replay volumes and all audit-store write failures.
