# @weldall/goose

## 0.2.0

### Minor Changes

- 07ea2fe: Add the standalone `@weldall/goose` stdio MCP package with skill search, catalog browsing, skill documents, connections, and separate read/write tools. It delegates to the local Weldall binary in PATH without shipping binaries or handling credentials. It uses the existing JSON commands and returns bounded, ANSI-cleaned stderr diagnostics with exit codes.

  Advertise reference-free input schemas for Goose Code Mode while retaining strict runtime JSON validation. Include connection IDs, connector enabled state, requested/granted scopes and optional details in `list_connections`, avoiding a separate shell inspection while preserving pagination and explicit field filtering.

  Teach Goose to map CLI examples in unchanged skill documents to MCP calls, including method/body/header flags, connection selection and explicit unsupported-operation boundaries. Keep routine internal details out of user-facing responses; explain account choices and access problems in plain language without hiding failures or uncertainty. This is agent guidance, not enforcement over other host tools.

  Add `organizationInstructions` to CLI `status --json`: the live text, an empty string when unconfigured, or null when loading fails. Load this field before MCP startup and include it unchanged in the host prompt. Preserve organization-specific discovery/routing rules while mapping CLI syntax to MCP calls. Older CLIs without the field and unavailable/malformed context fail visibly rather than starting without organization context; an updated local CLI is required.

  Stock-Goose acceptance and npm/MCP Registry publication are separate release gates; the White-Label client is unchanged.
