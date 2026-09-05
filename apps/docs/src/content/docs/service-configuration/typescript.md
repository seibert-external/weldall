---
title: Integrate a TypeScript service
description: Use the Weldall SDK with Hono to protect a contract API and publish instructions for agents.
sidebar:
  label: TypeScript
---

Weldall validates incoming requests to web services. We provide libraries you can add to your application to check who is making a request and whether they have the required permissions. These checks run before the application reads data or makes changes.

For TypeScript, use `@weldall/sdk`. This guide uses it with Hono to build a service that returns a contract list only with the `contracts:read` permission. The service also publishes a skill: instructions with the command an agent needs to call it.

You need Node.js 22.15 or newer, pnpm, and a running Weldall instance. The [TypeScript SDK source and reference](https://github.com/seibert-external/weldall/tree/main/packages/sdk) live in the Weldall repository. Install the published package from [npm](https://www.npmjs.com/package/@weldall/sdk).

## 1. Create the Hono project

```sh
mkdir weldall-contracts
cd weldall-contracts
pnpm init
pnpm pkg set type=module
pnpm add @hono/node-server @weldall/sdk hono
pnpm add --save-dev @types/node tsx typescript
mkdir src
```

## 2. Protect the contract route

Create `src/index.ts`:

```ts
import { serve } from "@hono/node-server";
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { Hono } from "hono";

const weldallIssuer = process.env.WELDALL_ISSUER ?? "https://weldall.example.com";
const publicOrigin = process.env.PUBLIC_ORIGIN ?? "http://localhost:8787";
const key = await generateEs256KeyPair();

const weldall = initWeldall(weldallIssuer, {
  resource: `${publicOrigin}/api`,
  publicOrigin,
  clientId: "weldall-cli-at-contracts",
  supportedScopes: ["contracts:read"],
  signingKey: {
    kid: "development-only",
    privateJwk: key.privateJwk,
    publicJwk: key.publicJwk,
  },
  replayStore: inMemory(),
  skills: {
    items: [
      {
        id: "list",
        title: "List contracts",
        requiredScopes: ["contracts:read"],
        visibility: "HIDDEN_IF_UNALLOWED",
        content: `# List contracts\n\nRun \`weldall request --scope contracts:read ${publicOrigin}/api/contracts\`.`,
      },
    ],
  },
  allowInsecureLoopback: publicOrigin === "http://localhost:8787",
});

const app = new Hono<{ Variables: WeldallVariables }>();
weldall.registerRoutes(app);

app.get("/api/contracts", weldall.protect({ scopes: ["contracts:read"] }), (context) => {
  const auth = weldall.getAuth(context);
  return context.json({
    requestedBy: auth.identity.subject,
    contracts: [
      { id: "contract-1001", customer: "Nordstern GmbH", status: "active" },
      { id: "contract-1002", customer: "Südwind AG", status: "review" },
    ],
  });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
```

`registerRoutes()` adds discovery, signing-key, token, and skill routes. `protect()` checks authorization before the contract handler runs. The handler can then read the verified identity with `getAuth()`. How you map that identity to your own user records is up to your application.

The skill tells the agent how to call the route. Its visibility setting hides it from employees without `contracts:read`; it does not replace the route's authorization check.

## 3. Check the service locally

Set `WELDALL_ISSUER` to your Weldall instance and start the service:

```sh
WELDALL_ISSUER=https://weldall.example.com \
PUBLIC_ORIGIN=http://localhost:8787 \
pnpm exec tsx src/index.ts
```

In another terminal, check discovery and the protected route:

```sh
curl -i http://localhost:8787/.well-known/oauth-protected-resource
curl -i http://localhost:8787/api/contracts
```

Discovery returns `200` with the resource identifier `http://localhost:8787/api`. The contract request returns `401` because it has no Weldall authorization. These checks do not require a CLI login. You can also call `await weldall.ready()` before starting the server to check issuer discovery and signing configuration at startup.

## 4. Deploy and register the service

:::caution[Replay protection across instances]
Each DPoP proof contains a unique ID (`jti`). The SDK stores used IDs and rejects reused proofs. With `inMemory()`, this only works within one process.

Proofs are short-lived, but another instance can still accept the same proof within that window. To prevent replays across instances, provide a shared replay store, for example backed by Redis. It must insert new IDs atomically, reject duplicates, and retain IDs until the validity window ends. See [Security](../../oauth-security/) for details.
:::

In production, use HTTPS and load your ES256 signing key from configuration rather than generating a new one on every start as the example does.

Deploy the service at `https://contracts.example.com` and set `PUBLIC_ORIGIN` to that exact URL. Keep `WELDALL_ISSUER` set to your Weldall instance. The resource identifier becomes `https://contracts.example.com/api`, and the skill uses the deployed URL.

Continue with [registration and permission assignment](../#for-weldall-administrators). Those steps are the same for TypeScript and Python.

## Framework examples on GitHub

The [Weldall repository](https://github.com/seibert-external/weldall) includes these example directories. Their READMEs describe how to run them:

| Directory                                                                                  | Use it for                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| [`examples/hono`](https://github.com/seibert-external/weldall/tree/main/examples/hono)     | Hono middleware                               |
| [`examples/basic`](https://github.com/seibert-external/weldall/tree/main/examples/basic)   | A framework-neutral Fetch handler             |
| [`examples/next`](https://github.com/seibert-external/weldall/tree/main/examples/next)     | Next.js route handlers in the Node.js runtime |
| [`examples/astro`](https://github.com/seibert-external/weldall/tree/main/examples/astro)   | Astro endpoints and middleware                |
| [`examples/skills`](https://github.com/seibert-external/weldall/tree/main/examples/skills) | Publishing a skill catalog                    |

The Hono, Next.js, and Astro examples use an expenses API rather than this guide's contracts API. Use the resource, client ID, and scopes from the example you choose when registering it in Weldall.
