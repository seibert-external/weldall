# @weldall/weldall

## 0.7.1

### Patch Changes

- Updated dependencies [22c772f]
  - @weldall/sdk@0.12.0

## 0.7.0

### Minor Changes

- 04837c5: Add optional native MCP serving with existing DPoP authentication and explicit discovery/operation scopes. Unify bounded resource, connector-type, query and skill discovery behind the CLI, with session-local extension publication, explicit account continuation and additive whole-source dependencies. Preserve HTTP and shipped exact-tool dependency semantics. Include the Expenses reference resource with native tools/resources, a whole-resource review skill, matching development seed, and user/machine authorization tests. Load the native MCP runtime lazily to preserve standalone startup under the pinned Bun compiler. Cache native discovery metadata in bounded server memory for 60 seconds and validated catalogs in owner-only CLI files for five minutes, while retaining live authorization and revision checks. Add native MCP Apps: a TypeScript resource helper with source-bound asset CSP, native-only UI metadata transport, session-local UI references, and a sanitized Expenses view. Add HTML injection and framework-independent browser exports for sizing and configurable fullscreen/PiP. Public same-origin ES modules require an enforced display-only or resource-bound bridge. Add per-view tool allowlists, a browser call helper and host-bound extension dispatch with live authorization; unsupported clients fail closed. Expose typed browser APIs for chat messages, future-turn model context, own-resource listing/reads, external links, user-confirmed downloads, logs, display/lifecycle events and capability-aware sampling. The desktop wires supported host actions without dropping source isolation, scope checks or the network sandbox; model actions triggered by chat are distinct from direct allowlisted UI calls. The Expenses UI demonstrates non-persistent approve/deny previews. Provider inline code, connector Apps and cross-resource UI calls remain unsupported. This remains development work: Task 1's parity, performance, installed-host/next-model and real-pilot acceptance gates must close before release; no minimum published version is claimed.

### Patch Changes

- 42dab21: Cache validated MCP tool catalogs in bounded process-local memory for five minutes. Warm discovery avoids upstream sessions and warm calls skip repeated tool listing, while retaining live authorization, quotas, audit checks and fresh invocation sessions. Add safe phase timings and independently cancellable shared discovery.
- Updated dependencies [04837c5]
  - @weldall/sdk@0.11.0

## 0.6.0

### Minor Changes

- 65e5205: Add Atlassian MCP connections, private DPoP broker APIs, CLI/SDK access and skill-dependency activation. Credentials remain server-side; calls are not retried automatically. Deploy the matching migrations/server before updating clients. Configuration, authorization, host compatibility and limitations are documented in the MCP reference.
- 65e5205: Add public-only IaC configuration/import for shared connections and group/login providers, with UI-only credentials, disabled drafts and plan-bound login-authority approval. Preserve credentials during import and protect the last active login provider. Back up the database and deploy migrations with the matching server before updating clients. An unfinished sign-in from before the upgrade must be started again; existing sessions remain valid.
- 65e5205: Add scope-shared Atlassian service-account connections with UI-only encrypted keys, stable identifiers and live user/machine authorization. Personal OAuth remains owner-only. SDK calls use DPoP, enforce bounds and do not retry automatically.

### Patch Changes

- Updated dependencies [65e5205]
- Updated dependencies [65e5205]
  - @weldall/sdk@0.10.0

## 0.5.3

### Patch Changes

- 7a3caa8: Improve account connection setup and OAuth completion pages with provider branding, collapsible permission selection, and styled result states.

## 0.5.2

### Patch Changes

- 667628f: Keep managed connections usable when an upstream endpoint rejects a request with HTTP 401, add safe Atlassian diagnostics, and support selectable granular scopes for every Jira, Jira Software, Jira Service Management, and Confluence route accepted by the connector.

## 0.5.1

### Patch Changes

- aa02432: Publish the Weldall server as a Docker image. Each `@weldall/weldall` release is now built, tested against a clean PostgreSQL, and published to Docker Hub as `x.y.z`, `x.y`, `latest` and the commit SHA.

## 0.5.0

### Minor Changes

- 5bf763c: Add Atlassian Cloud connectors for Jira and Confluence, with mandatory site allowlists, resource-level OAuth setup, and rotating offline credentials. Support Atlassian connector policy in IaC and provider-owned site metadata in connection details. Show provider-generated request examples and pagination guidance in human, JSON, and agent-oriented CLI output. Allow local cancellation cleanup when a provider does not support remote revocation, with an explicit warning.

## 0.4.0

### Minor Changes

- be0d54f: Add a read-only `/statistics` page for anyone holding the new system scope `weldall:statistics`. It shows org-wide usage over the last 24 hours, 7, 30 or 90 days: active people with the change from the previous period, token exchanges by resource, the people who retrieved each skill and the number of machine clients. `weldall:administer` does not include the scope, and the page remembers the last interval in a cookie.

## 0.3.0

### Minor Changes

- eecb200: Support OpenBao Transit envelope encryption for managed connectors and accept OPENBAO in declarative manifests. Keep OpenBao availability scoped to credential operations rather than administration or startup.

## 0.2.0

### Minor Changes

- 0d18dd8: Add owner-managed Google connections for Gmail and Calendar, with encrypted server-side credential storage, administrator configuration through the UI and IaC, and CLI commands to connect, inspect, reconnect, disconnect, and proxy requests through Weldall.

  Existing CLI workflows, including connector-free IaC, remain compatible with servers that do not support connectors. Connector commands and connector IaC declarations require the updated server.

## 0.1.0

### Minor Changes

- 3d7f7b7: Version the Weldall server as a release unit. The app stays private on npm; `changeset publish` creates a `@weldall/weldall@x.y.z` Git tag and GitHub release, and the Docker image release builds from that tag.
