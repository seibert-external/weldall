# @weldall/goose

## 0.4.3

### Patch Changes

- 12fa865: Preserve MCP App connectDomains in the bundled CLI validation schema so fetch-based PDF.js views work end to end. Keep object embeds blocked and remove obsolete object-origin forwarding; legacy objectDomains options remain accepted but ignored. Add a regression for connection metadata through authenticated native CLI reads.

## 0.4.2

### Patch Changes

- ab6b77e: Use focused integration discovery with activation as the default entry point when supported by the local CLI. Reuse active tools, reserve catalog-only discovery for explicit catalog requests, and retain the skill-search workflow for older CLIs.

## 0.4.1

### Patch Changes

- 1244f7a: Preserve validated MCP App connection and object CSP domains when Goose re-sanitizes native UI resources.

## 0.4.0

### Minor Changes

- 04837c5: Add optional native MCP serving with existing DPoP authentication and explicit discovery/operation scopes. Unify bounded resource, connector-type, query and skill discovery behind the CLI, with session-local extension publication, explicit account continuation and additive whole-source dependencies. Preserve HTTP and shipped exact-tool dependency semantics. Include the Expenses reference resource with native tools/resources, a whole-resource review skill, matching development seed, and user/machine authorization tests. Load the native MCP runtime lazily to preserve standalone startup under the pinned Bun compiler. Cache native discovery metadata in bounded server memory for 60 seconds and validated catalogs in owner-only CLI files for five minutes, while retaining live authorization and revision checks. Add native MCP Apps: a TypeScript resource helper with source-bound asset CSP, native-only UI metadata transport, session-local UI references, and a sanitized Expenses view. Add HTML injection and framework-independent browser exports for sizing and configurable fullscreen/PiP. Public same-origin ES modules require an enforced display-only or resource-bound bridge. Add per-view tool allowlists, a browser call helper and host-bound extension dispatch with live authorization; unsupported clients fail closed. Expose typed browser APIs for chat messages, future-turn model context, own-resource listing/reads, external links, user-confirmed downloads, logs, display/lifecycle events and capability-aware sampling. The desktop wires supported host actions without dropping source isolation, scope checks or the network sandbox; model actions triggered by chat are distinct from direct allowlisted UI calls. The Expenses UI demonstrates non-persistent approve/deny previews. Provider inline code, connector Apps and cross-resource UI calls remain unsupported. This remains development work: Task 1's parity, performance, installed-host/next-model and real-pilot acceptance gates must close before release; no minimum published version is claimed.

## 0.3.0

### Minor Changes

- 65e5205: Add Atlassian MCP connections, private DPoP broker APIs, CLI/SDK access and skill-dependency activation. Credentials remain server-side; calls are not retried automatically. Deploy the matching migrations/server before updating clients. Configuration, authorization, host compatibility and limitations are documented in the MCP reference.

### Patch Changes

- 65e5205: Add scope-shared Atlassian service-account connections with UI-only encrypted keys, stable identifiers and live user/machine authorization. Personal OAuth remains owner-only. SDK calls use DPoP, enforce bounds and do not retry automatically.

## 0.2.1

### Patch Changes

- 9aa34ee: Add an explicit text response mode for bounded textual responses with content types such as `multipart/mixed`, allowing Gmail batch results to be returned inline without enabling binary downloads or file output.

## 0.2.0

### Minor Changes

- 07ea2fe: Add the standalone `@weldall/goose` stdio MCP package with skill search, catalog browsing, skill documents, connections, and separate read/write tools. It delegates to the local Weldall binary in PATH without shipping binaries or handling credentials. It uses the existing JSON commands and returns bounded, ANSI-cleaned stderr diagnostics with exit codes.

  Advertise reference-free input schemas for Goose Code Mode while retaining strict runtime JSON validation. Include connection IDs, connector enabled state, requested/granted scopes and optional details in `list_connections`, avoiding a separate shell inspection while preserving pagination and explicit field filtering.

  Teach Goose to map CLI examples in unchanged skill documents to MCP calls, including method/body/header flags, connection selection and explicit unsupported-operation boundaries. Keep routine internal details out of user-facing responses; explain account choices and access problems in plain language without hiding failures or uncertainty. This is agent guidance, not enforcement over other host tools.

  Add `organizationInstructions` to CLI `status --json`: the live text, an empty string when unconfigured, or null when loading fails. Load this field before MCP startup and include it unchanged in the host prompt. Preserve organization-specific discovery/routing rules while mapping CLI syntax to MCP calls. Older CLIs without the field and unavailable/malformed context fail visibly rather than starting without organization context; an updated local CLI is required.

  Stock-Goose acceptance and npm/MCP Registry publication are separate release gates; the White-Label client is unchanged.
