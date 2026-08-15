# Weldall Infrastructure as Code

## Status

Implemented; not yet released.

## Decision

Weldall IaC v1 uses **native Weldall YAML**, managed through the existing `weldall` CLI with `weldall plan`, `weldall up`, `weldall import`, and related commands. One complete configuration snapshot is validated and committed atomically.

**Terraform is not part of this plan.** We will not build a Terraform provider, consume Terraform state, use HCL, or make Terraform a supported v1 interface. The native Weldall workflow is the sole implementation target.

Terraform was evaluated and rejected for this feature because its normal resource-by-resource CRUD and partial-apply model conflicts with the chosen requirement that one Weldall configuration snapshot is validated and committed atomically. A single aggregate Terraform resource could retain atomicity but would provide poor Terraform ergonomics and duplicate the native workflow. Terraform may be reconsidered later through a separate proposal after the native API and ownership model are stable; that possibility creates no v1 design or compatibility obligation.

## Goals

- Manage Weldall's core administrative primitives declaratively in source control.
- Preview changes before applying them.
- Apply one complete desired-state snapshot atomically.
- Distinguish IaC-managed primitives from manually managed primitives.
- Never delete a manual primitive merely because it is absent from YAML.
- Explicitly import existing manual primitives into an IaC workspace.
- Explicitly release ownership without deleting the underlying primitive.
- Detect and restore manual drift on the next apply.
- Authenticate automation through the existing machine-to-machine mechanism.
- Support Linux CI and macOS without browser login or a master password.
- Keep all private key material out of manifests, state, responses, audits, and logs.

## Non-goals

- Terraform, OpenTofu, HCL, Terraform state, or a Terraform provider.
- Managing group providers, provider credentials, CLI settings, users, discovered catalogs, audit records, or Better Auth tables in v1.
- Sharing ownership of one primitive between repositories.
- Field-level or relation-level ownership.
- Variables, expressions, templates, environment substitution, modules, or overlays.
- Managing private machine keys or introducing a secret store.
- Automatically adopting a matching manually managed primitive.
- Transferring ownership between IaC workspaces in v1.
- Targeting multiple Weldall servers from one workspace.

## V1 primitives

| Primitive              | Natural identity          | IaC-owned desired state                                                                                                  |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Scope                  | Scope key                 | Description                                                                                                              |
| Downstream resource    | Resource key              | Name, resource identifier, authorization server, downstream client ID, enabled flags, supported scopes, request prefixes |
| Machine client         | Client ID                 | Name, enabled state, allowed resources, allowed scopes, active public keys                                               |
| Administrator skill    | Slug                      | Title, inline Markdown content, required scopes, visibility                                                              |
| Email scope assignment | Normalized email          | Complete assigned scope set                                                                                              |
| Group scope assignment | Provider key and group ID | Complete assigned scope set; group IDs are opaque and no group metadata is persisted                                     |

Nested rows such as grants, resource-scope links, request prefixes, machine access links, and machine public keys belong to their parent primitive. Skill slugs are immutable natural identities: changing a managed skill slug replaces it. Administrator-managed skills may override a resource-published skill with the same canonical ID; discovered skills and catalogs are never managed or bindable. IaC owns the complete configurable state of an imported or created primitive.

The built-in scopes `weldall:login`, `weldall:administer`, and `weldall:iac` remain server-owned. Manifests may reference them in assignments or machine access but cannot declare, import, rename, update, or delete them.

## Repository layout

A workspace has one root `weldall.yml` and may include deterministic YAML fragments.

```text
repository/
├── weldall.yml
├── weldall.lock.yml
└── weldall/
    ├── scopes.yml
    ├── resources.yml
    ├── machines.yml
    ├── skills.yml
    └── assignments.yml
```

Example root:

```yaml
apiVersion: weldall.dev/v1

workspace:
  name: platform-access
  issuer: https://weldall.example.com

include:
  - weldall/**/*.yml
```

Example fragment:

```yaml
scopes:
  expenses_read:
    key: expenses:read
    description: Read expenses

resources:
  expenses:
    key: expenses
    name: Expenses
    resourceIdentifier: https://expenses.example.com/api
    authorizationServer: https://expenses.example.com
    downstreamClientId: weldall-cli-at-expenses
    enabled: true
    skillDiscoveryEnabled: false
    requestPrefixes:
      - https://expenses.example.com/api
    scopes:
      - expenses:read

machines:
  deployer:
    clientId: expenses-deployer
    name: Expenses deployer
    enabled: true
    publicKeys:
      ci-2026:
        kty: EC
        crv: P-256
        x: "..."
        y: "..."
    resources:
      - expenses
    scopes:
      - expenses:read
      - weldall:iac

emailAssignments:
  alice:
    email: alice@example.com
    scopes:
      - weldall:login
      - expenses:read

groupAssignments:
  finance:
    provider: corporate-directory
    groupId: finance
    scopes:
      - expenses:read
```

### Manifest rules

- Map keys form stable logical addresses such as `scope.expenses_read` and `machine.deployer`.
- Relations use stable natural keys and may reference manually managed or other-workspace primitives.
- Included paths are root-relative, lexically sorted, bounded, and cannot escape the workspace through paths or symlinks.
- Duplicate logical addresses, duplicate natural identities, unknown fields, custom YAML tags, aliases, and private JWK fields are rejected.
- Arrays with set semantics are canonicalized and compared without ordering drift.
- Configuration has no interpolation or environment-dependent evaluation in v1.
- Identity fields that are immutable in the current product are replacements rather than updates.
- Logical address changes use an explicit state-move command so they are not interpreted as delete and create.

## Lockfile

`weldall.lock.yml` is generated and committed to version control.

```yaml
version: 1
server:
  issuer: https://weldall.example.com
  installationId: 0bc8c262-0000-0000-0000-000000000000

workspace:
  id: 67ade6dc-0000-0000-0000-000000000000
  name: platform-access
  observedRevision: 12

objects:
  scope.expenses_read:
    kind: scope
    objectId: cm123
    identity: expenses:read
    observedVersion: 3
```

Rules:

- A random workspace UUID is authoritative; Git remote URLs and runner machines are not workspace identities.
- One lockfile is bound to one issuer and one persistent server installation UUID.
- The installation UUID prevents an old lockfile from silently targeting a reset or replaced server at the same URL.
- The lockfile contains mappings, versions, and revision metadata, never credentials or private keys.
- Server-side ownership remains authoritative. The lockfile is a committed cache and review artifact, not proof of ownership.
- `weldall state pull` reconstructs or repairs the lockfile from server state.
- Lockfile replacement is atomic on the local filesystem after a successful remote commit.
- If the server commits but local lockfile writing fails, rerunning the idempotent operation or using `state pull` recovers safely.

This file is Weldall workspace state. It is unrelated to Terraform's dependency lockfile or Terraform state.

## Ownership model

Multiple repositories may manage different primitives on the same Weldall server, but each primitive has at most one owning IaC workspace.

| Situation                                                | Required behavior                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| Manual primitive is absent from YAML                     | Leave it untouched                                                 |
| YAML declares a natural key that already exists manually | Fail and require `weldall import`                                  |
| YAML declares a primitive owned by another workspace     | Fail; never steal or share ownership                               |
| IaC-owned primitive is edited in the admin UI            | Keep ownership; show drift and restore YAML state on the next `up` |
| IaC-owned primitive is manually deleted                  | Keep an ownership tombstone and recreate it on the next `up`       |
| IaC-owned declaration is removed                         | Plan deletion and delete it on approved apply                      |
| Declared public machine key is removed                   | Plan an irreversible key revocation                                |
| Primitive is explicitly unmanaged                        | Preserve current server state and release ownership                |
| System scope is declared or imported                     | Reject                                                             |

The UI marks managed primitives as IaC-owned and shows the workspace and logical address. Per the selected product behavior, UI edits remain available without an extra warning or confirmation. Such edits are drift and may be overwritten later.

### External references

A workspace may reference primitives it does not own by stable natural key. Ownership does not propagate through a reference.

Deletion of an owned primitive must never silently cascade into a manual primitive or one owned by another workspace. The plan must either update all affected primitives owned by the same workspace in the same atomic snapshot or report external references as blockers.

Existing last-administrator and system-scope protections remain in force. IaC is not permitted to remove the last verified administrator.

## Machine lifecycle

Machine clients preserve a one-to-one declarative mapping:

- `enabled: false` means the machine remains present but deactivated.
- Removing the machine declaration means hard deletion, including its access links and public-key records.
- Removing one public key means revoking that key rather than physically erasing its historical record where auditability requires retention.
- A revoked key cannot become active again by re-adding it; rotation uses a new key ID and public key.

The authenticating runner may manage its own machine metadata, but an apply must reject any operation that would, during that request:

- hard-delete the caller,
- disable the caller,
- remove the caller's `weldall:iac` access,
- or revoke the key that authenticated the request.

Key rotation therefore follows: add new public key, switch the CI secret to the matching private key, then remove the old public key while authenticated with the new key.

## CLI interface

```sh
weldall init
weldall validate
weldall plan
weldall plan --json
weldall up
weldall up --yes
weldall import scope expenses:read --as scope.expenses_read
weldall unmanage scope.expenses_read
weldall state pull
weldall state mv scope.old scope.new
```

### `weldall init`

- Creates a root manifest and committed lockfile identity for one issuer.
- Fails rather than overwriting existing configuration.
- Registers or retrieves the server-side workspace during the first authenticated operation.

### `weldall validate`

- Parses includes and validates the complete local schema without changing server state.
- Performs deterministic canonicalization.
- May run without credentials for local-only checks; online reference validation is a separate reported phase when credentials are present.

### `weldall plan`

- Authenticates, reads current server state, and computes a deterministic plan.
- Shows creates, updates, replacements, deletes, key revocations, drift restoration, and blockers.
- Never changes managed primitives or ownership.
- Supports stable machine-readable JSON and a Terraform-style detailed exit code without adopting Terraform state or semantics.

### `weldall up`

- Computes and displays a fresh plan.
- Prompts in an interactive terminal before applying changes.
- Requires `--yes` in a non-interactive environment and fails closed without it.
- Does not prompt for a no-change plan.
- Sends canonical configuration and plan digests so the server can detect stale plans.

### `weldall import`

- Selects one existing manually managed primitive by kind and natural identity.
- Fails if it is already owned by any workspace or is a protected system primitive.
- Atomically claims it for the current workspace.
- Emits its complete current configurable state into a new included YAML fragment and updates the lockfile.
- Never overwrites an existing declaration or silently changes the imported object.
- Uses an operation ID so a server commit followed by a local file failure can be retried safely.

### `weldall unmanage`

- Requires the logical address to be absent from desired configuration to avoid immediate recreation ambiguity.
- Preserves the primitive exactly as it currently exists.
- Removes only its workspace ownership binding and lockfile entry.
- Is explicit and independently confirmed because future YAML removal otherwise means deletion.

### State commands

- `state pull` recovers local mappings from authoritative server ownership.
- `state mv` changes a logical address without replacing the remote primitive.
- No command directly edits opaque server IDs or ownership records without server validation.

## Authentication and authorization

IaC uses the existing machine-to-machine flow. The server stores only public keys; the executing process keeps the matching private key in its existing CI or deployment secret mechanism.

Bootstrap:

1. An administrator manually creates a runner machine client.
2. The administrator registers its public ES256 P-256 JWK.
3. The administrator allows the built-in `weldall:iac` scope for that machine.
4. CI receives the existing M2M values: issuer, client ID, key ID, private JWK, and matching public JWK.
5. The CLI requests a five-minute DPoP-bound machine token for Weldall's own API and invokes the IaC endpoints.

No browser login, Keychain session, master password, repository private key, or new credential store is involved.

### New system scope

Add fixed built-in scope:

```text
weldall:iac — Plan and apply Weldall infrastructure configuration.
```

Rules:

- It is machine-only and reference-only.
- Email and group assignment APIs must reject attempts to grant it to people.
- A machine needs the scope in `MachineAllowedScope` to receive an internal IaC token.
- Possession grants global IaC administration in v1, including workspace creation, apply, import, unmanage, and state moves.

### Internal machine token

Extend machine token issuance for `resource == WELDALL_RESOURCE` without adding Weldall itself to `DownstreamResource`.

For an IaC token, the token endpoint must verify:

- active machine and active registered key,
- valid `private_key_jwt` assertion and DPoP proof,
- Weldall's API as the exact resource,
- exact requested scope `weldall:iac`,
- and matching `MachineAllowedScope`.

Add an IaC API verifier that accepts only Weldall-issued machine JWTs with:

- the internal Weldall API audience,
- `identity_type == machine`,
- `weldall:iac` in the token scope,
- strict DPoP binding and replay protection,
- and live revalidation of machine enabled state, active key thumbprint, and current allowed scope.

Before production use with multiple Weldall processes, replace the current process-local replay stores with a shared PostgreSQL- or Redis-backed replay store.

## Server-side data model

### `InstallationIdentity`

A singleton containing the persistent random UUID advertised by the server and pinned in workspace lockfiles. The fixed `id: default` is only the singleton row key. The UUID changes when the database installation is recreated so an old lockfile cannot silently target a replacement server at the same issuer.

### `IacWorkspace`

- `id`: client-generated random UUID from the committed lockfile
- `name`: human-readable display name
- `issuer` or installation relation
- `revision`: monotonically increasing optimistic state revision
- `lastConfigDigest`
- timestamps and last actor metadata

### `IacObjectBinding`

- workspace ID
- unique logical address within the workspace
- primitive kind
- natural identity snapshot
- one nullable typed relation to a supported primitive
- timestamps

Typed target relations are unique so one primitive cannot be bound twice. Target deletion uses `ON DELETE SET NULL`, preserving the binding as a tombstone after an out-of-band deletion. Intentional IaC deletion removes both target and binding in the same transaction.

### `IacOperation`

- operation UUID/idempotency key
- workspace ID
- operation type
- request/configuration digest
- prior and resulting workspace revision
- status and bounded result summary
- timestamps

It supports safe retries for apply, import, unmanage, and state moves without repeating committed mutations.

## API

Use a versioned REST API rather than exposing browser-admin tRPC to automation:

```text
POST /api/iac/v1/plan
POST /api/iac/v1/apply
POST /api/iac/v1/import
POST /api/iac/v1/unmanage
POST /api/iac/v1/state/move
GET  /api/iac/v1/workspaces/:id/state
```

Requirements:

- Machine and DPoP authentication only.
- Strict, bounded request and response schemas.
- Canonical SHA-256 configuration and plan digests.
- Request IDs, correlation IDs, and idempotency keys.
- Structured errors containing logical addresses, collision owners, blockers, and current revisions without exposing secrets.
- Discovery advertises the IaC API endpoint, supported manifest/API versions, installation UUID, and `weldall:iac`.
- Publish JSON Schema for manifests and OpenAPI for the HTTP contract.
- The API is designed for the native CLI only in v1; it is not a Terraform provider compatibility layer.

## Planning algorithm

1. Load and canonicalize the complete submitted desired state.
2. Validate workspace identity, issuer, installation UUID, schema version, and limits.
3. Resolve existing bindings, tombstones, live target rows, and natural-key collisions.
4. Resolve all references by stable key, including permitted external references.
5. Compare complete owned primitive snapshots to desired state.
6. Produce deterministic actions:
   - create,
   - update,
   - replace,
   - delete,
   - recreate missing owned primitive,
   - register public key,
   - revoke public key,
   - or no-op.
7. Compute dependency order and deletion blockers.
8. Check protected system scopes, last-admin safety, cross-workspace ownership, and runner self-protection.
9. Return a canonical plan and digest without mutation.

Natural-key collisions with manual primitives never become updates. They are plan errors that point to `weldall import`.

## Atomic apply

The complete native manifest is the transaction boundary.

1. `up` sends the canonical desired-state digest, planned workspace revision, plan digest, and operation ID.
2. The server opens a serializable database transaction.
3. It acquires a shared advisory lock used by all configuration-changing admin and IaC operations.
4. It reloads ownership, versions, references, machine credentials, and protected invariants.
5. It recomputes the plan inside the transaction.
6. Any changed revision, digest, collision, ownership, reference, or self-protection result rejects the whole apply as stale.
7. It executes the dependency-ordered plan with transaction-aware domain services.
8. It writes primitive and aggregate audit records in the same transaction.
9. It increments the workspace revision, stores the operation result, and commits.
10. Any error rolls back every primitive, binding, revision, and audit event from that apply.

Group assignment creation resolves only the configured provider record inside the transaction. Group IDs are opaque: planning and apply never require provider connectivity or remote group existence, and no group display metadata is persisted.

The database transaction cannot include the local lockfile write. Idempotent operation records and `state pull` cover that boundary.

## Shared domain services

IaC must not copy the current browser-admin rules into a separate implementation.

Refactor mutation logic from:

- `apps/weldall/src/server/admin/service.ts`,
- `apps/weldall/src/server/machines/service.ts`,
- `apps/weldall/src/server/group-providers/service.ts`.

Create transaction-aware helpers that accept:

- `Prisma.TransactionClient`,
- a user or machine actor,
- operation source,
- expected version or expected workspace snapshot.

Browser tRPC continues to call the same helpers with `admin_api`; IaC uses them with `weldall_up`, import, or unmanage sources. Preserve existing validation for normalized URLs, prefix overlap, scope keys, JWKs, immutable identities, provider groups, optimistic versions, protected scopes, last-admin safety, and audit metadata.

All admin and IaC configuration mutations must follow one documented lock order to avoid deadlocks and to ensure a browser edit cannot interleave with an atomic IaC snapshot.

## Admin UI

Add management metadata to DTOs for the five v1 primitives:

```ts
management:
  | { type: "manual" }
  | {
      type: "iac";
      workspaceId: string;
      workspaceName: string;
      address: string;
    };
```

UI changes:

- Show an `IaC` badge in relevant tables and details.
- Show workspace name and logical address.
- Continue allowing normal edits and deletes silently.
- Preserve ownership after an edit.
- Preserve an ownership tombstone after manual deletion.
- Optionally add a read-only workspace overview showing revision, last apply, actor, and owned-object count.

The UI does not become a manifest editor and does not expose private key material.

## Audit

Add aggregate and lifecycle events such as:

- `iac.plan.generated`
- `iac.apply.succeeded`
- `iac.apply.denied`
- `iac.apply.failed`
- `iac.object.imported`
- `iac.object.unmanaged`
- `iac.state.moved`
- `machine_client.deleted`

Audit metadata includes:

- machine actor and client ID,
- workspace ID and name,
- request and correlation IDs,
- prior and resulting revisions,
- configuration and plan digests,
- action counts and affected logical addresses,
- outcome and bounded reason code.

Continue writing per-primitive audit events using explicit IaC sources. Never record access tokens, client assertions, DPoP proofs, private JWKs, complete manifests, or request payloads. Existing audit schemas already anticipate `weldall_up` and `static_manifest_import` sources and should be normalized around the final naming.

## Linux and macOS packaging

At the time of this plan, the npm CLI was restricted to macOS because interactive user sessions used macOS Keychain and Preferences. IaC itself had no Keychain requirement.

For v1:

- publish `@weldall/cli` for Linux and macOS,
- make the Keychain native dependency optional and load it only for user-session commands,
- retain macOS Keychain behavior for interactive login,
- allow M2M IaC commands to run without Keychain or macOS Preferences,
- read the issuer from the manifest with an explicit environment override only where already supported,
- use the SDK's existing M2M environment-key loading rather than creating profiles or credential files,
- provide clear unsupported-platform errors only for commands that genuinely require macOS,
- test installation and IaC command startup on Linux and macOS.

## Security requirements

- Reject any JWK containing private member `d` at every manifest, API, service, and logging boundary.
- Redact public JWK coordinates from ordinary plan/audit output; show key ID and thumbprint.
- Apply strict payload, object-count, include-count, and per-relation limits.
- Require HTTPS issuer and canonical server discovery.
- Never follow redirects for IaC API calls.
- Verify the discovery installation UUID against the lockfile before sending a mutation.
- Use DPoP-bound short-lived machine tokens and shared replay protection in production.
- Revalidate authorization immediately before mutation.
- Make apply, import, unmanage, and state moves idempotent.
- Fail closed on ambiguous references, ownership, stale state, or incomplete audit writes.
- Keep all manually managed primitives out of the deletion set unless explicitly imported first.

## Delivery phases

### Phase 1: contracts and architecture

- Record the explicit native-YAML decision and Terraform non-goal.
- Freeze v1 primitive boundaries and natural identities.
- Define manifest, canonicalization, lockfile, plan, and error schemas.
- Define atomicity, ownership, tombstone, import, and unmanage semantics.
- Define validation limits and CLI exit codes.

### Phase 2: database foundation

- Add installation, workspace, binding, and operation models.
- Add typed ownership relations and tombstone behavior.
- Add migrations, generated Prisma client, seed updates, and model tests.
- Add `weldall:iac` as a protected machine-only system scope.

### Phase 3: internal M2M authorization

- Permit a machine token for Weldall's own API and `weldall:iac`.
- Add IaC machine-token and DPoP verification.
- Add live policy revalidation and caller self-protection.
- Implement shared replay storage before multi-instance production deployment.

### Phase 4: shared mutation services

- Extract transaction-aware helpers from current admin services.
- Establish one lock order for browser and IaC mutations.
- Add hard machine deletion and audit behavior.
- Preserve all current business and safety validation.

### Phase 5: planner and reconciler

- Implement canonical desired-state snapshots.
- Resolve references, ownership, drift, collisions, tombstones, and blockers.
- Generate deterministic plans.
- Implement serializable all-or-nothing apply with idempotency.

### Phase 6: HTTP API

- Implement plan, apply, state, import, unmanage, and state-move endpoints.
- Add strict schemas, discovery metadata, OpenAPI, and structured errors.
- Add request limits, idempotency, and failure-injection tests.

### Phase 7: CLI

- Implement YAML parser, includes, canonicalization, and local validation.
- Implement committed lockfile creation and recovery.
- Add `init`, `validate`, `plan`, and `up` with human and JSON output.
- Add `import`, `unmanage`, `state pull`, and `state mv`.
- Make IaC commands work on Linux and macOS using existing M2M environment secrets.

### Phase 8: UI and audit

- Add ownership metadata and badges across the five primitive surfaces.
- Add optional read-only workspace overview.
- Add aggregate IaC events and machine deletion events.
- Verify no key or manifest leakage in UI, errors, or audit records.

### Phase 9: documentation and release

- Document bootstrap, CI setup, key rotation, import, unmanage, recovery, drift, and deletion behavior.
- Publish manifest JSON Schema and API OpenAPI documents.
- Add Linux/macOS package checks, integration tests, E2E flows, and a Changeset.
- Explicitly document that Terraform is unsupported and outside v1.

## Acceptance criteria

### Ownership and safety

- A manual primitive omitted from YAML remains unchanged.
- A matching manual natural key causes a collision error until explicitly imported.
- A primitive owned by another workspace cannot be imported, updated, or deleted.
- One remote primitive cannot be bound to two logical addresses.
- Unmanage preserves the primitive and releases ownership.
- System scopes remain undeclarable and unimportable.
- External references block unsafe deletion rather than cascading.
- The last verified administrator cannot be removed.

### Drift and lifecycle

- Manual edits to owned primitives appear in the next plan and are restored by `up`.
- Manual deletion leaves a tombstone and causes recreation on the next `up`.
- Removing an owned declaration plans and performs deletion.
- Removing an active public key plans and performs irreversible revocation.
- Removing a machine hard-deletes it; `enabled: false` only deactivates it.
- Logical address moves preserve the remote object and ownership.

### Atomicity and concurrency

- A failed create, update, delete, reference check, audit write, or group-version check rolls back the entire apply.
- Concurrent applies from the same revision cannot both commit.
- Browser edits cannot interleave with a committed IaC snapshot.
- A stale plan or changed configuration digest cannot be applied.
- Retrying a committed operation does not repeat mutations.
- A failed local lockfile write is recoverable with retry or `state pull`.

### Authentication

- IaC commands require a valid active machine, active key, DPoP proof, internal audience, and live `weldall:iac` grant.
- Human access to `weldall:iac` is rejected.
- The caller cannot delete or disable itself, revoke its authenticating key, or remove its own IaC authorization in that apply.
- Revoked keys and replayed assertions/proofs cannot apply configuration.

### Secret handling

- Private JWKs are rejected from YAML and API payloads.
- Private keys never appear in lockfiles, plans, responses, audits, errors, or logs.
- Plan and audit output identify public keys only by key ID and thumbprint.

### Platform and UX

- Packaged `weldall validate`, `plan`, `up`, `import`, and state commands run on Linux CI and macOS.
- Non-interactive `up` fails without `--yes`.
- Human plan output and `--json` are deterministic.
- A no-change apply is idempotent and does not prompt.
- Help and documentation consistently describe native Weldall YAML as the only supported IaC interface.

## Future considerations

A future proposal may independently evaluate Terraform or OpenTofu after Weldall's native ownership and API contracts are stable. Such a proposal must explicitly address partial apply, ownership interoperability, separate state, release engineering, and conflict with native workspaces. No Terraform provider, state compatibility, HCL schema, or provider-specific API behavior is reserved by this plan.
