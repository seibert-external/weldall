# Weldall for Goose

Use Weldall skills and connected services in Goose through a local stdio MCP extension.

## Requirements

- Node.js 22.15 or newer.
- The local Weldall binary in PATH, logged in and supporting `organizationInstructions` in `weldall status --json`.

## Setup

Add a **Command-Line Extension** in Goose with a 300-second timeout:

```sh
npx -y @weldall/goose@0.1.0
```

Keep Code Mode disabled in Goose 1.51 so organization instructions reach the model.

## Skill-driven remote MCP tools

With an MCP-capable Weldall server and CLI, loading a skill activates its declared remote tools and optional resources. The six stable tools remain unchanged. A single compatible READY connection is selected automatically; multiple accounts require an explicit user choice using the dynamically advertised `select_mcp_connection` tool. Account binding cannot change during the session, and the model cannot substitute the skill's declared tools.

MCP activation requires explicit `capabilities: ["mcp"]` on both the connector catalog entry and selected connection; it never infers support from provider names. `list_connections` also exposes capabilities when supplied by the server. Older shipped HTTP-only responses may omit that metadata, but cannot activate MCP tools.

Skills declare MCP dependencies by `connectorKey`; there is no separate MCP-server primitive. Activated tool names use `mcp_<connector-key hash>__upstreamName` to keep namespaces distinct and bounded. Use the advertised names. Resource URIs are session-local `weldall-mcp://` entries, not URLs to fetch directly. The extension emits tool/resource list-change notifications and delegates every invocation to the local CLI; the server reauthorizes each request. Failed calls are never retried automatically.

Use a Goose version that handles list-change notifications. The packed smoke exercises dynamic activation and resources through a fake CLI, not an installed Stock Goose application or live Atlassian consent. Those remain manual release-acceptance gates. Update server, CLI and extension together before using this feature; no white-label client changes are included.

## Textual response content types

The `get` and `send` tools normally parse text and JSON responses automatically. For an endpoint
documented to return textual bytes with another content type, such as Gmail's `multipart/mixed`
batch response, set `responseMode` to `text`. The response is returned inline under the extension's
existing output limits. Binary downloads and saving responses to local files remain unsupported.
