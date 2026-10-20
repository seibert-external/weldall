# @weldall/sdk

`@weldall/sdk` adds Weldall authentication to a resource server. It verifies DPoP-bound requests, provides the OAuth endpoints Weldall needs, and works with Fetch, Hono, Next.js, and Astro.

The package implements the protocol drafts pinned by Weldall. Before deploying it, read the [production checklist](#production-checklist), especially the notes about stable keys and replay storage.

## Installation

```sh
npm install @weldall/sdk
```

The SDK requires Node.js 22.15 or newer. Hono, Next.js, and Astro are optional peer dependencies, so only install the framework used by your service. Deployed services must use HTTPS; Next.js route handlers must use the Node.js runtime.

## Hono example

Install the adapter and server packages:

```sh
npm install @weldall/sdk hono @hono/node-server
```

Then configure the resource, mount Weldall's protocol routes, and protect the application routes:

```ts
import { serve } from "@hono/node-server";
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { Hono } from "hono";

const key = await generateEs256KeyPair(); // load a stable key in production

const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://contracts.example.com/api",
  publicOrigin: "https://contracts.example.com",
  clientId: "weldall-cli-at-contracts",
  supportedScopes: ["contracts:read"],
  signingKey: { kid: "development-only", ...key },
  replayStore: inMemory(),
  skills: {
    items: [
      {
        id: "list",
        title: "List contracts",
        requiredScopes: ["contracts:read"],
        visibility: "HIDDEN_IF_UNALLOWED",
        content:
          "# List contracts\n\nRun `weldall request --scope contracts:read https://contracts.example.com/api/contracts`.",
      },
    ],
  },
});

const app = new Hono<{ Variables: WeldallVariables }>();
weldall.registerRoutes(app);

app.get("/api/contracts", weldall.protect({ scopes: ["contracts:read"] }), (context) => {
  const auth = weldall.getAuth(context);
  const requestedBy =
    auth.identity.type === "machine" ? auth.identity.clientId : auth.identity.email;
  return context.json({ requestedBy, contracts: [] });
});

serve({ fetch: app.fetch, port: 8787 });
```

`registerRoutes` mounts the metadata, key, token, and optional skill endpoints. `protect` validates the request before the handler runs. Inside the handler, `getAuth` returns the subject, granted scopes, token ID, client ID, and caller identity.

A caller is either a user or a machine. Check `auth.identity.type` before reading caller-specific fields such as `email` or the machine's `clientId`.

Discovery happens on the first request that needs it. Call `await weldall.ready()` during startup if the service should fail early when Weldall cannot be reached.

If the resource cannot connect to the Weldall issuer directly, set `discoveryProxyOrigin` to a trusted HTTPS reverse proxy:

```ts
const weldall = initWeldall("https://weldall.example.com", {
  // Keep the remaining resource options unchanged.
  discoveryProxyOrigin: "https://weldall-discovery-proxy.internal.example.com",
  // ...
});
```

The proxy only transports authorization-server metadata and JWKS requests. The SDK still requires metadata and signed assertions to identify the canonical Weldall issuer, and it requires the advertised `jwks_uri` to remain on that canonical origin. The proxy must expose `GET /.well-known/oauth-authorization-server` and the canonical JWKS path advertised by that response (Weldall currently uses `GET /api/oauth/jwks`) without rewriting their JSON responses.

## Native MCP (development preview)

Native serving and shared resource/connector/skill discovery are available on the development
branch, with no published minimum version yet. Python serving is also implemented; full parity,
performance and packaged-host acceptance remain Task 1 release gates.

Install the optional runtime only in services that expose MCP:

```sh
npm install @modelcontextprotocol/sdk@^1.32.1 ajv@^8.20.0
```

Add this provider as the `mcp` option of the existing `initWeldall` configuration. Keep the existing
HTTP routes and authentication configuration:

```ts
import { createNativeMcp } from "@weldall/sdk/mcp/server";

const mcp = createNativeMcp({
  path: "/api/mcp",
  description: "Contracts visible to the authenticated caller",
  discoveryScopes: ["contracts:read"],
  tools: [
    {
      name: "whoami",
      description: "Return the verified caller, not an identity supplied in arguments",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      scopes: ["contracts:read"],
      annotations: { readOnlyHint: true },
      async handler(_, { auth, signal }) {
        signal.throwIfAborted();
        return { content: [{ type: "text", text: auth.subject }] };
      },
    },
  ],
});
// initWeldall(host, { ...existingOptions, mcp });
```

Hono's `registerRoutes` mounts the provider automatically. Fetch/Next expose
`weldall.handlers.mcp(request)`; mount it at the exact configured path, exporting the handler
as the route's `POST`. Astro exposes `weldall.handlers.mcp(context)`. Core HTTP consumers do not
load the optional MCP runtime. A provider is an immutable catalog; replace/restart it to change
definitions or policies.

- SDK declarations own description, endpoint path, discovery scopes, operation scopes and the
  catalog revision. Protected-resource metadata advertises them as `weldall_mcp` (schema version 1).
  There is no second editable policy copy or new persisted resource field. The authenticated
  registry's opt-in `?mcp=1` read synchronizes validated advertisements at request time, omitting
  missing/unreachable/incompatible or unauthorized advertisements. It is bounded to 100 resources,
  four concurrent metadata requests, five seconds and 64 KiB per document; no stale catalog grants
  access. Ordinary registry reads do not contact resources.
- The enabled registry resource, its authorization-server origin, supported scopes and approved
  request prefixes remain the trust boundary. Keep `/api/mcp` inside those prefixes; the CLI
  rejects metadata pointing elsewhere. Existing IaC resource registration is unchanged.
- Discovery scopes and each operation's `scopes` must be explicit, nonempty, unique and supported.
  Every scope is required. Initialization and all listings authenticate and enforce discovery
  scopes; invocation also requires the operation's scopes. The CLI obtains the union before
  invoking, using ordinary nonempty-scope exchanges. It never retries a denied operation.
- Tool input/output schemas use JSON Schema Draft 2020-12 (also the default when `$schema` is
  omitted); other declared dialects and asynchronous validation are rejected. `format` is an
  annotation, not an enforced constraint. Handlers receive the same verified user/machine context
  as HTTP and must enforce business/record-level authorization themselves. Honor `signal`;
  cancelling transport cannot undo a completed write.
- Ordinary tools and fixed resources are supported; resource-template listing is empty.
  Transport is stateless Streamable HTTP with JSON responses, no sessions/reconnection.
  Only the native `_meta["weldall/scopes"]` field is used for operation policy. Native tools can
  additionally link a display-only MCP App as described below; connector UI metadata stays stripped.
- Resource owners must audit execution at the handler/business layer without recording tokens or
  sensitive arguments. Central token/discovery activity does not audit direct MCP execution.
  Locally verified user tokens can remain valid for their ten-minute lifetime (machine tokens:
  five minutes); this is not immediate central grant revocation.
- Removing the `mcp` option disables advertisement and the MCP route without changing HTTP.

### Tool behavior hints (not permissions)

Tool `annotations` describe expected behavior to clients/models. They do **not** enforce it:
scopes and handler-level checks control access. These are standard MCP field names:

| Hint              | Meaning when `true`                                                                            | MCP default if omitted |
| ----------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| `readOnlyHint`    | Only reads; does not modify its environment.                                                   | `false`                |
| `destructiveHint` | May delete or overwrite existing data; `false` means only additive changes.                    | `true`                 |
| `idempotentHint`  | Repeating the same arguments has no additional side effects.                                   | `false`                |
| `openWorldHint`   | Interacts with an open-ended set of external entities, such as web search or email recipients. | `true`                 |

`destructiveHint` and `idempotentHint` matter only for tools that are not read-only.
An internal expense database or memory store is a closed domain (`openWorldHint: false`).
A web search is both read-only and open-world: this hint is **not** a synonym for write access,
network permission or UI bridge access. Idempotency also does not mean identical results or
authorize automatic retries. Weldall preserves supplied hints without inserting defaults.

Skills can declare `mcpDependencies: [{ kind: "resource", resourceKey: "billing" },
{ kind: "connector", connectorType: "atlassian-mcp" }]`. These select whole available catalogs;
existing `{ connectorKey, tools, includeResources }` entries still select only those exact tools.
No skill dependency selects an account. New-form administrative configuration uses the existing
IaC skill field and requires server feature `mcp-discovery-v1`. Registration identity, enabled
state, supported scopes and request prefixes remain existing IaC resource fields; SDK metadata
is derived, not another independently editable IaC policy.

The executable local fixture is `apps/expenses/src/app.ts`; its `create_expense` tool is a
demonstration only and does not persist records. It is not an approved real-service pilot.

## Display-only MCP Apps (TypeScript preview)

Native resource tools can link a server-rendered HTML/CSS view. Keep the normal tool result:
text-only hosts and older CLIs still receive it. There is no central HTML proxy or additional
HTML endpoint: the host reads the registered `ui://` resource through the same authenticated
MCP endpoint as the tools.

```ts
import { createNativeMcp, createMcpAppResource, escapeMcpAppText } from "@weldall/sdk/mcp/server";

const view = createMcpAppResource({
  name: "caller",
  scopes: ["contracts:read"],
  resourceOrigin: "https://contracts.example.com",
  displayModes: ["inline", "fullscreen", "pip"],
  styleUrls: ["https://contracts.example.com/assets/caller.css"],
  render: ({ auth }) =>
    `<main><h1>Requested by</h1><p>${escapeMcpAppText(auth.subject)}</p></main>`,
});

const mcp = createNativeMcp({
  path: "/api/mcp",
  description: "Contracts",
  discoveryScopes: ["contracts:read"],
  resources: [view],
  tools: [
    {
      name: "whoami",
      inputSchema: { type: "object", additionalProperties: false },
      scopes: ["contracts:read"],
      _meta: { ui: { resourceUri: view.uri } },
      async handler(_, { auth }) {
        return { content: [{ type: "text", text: auth.subject }] };
      },
    },
  ],
});
```

The helper generates the URI, document, MIME type (`text/html;profile=mcp-app`) and a fixed,
CSP-hashed display bootstrap. `displayModes` defaults to `["inline"]`; `inline` is required.
Add `fullscreen` and/or `pip` to offer the host controls, not to switch modes automatically.
The bootstrap negotiates the MCP Apps lifecycle and reports natural content height, including
changes after CSS loads. Rendering still runs on the server with `{ auth, signal }`, independently
of a tool call; it does not receive tool arguments/results. Escape interpolated data.

`resourceOrigin` authorizes public CSS, images, fonts and JavaScript **ES modules** from that exact
origin (scheme + host + port). URLs must be absolute HTTPS, or HTTP on explicit loopback hosts for
development. No CDNs, credentials or wildcards. At the extension boundary the origin is re-derived
from the registered resource identifier, never trusted from provider metadata. The document CSP
blocks direct fetch/WebSocket connections, frames and form submissions. Provider inline scripts,
event handlers and static navigation/form markup are removed. JavaScript can implement local UI
interactions, but receives neither provider credentials nor authority to invoke business tools.

### HTML templates and React/Vue

`createMcpAppResource()` creates the resource definition; add it to `createNativeMcp` to register it.
Its read handler includes the bootstrap automatically. For custom HTML assembly append the string from
`renderMcpAppBootstrapHtml({ displayModes: ["inline", "fullscreen", "pip"] })` from
`@weldall/sdk/mcp/display` (also exported by `/mcp/server`) at the end of the body; return the
result through the native UI resource, not as an unauthenticated HTML endpoint.

For a React/Vue UI, set `scriptUrls: ["https://contracts.example.com/assets/app.js"]` on the resource
and render a mount point such as `<div id="root"></div>`. Bundle your framework normally and serve
its ES modules, CSS and fonts from `resourceOrigin`, with correct MIME types and CORS headers for
cross-origin iframe/module loading. These assets must be public and non-sensitive; authenticated
HTML supplies the initial data. Inline hydration scripts and API fetching are not supported.

The framework-independent browser export has no React or Node dependencies:

```tsx
import { mountMcpApp } from "@weldall/sdk/mcp/browser";

useEffect(() => mountMcpApp({ displayModes: ["inline", "fullscreen", "pip"] }), []);
```

The returned cleanup removes observers/listeners after the last mount. An existing HTML bootstrap
and framework effects share one handshake; the first mount owns its configuration. When using
`createMcpAppResource`, its automatic bootstrap already handles sizing, so this effect is optional.

**Host boundary:** resource modules are queued, not emitted as immediately executable script tags.
They load only after the host advertises `hostCapabilities.experimental["weldall/display-only"]`
with `{ version: 1 }`. The updated Goose host enforces this for the Weldall extension: UI tool calls,
additional resource reads, chat messages, external links and unhandled RPC are rejected. Other
Goose apps retain their existing behavior. Older hosts still render the static content and fixed
sizing bootstrap but do not load resource modules. This is not source-bound interactive tool access;
that remains deferred. Connector/connection Apps remain unsupported.

The runnable example is [Expenses](../../apps/expenses/README.md). Protocol tests do not prove
that an installed desktop host has loaded the branch extension; verify the iframe in that host
before claiming desktop acceptance.

## Scope rules

A route can require one or more scopes:

```ts
weldall.protect({ scopes: ["contracts:read", "contracts:export"] });
```

Every entry in `scopes` is required. When `anyScopes` is also present, the request needs at least one scope from that list as well. An empty policy still requires a valid Weldall request.

The framework-neutral Fetch API follows the same rules:

```ts
const auth = await weldall.verify(request, { scopes: ["contracts:read"] });
const result = await weldall.verifyNoThrow(request);
```

`verify` throws a `WeldallAuthError` when authentication fails. `verifyNoThrow` returns `{ ok: true, auth }` on success or `{ ok: false, error, response }` on failure.

## Machine-to-machine calls

A backend can authenticate with its own registered machine identity. The calling service loads its ES256 key pair and requests a five-minute token for one resource:

```ts
import { loadEs256KeyPairFromEnv, requestMachineToken } from "@weldall/sdk";

const key = await loadEs256KeyPairFromEnv({
  privateName: "MACHINE_SIGNING_PRIVATE_JWK",
  privateValue: process.env.MACHINE_SIGNING_PRIVATE_JWK!,
  publicName: "MACHINE_SIGNING_PUBLIC_JWK",
  publicValue: process.env.MACHINE_SIGNING_PUBLIC_JWK!,
});

const token = await requestMachineToken({
  issuer: "https://weldall.example.com",
  clientId: "expenses-a",
  resource: "https://expenses-b.example.com/api",
  scopes: ["expenses-b:read"],
  kid: process.env.MACHINE_SIGNING_KID!,
  key,
});
```

The receiving service uses its normal `initWeldall`, `verify`, or framework adapter setup. Machine tokens are accepted automatically. Route access still comes from `scopes` and `anyScopes`; inspect `auth.identity.type` only when the handler needs to treat users and machines differently.

The SDK verifies the token profile, issuer, audience, subject, client, lifetime, scopes, key binding, and DPoP proof. Machine identities do not contain user email addresses and cannot impersonate users.

Store private keys in deployment secrets, KMS, Vault, or another credential system. Do not put them in Weldall, manifests, repositories, errors, or logs. To rotate a key, register the new public key, deploy the matching private key, and revoke the old key after the rollout.

When a `ReplayStore` is configured, every request needs a fresh DPoP proof. `replayStore: "disabled"` skips that check and accepts the resulting replay risk.

### Call shared MCP connections as a machine

Provision a shared service-account key in the admin UI and assign `weldall:mcp` plus every connector/use scope. Request a token for Weldall itself, not a downstream resource:

```ts
import { requestMachineToken, createWeldallMcpClient } from "@weldall/sdk";
const token = await requestMachineToken({
  issuer,
  clientId,
  kid,
  key,
  resource: `${issuer}/api`,
  scopes: ["weldall:mcp", "atlassian-mcp:use-shared"],
});
const mcp = createWeldallMcpClient({ issuer, accessToken: token.accessToken, key });
const target = { connectorKey: "atlassian-mcp", connection: "production-bot" };
await mcp.listTools(target);
await mcp.callTool({ ...target, name: "TOOL_NAME", arguments: {} });
```

Use a stable shared connection key and discovered tool names/arguments. Also available: `listConnectors`, `listConnections`, `listResources` and `readResource({ connectorKey, connection, uri })`. The MCP API is also exported from `@weldall/sdk/mcp`.

All methods accept `signal`, use fresh DPoP proofs and validate bounded contracts: discovery 20 seconds, operations 30 seconds, requests/definitions 1 MiB, results 10 MiB. No automatic retries, including timeouts/401s: writes may already have executed. `WeldallMcpError` exposes sanitized code/status, not upstream bodies. Tokens/keys stay in memory; authorization is checked live. Machines cannot start OAuth or provision secrets.

## Publishing skills

Skills can live next to the API they describe. Configure a static catalog or load one from a local source:

```ts
skills: {
  load: async () => loadPublishedSkills(),
}
```

A skill has a resource-local ID, a title, required scopes, visibility, and Markdown instructions. Optional `meta.tags`, `meta.owner`, `meta.appearance`, and `lastUpdatedAt` values supply directory metadata; tags are limited to 20 non-empty strings of at most 40 characters each. Appearance accepts extensible string metadata; Weldall recognizes canonical kebab-case [Lucide icon names](https://lucide.dev/icons/) plus `gradientFrom`, `gradientTo`, `darkGradientFrom`, and `darkGradientTo` six-digit hex colors. Missing or invalid visual values use deterministic fallbacks.

```ts
{
  id: "list",
  title: "List contracts",
  requiredScopes: ["contracts:read"],
  visibility: "HIDDEN_IF_UNALLOWED",
  meta: {
    tags: ["contracts", "review"],
    owner: "Legal Operations",
    appearance: {
      icon: "file-text",
      gradientFrom: "#555BD6",
      gradientTo: "#7773E5",
      darkGradientFrom: "#2A2660",
      darkGradientTo: "#403A86",
    },
  },
  lastUpdatedAt: "2026-08-20",
  content: "# List contracts\n\n...",
}
```

Weldall adds the registered resource key to the local ID. For a resource named `contracts`, the public skill ID becomes `contracts.list`.

Visibility affects discovery, not authorization:

- `DEFAULT` shows the skill and reports any missing scopes.
- `HIDDEN_IF_UNALLOWED` hides the skill until all required scopes are granted.

The API route still needs its own scope policy. Skill instructions never grant access.

The catalog provider receives no employee identity and must return the same catalog for every caller. Catalogs may contain up to 100 skills or 1 MiB of JSON. IDs must be unique, and required scopes use the `namespace:permission` format. Weldall checks the catalog again and withholds skills that refer to unknown scopes.

## Framework adapters

### Next.js App Router

Create one shared SDK instance:

```ts
// src/lib/weldall.ts
import { initWeldall } from "@weldall/sdk/next";

export const weldall = initWeldall("https://weldall.example.com", options);
```

Protect a route with `withWeldall`:

```ts
// src/app/api/contracts/route.ts
import { weldall } from "@/lib/weldall";

export const runtime = "nodejs";
export const GET = weldall.withWeldall({ scopes: ["contracts:read"] }, async (_request, auth) =>
  Response.json({
    requestedBy: auth.identity.type === "machine" ? auth.identity.clientId : auth.identity.email,
  }),
);
```

Each protocol endpoint is a small handler export. For example:

```ts
// src/app/oauth/token/route.ts
import { weldall } from "@/lib/weldall";

export const runtime = "nodejs";
export const POST = weldall.handlers.token;
```

Add equivalent `GET` route files for the metadata, JWKS, and optional skill handlers listed in [Protocol routes](#protocol-routes).

### Astro SSR

Create one shared adapter instance:

```ts
// src/weldall.ts
import { initWeldall } from "@weldall/sdk/astro";

export const weldall = initWeldall("https://weldall.example.com", options);
```

Call `weldall.protect()` from middleware and read the result with `weldall.getAuth(context)`. Add `weldallAuth` to `App.Locals`.

Astro endpoint files can export the handlers directly:

```ts
// src/pages/oauth/token.ts
import { weldall } from "../../weldall";

export const prerender = false;
export const POST = weldall.handlers.token;
```

Create `GET` endpoints for metadata, JWKS, and the optional skill catalog. Set `prerender = false` in every endpoint file.

### Starlight search integration

`@weldall/sdk/starlight` turns a [Starlight](https://starlight.astro.build)
site into a Weldall resource with an agent-facing full-text search endpoint.
The site's MDX content is indexed at build time with language-specific Orama
stemming and stop-word removal. Agents query `GET /api/search` and read full
pages from `GET /api/content?path=…` through
`weldall request` — no browser. It also
publishes the skill catalog so Weldall auto-discovers the `search` skill.

```js
// astro.config.mjs — requires SSR (`output: "server"` + a server adapter)
import { weldallSearch } from "@weldall/sdk/starlight";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    starlight({ title: "Documentation" }),
    weldallSearch("https://weldall.example.com", {
      publicOrigin: "https://docs.example.com",
      resource: "https://docs.example.com/api",
      clientId: "weldall-cli-at-docs",
      requiredScopes: ["search:read"],
      language: "english",
    }),
  ],
});
```

The search endpoint returns ranked hits with a short excerpt centered on a
literal query match when available, so agents can see why each page matched.
Agents that need the full body request it by path from the content endpoint
(also protected by the same scopes):

```sh
weldall request --scope search:read \
  "https://docs.example.com/api/content?path=/team/overview/"
```

Both endpoints require **all** of the configured `requiredScopes`. The
auto-discovered `search` skill documents both commands so agents can search
and then read a result end to end.

The generated `search` skill is customizable by the site owner through the
`skills.search` option — a custom `title`, an opening `description` containing
concrete discovery vocabulary and example tasks, a full `content` replacement,
or `extraRules` appended to the generated operating rules:

```js
weldallSearch("https://weldall.example.com", {
  // ...
  skills: {
    search: {
      description: "Use this for office support, vehicle booking, onboarding, and company facts.",
      extraRules: "Pages under /office describe internal support teams.",
    },
  },
});
```

The interface mirrors `initWeldall(host, options)`. The search endpoint
requires **all** of the configured `requiredScopes`, which are also the skill's
`requiredScopes` and the resource's supported scopes. Configuration is
**prop-driven**: the consuming site passes values in `astro.config.mjs` and may
read them from its own environment variables however it likes — the library
accepts values, never environment-variable names. Runtime-only values are not
written into `.weldall-search/config.json`: set `WELDALL_SIGNING_KEY` in the
server environment, and call `configureWeldallSearchRuntime({ replayStore })`
from server startup code before serving the injected routes.

`language` defaults to `"english"`. It enables the matching stemmer and
stop-word list; import `SUPPORTED_SEARCH_LANGUAGES` from
`@weldall/sdk/starlight` to inspect the accepted values.

Orama and gray-matter are optional peer dependencies and must be installed in
the consuming site:

```sh
pnpm add @orama/orama @orama/stemmers @orama/stopwords gray-matter
```

## Protocol routes

Hono's `registerRoutes` mounts all required handlers. Fetch, Next.js, and Astro integrations mount the same handlers explicitly:

| Route                                     | Handler                       |
| ----------------------------------------- | ----------------------------- |
| `/.well-known/oauth-authorization-server` | `authorizationServerMetadata` |
| `/.well-known/oauth-protected-resource`   | `protectedResourceMetadata`   |
| `/.well-known/oauth-protected-resource/*` | `protectedResourceMetadata`   |
| `/.well-known/jwks.json`                  | `jwks`                        |
| `/.well-known/weldall-skills`             | `skills`                      |
| `/oauth/token`                            | `token`                       |

The handler is available as `weldall.handlers.<name>`. The resource-specific protected metadata path must match the path in `resource`. For `https://contracts.example.com/api`, expose `/.well-known/oauth-protected-resource/api`. The skill route is only needed when `skills` is configured.

## Production checklist

- Load a stable ES256 signing key. Generating one at startup invalidates tokens after every restart. KMS and Vault integrations can provide a signing-key provider with `current()` and `jwks()` methods.
- Keep `resource`, `publicOrigin`, deployed protocol routes, and the resource registered in Weldall exactly aligned.
- Use HTTPS. Set `allowInsecureLoopback: true` only for local loopback development.
- Choose replay storage deliberately. `inMemory()` holds up to 10,000 live entries by default, belongs to one process, and clears on restart. A shared `ReplayStore` must return `true` only for the first `consume(key, expiresAt)` call and fail closed on storage errors.
- Plan key rotation, restarts, draft upgrades, and independent conformance testing before rollout. The current protocol boundary has no DPoP nonce negotiation.

## License

FSL-1.1-ALv2 (Functional Source License), converting to Apache-2.0 two years after each release.
