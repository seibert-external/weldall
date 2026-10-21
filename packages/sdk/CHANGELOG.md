# @weldall/sdk

## 0.12.1

### Patch Changes

- 12fa865: Preserve MCP App connectDomains in the bundled CLI validation schema so fetch-based PDF.js views work end to end. Keep object embeds blocked and remove obsolete object-origin forwarding; legacy objectDomains options remain accepted but ignored. Add a regression for connection metadata through authenticated native CLI reads.

## 0.12.0

### Minor Changes

- 22c772f: Allow MCP App resources to declare validated CSP `connectDomains` and `objectDomains` for direct browser network access and embeds.

## 0.11.0

### Minor Changes

- 04837c5: Add optional native MCP serving with existing DPoP authentication and explicit discovery/operation scopes. Unify bounded resource, connector-type, query and skill discovery behind the CLI, with session-local extension publication, explicit account continuation and additive whole-source dependencies. Preserve HTTP and shipped exact-tool dependency semantics. Include the Expenses reference resource with native tools/resources, a whole-resource review skill, matching development seed, and user/machine authorization tests. Load the native MCP runtime lazily to preserve standalone startup under the pinned Bun compiler. Cache native discovery metadata in bounded server memory for 60 seconds and validated catalogs in owner-only CLI files for five minutes, while retaining live authorization and revision checks. Add native MCP Apps: a TypeScript resource helper with source-bound asset CSP, native-only UI metadata transport, session-local UI references, and a sanitized Expenses view. Add HTML injection and framework-independent browser exports for sizing and configurable fullscreen/PiP. Public same-origin ES modules require an enforced display-only or resource-bound bridge. Add per-view tool allowlists, a browser call helper and host-bound extension dispatch with live authorization; unsupported clients fail closed. Expose typed browser APIs for chat messages, future-turn model context, own-resource listing/reads, external links, user-confirmed downloads, logs, display/lifecycle events and capability-aware sampling. The desktop wires supported host actions without dropping source isolation, scope checks or the network sandbox; model actions triggered by chat are distinct from direct allowlisted UI calls. The Expenses UI demonstrates non-persistent approve/deny previews. Provider inline code, connector Apps and cross-resource UI calls remain unsupported. This remains development work: Task 1's parity, performance, installed-host/next-model and real-pilot acceptance gates must close before release; no minimum published version is claimed.

## 0.10.0

### Minor Changes

- 65e5205: Add Atlassian MCP connections, private DPoP broker APIs, CLI/SDK access and skill-dependency activation. Credentials remain server-side; calls are not retried automatically. Deploy the matching migrations/server before updating clients. Configuration, authorization, host compatibility and limitations are documented in the MCP reference.
- 65e5205: Add scope-shared Atlassian service-account connections with UI-only encrypted keys, stable identifiers and live user/machine authorization. Personal OAuth remains owner-only. SDK calls use DPoP, enforce bounds and do not retry automatically.

## Unreleased

- Add a bounded, non-retrying DPoP MCP client for shared connections, with connector/connection discovery, tools, resources, calls and reads.

## 0.9.0

### Minor Changes

- f5fb616: Improve agent skill discovery and knowledge-base search steering. The CLI now caches and searches skill catalog previews, handles multi-word queries by ranking term overlap, and gives actionable fallback guidance when no cached skill matches. The Starlight integration now centers excerpts on literal query matches and lets site owners customize the generated search skill's opening discovery description.

## 0.8.0

### Minor Changes

- 9e737d9: Extend `@weldall/sdk/starlight` with a protected `GET /api/content` endpoint (configurable via `contentPath`, default `/api/content`) that returns full page markdown as `{ path, title, description, content, subject }`, with raw bodies persisted to `.weldall-search/documents.json` at build and copied into the build output. Also allow site owners to customize the generated `search` skill via `weldallSearch(host, { skills: { search: { title?, content?, extraRules? } } })`, with overrides persisted to `.weldall-search/config.json`. The generated skill now documents both the search and page-read commands and their response shapes.

## 0.7.0

### Minor Changes

- 34d9797: Add `@weldall/sdk/starlight`: a Starlight/Astro integration that exposes a Weldall-SDK-authenticated full-text search endpoint (`/api/search`) over the site's own MDX content. It indexes the content at build time with configurable language-specific Orama stemming and stop-word removal, protects the endpoint with DPoP + a `search:read`-style scope, and publishes a skill catalog so Weldall auto-discovers the `search` skill. The interface mirrors `initWeldall(host, options)`. Orama and gray-matter are optional peer dependencies, loaded lazily, so the core SDK footprint is unchanged.

## 0.6.0

### Minor Changes

- 2ae041c: Support the optional `skills.meta.appearance` field in skill catalogs and IaC manifests, with validation for its string record shape.

## 0.5.0

### Minor Changes

- ac4d043: Allow resource servers to retrieve Weldall authorization-server metadata and signing keys through a dedicated discovery proxy while retaining canonical issuer validation.

## 0.4.0

### Minor Changes

- 2b79697: Add private-key machine client credentials with independent resource/scope access selection and DPoP-bound target verification.

## 0.3.0

### Minor Changes

- 27eddb1: Add authenticated resource skill publication, persisted Weldall discovery, source metadata, partial catalog warnings, and extensible skill visibility values.

## 0.2.1

### Patch Changes

- 62f4673: Require explicit approval for every native CLI login, make cross-process credential locking race-safe, and preserve rotated refresh credentials before follow-up validation.

  Harden SDK error responses, authorization-server metadata, replay classification, request-target matching, and published security guidance.

## 0.2.0

### Minor Changes

- 97a3552: Carry Weldall-verified email claims through ID-JAG exchange into downstream access tokens and expose them in the SDK authentication context.

## 0.1.0

### Minor Changes

- 3971089: Publish the framework-neutral Weldall resource-server SDK with Hono, Next.js, and Astro adapters.
