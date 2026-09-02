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
