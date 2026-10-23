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

For capable CLIs, the default workflow starts with focused discovery and activation, including
capability questions, unless organization instructions require another workflow. Already active
tools are reused directly; no preliminary skill search is needed. Reserve `catalogOnly: true` for
explicit catalog-only overviews without activation. Activation never authorizes writes. Older CLIs
retain the search-skills-first workflow.

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

## Native resource MCP Apps (development branch)

Native tools may reference an HTML/CSS view in `_meta.ui.resourceUri`. The extension checks that
the view exists in that source's catalog, preserves a source/session-local `ui://` URI, and routes
resource reads through the existing direct CLI path. Connector/connection UI metadata is still
stripped. Hosts without MCP Apps support continue to receive normal text tool results.

Before returning native UI HTML to Goose, the extension applies the SDK's HTML sanitizer
and restrictive document CSP. This covers text and base64 content, even when the provider changes
the MIME type. Assets remain bound to the registered resource origin; validated provider CSP connection
domains are forwarded into the second sanitizer pass. Objects stay blocked: use PDF.js/fetch/canvas,
not PDF plugins. CLI 0.22.1 or newer is required for `connectDomains`; 0.22.0 strips that metadata.
Provider inline code is removed and replaced with the SDK\'s CSP-hashed display bootstrap. Public
ES modules load only after a compatible host advertises `weldall/app-bridge`,
`weldall/display-only` or `weldall/resource-tool-calls` (version 1).
A catalog-level `_meta.ui.allowedTools` opts a view into calls to named tools of that same registered resource.
Every registered native HTML view receives an opaque handle for its own resource access, even when
its tool allowlist is empty. The extension generates the handle; provider metadata/HTML cannot supply it.

The host keeps the handle out of the iframe and injects it into `call_resource_ui_tool`, an app-only
dispatcher hidden from the model. Every tool dispatch checks the current resource binding and allowlist,
then uses the existing CLI issuer/subject/revision/resource guards and live scope authorization.
The app-only `read_resource_ui_resource` dispatcher lists the bound catalog (no URI) or reads a known
upstream URI of that exact binding. Foreign/local-routed URIs and caller-supplied routing are rejected.
UI-initiated reads never mint or expose new host handles.
At most 128 view handles are retained; evicted or replaced bindings require a fresh view read.
Native MCP calls are never retried. Goose's existing Auto-mode requirement remains in force; no Rust changes
or general-purpose App permission changes are needed.

Ordinary UI-linked tools remain model-only. The desktop enables chat, future-turn context, resource reads,
links, user-confirmed downloads, logs and lifecycle actions through the SDK. Direct discovery/connector/
foreign-resource calls and arbitrary HTTP fetching remain unavailable. Chat messages can trigger model
actions using any of the chat's tools: the UI allowlist does not constrain subsequent model actions.
Older extensions/clients have no usable resource binding and fail closed. Other Goose extensions retain
their existing bridge. See the SDK README for capability negotiation and host-specific limitations.

See [the Expenses demo](../expenses/README.md#show-the-demo-ui-in-goose) for the first UI.
Restart the branch extension after rebuilding. The MCP integration tests cover metadata and HTML
transport; actual iframe rendering in an installed Goose remains a separate acceptance check.

## Textual response content types

The `get` and `send` tools normally parse text and JSON responses automatically. For an endpoint
documented to return textual bytes with another content type, such as Gmail's `multipart/mixed`
batch response, set `responseMode` to `text`. The response is returned inline under the extension's
existing output limits. Binary downloads and saving responses to local files remain unsupported.

## Request retries and managed connections

The `get` tool may retry a read after HTTP 429, 502, 503 or 504 with bounded backoff. The `send`
tool is never retried, including when a skill documents POST as a repeatable read-only transport or
when the outcome is ambiguous. Before a managed-connection send, pass the exact provider
permissions documented by the loaded skill as `requiredScopes`; the selected connection must be
enabled, `READY`, and grant every required permission. A missing or unavailable connection stops
the request before it is sent.
