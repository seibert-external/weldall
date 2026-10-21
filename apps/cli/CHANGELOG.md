# @weldall/cli

## 0.22.0

### Minor Changes

- 04837c5: Add optional native MCP serving with existing DPoP authentication and explicit discovery/operation scopes. Unify bounded resource, connector-type, query and skill discovery behind the CLI, with session-local extension publication, explicit account continuation and additive whole-source dependencies. Preserve HTTP and shipped exact-tool dependency semantics. Include the Expenses reference resource with native tools/resources, a whole-resource review skill, matching development seed, and user/machine authorization tests. Load the native MCP runtime lazily to preserve standalone startup under the pinned Bun compiler. Cache native discovery metadata in bounded server memory for 60 seconds and validated catalogs in owner-only CLI files for five minutes, while retaining live authorization and revision checks. Add native MCP Apps: a TypeScript resource helper with source-bound asset CSP, native-only UI metadata transport, session-local UI references, and a sanitized Expenses view. Add HTML injection and framework-independent browser exports for sizing and configurable fullscreen/PiP. Public same-origin ES modules require an enforced display-only or resource-bound bridge. Add per-view tool allowlists, a browser call helper and host-bound extension dispatch with live authorization; unsupported clients fail closed. Expose typed browser APIs for chat messages, future-turn model context, own-resource listing/reads, external links, user-confirmed downloads, logs, display/lifecycle events and capability-aware sampling. The desktop wires supported host actions without dropping source isolation, scope checks or the network sandbox; model actions triggered by chat are distinct from direct allowlisted UI calls. The Expenses UI demonstrates non-persistent approve/deny previews. Provider inline code, connector Apps and cross-resource UI calls remain unsupported. This remains development work: Task 1's parity, performance, installed-host/next-model and real-pilot acceptance gates must close before release; no minimum published version is claimed.

### Patch Changes

- 04837c5: Preserve the existing macOS Keychain item during token refresh and profile updates, avoiding session loss when an update fails or is interrupted. Keep explicit login ownership migration and separate npm/standalone credential namespaces unchanged.

## 0.21.1

### Patch Changes

- 166a650: Accept all three supported BigQuery scopes in Google connector IaC configuration and the manifest JSON schema, fixing validation of imported connectors.

## 0.21.0

### Minor Changes

- 65e5205: Add Atlassian MCP connections, private DPoP broker APIs, CLI/SDK access and skill-dependency activation. Credentials remain server-side; calls are not retried automatically. Deploy the matching migrations/server before updating clients. Configuration, authorization, host compatibility and limitations are documented in the MCP reference.
- 65e5205: Add public-only IaC configuration/import for shared connections and group/login providers, with UI-only credentials, disabled drafts and plan-bound login-authority approval. Preserve credentials during import and protect the last active login provider. Back up the database and deploy migrations with the matching server before updating clients. An unfinished sign-in from before the upgrade must be started again; existing sessions remain valid.

### Patch Changes

- 65e5205: Add scope-shared Atlassian service-account connections with UI-only encrypted keys, stable identifiers and live user/machine authorization. Personal OAuth remains owner-only. SDK calls use DPoP, enforce bounds and do not retry automatically.

## 0.20.1

### Patch Changes

- 7a3caa8: Open the server-hosted completion page after a successful browser login.
- 07ea2fe: Add the standalone `@weldall/goose` stdio MCP package with skill search, catalog browsing, skill documents, connections, and separate read/write tools. It delegates to the local Weldall binary in PATH without shipping binaries or handling credentials. It uses the existing JSON commands and returns bounded, ANSI-cleaned stderr diagnostics with exit codes.

  Advertise reference-free input schemas for Goose Code Mode while retaining strict runtime JSON validation. Include connection IDs, connector enabled state, requested/granted scopes and optional details in `list_connections`, avoiding a separate shell inspection while preserving pagination and explicit field filtering.

  Teach Goose to map CLI examples in unchanged skill documents to MCP calls, including method/body/header flags, connection selection and explicit unsupported-operation boundaries. Keep routine internal details out of user-facing responses; explain account choices and access problems in plain language without hiding failures or uncertainty. This is agent guidance, not enforcement over other host tools.

  Add `organizationInstructions` to CLI `status --json`: the live text, an empty string when unconfigured, or null when loading fails. Load this field before MCP startup and include it unchanged in the host prompt. Preserve organization-specific discovery/routing rules while mapping CLI syntax to MCP calls. Older CLIs without the field and unavailable/malformed context fail visibly rather than starting without organization context; an updated local CLI is required.

  Stock-Goose acceptance and npm/MCP Registry publication are separate release gates; the White-Label client is unchanged.

## 0.20.0

### Minor Changes

- e364eda: Make connector discovery show which providers are connected and point human and agent output to provider-specific usage hints. Remove the specialized offset-pagination options from `weldall request`; callers now follow each provider's pagination instructions with explicit requests.

### Patch Changes

- 667628f: Keep managed connections usable when an upstream endpoint rejects a request with HTTP 401, add safe Atlassian diagnostics, and support selectable granular scopes for every Jira, Jira Software, Jira Service Management, and Confluence route accepted by the connector.

## 0.19.0

### Minor Changes

- 5bf763c: Add Atlassian Cloud connectors for Jira and Confluence, with mandatory site allowlists, resource-level OAuth setup, and rotating offline credentials. Support Atlassian connector policy in IaC and provider-owned site metadata in connection details. Show provider-generated request examples and pagination guidance in human, JSON, and agent-oriented CLI output. Allow local cancellation cleanup when a provider does not support remote revocation, with an explicit warning.

## 0.18.0

### Minor Changes

- eecb200: Support OpenBao Transit envelope encryption for managed connectors and accept OPENBAO in declarative manifests. Keep OpenBao availability scoped to credential operations rather than administration or startup.

## 0.17.0

### Minor Changes

- 0d18dd8: Add owner-managed Google connections for Gmail and Calendar, with encrypted server-side credential storage, administrator configuration through the UI and IaC, and CLI commands to connect, inspect, reconnect, disconnect, and proxy requests through Weldall.

  Existing CLI workflows, including connector-free IaC, remain compatible with servers that do not support connectors. Connector commands and connector IaC declarations require the updated server.

## 0.16.0

### Minor Changes

- a8111a1: Add `--agentic` to `scopes`, `skills show`, and `skills find`, alongside `skills list`, and produce every `--agentic` payload with the format's reference encoder, `@toon-format/toon`, in place of the CLI's own. The output is TOON: `scopes` declares the assigned scopes inline and one row per resource, `skills show` writes one object and drops the duplicated skill body along with the fields an agent does not act on, and `skills find` writes a table of exactly what the local cache holds. As on `skills list`, the shape is not a contract and `--json` cannot be combined with it.

## 0.15.0

### Minor Changes

- 6c10a61: Hide the IaC commands (`init`, `validate`, `plan`, `up`, `import`, `unmanage`, `state`) from `weldall --help` and the bare `weldall` output unless a machine client is configured. They authenticate with `WELDALL_M2M_*`, so a browser login alone never makes them usable. The commands stay runnable while hidden.

### Patch Changes

- 80344af: Remove test-only credential, preferences, browser, HTTP bridge, and runtime hooks from published npm and standalone CLI artifacts. E2E coverage now uses explicitly instrumented test builds instead.

## 0.14.1

### Patch Changes

- 47b60d1: Keep standalone credentials separate from npm sessions and update the signed binary instructions.

## 0.14.0

### Minor Changes

- 9c2b3a7: Add `weldall skills list --agentic`, a TOON rendering of the visible catalog for agents to read. The header declares the row count, so an agent that reads a truncated catalog can tell. The shape is deliberately unstable and is not a substitute for `--json`.

## 0.13.0

### Minor Changes

- 12af225: Store the saved session through the operating system's credential service in-process on every runtime, including the standalone macOS executable, which previously went through `/usr/bin/security`. On macOS the keychain item is now created by the CLI itself, so only the Weldall executable can read it without a prompt; the standalone build is re-signed after compiling so the darwin-x64 executable gets a valid code identity too. After upgrading from an npm install or an older standalone build on macOS, run `weldall login` once more.

### Patch Changes

- 1358d09: Sign the macOS standalone executables with the Seibert Developer ID certificate and notarize them with Apple in the release workflow. Gatekeeper now runs a downloaded `weldall` binary without a warning, so the `xattr -d com.apple.quarantine` step is gone from the install instructions, and the saved session stays readable across CLI upgrades because the keychain trusts the signing identity rather than one specific build.

## 0.12.0

### Minor Changes

- f5fb616: Improve agent skill discovery and knowledge-base search steering. The CLI now caches and searches skill catalog previews, handles multi-word queries by ranking term overlap, and gives actionable fallback guidance when no cached skill matches. The Starlight integration now centers excerpts on literal query matches and lets site owners customize the generated search skill's opening discovery description.

## 0.11.2

### Patch Changes

- 1932dd0: Include the failed response body in `weldall request` errors: field errors from the facade (for example `sort: Invalid option: expected one of asc|desc`) now reach the agent instead of a bare `failed with HTTP 400` status line.

## 0.11.1

### Patch Changes

- f96499e: Add a once-daily, stderr-only notice when a newer `@weldall/cli` version is available, with the upgrade command matching your install method (npm or standalone).

## 0.11.0

### Minor Changes

- 4f9a993: Make help strictly local, cache validated discovery and signing keys, reuse verified access sessions, prepare resource authorization once per process, add bounded offset pagination with JSON Lines output, and add cached skill search and positional skill aliases.

## 0.10.0

### Minor Changes

- 2ae041c: Support the optional `skills.meta.appearance` field in skill catalogs and IaC manifests, with validation for its string record shape.

## 0.9.1

### Patch Changes

- d987bcd: Display assigned scopes directly in CLI access output instead of replacing them with potentially misleading permission descriptions.

## 0.9.0

### Minor Changes

- 16b8064: Add complete Ubuntu, macOS, and Windows CLI support plus self-contained standalone release assets. Initial standalone assets are unsigned and should be verified with the published SHA-256 checksums.

## 0.8.0

### Minor Changes

- 43587f9: Add native Weldall YAML infrastructure-as-code commands for scopes, resources, machine clients, administrator-managed skills, and assignments, with committed lockfile state, atomic planning/apply workflows, and Linux packaging with optional macOS Keychain support.

## 0.7.0

### Minor Changes

- 6aaeaa2: Add native Weldall YAML infrastructure-as-code commands, committed lockfile state, atomic planning/apply workflows, and Linux packaging with optional macOS Keychain support.

## 0.6.0

### Minor Changes

- 4c89941: Render human-facing CLI output with Ink using bordered, color-coded account, access, skill, configuration, notice, and help panels. Root help stacks the Weldall account, organization instructions, and capped scope and skill previews while preserving plain machine-readable output.

## 0.5.0

### Minor Changes

- 27eddb1: Add authenticated resource skill publication, persisted Weldall discovery, source metadata, partial catalog warnings, and extensible skill visibility values.

### Patch Changes

- e33b4e0: Show only API names in the status output's available APIs section.

## 0.4.1

### Patch Changes

- 62f4673: Require explicit approval for every native CLI login, make cross-process credential locking race-safe, and preserve rotated refresh credentials before follow-up validation.

  Harden SDK error responses, authorization-server metadata, replay classification, request-target matching, and published security guidance.

## 0.4.0

### Minor Changes

- 97a3552: Carry Weldall-verified email claims through ID-JAG exchange into downstream access tokens and expose them in the SDK authentication context.
- 0edef3d: Add streaming raw and multipart file uploads plus binary-safe, atomic response downloads to `weldall request`.

## 0.3.0

### Minor Changes

- 27ac58e: Render compact framed CLI context, cache administrator instructions, and distinguish all assigned scopes from permissions exposed by enabled APIs.

## 0.2.1

### Patch Changes

- aa7d279: Replace the animated CLI header with a centered Weldall wordmark and agent-focused introduction.

## 0.2.0

### Minor Changes

- f4c413e: Publish the macOS CLI through npm as @weldall/cli.
