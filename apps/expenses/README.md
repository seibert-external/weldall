# Expenses — HTTP and native MCP demo

This repository's runnable Task 1 resource demonstrates the same protected expense data through HTTP and native MCP. It uses the Hono adapter and `createNativeMcp` from `@weldall/sdk`; it is not a separate MCP connector. The `list_expenses` tool also links a display-only MCP App. Desktop preselection and UI interactivity are not part of this demo.

| Interface                   | Behavior                                                                 | Required scopes                                                     |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `GET /api/expenses`         | Read the fixed demo list and verified caller identity                    | `expenses:read`                                                     |
| MCP `list_expenses`         | The same data as HTTP, including structured content                      | `expenses:read`                                                     |
| MCP `ui://weldall/expenses` | Server-rendered HTML/CSS expense view and verified caller                | `expenses:read`                                                     |
| `GET /mcp-ui/expenses.css`  | Public, non-sensitive stylesheet for the view                            | None                                                                |
| MCP `expenses://current`    | The same data as a protected JSON resource                               | `expenses:read`                                                     |
| MCP `create_expense`        | Validate a description and return a synthetic expense; **not persisted** | `expenses:read` for discovery, plus `expenses:create` for execution |
| Skill `expenses.review`     | Activate the whole native resource and describe a read-only review       | `expenses:read`                                                     |

The native endpoint is `/api/mcp`. Protected-resource metadata advertises its endpoint, discovery scope and catalog revision. Anonymous initialize/list/read requests are denied. Discovery may advertise the write tool, but does **not** grant permission to execute it. Both user and machine tokens are DPoP-bound; each request requires a fresh proof.

HTTP POST and DELETE routes remain available for the existing demo. They also return synthetic results without changing the fixed list. The in-memory replay store is for this single-process development demo, not a multi-instance production deployment.

## Run locally

Follow [local development](../docs/src/content/docs/local-development.md) for the database, signing keys, local HTTPS and application processes. From the repository root, build the SDK and branch CLI:

```sh
pnpm --filter @weldall/sdk build
pnpm --filter @weldall/cli build
# Start this in your own terminal if pnpm dev is not already running it:
pnpm --filter @weldall/expenses dev
```

The default resource origin is `https://expenses.seibert.localdev`. `src/env.ts` lists the signing and downstream overrides; keep these consistent with the registered origin, audience and request prefixes.

On a **fresh disposable database**, the standard development seed registers resource key `expenses`, its supported scopes, the published `expenses.review` skill and the read-only `dev-expenses-reader` machine. The seed and served catalog share `src/review-skill.ts`, including this dependency:

```json
{ "kind": "resource", "resourceKey": "expenses" }
```

There is no account ID or fixed tool list in that dependency, and no extra persisted native-MCP configuration field. The resource owns its endpoint and operation policy; Weldall's existing registry owns its trusted origin and scope bounds.

Do **not** rerun the development seed against a database with data you want to preserve. An existing database may have an older cached `expenses.review`; update its published skill catalog through the normal resource-catalog refresh workflow rather than expecting an app restart to replace it.

An administrator must grant the demo user `expenses:read` in addition to login access. Admin/login permission alone does not grant business access. Keep a read-only user without `expenses:create` for the denial check; the demo does not add user grants automatically.

## Discover and read with the branch CLI

Run from the repository root. The subshell uses only an ephemeral issuer override; it does not change the saved issuer or installed CLI:

```sh
(
  export WELDALL_ISSUER=https://weldall.seibert.localdev
  cli=./apps/cli/dist/index.js
  "$cli" login

  # Lightweight search; no native schemas, resource-token exchange or activation.
  "$cli" discover --query expenses --catalog-only --json
  # Direct discovery and the optional skill resolve the same native resource.
  "$cli" discover --resource expenses --json
  "$cli" discover --skill expenses.review --json

  "$cli" mcp native tools expenses --json
  "$cli" mcp native resources expenses --json
  "$cli" mcp native call expenses list_expenses --json
  "$cli" mcp native read-resource expenses --uri expenses://current --json
  "$cli" request --scope expenses:read https://expenses.seibert.localdev/api/expenses
)
```

Expect two tools and two MCP resources. HTTP, `list_expenses` and `expenses://current` return the same list and caller identity. Separate CLI processes do not publish tools into a host session: with the branch extension, `discover_integrations({"resources":["expenses"]})` or `read_skill_document` for `expenses.review` performs session-local activation. Use the tool names returned by the extension, not guessed aliases. See [the extension README](../goose-extension/README.md) for branch-host setup.

For a user granted **only** `expenses:read`, this must fail rather than execute the write:

```sh
WELDALL_ISSUER=https://weldall.seibert.localdev ./apps/cli/dist/index.js \
  mcp native call expenses create_expense \
  --arguments '{"description":"Demo lunch"}' --json
```

If that user also has `expenses:create`, the call succeeds but remains non-persistent. Never automatically retry writes or switch to HTTP after a failed MCP operation.

## Show the demo UI in Goose

Build the branch SDK, CLI and extension (restart the extension after rebuilding):

```sh
pnpm --filter @weldall/sdk build
pnpm --filter @weldall/cli build
pnpm --filter @weldall/goose build
```

Use the branch extension and CLI as described in the extension README, with the Expenses process
running and the user granted `expenses:read`. Ask Goose to discover resource `expenses` and invoke
its advertised `list_expenses` tool. A host with MCP Apps rendering should show the expense card
in an iframe alongside the ordinary tool result. This demo enables inline, fullscreen and PiP;
the SDK bootstrap reports its natural height. Resource-owned JavaScript additionally requires the
updated white-label host with its display-only bridge guard.

The tool links `ui://weldall/expenses`; the extension rewrites this to a session/source-local
`ui://` URI. Goose reads that URI through the extension and CLI directly from `/api/mcp`.
The returned HTML imports `https://expenses.seibert.localdev/mcp-ui/expenses.css` (or the configured
resource origin). Only that asset origin is declared in the UI CSP. The local HTTPS certificate
must be trusted by the desktop browser as well as the CLI.

`createMcpAppResource` renders current data using the authenticated resource-read identity. It does not
consume the preceding tool result or its arguments. This demo uses only the fixed SDK display
bootstrap: no business JavaScript, forms, direct fetches or UI-initiated tool calls. The SDK also
supports same-origin ES modules (including React bundles) and a browser `mountMcpApp` export.
Those modules load only after the host confirms its enforced display-only bridge boundary.
Source-bound interactive tool access remains deferred.

For protocol-only inspection:

```sh
./apps/cli/dist/index.js mcp native read-resource expenses --uri ui://weldall/expenses --json
```

A successful CLI read proves HTML transport, **not** that Goose displayed the iframe. Record
installed-host verification separately. Text-only/older clients still receive the normal tool
result.

## Automated checks

```sh
pnpm --filter @weldall/expenses test
pnpm --filter @weldall/expenses typecheck
pnpm --filter @weldall/expenses build
```

`test/native-mcp.test.ts` exercises the actual Hono app with the real MCP client/transport, ephemeral signing keys and in-process HTTP routing. It covers metadata, authenticated skill publication, whole-resource dependencies, user/machine HTTP–MCP parity, read-only write denial, explicit write permission and input validation, anonymous denial, discovery scopes and replay rejection. No database, running server or real user credentials are required.

The existing `pnpm m2m:demo` remains an HTTP machine smoke against the running stack and requires the seeded machine/key pair. The automated native tests do not replace live machine-registration or installed-host acceptance.
