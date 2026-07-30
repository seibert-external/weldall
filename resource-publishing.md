# Automatic Skill Discovery from Resource Servers

## Status

Planned.

## Decision summary

Weldall will aggregate skills from two trusted sources:

1.  manually maintained administrator skills stored in PostgreSQL;
2.  skill catalogs published by explicitly approved resource servers.

A publishing resource is the **source of instructions**, not the authorization boundary or necessarily the target of those instructions. A published skill may orchestrate requests across multiple registered resources.

Resource catalogs and discovered skill documents are persisted in PostgreSQL:

- due catalogs are refreshed every 10 minutes;
- user-facing skill requests read persisted data and never depend on an in-process cache;
- Next.js `after()` schedules non-blocking refresh work on Docker;
- database leases deduplicate refreshes across requests and processes;
- failed refreshes are logged, stored as safe resource-level status, and preserve the last known valid catalog for up to 24 hours;
- administrators can inspect discovered skills and refresh health, and can enable or disable discovery per resource.

No backwards compatibility is required for the existing skill API or CLI response schema.

## Existing architecture

Weldall currently has:

- a database-backed global scope registry;
- many-to-many mappings from global scopes to downstream resources;
- a database-backed manual Skill Registry;
- an authenticated `/api/me/skills` API;
- a publishable resource-server SDK for Fetch, Hono, Next.js, and Astro;
- RFC 9728 protected-resource metadata published by resource servers;
- Weldall authorization-server metadata and JWKS;
- a PostgreSQL deployment and a Docker-hosted Next.js process where `after()` is available.

The global scope model already supports one scope on several resources:

```text
contracts:manage
  ├── contracts
  ├── signatures
  └── archive
```

A user grant for contracts:manage can therefore authorize requests to every active resource which explicitly supports that scope.

## Goals

- Automatically discover skills from approved resource servers.
- Keep manual administrator-authored skills.
- Allow resource-published skills to orchestrate multiple resources.
- Preserve global scope semantics above individual resources.
- Authenticate Weldall when it reads protected resource catalogs.
- Avoid sending user identities or grants to catalog publishers.
- Persist discovered catalogs and skill documents in PostgreSQL.
- Refresh due catalogs every 10 minutes without blocking user-facing requests.
- Keep resource failures isolated, logged, persisted as safe status, and observable in the admin UI.
- Let administrators enable or disable discovery independently for each resource.
- Preserve the Resource Registry and target services as authorization boundaries.
- Support catalog publication through every @weldall/sdk adapter.

## Non-goals

- Automatically registering resources.
- Automatically creating scopes or user grants.
- Deriving scopes or target resources from Markdown.
- Treating a skill catalog as authorization policy.
- Executing JavaScript, MDX, or resource-provided code.
- Keeping an in-memory catalog cache.
- Allowing resource publishers to edit manual administrator skills.
- Replacing per-request Resource Registry validation in the CLI.
- Supporting arbitrary cross-origin catalog endpoints in the MVP.

## Terminology

### Skill publisher

A trusted source which publishes agent-readable instructions.

Initially, publishers are explicitly approved DownstreamResource records. The implementation should internally use a neutral source abstraction so standalone orchestration or capability servers can be supported later.

```ts
interface SkillCatalogSource {
  key: string;
  name: string;
  resourceIdentifier: string;
  authorizationServer: string;
  metadataUrl: string;
}
```

### Execution target

A registered resource selected by the complete URL passed to weldall request.

The publisher and execution target are independent. One publisher may document operations involving several execution targets.

### Global scope

A lowercase namespace:permission value validated by the existing scope-key schema:

```regex
  ^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$
```

Examples:

```text
  contracts:manage
  contracts:read
  marketing.events:publish
```

Skill IDs use dots, while scopes require a colon:

```text
  Skill ID: contracts.manage
  Scope:    contracts:manage
```

## Trust model

Registering an API resource must not implicitly allow that server to inject agent instructions.

DownstreamResource receives an explicit field:

```text
  skillDiscoveryEnabled Boolean @default(false)
```

Only resources satisfying both conditions are queried:

```text
  enabled = true
  skillDiscoveryEnabled = true
```

This field is controlled by Weldall administrators and audited through normal resource create/update events.

A resource which merely advertises a catalog endpoint does not become trusted until the administrator enables discovery.

Resource-published Markdown is trusted instructional content, but it remains non-authoritative:

1.  Weldall filters skill visibility using current global grants.
2.  The CLI resolves every request URL against the live Resource Registry.
3.  The selected target resource must support every requested scope.
4.  Weldall only exchanges scopes currently granted to the user.
5.  The target service validates token audience, scopes, and DPoP.
6.  Catalog contents cannot extend these authorization boundaries.

## Discovery through protected-resource metadata

Catalog discovery belongs in RFC 9728 protected-resource metadata because it describes a capability of the resource server. It does not belong in OpenID Provider metadata.

The SDK adds an extension member when skills are configured:

```json
{
  "resource": "https://contracts.example.com/api",
  "authorization_servers": ["https://contracts.example.com"],
  "scopes_supported": ["contracts:manage"],
  "weldall_skills_endpoint": "https://contracts.example.com/.well-known/weldall-skills"
}
```

Unknown extension members are permitted in OAuth metadata.

Weldall derives the RFC 9728 metadata URL from the registered resourceIdentifier. For example:

```text
  Resource:
  https://contracts.example.com/api

  Metadata:
  https://contracts.example.com/.well-known/oauth-protected-resource/api
```

### Metadata validation

Weldall requires:

- HTTPS;
- no credentials or fragment;
- no redirects;
- a bounded request timeout;
- a bounded response size;
- JSON content type;
- exact resource equality with the registered resource identifier;
- the configured authorization server in authorization_servers;
- a single valid weldall_skills_endpoint;
- the catalog endpoint on the same origin as the resource identifier;
- no catalog endpoint credentials, query, or fragment.

Invalid metadata does not replace a previously valid persisted catalog.

Production deployments must continue to enforce appropriate network-egress policy. Same-origin validation prevents metadata from redirecting Weldall to arbitrary destinations but does not replace infrastructure-level SSRF controls for administrator-registered
internal hosts.

## Catalog endpoint authentication

The catalog endpoint is not public. Weldall authenticates with a short-lived signed service assertion.

Example:

```http
  GET /.well-known/weldall-skills HTTP/1.1
  Accept: application/json
  Authorization: Bearer <signed-assertion>
```

The assertion uses Weldall’s existing ES256 signing key published through Weldall authorization-server discovery and JWKS.

### Protected header

```json
{
  "alg": "ES256",
  "kid": "<current-weldall-key-id>",
  "typ": "weldall-skills+jwt"
}
```

### Claims

```json
{
  "iss": "https://weldall.example.com",
  "sub": "https://weldall.example.com",
  "aud": "https://contracts.example.com/.well-known/weldall-skills",
  "resource": "https://contracts.example.com/api",
  "purpose": "skills:read",
  "iat": 1770000000,
  "exp": 1770000060,
  "jti": "<unique-id>"
}
```

Requirements:

- exact Weldall issuer;
- exact endpoint audience;
- exact resource identifier;
- exact purpose;
- maximum lifetime of 60 seconds;
- bounded clock tolerance;
- unique, bounded jti;
- exact JWT type and ES256 algorithm;
- key selected from Weldall’s safely discovered JWKS.

The SDK consumes jti through the configured ReplayStore. Replay-store failures fail closed.

This is a dedicated signed service assertion, not an end-user token and not a private_key_jwt token-endpoint authentication request. No user ID, email, grants, access token, refresh token, or DPoP key is sent to the publisher.

Strict typ, audience, purpose, and resource checks provide protocol separation even though the existing Weldall signing key is reused.

## Catalog format

The resource returns one complete catalog:

```json
{
  "schemaVersion": 1,
  "resource": "https://contracts.example.com/api",
  "skills": [
    {
      "id": "manage",
      "title": "Manage contracts",
      "requiredScopes": ["contracts:manage"],
      "visibility": "DEFAULT",
      "content": "# Manage contracts\n\n..."
    }
  ]
}
```

The response uses:

```http
  Content-Type: application/json
  Cache-Control: private, no-store
```

Weldall persists catalogs in PostgreSQL and does not rely on intermediary HTTP caches.

### Catalog limits

Recommended limits:

- at most 100 skills per catalog;
- at most 1 MiB for the complete response;
- local skill ID at most 120 characters;
- title between 1 and 200 characters;
- Markdown content between 1 and 100,000 characters;
- at most 100 required scopes per skill;
- no duplicate IDs;
- no duplicate scopes;
- no unknown top-level or skill fields in schema version 1.

Local resource skill IDs use:

```regex
  ^[a-z0-9]+(?:[_-][a-z0-9]+)*$
```

Dots are reserved for publisher namespacing.

### Canonical IDs

Weldall creates the user-facing canonical ID:

```text
  <publisher-key>.<local-skill-id>
```

Example:

```text
  Publisher: contracts
  Local ID:  manage
  Canonical: contracts.manage
```

Publisher namespacing identifies the source and prevents collisions between resource catalogs. It does not imply that the skill can only call its publisher.

The combined canonical ID has a bounded length and is treated as an opaque identifier by the CLI.

## Multi-resource skills

A publisher may require any non-system global scope, whether or not that scope is supported by the publishing resource.

Example catalog entry:

```json
{
  "id": "manage",
  "title": "Manage contracts",
  "requiredScopes": ["contracts:manage"],
  "visibility": "HIDDEN_IF_UNALLOWED",
  "content": "# Manage contracts\n\nUse the Contracts, Signatures, and Archive APIs..."
}
```

Its instructions may contain:

```sh
  weldall request \
    --scope contracts:manage \
    https://contracts.example.com/api/contracts/123

  weldall request \
    --method POST \
    --scope contracts:manage \
    https://signatures.example.com/api/signing-jobs

  weldall request \
    --method POST \
    --scope contracts:manage \
    https://archive.example.com/api/contracts/123
```

Each request is resolved independently:

```text
  URL → active registered resource
      → resource supports contracts:manage
      → user possesses contracts:manage
      → token exchange
      → DPoP-protected target request
```

The MVP does not require a resourcesUsed declaration. Such metadata would duplicate the URLs in the instructions and could drift. It may be added later for diagnostics, but it must never become authorization policy.

## Scope validation

Resource catalog scopes are interpreted as global scope keys.

A remote skill is eligible only when:

- every scope has valid namespace:permission syntax;
- every scope exists in Weldall’s global Scope Registry;
- no required scope is a protected system scope.

Required scopes do not need to belong to or be supported by the publisher.

Unknown global scopes do not get created automatically. Structurally valid skills are persisted exactly as published, but skills with unknown or protected system scopes are filtered out when user-facing APIs read them. Scope validity is derived from the live Scope Registry rather than stored as quarantine state, so registering a previously unknown scope activates the persisted skill without another resource fetch.

The admin UI computes and displays unknown or protected scope warnings on discovered skill rows. These conditions are also logged using scope keys and publisher identifiers without logging skill content. Development seeds include a discovered skill with a syntactically valid unknown scope so this state remains visible and testable.

## Manual skills and override behavior

The existing administrator Skill Registry remains the source for manual skills.

Manual and discovered skills are merged by canonical ID. A manual skill wins an exact collision:

```text
  Resource skill: contracts.manage
  Manual skill:   contracts.manage
  Result:         manual skill
```

This enables administrators to deliberately replace or customize publisher instructions without mutating the resource catalog.

The admin interface continues to edit only manual skills. Resource-published skills are read-only in Weldall and must be changed at their publisher.

The user-facing API reports the source:

```json
{
  "source": {
    "type": "resource",
    "key": "contracts",
    "name": "Contracts"
  }
}
```

or:

```json
{
  "source": {
    "type": "admin"
  }
}
```

An override should produce an operational log or admin-visible indicator so administrators can identify shadowed resource skills.

## Visibility

Visibility continues to use the user’s current effective global scopes.

The Boolean `hidden` field is replaced everywhere—manual skills, published catalogs, database records, API contracts, CLI validation, and admin forms—with an extensible `visibility` enum. Schema version 1 defines:

```text
DEFAULT
HIDDEN_IF_UNALLOWED
```

`requiredScopes` remains an AND-set:

- all scopes present: the skill is available;
- missing scopes with `visibility: DEFAULT`: the skill remains visible and reports missing scopes;
- missing scopes with `visibility: HIDDEN_IF_UNALLOWED`: the skill is omitted.

Visibility is evaluated after manual and resource skills are merged. Scope evaluation is performed for every user request; persisted catalogs never contain user-specific grants or visibility decisions.

## Persistence and refresh design

PostgreSQL is the only catalog store. No process-memory catalog cache is introduced. User-facing reads load the last valid persisted snapshot, while refresh work writes a replacement snapshot transactionally.

### Persisted state

Each resource has at most one `DiscoveredSkillCatalog` containing:

- the resource ID and resource version used for the successful fetch;
- the validated metadata and catalog endpoint needed for diagnostics;
- `lastAttemptAt`, `lastSuccessfulRefreshAt`, `nextRefreshAt`, and `staleAfter`;
- a bounded refresh lease (`refreshLeaseUntil`) for database-backed deduplication;
- retry/backoff state;
- the latest safe failure category and timestamp;
- normalized `DiscoveredSkill` rows containing local/canonical ID, title, Markdown content, required scopes, and visibility.

The last failure is operational state, not catalog content. It is cleared on success. Response bodies, assertions, tokens, secrets, and raw exceptions are never persisted.

### Timing and scheduling

- successful catalogs become due for refresh after 10 minutes;
- persisted last-known-good data may be served for at most 24 hours after its last successful refresh;
- catalog fetch timeout is initially 5 seconds;
- failures use bounded exponential backoff capped at 10 minutes;
- enabling discovery schedules an immediate first refresh;
- user-facing list/detail requests may schedule due refreshes with Next.js `after()`, but always answer from PostgreSQL without waiting for network I/O.

```ts
import { after } from "next/server";

after(() => refreshDueCatalogs());
```

A deployment/startup refresh sweep also claims due resources, so refresh does not depend on a particular skill being requested. The refresh service remains framework-neutral; only scheduling is supplied by Next.js.

### Database-backed refresh coordination

Before network I/O, a worker atomically claims a resource whose `nextRefreshAt` is due and whose lease is absent or expired. This prevents concurrent requests or future application instances from fetching the same source simultaneously. The lease is time-bounded so a crashed worker cannot block later refreshes.

Refresh concurrency across different publishers is bounded. Once metadata and the complete catalog pass structural validation, one transaction replaces that resource’s discovered skill rows and updates the successful-refresh fields. Readers observe either the old complete snapshot or the new complete snapshot, never a partial catalog.

### Cold source

Until the first refresh succeeds, no discovered skills exist for that source. APIs return other persisted/manual skills and a safe `catalog_pending` or `catalog_temporarily_unavailable` warning. They do not perform a blocking fetch. Admin pages show the pending or failed state and the latest attempt.

### Failed refresh

A malformed response, authentication error, timeout, network error, or metadata error:

- emits a structured failure log for every failed attempt;
- persists a safe failure category and timestamp on the resource catalog status;
- does not overwrite or delete the last valid discovered skills;
- advances `nextRefreshAt` according to backoff;
- continues serving the last valid rows until the 24-hour maximum age.

After the maximum stale age, user-facing APIs omit the discovered skills until a successful refresh. The admin UI continues showing the persisted rows as expired together with failure status for diagnosis.

### Disablement and resource changes

A resource is immediately excluded from user-facing discovered skills when it is deleted, disabled, or has `skillDiscoveryEnabled = false`. Persisted discovered rows are retained for administration instead of being used as an implicit cache:

- resource and skill admin views show them read-only and visibly disabled;
- no refresh is scheduled while discovery or the resource is disabled;
- re-enabling discovery schedules an immediate refresh;
- a resource identity/version change makes the previous snapshot ineligible and schedules a replacement;
- deleting the resource cascades its catalog and discovered skill rows.

PostgreSQL-backed state and leases also make catalog visibility and refresh coordination consistent in a future multi-instance deployment; no separate shared cache design is required.

## Weldall API

The existing skill API changes to an envelope so partial discovery can be communicated explicitly.

### List

```http
  GET /api/me/skills
```

Example:

```json
{
  "items": [
    {
      "id": "contracts.manage",
      "title": "Manage contracts",
      "requiredScopes": ["contracts:manage"],
      "visibility": "HIDDEN_IF_UNALLOWED",
      "available": true,
      "missingScopes": [],
      "source": {
        "type": "resource",
        "key": "contracts",
        "name": "Contracts"
      }
    }
  ],
  "warnings": [
    {
      "source": "archive",
      "code": "catalog_temporarily_unavailable"
    }
  ]
}
```

Warnings contain no endpoint response body, token, assertion, or internal exception.

A stale but usable persisted source does not block the response. The API may expose a machine-readable stale status for diagnostics.

### Detail

```http
  GET /api/me/skills/{skillId}
```

The response additionally contains:

- raw Markdown content;
- the composed document including normalized frontmatter.

If a canonical resource skill cannot be resolved because its source has no successful persisted catalog yet, return `503 temporarily_unavailable`, not 404.

If the source has a usable persisted catalog and the skill does not exist or is hidden by `HIDDEN_IF_UNALLOWED`, return 404.

Both endpoints remain protected by the existing DPoP-bound Weldall access-token mechanism.

## CLI behavior

Commands remain conceptually:

```sh
  weldall skills
  weldall skills show contracts.manage
```

The CLI is updated for the new envelope and source metadata.

Friendly output continues to show canonical ID, title, and availability. Partial discovery warnings are written to stderr without exposing internal details.

--json returns the complete API structure, including sources and warnings.

Terminal sanitization continues to apply to all resource-provided titles, identifiers, warnings, and Markdown.

No local CLI catalog cache is introduced; PostgreSQL remains the authoritative discovered catalog store.

## SDK API

@weldall/sdk adds a typed skill provider.

Suggested shape:

```ts
const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://contracts.example.com/api",
  publicOrigin: "https://contracts.example.com",
  clientId: "weldall-cli-at-contracts",
  supportedScopes: ["contracts:manage"],
  signingKey,
  replayStore,
  skills: {
    load: async () => [
      {
        id: "manage",
        title: "Manage contracts",
        requiredScopes: ["contracts:manage"],
        visibility: "HIDDEN_IF_UNALLOWED",
        content: "# Manage contracts\n\n...",
      },
    ],
  },
});
```

The provider callback receives no user or request identity. Catalog publication must be the same for every authenticated Weldall instance using that resource configuration.

A static helper may also be provided:

```ts
  skills: {
    items: [...]
  }
```

### Core handlers

Add:

```ts
weldall.handlers.skills;
```

Responsibilities:

1.  require GET;
2.  reconstruct and use the configured public endpoint URL;
3.  require exactly one Bearer assertion;
4.  verify Weldall discovery and JWKS safely;
5.  verify JWT header and claims;
6.  consume the assertion jti;
7.  call the configured provider;
8.  validate the generated catalog;
9.  return a bounded no-store JSON response.

When no skill provider is configured:

- protected-resource metadata omits weldall_skills_endpoint;
- direct invocation of the handler returns 404.

### Hono

registerRoutes() automatically mounts:

```text
  GET /.well-known/weldall-skills
```

### Next.js

Applications mount:

```ts
// app/.well-known/weldall-skills/route.ts
import { weldall } from "@/weldall";

export const runtime = "nodejs";
export const GET = weldall.handlers.skills;
```

### Astro

Applications mount an endpoint adapter matching the existing metadata and token-handler patterns.

### Discovery refactoring

The existing SDK JWKS discovery currently specializes key lookup for ID-JAG JWTs. Refactor it into a safe generic Weldall signing-key lookup used by both:

- ID-JAG validation;
- skill-fetch assertion validation.

Protocol-specific callers remain responsible for exact typ, claim, audience, and error semantics.

## Database and admin changes

### Prisma

Add persisted catalog models and replace the existing manual-skill Boolean with the shared enum:

```prisma
  enum SkillVisibility {
    DEFAULT
    HIDDEN_IF_UNALLOWED
  }

  model Skill {
    // existing fields
    visibility SkillVisibility @default(DEFAULT)
  }

  model DownstreamResource {
    // existing fields
    skillDiscoveryEnabled Boolean                  @default(false)
    discoveredCatalog     DiscoveredSkillCatalog?
  }

  model DiscoveredSkillCatalog {
    id                      String            @id @default(cuid())
    resourceId              String            @unique
    sourceResourceVersion   Int?
    schemaVersion           Int?
    metadataUrl             String?
    catalogEndpoint         String?
    lastAttemptAt           DateTime?
    lastSuccessfulRefreshAt DateTime?
    nextRefreshAt           DateTime
    staleAfter              DateTime?
    refreshLeaseUntil       DateTime?
    retryCount              Int               @default(0)
    lastFailureCategory     String?
    lastFailureAt           DateTime?
    createdAt               DateTime          @default(now())
    updatedAt               DateTime          @updatedAt
    resource                DownstreamResource @relation(fields: [resourceId], references: [id], onDelete: Cascade)
    skills                  DiscoveredSkill[]

    @@index([nextRefreshAt, refreshLeaseUntil])
  }

  model DiscoveredSkill {
    id             String          @id @default(cuid())
    catalogId      String
    localId        String
    canonicalId    String
    title          String
    content        String
    requiredScopes String[]        @default([])
    visibility     SkillVisibility @default(DEFAULT)
    createdAt      DateTime        @default(now())
    updatedAt      DateTime        @updatedAt
    catalog        DiscoveredSkillCatalog @relation(fields: [catalogId], references: [id], onDelete: Cascade)

    @@unique([catalogId, localId])
    @@unique([canonicalId])
    @@index([catalogId])
  }
```

Exact field names may follow repository conventions, but the separation is required: catalog refresh state belongs to the resource-level catalog, while complete discovered documents belong to child rows. Unknown-scope status is deliberately not persisted.

### Migration and seeds

Because the project is greenfield, squash the existing migration chain and this schema change into one fresh baseline rather than adding another incremental migration. The baseline contains schema only, not environment-specific sample data.

Deployment data and development examples are separated:

- production deployments either run no seed or an idempotent production-safe seed containing only mandatory system records;
- development setup runs an explicit development seed after the production-safe seed;
- sample resources, scopes, grants, manual skills, and discovered catalogs live only in the development seed;
- the development seed includes a persisted discovered skill requiring a syntactically valid but unregistered scope, so the admin warning and user-facing filtering paths are reproducible.

Add distinct package scripts so deploy automation cannot accidentally run development seeds. Document that recreating the greenfield database is required after the migration squash.

### Resource administration

The resource create/edit form receives:

```text
  Discover skills from this resource
```

The control explains that enabling it trusts the resource to provide agent instructions which may involve other registered resources. Resource tables show enabled/disabled discovery status plus catalog health. Changes use existing optimistic locking and resource audit events; audit metadata includes the before/after value of `skillDiscoveryEnabled`.

The resource detail view shows:

- whether discovery is enabled;
- pending, fresh, stale, expired, or failed refresh state;
- last attempt and last successful refresh;
- the safe latest failure category and timestamp;
- discovered skill count.

When discovery is disabled, persisted catalog and skill rows remain visible but are clearly marked disabled and are excluded from user-facing APIs.

### Skill administration

The Skill Registry becomes a combined operational view:

- manual skills remain editable and are labeled `Manual`;
- resource-published skills are read-only and link to their publisher resource;
- discovered rows show canonical ID, visibility, freshness, discovery-disabled state, unknown/protected scope warnings, and manual-override status;
- details show persisted Markdown and required scopes without allowing edits;
- unknown/protected scope warnings are computed by joining against the current Scope Registry, not stored on discovered rows.

This discovered-skill visibility is required for initial delivery, not deferred follow-up work.

## Failure semantics

Failures are isolated per publisher.

| Condition            | Persisted catalog         | Behavior                                       |
| -------------------- | ------------------------- | ---------------------------------------------- |
| First success        | None                      | Atomically persist and serve discovered skills |
| First failure        | None                      | Log/store failure; omit source with warning    |
| Fresh                | Valid                     | Read from PostgreSQL immediately               |
| Due                  | Valid, under 24h          | Read persisted rows and schedule refresh       |
| Refresh failure      | Valid, under 24h          | Log/store failure, keep rows, and back off     |
| Expired              | Older than 24h            | Admin sees rows; user API omits with warning   |
| Invalid new catalog  | Valid previous            | Keep previous rows transactionally             |
| Discovery disabled   | Retained, marked disabled | Admin sees rows; user API excludes source      |
| Resource disabled    | Retained, marked disabled | Admin sees rows; user API excludes source      |
| Unknown global scope | Valid                     | Persist; filter on read and flag in admin UI   |
| Manual collision     | Both valid                | Manual skill wins; admin UI flags override     |

A failure in one publisher must not prevent manual skills or other valid publishers from being returned.

## Security requirements

- Catalog discovery is disabled unless explicitly approved by an administrator.
- Catalog endpoints are restricted to the registered resource origin.
- Weldall never follows discovery or catalog redirects.
- All network operations have timeouts and response-size limits.
- Catalog assertions are short-lived, audience-bound, resource-bound, purpose-bound, and replay-protected.
- JWT algorithm, type, key ID, issuer, audience, timestamps, purpose, resource, and jti are validated strictly.
- User identities and grants are never sent during catalog discovery.
- Catalog responses cannot create scopes, grants, resources, or request prefixes.
- Resource-published skills requiring Weldall system scopes are never returned by user-facing APIs.
- Markdown is never executed or rendered as MDX.
- CLI output is terminal-sanitized.
- Resource request prefixes remain authoritative for outbound requests.
- Target services remain authoritative for token, scope, audience, and DPoP validation.
- Tokens, assertions, Markdown, endpoint response bodies, and secrets are not logged.
- Logs contain only source IDs, safe categories, durations, counts, and freshness state.
- Invalid refreshes never replace last-known-good data.
- Persisted catalog state never contains user-specific authorization decisions.

## Observability

Emit structured events or logs for:

- initial catalog refresh succeeded/failed;
- scheduled catalog refresh succeeded/failed;
- invalid metadata;
- invalid catalog;
- assertion rejection at the SDK endpoint;
- unknown/protected scope filtering;
- catalog stale and catalog expired;
- manual override collision.

Suggested fields:

```text
  publisherId
  publisherKey
  resourceVersion
  failureCategory
  durationMs
  skillCount
  freshness
  lastSuccessfulRefreshAt
  nextRefreshAt
```

Do not log catalog content or signed assertions.

## Implementation phases

### Phase 1: Protocol and shared types

- Define protected-resource metadata extension.
- Define catalog schema, `SkillVisibility`, and validation limits.
- Replace Boolean `hidden` contracts with `DEFAULT | HIDDEN_IF_UNALLOWED` across shared types.
- Define signed assertion header and claims.
- Define canonical skill ID rules.
- Add shared SDK types and validators.
- Refactor safe JWKS lookup for multiple JWT protocols.

### Phase 2: SDK publication

- Add static and async skill-provider options.
- Add metadata advertisement.
- Add signed-assertion verification.
- Add replay consumption.
- Add the catalog handler.
- Mount the route through Hono.
- Add Next.js and Astro adapters/examples.
- Document trust and deployment requirements.

### Phase 3: Database, seeds, and resource trust configuration

- Add `skillDiscoveryEnabled`, `SkillVisibility`, `DiscoveredSkillCatalog`, and `DiscoveredSkill`.
- Replace manual skill `hidden` with `visibility`.
- Squash the greenfield migrations into one schema-only baseline.
- Separate optional production-safe and explicit development seed commands.
- Seed the unknown-scope discovered-skill case only for development.
- Update resource DTOs, validation, create/update service, and audit metadata.
- Update admin forms and resource table; keep discovery disabled by default.

### Phase 4: Weldall discovery client

- Derive and fetch RFC 9728 metadata.
- Validate resource and authorization-server identity.
- Validate same-origin catalog endpoint.
- Issue short-lived signed assertions.
- Fetch and structurally validate catalogs.
- Add bounded concurrency, timeouts, body limits, and safe errors.

### Phase 5: PostgreSQL persistence and refresh

- Persist complete normalized catalogs and resource-level refresh state.
- Atomically replace discovered rows only after full validation.
- Claim due refreshes with bounded database leases.
- Implement the 10-minute refresh interval and 24-hour maximum serving age.
- Implement bounded refresh concurrency and retry backoff.
- Trigger immediate refresh when discovery is enabled.
- Run due-refresh sweeps at deployment/startup and inject Next.js `after()` scheduling from request/admin handlers.
- Preserve and visibly disable rows for disabled discovery/resources; cascade rows only when a resource is deleted.
- Emit structured logs and persist safe status for every failed fetch.

### Phase 6: Aggregation and visibility

- Load manual skills and approved publishers.
- Merge resource catalogs by canonical ID.
- Apply manual override precedence.
- Validate required scopes against the current global registry.
- Filter unknown and system scopes dynamically at read time and expose computed admin warnings.
- Evaluate user visibility with current effective scopes.
- Compose normalized Markdown documents.
- Return source and partial-result metadata.

### Phase 7: API and CLI

- Change list API to the envelope response.
- Add source, visibility, freshness, and warning structures.
- Update detail lookup and failure distinction.
- Update CLI validators and output.
- Print partial warnings safely.
- Preserve terminal sanitization.

### Phase 8: Reference implementation and documentation

- Publish an Expenses skill through apps/expenses.
- Demonstrate a multi-resource contracts-style skill in tests or examples.
- Retain admin-created skills as override examples.
- Add the required read-only discovered-skill and resource refresh-status admin views.
- Document production-safe versus development-only seeding.
- Update architecture, SDK, CLI, and security documentation.
- Add SDK and CLI changesets.

## Test plan

### Scope and identity

- contracts:manage is accepted.
- contracts.manage is rejected as a scope.
- canonical skill ID contracts.manage is accepted.
- required scopes may be unsupported by the publisher.
- required scopes may be supported by several target resources.
- unknown scopes remain persisted but are filtered from user APIs and flagged in admin UI.
- system scopes remain persisted but are filtered from user APIs and flagged in admin UI.
- registering an unknown scope activates the persisted skill without another fetch.

### Metadata discovery

- correct RFC 9728 metadata URL is derived.
- exact resource identity succeeds.
- mismatched resource fails.
- missing configured authorization server fails.
- missing extension means no catalog.
- cross-origin endpoint fails.
- credentials, query, fragment, HTTP, and redirects fail.
- timeout and oversized metadata fail safely.

### Assertion verification

- valid assertion succeeds.
- missing assertion fails.
- duplicate authorization fails.
- wrong algorithm, type, key ID, issuer, audience, resource, purpose, or subject fails.
- expired or excessively long assertion fails.
- replayed jti fails.
- JWKS rotation refreshes safely.
- discovery/JWKS outage fails closed.
- no user information appears in the assertion.

### Catalog validation

- valid static catalog succeeds.
- valid async provider succeeds.
- duplicate IDs fail.
- duplicate scopes fail.
- malformed IDs fail.
- invalid scope syntax fails.
- oversized documents and catalogs fail.
- wrong resource fails.
- unknown fields or schema versions fail.
- invalid refresh preserves previous valid data.

### Persistence and refresh

Use PostgreSQL, a fake clock, and injected fetch/scheduler:

- user-facing reads never require an in-process cache or blocking network fetch.
- enabling discovery creates pending status and schedules the first refresh.
- concurrent workers acquire only one database refresh lease per resource.
- expired leases can be reclaimed after worker failure.
- fresh reads do not schedule a fetch.
- a catalog becomes due after 10 minutes and schedules non-blocking refresh.
- startup/deployment sweeps refresh due catalogs without a user request.
- successful refresh atomically replaces all discovered rows and status.
- readers never observe a partially replaced catalog.
- failed refresh emits a structured log, persists safe failure status, and preserves prior rows.
- retry backoff prevents request storms.
- user APIs stop serving rows 24 hours after the last success while admin APIs still display them as expired.
- resource identity/version change makes old rows ineligible and schedules refresh.
- resource or discovery disable retains rows, marks them disabled in admin UI, excludes them from user APIs, and stops refreshes.
- resource deletion cascades catalog and skill rows.
- no token, assertion, response body, Markdown, or raw exception is persisted in refresh status.

### Aggregation

- manual-only catalog works.
- resource-only catalog works.
- several publishers merge deterministically.
- publisher namespaces prevent cross-resource collisions.
- manual exact-ID collision wins.
- source metadata is correct.
- both visibility enum values use effective global grants with the documented behavior.
- a multi-resource skill is visible from one global grant.
- partial publisher failure does not remove valid sources.
- detail lookup for a source without a successful persisted catalog returns temporary unavailability rather than false not-found.
- unknown/protected scope status is computed at read time and shown only to administrators.

### SDK adapters

For Fetch, Hono, Next.js, and Astro:

- metadata advertises the endpoint only when configured.
- the endpoint can be mounted correctly.
- valid assertion returns a catalog.
- invalid assertion produces consistent rejection.
- server-only code does not enter client bundles.
- package tarballs include the new types and handlers.

### End-to-end

- Expenses publishes at least one resource skill.
- Weldall refreshes and persists its catalog in PostgreSQL.
- the CLI lists and displays the persisted skill.
- a manual skill with the same canonical ID overrides it.
- resource skill changes appear after the persisted refresh without restarting Weldall.
- due persisted results return while Docker schedules refresh with `after()`.
- disabling skill discovery immediately removes the resource skill from user APIs while retaining a visibly disabled admin record.
- development seeding exposes an unknown-scope discovered skill in admin UI and filters it from user APIs.
- a multi-resource skill performs requests against two resources using one global scope.
- each target independently rejects the request if it does not support that scope.

## Acceptance criteria

- Administrators can explicitly enable or disable skill discovery per resource.
- Approved resources advertise and serve authenticated skill catalogs through the SDK.
- Weldall authenticates with a short-lived ES256 assertion validated through its public JWKS.
- Catalog requests contain no user identity or grants.
- Resource-published skills may require any registered non-system global scope.
- Skills may document operations across multiple resources.
- Scope keys continue to enforce lowercase namespace:permission.
- Every outbound CLI request still validates the selected target resource and its supported scopes.
- Manual skills remain editable and override exact discovered IDs.
- Manual and published skills use `DEFAULT | HIDDEN_IF_UNALLOWED` instead of a Boolean `hidden` field.
- Discovered catalogs and complete skill documents are stored in PostgreSQL; no process-memory catalog cache exists.
- Catalogs become due every 10 minutes and are refreshed through database-coordinated work scheduled with `after()` and startup/deployment sweeps.
- Failed fetches are structurally logged, visible as safe resource-level status in the admin UI, and preserve last-known-good catalogs for at most 24 hours.
- Administrators can inspect read-only discovered skills, freshness, failures, overrides, and dynamically computed unknown/protected scope warnings.
- Disabling discovery or a resource excludes persisted skills from user APIs without hiding them from administrators.
- Greenfield migrations are squashed; deployment-safe and development-only seeds are separate, and the development seed covers the unknown-scope case.
- Fetch, Hono, Next.js, and Astro SDK integrations expose the same protocol.
- The Expenses reference app demonstrates automatic skill publication.
- Security, persistence/refresh, adapter, CLI, admin UI, seed, and end-to-end tests cover successful and rejected behavior.

## Follow-up work

- Standalone skill publishers not tied to execution resources.
- Conditional requests using ETag or catalog revisions.
- Manual refresh controls and retained refresh-attempt history beyond the latest safe status.
- Publisher ownership and delegated publisher administration.
- Optional diagnostic declarations of resources used by a skill.
- Signed catalog responses for deployments requiring authenticity beyond TLS.
- Standardization of the protected-resource metadata extension.
