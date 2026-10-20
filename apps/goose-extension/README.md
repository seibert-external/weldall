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

## Shared discovery (development branch)

When the local CLI explicitly advertises `nativeDiscoveryVersion: 1` in `status --json`,
the extension exposes `discover_integrations({ resources: ["expenses"], connectorTypes:
["atlassian-mcp"], skills: ["expenses.review"] })`, or `{ query: "expenses" }`. It resolves through
the CLI and atomically publishes each successful source’s tools and ordinary resources, then
emits list-change notifications before returning instructions/outcomes. `catalogOnly: true`
does not activate. Ambiguity uses `select_mcp_connection` with an explicitly chosen offered ID.
`read_skill_document` uses this same resolver and reports incomplete dependencies.

Repeat a selection to refresh its catalog. `{ remove: ["resource:expenses", "connector:work"] }`
removes live handlers without forgetting the session’s account choice; removal cannot enable a
silent account switch. A detected identity/origin change clears old routes and requires fresh
discovery. Identical concurrent discovery coalesces; cancelling one waiter does not cancel others.

Discovered tools use readable names such as `native_list_expenses_<12-hex-suffix>` and
`mcp_search_<12-hex-suffix>`. The suffix distinguishes the source, identity, route and original
tool name; readable parts are sanitized and shortened to keep the full `weldall__`-prefixed
Goose name within 64 characters. Always use the advertised name rather than constructing one.

Bindings contain only routing metadata. Calls use the exact resource identity, catalog revision,
Weldall origin and principal; unknown names/URIs cannot establish routes. A new activation instance
starts empty, and a discovered identity/origin change invalidates the previous maps. Native
permission checks still happen at the resource; this is not a credential store.

Use the CLI and extension built from this branch for the preview. Older CLIs keep the existing
skill workflow and do not receive an unsupported discovery command. Existing connector skills
retain their exact selected tools unless an explicit whole-source selection broadens them.
New-form skills require a capable CLI/server and are rejected by older parsers, not silently
reported as fully activated.

The in-memory MCP tests verify notification ordering and immediate tool-list refresh. Stock
Goose, the white-label adapter, Code Mode and packaged-host behavior still need manual acceptance;
do not infer host/model refresh guarantees from the protocol tests alone.

## Textual response content types

The `get` and `send` tools normally parse text and JSON responses automatically. For an endpoint
documented to return textual bytes with another content type, such as Gmail's `multipart/mixed`
batch response, set `responseMode` to `text`. The response is returned inline under the extension's
existing output limits. Binary downloads and saving responses to local files remain unsupported.
