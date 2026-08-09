# @weldall/sdk

Build a Weldall resource server with Fetch, Hono, Next.js, or Astro. The SDK verifies DPoP-bound requests, issues local access tokens, publishes OAuth metadata, and can publish agent skills from the service itself.

> This package implements pinned ID-JAG and JWT-DPoP drafts. Review the production notes before using it outside a controlled deployment.

## Install

```sh
npm install @weldall/sdk
```

Requirements:

- Node.js 22.15 or newer
- HTTPS in deployed environments
- Node.js runtime for Next.js route handlers

Hono, Next.js, and Astro are optional peer dependencies. Install the framework you use.

## Hono quick start

```sh
npm install @weldall/sdk hono @hono/node-server
```

```ts
import { serve } from "@hono/node-server";
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { Hono } from "hono";

const key = await generateEs256KeyPair(); // use a stable key in production

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
  return context.json({ requestedBy: auth.identity.email, contracts: [] });
});

serve({ fetch: app.fetch, port: 8787 });
```

`registerRoutes` mounts the token, metadata, JWKS, and skill catalog endpoints. `protect` rejects the request before your handler runs. `getAuth` returns the verified subject, email, granted scopes, token ID, and client ID.

Call `await weldall.ready()` during startup if you want Weldall discovery to fail early. Otherwise discovery happens when it is first needed.

## Scope policies

```ts
weldall.protect({ scopes: ["contracts:read", "contracts:export"] });
```

Every entry in `scopes` is required. If `anyScopes` is present, the request must additionally contain at least one of those scopes. An empty policy still requires a valid Weldall request.

The core Fetch API exposes the same behavior:

```ts
const auth = await weldall.verify(request, { scopes: ["contracts:read"] });
const result = await weldall.verifyNoThrow(request);
```

`verify` throws `WeldallAuthError`. `verifyNoThrow` returns either `{ ok: true, auth }` or `{ ok: false, error, response }`.

## Publish skills

Skills live with the API they describe. Configure static items or load them from a local source:

```ts
skills: {
  load: async () => loadPublishedSkills(),
}
```

The provider receives no employee identity and must return the same catalog for every caller.

A published skill contains:

```ts
{
  id: "list",                       // local resource ID
  title: "List contracts",
  requiredScopes: ["contracts:read"],
  visibility: "HIDDEN_IF_UNALLOWED",
  content: "# List contracts\n\n..."
}
```

Weldall prefixes the local ID with the registered resource key. For a resource with the key `contracts`, the public skill ID is `contracts.list`.

Visibility controls discovery, not authorization:

- `DEFAULT` keeps the skill visible and reports missing scopes.
- `HIDDEN_IF_UNALLOWED` hides the skill until every required scope is granted.

The API route still needs its own `protect` policy. Instructions never grant access.

When skill discovery is enabled for the resource, Weldall reads its protected-resource metadata and follows `weldall_skills_endpoint`. Catalog requests use a short-lived, audience- and resource-bound service assertion. Employee tokens and identities are not sent to the catalog endpoint.

The SDK validates each catalog before returning it. IDs must be unique local IDs, required scopes use `namespace:permission` syntax, and a catalog may contain at most 100 skills or 1 MiB of JSON. Weldall validates the response again before storing it and withholds skills that use unknown scopes; registered protected system scopes are valid requirements.

## Routes

The Hono adapter mounts these routes with `registerRoutes`:

| Route                                     | Handler                                |
| ----------------------------------------- | -------------------------------------- |
| `/.well-known/oauth-authorization-server` | `handlers.authorizationServerMetadata` |
| `/.well-known/oauth-protected-resource`   | `handlers.protectedResourceMetadata`   |
| `/.well-known/oauth-protected-resource/*` | `handlers.protectedResourceMetadata`   |
| `/.well-known/jwks.json`                  | `handlers.jwks`                        |
| `/.well-known/weldall-skills`             | `handlers.skills`                      |
| `/oauth/token`                            | `handlers.token`                       |

With the core Fetch API or the Next.js adapter, mount those handlers yourself. The Astro adapter wraps them as Astro endpoints.

## Next.js App Router

Create one shared instance:

```ts
// src/lib/weldall.ts
import { initWeldall } from "@weldall/sdk/next";

export const weldall = initWeldall("https://weldall.example.com", options);
```

Protect application routes with `withWeldall`:

```ts
// src/app/api/contracts/route.ts
import { weldall } from "@/lib/weldall";

export const runtime = "nodejs";
export const GET = weldall.withWeldall({ scopes: ["contracts:read"] }, async (_request, auth) =>
  Response.json({ requestedBy: auth.identity.email }),
);
```

Infrastructure routes are small handler exports. For example:

```ts
// src/app/oauth/token/route.ts
import { weldall } from "@/lib/weldall";

export const runtime = "nodejs";
export const POST = weldall.handlers.token;
```

Create the remaining route files the same way:

| File                                                        | Export                                               |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `src/app/.well-known/oauth-authorization-server/route.ts`   | `GET = weldall.handlers.authorizationServerMetadata` |
| `src/app/.well-known/oauth-protected-resource/route.ts`     | `GET = weldall.handlers.protectedResourceMetadata`   |
| `src/app/.well-known/oauth-protected-resource/api/route.ts` | `GET = weldall.handlers.protectedResourceMetadata`   |
| `src/app/.well-known/jwks.json/route.ts`                    | `GET = weldall.handlers.jwks`                        |
| `src/app/.well-known/weldall-skills/route.ts`               | `GET = weldall.handlers.skills`                      |

The `/api` metadata route above matches `resource: "https://contracts.example.com/api"`. If your resource uses another path, expose the corresponding RFC 9728 path instead. The skills route is needed only when `skills` is configured.

## Astro SSR

Create the Astro adapter instance:

```ts
// src/weldall.ts
import { initWeldall } from "@weldall/sdk/astro";

export const weldall = initWeldall("https://weldall.example.com", options);
```

Use `weldall.protect()` in middleware and read the identity with `weldall.getAuth(context)`. Declare `weldallAuth` in `App.Locals`.

Astro handlers already accept an endpoint context:

```ts
// src/pages/oauth/token.ts
import { weldall } from "../../weldall";

export const prerender = false;
export const POST = weldall.handlers.token;
```

Add equivalent `GET` endpoint files for authorization-server metadata, protected-resource metadata, the resource-specific protected metadata path, JWKS, and—when configured—the skill catalog. Set `prerender = false` in each file. For the `/api` resource used above, the files are:

- `src/pages/.well-known/oauth-authorization-server.ts`
- `src/pages/.well-known/oauth-protected-resource.ts`
- `src/pages/.well-known/oauth-protected-resource/api.ts`
- `src/pages/.well-known/jwks.json.ts`
- `src/pages/.well-known/weldall-skills.ts`

## Production notes

Use a stable ES256 signing key. Generating a key at startup invalidates verification after a restart. For KMS or Vault, provide a signing-key provider with `current()` and `jwks()` methods.

Use a shared atomic `ReplayStore` when more than one service instance is running. `inMemory()` is process-local, clears on restart, and defaults to 10,000 live entries. It is suitable for development and single-process evaluation, not horizontal deployment.

`ReplayStore.consume(key, expiresAt)` must return `true` only for the first consume. Store failures fail closed. Skill publishing cannot be combined with `replayStore: "disabled"`.

Keep `resource`, `publicOrigin`, the deployed routes, and the resource registered in Weldall aligned exactly. Set `allowInsecureLoopback: true` only for local loopback development.

The current protocol boundary has no DPoP nonce negotiation. Plan key rotation, shared replay storage, restart behavior, draft upgrades, and independent conformance testing before production rollout.

## License

Apache-2.0
