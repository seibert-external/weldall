# Group-provider scope assignments

## Status

Draft for review.

## Summary

Weldall grants scopes through direct email assignments and through groups from administrator-configured group providers.

Effective scopes are the union of direct email scopes and scopes from matching provider groups:

```text
email -> direct scopes -----------------+
                                        +-> effective scopes
provider -> groups -> member emails ----+
```

The first provider implementation consumes a fixed HTTP JSON contract. Core policy and assignment code use a normalized provider interface and contain no deployment- or vendor-specific names. A typed adapter registry is the extension point for future provider types; its declaration must include a code comment explaining how to add an adapter without coupling it to assignment or policy code.

## Goals

- Preserve existing email assignments and their behavior.
- Let administrators register, test, update, disable, and delete group-provider configurations.
- Let administrators select a provider, one or more groups, and one or more scopes.
- Resolve the authenticated Weldall email to one provider user and its effective groups at authorization time.
- Union direct and group-derived scopes consistently across every authorization path.
- Keep provider authorization uncached: each new ID-JAG resolves current provider groups, while the resulting access token remains valid for its existing ten-minute lifetime.
- Fail closed for provider-derived grants without removing direct grants.
- Keep provider credentials secret and prevent provider URLs from becoming an SSRF primitive.
- Keep the implementation generic enough to add other provider adapters later.

## Non-goals for the first version

- Direct LDAP connectivity.
- Runtime installation or upload of provider plugins.
- Arbitrary request paths, authentication schemes, or custom headers.
- Deny rules or assignment precedence.
- Recursive traversal of nested groups.
- External-member support.
- Webhooks or scheduled background synchronization.
- Server-side provider-response or membership caching.

## Existing behavior to preserve

Direct assignments currently use:

```text
EmailScopeAssignment -> EmailScopeGrant -> Scope
```

They support normalized emails, optimistic versions, complete scope replacement, audit events, scope-deletion handling, and final-administrator protection. This model remains intact rather than being migrated into a polymorphic assignment table.

Administrator authorization remains based on a verified Weldall user with an effective `weldall:administer` scope. The scope may be direct or group-derived; group-derived authorization is resolved live and fails closed on provider failure, disablement, version change, or membership removal.

## Provider abstraction

Core code uses a server-only normalized interface:

```ts
interface GroupProviderAdapter {
  searchGroups(query: string, limit: number): Promise<GroupProviderGroup[]>;
  getGroups(groupIds: string[]): Promise<GroupProviderGroup[]>;
  getGroup(groupId: string): Promise<GroupProviderGroup>;
  testConnection(): Promise<{ groupCount: number }>;
  findUserByEmail(email: string): Promise<GroupProviderUserSummary | null>;
  getUser(userId: string): Promise<GroupProviderUser>;
}

interface GroupProviderGroup {
  id: string;
  name: string;
  description?: string;
}

interface GroupProviderUserSummary {
  id: string;
  email: string;
  active: boolean;
}

interface GroupProviderUser extends GroupProviderUserSummary {
  groupIds: string[];
}
```

Provider implementations are registered in server code by a stable adapter type. An administrator registers an instance of a supported adapter; they do not upload executable code. Keep the registry exhaustive so adding an adapter requires an explicit factory and configuration schema. Add a comment at the registry explaining this extension contract.

The first adapter type is `management-api-v1`. Its upstream API only supports listing all groups, so each group-search request fetches the bounded list and performs case-insensitive fuzzy matching over group ID, name, and description in memory. `getGroups(groupIds)` fetches the list once and resolves all requested summaries in one operation; the administration client uses it through a batched TanStack Query rather than issuing one query per selected group. There is no server-side provider cache.

## `management-api-v1` HTTP contract

### Authentication

Every request sends:

```http
Authorization: Token <configured token>
Accept: application/json
```

### List groups

```http
GET <baseUrl>/api/management/groups/
```

Expected response shape:

```json
[
  {
    "cn": "example",
    "ou": "example",
    "description": ""
  }
]
```

Mapping:

- `ou` is the opaque, case-sensitive stable group ID.
- `cn` is the display name, falling back to `ou`.
- `description` is optional display metadata.
- Additional fields such as DNs, ownership, mail addresses, aliases, and URLs are tolerated and discarded.

### Get group details

```http
GET <baseUrl>/api/management/groups/<encoded-group-id>/
```

The response may contain `direct_members`, `external_members`, `group_members`, and `members`, but these fields are not part of the generic contract and are ignored. Authorization uses the user's effective `groups` list instead. The adapter validates only the group ID, name, and optional description needed by Weldall.

### Find user by email

```http
GET <baseUrl>/api/management/users/?mail=<encoded-normalized-email>
```

Expected response shape:

```json
[
  {
    "username": "example-user",
    "email": "example.user@example.com",
    "is_active": true
  }
]
```

The real response may contain additional fields such as names, password dates, entry DNs, URLs, or operating-system settings. They are intentionally not part of the generic contract.

Mapping and cardinality rules:

- The query parameter is the provider model field `mail`, not the serialized field `email`.
- `username` is the opaque provider user ID.
- `email` must normalize to the requested email.
- `is_active` controls whether the user can receive group-derived scopes.
- An empty array means no matching provider user.
- More than one result is ambiguous and fails closed.

### Get user with groups

```http
GET <baseUrl>/api/management/users/<encoded-user-id>/
```

Expected response shape:

```json
{
  "username": "example-user",
  "email": "example.user@example.com",
  "is_active": true,
  "groups": ["example-group"]
}
```

Only `username`, `email`, `is_active`, and `groups` are part of the generic contract. Additional provider fields are tolerated and discarded. The detail username and normalized email must match the lookup result. `groups` is the authoritative effective membership set used for scope resolution.

### Contract validation and bounds

Responses are validated with selective Zod schemas that require only fields relevant to Weldall and tolerate/discard additional provider fields:

```ts
const providerUserSummarySchema = z.object({
  username: z.string().trim().min(1).max(191),
  email: z.string().email().max(320),
  is_active: z.boolean(),
});

const providerUserDetailSchema = providerUserSummarySchema.extend({
  groups: z.array(z.string().trim().min(1).max(191)).max(10_000),
});
```

Group responses follow the same selective approach for `ou`, `cn`, and optional `description`. Do not use `.strict()` for upstream response objects. After parsing, map and return only normalized generic DTO fields.

The client also enforces:

- HTTPS base URL.
- Fixed paths and HTTP `GET` only.
- No redirects.
- JSON response content type.
- Per-request timeout.
- Maximum response size.
- Maximum group and user-group counts.
- URL/query encoding for group IDs, user IDs, and email addresses.
- No retries in an authorization request.

A missing, ambiguous, inactive, mismatched, timed-out, malformed, or non-successful user lookup cannot create a grant.

## Identity resolution

The provider's filtered user-list endpoint bridges Weldall's authenticated email to the provider username without enumerating groups or users.

For each enabled provider that has group assignments:

1. Normalize the authenticated Weldall email.
2. Call `findUserByEmail(email)`, which requests `users/?mail=<email>`.
3. Require zero or one result; zero contributes no scopes and multiple results fail closed.
4. Require the result to be active and its normalized email to equal the requested email.
5. Call `getUser(result.id)`.
6. Require the detail response to have the same user ID and normalized email and to remain active.
7. Intersect `detail.groupIds` with the provider's configured group assignments.
8. Load and union scopes for the matching assignments.

This performs at most two provider requests per enabled provider during an ID-JAG decision and no request per group or group member. There is no server-side provider or membership cache. Group changes therefore affect the next ID-JAG immediately; already-issued access tokens retain their existing ten-minute validity.

## Data model

Add the following Prisma models and matching SQL constraints.

### `GroupProvider`

| Field                    | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `id`                     | CUID primary key                                  |
| `key`                    | Immutable, unique administrator-facing identifier |
| `name`                   | Display name                                      |
| `adapterType`            | Initially `management-api-v1`                     |
| `baseUrl`                | Normalized HTTPS origin                           |
| `encryptedToken`         | Versioned encrypted credential envelope           |
| `encryptionKeyVersion`   | Key version used for rotation/migration           |
| `enabled`                | Disabled providers contribute no scopes           |
| `version`                | Optimistic concurrency version                    |
| `createdAt`, `updatedAt` | Timestamps                                        |
| `createdBy`, `updatedBy` | Actor identifiers                                 |

The token is write-only and is never included in DTOs.

### `GroupScopeAssignment`

| Field                    | Purpose                        |
| ------------------------ | ------------------------------ |
| `id`                     | CUID primary key               |
| `providerId`             | Owning provider                |
| `groupId`                | Opaque provider group ID       |
| `version`                | Optimistic concurrency version |
| `createdAt`, `updatedAt` | Timestamps                     |
| `createdBy`, `updatedBy` | Actor identifiers              |

Constraint: `UNIQUE(providerId, groupId)`.

One row represents one provider group. Selecting multiple groups creates multiple assignments in one transaction.

### `GroupScopeGrant`

| Field          | Purpose          |
| -------------- | ---------------- |
| `id`           | CUID primary key |
| `assignmentId` | Group assignment |
| `scopeId`      | Granted scope    |
| `createdAt`    | Timestamp        |
| `createdBy`    | Actor identifier |

Constraint: `UNIQUE(assignmentId, scopeId)`.

Provider deletion is restricted while assignments exist. Scope deletion explicitly updates the versions and audits of affected group assignments instead of relying silently on cascading foreign keys.

## Effective-scope policy

Introduce a single policy entry point:

Scope keys use a branded smart type produced only by the existing lowercase `namespace:permission` Zod validation:

```ts
declare const scopeKeyBrand: unique symbol;
type ScopeKey = string & { readonly [scopeKeyBrand]: true };

const scopeKeySchema = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/)
  .transform((value): ScopeKey => value as ScopeKey);

async function effectiveScopesFor(email: string): Promise<ScopeKey[]>;
```

Database values and API inputs must pass through `scopeKeySchema` before becoming `ScopeKey`; application code must not use unchecked casts outside the schema module.

It returns a sorted, deduplicated union:

```text
direct email grants UNION successful group-provider grants
```

Rules:

- Direct email grants are evaluated independently and remain available during provider failures.
- A disabled provider contributes no scopes.
- A failed provider lookup contributes no scopes.
- Failures from one provider do not suppress grants from another provider.
- Group assignments may include registered protected system scopes; protection is based on Scope `isSystem` metadata and the fixed system-scope constants, never a key-prefix guess.
- Group-derived `weldall:login` and `weldall:administer` are effective on the same authorization paths as direct grants.
- Resource-specific policy continues intersecting effective scopes with the resource's supported scopes.
- There are no deny assignments or precedence rules.

Use the centralized resolver from:

- `assignedScopesFor` and `resourceRegistryFor` in `apps/weldall/src/server/policy/resources.ts`.
- `exchangePolicyFor` in the same module.
- `/api/me/grants` and `/api/me/scopes` through those policy functions.
- Skill visibility in `apps/weldall/src/server/skills/service.ts`, replacing its independent direct-email grant query.

Remote provider calls must run outside the repeatable-read database transaction currently used by token-exchange policy. Database reads may remain transactional after remote membership has been resolved.

## No server-side provider cache

The first version does not cache group lists, user lookups, user details, memberships, or final scope decisions on the server. This avoids cache invalidation and revocation-delay semantics. TanStack Query may retain administration-page query data in the browser according to the existing UI conventions; it is not used for authorization.

The authorization cost is bounded to two HTTP requests per enabled provider with assignments. If this later becomes a measured bottleneck, caching can be added behind the adapter without changing the generic contract, but it is not part of this implementation.

## Failure behavior

| Condition                                         | Result                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| Provider disabled                                 | No scopes from that provider                       |
| Group assignment deleted                          | No scopes from that assignment on the next DB read |
| Email lookup returns no user                      | No scopes from that provider                       |
| Email lookup returns multiple users               | No scopes from that provider; log an ambiguity     |
| Summary/detail identity mismatch                  | No scopes from that provider                       |
| Provider timeout or transport failure             | No scopes from that provider                       |
| Invalid JSON or relevant-field contract violation | No scopes from that provider                       |
| User inactive                                     | No scopes from that provider                       |
| Direct email assignment exists                    | Direct scopes remain effective                     |
| Another provider succeeds                         | Its scopes remain effective                        |

Errors returned to clients remain generic. Server logs include provider and group identifiers, status/error category, and request duration, but never credentials or raw response bodies.

## Provider credential storage

Add a deployment-owned `WELDALL_CREDENTIAL_ENCRYPTION_KEY` and use authenticated encryption such as AES-256-GCM.

The stored envelope contains an algorithm/version marker, key version, nonce, ciphertext, and authentication tag. Associated data binds the ciphertext to the provider ID and credential purpose.

Requirements:

- Token inputs are accepted only on provider create or explicit token replacement.
- An empty token during update preserves the current credential.
- Tokens and encrypted envelopes are omitted from DTOs, logs, audit metadata, exceptions, and test-connection responses.
- Provider list/detail responses expose only a boolean such as `hasToken`.
- Encryption-key rotation is represented by `encryptionKeyVersion`; implementing automated re-encryption may be deferred, but the storage format must not preclude it.
- Production initialization fails clearly if providers exist but the required key cannot decrypt their credentials.

## SSRF controls

Provider URLs cause Weldall to make authenticated server-side requests and therefore require stronger controls than downstream resource metadata.

- Normalize `baseUrl` to an HTTPS origin without credentials, path, query, or fragment.
- Allow administrators to configure any HTTPS hostname or IP address; there is no application-level hostname/address allowlist.
- Disable redirects.
- Apply short timeouts, response-size limits, JSON validation, and bounded concurrency.
- Apply network-level egress controls in production when a deployment needs to restrict reachable infrastructure.
- Never let administrators configure paths, query templates, methods, or arbitrary headers.
- Never include the token in URLs.

This deliberately treats Weldall administrators as trusted to choose provider destinations. Fixed paths, HTTPS, redirect refusal, and request bounds reduce accidental exposure, while deployment-level egress policy remains the mechanism for installations that require network restrictions.

## Administration API

Add tRPC routers under the existing `adminProcedure`.

### `admin.groupProviders`

- `list`
- `get`
- `create`
- `update`
- `test`
- `searchGroups`
- `getGroups`
- `delete`

Create/update use optimistic versions. `test`, `searchGroups`, and `getGroups` perform provider HTTP work outside database transactions. `searchGroups` accepts a fuzzy query and bounded result limit. `getGroups` accepts a bounded ID array and supports TanStack Query batching for selected values. Test results contain sanitized status, latency, and group count only.

Deletion fails with `CONFLICT` while group assignments reference the provider. Disabling a provider is permitted and immediately removes its group-derived grants on the next policy evaluation.

### `admin.groupAssignments`

- `list`
- `createMany`
- `replace`
- `delete`

`createMany` accepts one provider, one or more opaque group IDs, and one or more scope keys. It validates:

- The configured provider record exists; it may be disabled while assignments are staged.
- Group IDs satisfy local format and length limits.
- Scopes exist.
- No provider/group assignment already exists.
- Input limits are respected.

Creation performs no provider HTTP request. The transaction resolves the local provider and scopes and atomically creates all requested assignment rows and grants.

## Administration UI

### Group providers

Add a `Group providers` navigation item and page.

Provider list shows:

- Name and key.
- Adapter type.
- Base URL.
- Enabled state.
- Last update.
- Whether a credential is configured.

Create/edit dialog includes:

- Key on create only.
- Name.
- Base URL.
- Token as a password field.
- Enabled toggle.
- Test connection action.

The UI never receives an existing token value.

### Group assignments

Add a separate `Group assignments` navigation item and `/group-assignments` page. Keep `/assignments` dedicated to existing email assignments; do not combine the two assignment types into tabs.

Group-assignment creation uses one TanStack Form:

1. Select any configured provider, including a disabled provider.
2. Enter the opaque group ID directly.
3. Select scopes, including protected system scopes when required.
4. Save the assignment; the server remains authoritative for duplicate provider/group conflicts.

The batch-capable service API remains available, but the administration UI intentionally creates one group assignment at a time.

The table shows provider, opaque group ID, scopes, and update time. Group names are not persisted; the provider and group ID form the stable assignment identity.

## Audit events

Add strict audit event types and metadata schemas:

- `group_provider.created`
- `group_provider.updated`
- `group_provider.deleted`
- `group_provider.tested`
- `group_scopes.created`
- `group_scopes.replaced`
- `group_scopes.deleted`

Provider audit metadata includes provider key, adapter type, normalized base URL, enabled state, version, and whether the credential changed. It never includes credential material.

Group-assignment metadata includes provider ID/key, opaque group ID, before/after scopes, added/removed scopes, source, and versions.

Update both:

- `apps/weldall/src/lib/audit.ts` and `apps/weldall/src/server/audit/service.ts`.
- The database audit-event type constraint in the new migration.

Authorization lookup failures should produce structured sanitized server logs. They should not create an audit row for every failed request in the first version because that can amplify an upstream outage into database load. Existing issued/denied ID-JAG audit events remain the authorization decision record.

## Validation and testing

### Provider adapter tests

- Correct fixed URLs, trailing slashes, query encoding, and `Token` header.
- `findUserByEmail` uses the `mail` query parameter.
- Selective group-list, group-detail, user-summary, and user-detail parsing tolerates unrelated fields but rejects missing or invalid relevant fields.
- Empty, unique, and ambiguous email lookup results.
- Summary/detail username and normalized-email consistency.
- Inactive and invalid-email users.
- Fuzzy group search and bounded batched `getGroups` behavior without a server cache.
- Timeouts, non-2xx responses, redirects, content type, and body limits.
- Token and response bodies are absent from errors/logging.
- Arbitrary HTTPS host/IP support and URL-shape validation.

### Administration service tests

- Provider CRUD, test, optimistic conflicts, disable, and restricted deletion.
- Write-only token behavior and replacement.
- Batch group assignment creation and rollback without provider connectivity.
- Unknown provider and scope rejection; group IDs remain opaque.
- Duplicate assignment conflict.
- System-scope create and replacement with complete audit metadata.
- Scope deletion versioning and auditing for group assignments.

### Policy tests

- Direct-only, group-only, and unioned scopes.
- Duplicate scope deduplication.
- Multiple groups and providers.
- Disabled provider.
- Inactive user or removed effective group.
- Empty, ambiguous, mismatched, unavailable, or malformed provider lookup fails closed while direct scopes remain.
- Every new ID-JAG decision performs a fresh provider lookup.
- Resource-scope intersection remains enforced.
- Skills use the same effective scopes as token exchange and resource discovery.
- Group-derived administration succeeds while live membership is valid and fails closed after revocation or provider failure.

### tRPC and browser tests

- Anonymous and non-admin access rejected.
- Same-origin/CSRF checks apply to all mutations.
- Provider token never appears in responses.
- Create/test/edit/disable provider flow.
- Create/edit/delete group assignment flow.
- Existing email-assignment browser coverage remains valid.

## Likely implementation locations

- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/<next>_group_provider_assignments/migration.sql`
- `apps/weldall/src/server/group-providers/types.ts`
- `apps/weldall/src/server/group-providers/management-api-v1.ts`
- `apps/weldall/src/server/group-providers/credentials.ts`
- `apps/weldall/src/server/group-providers/service.ts`
- `apps/weldall/src/server/policy/resources.ts`
- `apps/weldall/src/server/skills/service.ts`
- `apps/weldall/src/server/admin/service.ts`, or smaller provider/assignment admin services extracted from it
- `apps/weldall/src/server/trpc/router.ts`
- `apps/weldall/src/lib/audit.ts`
- `apps/weldall/src/server/audit/service.ts`
- `apps/weldall/src/app/(admin)/group-providers/*`
- `apps/weldall/src/app/(admin)/assignments/*`
- `apps/weldall/src/app/(admin)/group-assignments/*`
- `apps/weldall/src/app/_components/admin-frame.tsx`
- `.env.example`
- Focused unit, service, tRPC, policy, and browser tests

## Implementation sequence

1. Add the normalized provider types, `management-api-v1` adapter, credential encryption, SSRF controls, and focused unit tests.
2. Add the database migration and provider administration service/tRPC APIs with audit events.
3. Add group-assignment service/tRPC APIs, optimistic concurrency, scope deletion handling, and tests.
4. Add the uncached email-to-user-to-groups authorization lookup and centralize effective-scope resolution across resources, token exchange, grants, and skills.
5. Add separate group-provider and group-assignment pages; assignment creation uses configured providers and direct opaque group-ID input.
6. Add browser coverage, deployment configuration, and operational documentation.

## Acceptance criteria

- Existing email assignments continue to pass their current tests without data migration.
- Administrators can register and test a generic `management-api-v1` provider without any deployment/vendor name appearing in source or UI.
- Administrators can select any configured provider, enter one opaque group ID, and select scopes through a TanStack Form without provider connectivity; the server rejects duplicate assignments.
- An active provider user receives the sorted union of direct and matching group scopes in resource discovery, token exchange, `/api/me/grants`, `/api/me/scopes`, and skill visibility.
- Removing effective group membership stops group-derived grants on the next ID-JAG decision; an already-issued access token remains valid for its existing ten-minute lifetime.
- Provider outages or malformed responses never create provider-derived grants, while direct grants remain effective.
- Group assignments can grant registered protected system scopes, including `weldall:administer` and `weldall:login`, with live fail-closed provider evaluation.
- At least one verified direct-email administrator remains protected by existing final-admin logic.
- Provider tokens are encrypted at rest and absent from API responses, logs, audits, and errors.
- Provider requests accept any administrator-configured HTTPS origin while remaining limited to fixed contract paths, redirect refusal, and bounded requests.
- Provider and group-assignment mutations are versioned and audited.
- Authorization performs no server-side provider-response or membership caching.

## Confirmed review decisions

- Resolve users through `users/?mail=<email>`, then use `users/<username>/` and its `groups` array as the effective membership source.
- Validate only relevant provider fields with selective Zod schemas and tolerate unrelated response fields.
- Do not cache provider responses or memberships on the server.
- Do not restrict provider destinations with an application-level hostname allowlist.
- Store provider tokens encrypted in the database.
- Put provider configuration and group assignments on separate pages; keep existing email assignments on their current page.
