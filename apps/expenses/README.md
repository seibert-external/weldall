# Expenses — HTTP and native MCP demo

This repository's runnable Task 1 resource demonstrates the same protected expense data through HTTP and native MCP. It uses the Hono adapter and `createNativeMcp` from `@weldall/sdk`; it is not a separate MCP connector. MCP Apps and desktop preselection are not part of this demo.

| Interface                | Behavior                                                                 | Required scopes                                                     |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `GET /api/expenses`      | Read the fixed demo list and verified caller identity                    | `expenses:read`                                                     |
| MCP `list_expenses`      | The same data as HTTP, including structured content                      | `expenses:read`                                                     |
| MCP `expenses://current` | The same data as a protected JSON resource                               | `expenses:read`                                                     |
| MCP `create_expense`     | Validate a description and return a synthetic expense; **not persisted** | `expenses:read` for discovery, plus `expenses:create` for execution |
| Skill `expenses.review`  | Activate the whole native resource and describe a read-only review       | `expenses:read`                                                     |

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

Expect two tools and one MCP resource. HTTP, `list_expenses` and `expenses://current` return the same list and caller identity. Separate CLI processes do not publish tools into a host session: with the branch extension, `discover_integrations({"resources":["expenses"]})` or `read_skill_document` for `expenses.review` performs session-local activation. Use the tool names returned by the extension, not guessed aliases. See [the extension README](../goose-extension/README.md) for branch-host setup.

For a user granted **only** `expenses:read`, this must fail rather than execute the write:

```sh
WELDALL_ISSUER=https://weldall.seibert.localdev ./apps/cli/dist/index.js \
  mcp native call expenses create_expense \
  --arguments '{"description":"Demo lunch"}' --json
```

If that user also has `expenses:create`, the call succeeds but remains non-persistent. Never automatically retry writes or switch to HTTP after a failed MCP operation.

## Automated checks

```sh
pnpm --filter @weldall/expenses test
pnpm --filter @weldall/expenses typecheck
pnpm --filter @weldall/expenses build
```

`test/native-mcp.test.ts` exercises the actual Hono app with the real MCP client/transport, ephemeral signing keys and in-process HTTP routing. It covers metadata, authenticated skill publication, whole-resource dependencies, user/machine HTTP–MCP parity, read-only write denial, explicit write permission and input validation, anonymous denial, discovery scopes and replay rejection. No database, running server or real user credentials are required.

The existing `pnpm m2m:demo` remains an HTTP machine smoke against the running stack and requires the seeded machine/key pair. The automated native tests do not replace live machine-registration or installed-host acceptance.
