# @weldall/goose

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
