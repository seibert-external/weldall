# @weldall/sdk

Weldall's Node.js resource-server SDK for Fetch, Hono 4, Next.js 16 App Router, and Astro 7 SSR.

> **Prototype:** review the security boundary below before production use. The default replay store is process-local and the draft protocols are pinned, not stable RFCs.

## Requirements

- Node.js `>=22.15.0`
- Node runtime only (Next.js routes must export `runtime = "nodejs"`)
- HTTPS origins; loopback HTTP requires `allowInsecureLoopback: true`

## Install

```sh
pnpm add @weldall/sdk
# add hono, next, or astro for the matching optional adapter
```

## Core Fetch API

This runnable development setup generates a key at startup. Production deployments must load a stable key or use an external signer so existing tokens remain verifiable after restarts.

```ts
import { generateEs256KeyPair, inMemory, initWeldall } from "@weldall/sdk";

const key = await generateEs256KeyPair();
const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com/api",
  publicOrigin: "https://expenses.example.com",
  clientId: "weldall-cli-at-expenses",
  supportedScopes: ["expenses:read", "expenses:write"],
  signingKey: {
    kid: "development-only",
    privateJwk: key.privateJwk,
    publicJwk: key.publicJwk,
  },
  replayStore: inMemory(),
  skills: {
    items: [
      {
        id: "review",
        title: "Review expenses",
        requiredScopes: ["expenses:read"],
        visibility: "DEFAULT",
        content: "# Review expenses\n\nUse the Expenses API to review submitted expenses.",
      },
    ],
  },
});

await weldall.ready(); // optional eager discovery; exchange is otherwise lazy

export async function authenticate(request: Request) {
  return weldall.verify(request, { scopes: ["expenses:read"] });
}

export async function authenticateWithoutThrowing(request: Request) {
  return weldall.verifyNoThrow(request);
}
```

`scopes` is all-of. When `anyScopes` is present, at least one of those scopes is additionally required. An empty policy means authenticated-only.

Mount `handlers.token`, `handlers.authorizationServerMetadata`, `handlers.protectedResourceMetadata`, `handlers.jwks`, and (when configured) `handlers.skills` in the matching routes. They require a verified email in every Weldall ID-JAG, copy that identity into the local ES256 DPoP-bound `at+jwt` token, and publish local server metadata.

## Publishing skills

Configure either static `skills.items` or an async `skills.load` provider. Providers receive no user identity and must return the same catalog for every authenticated Weldall instance. Each skill uses a local ID; Weldall prefixes it with the registered resource key.

`visibility` is an extensible enum:

- `DEFAULT` keeps the skill discoverable and reports missing required scopes;
- `HIDDEN_IF_UNALLOWED` omits it when any required scope is unavailable to the user.

The protected-resource metadata advertises `weldall_skills_endpoint`. Mount `handlers.skills` at `/.well-known/weldall-skills`; the Hono adapter does this automatically. The endpoint accepts only short-lived, resource- and audience-bound `weldall-skills+jwt` Bearer assertions signed by Weldall. Skill publication therefore requires a real `ReplayStore`; `replayStore: "disabled"` is rejected when skills are configured.

## Framework adapters

### Hono

```ts
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { Hono } from "hono";

const key = await generateEs256KeyPair();
const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com/api",
  publicOrigin: "https://expenses.example.com",
  clientId: "weldall-cli-at-expenses",
  supportedScopes: ["expenses:read"],
  signingKey: { kid: "development-only", ...key },
  replayStore: inMemory(),
});
const app = new Hono<{ Variables: WeldallVariables }>();
weldall.registerRoutes(app);
app.get("/api/expenses", weldall.protect({ scopes: ["expenses:read"] }), (c) =>
  c.json({ subject: weldall.getAuth(c).identity.subject }),
);
```

### Next.js App Router

```ts
// src/lib/weldall.ts
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall } from "@weldall/sdk/next";

const key = await generateEs256KeyPair(); // load a stable key in production
export const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com/api",
  publicOrigin: "https://expenses.example.com",
  clientId: "weldall-cli-at-expenses",
  supportedScopes: ["expenses:read"],
  signingKey: { kid: "development-only", ...key },
  replayStore: inMemory(),
});
```

```ts
// app/api/expenses/route.ts
import { weldall } from "@/lib/weldall";

export const runtime = "nodejs";
export const GET = weldall.withWeldall({ scopes: ["expenses:read"] }, async (_request, auth) =>
  Response.json({ subject: auth.identity.subject }),
);
```

```ts
// app/oauth/token/route.ts
import { weldall } from "@/lib/weldall";

export const runtime = "nodejs";
export const POST = weldall.handlers.token;
```

Mount the metadata/JWKS handlers at `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, and `/.well-known/jwks.json` in the same way. When skills are configured, mount `weldall.handlers.skills` at `/.well-known/weldall-skills`.

### Astro SSR

```ts
// src/weldall.ts
import { generateEs256KeyPair, inMemory } from "@weldall/sdk";
import { initWeldall } from "@weldall/sdk/astro";

const key = await generateEs256KeyPair(); // load a stable key in production
export const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com/api",
  publicOrigin: "https://expenses.example.com",
  clientId: "weldall-cli-at-expenses",
  supportedScopes: ["expenses:read"],
  signingKey: { kid: "development-only", ...key },
  replayStore: inMemory(),
});
```

```ts
// src/middleware.ts
import { defineMiddleware, sequence } from "astro:middleware";
import { weldall } from "./weldall";

export const onRequest = sequence(weldall.protect({ scopes: ["expenses:read"] }));
```

```ts
// src/pages/api/expenses.ts
import { weldall } from "../../weldall";

export const prerender = false;
export const GET = (context) =>
  Response.json({ subject: weldall.getAuth(context).identity.subject });
```

Declare `weldallAuth` in `App.Locals`. Mount `weldall.handlers.token`, `weldall.handlers.skills`, and the metadata/JWKS handlers as Astro endpoints.

## Replay storage and security boundary

`ReplayStore.consume(key, expiresAt)` must atomically return `true` only for the first consume. Store errors fail closed. The SDK namespaces DPoP, ID-JAG, and skill-fetch assertion keys.

`inMemory()` is process-local, defaults to 10,000 live entries, and fails closed with HTTP 503 when capacity is reached. Size it approximately as `peak requests/second × 61`, or pass a larger `maxEntries`. Restarts clear it, and multiple instances do not share it. Use a shared Redis/database implementation for horizontal deployment. `replayStore: "disabled"` exists only for controlled diagnostics and is unsafe.

The SDK implements pinned ID-JAG draft-04 and JWT-DPoP draft-01 behavior. There is no DPoP nonce negotiation. Treat key rotation, shared replay storage, restart behavior, draft upgrades, and independent conformance testing as production-readiness work.

## Low-level verification primitives

The root package exports primitives for advanced integrations. They deliberately do not compose the whole sender-constrained flow:

- `verifyAccessToken` validates the token and `cnf.jkt`; the caller must also verify the request's DPoP proof with `verifyStrictDpop`, passing both `accessToken` and `expectedJkt`.
- `verifyIdJag` validates the assertion; the caller must atomically consume its `jti` before issuing a token.
- `verifyStrictDpop` should be given `expectedJkt` and a real replay store whenever it protects a sender-bound token or assertion.

Prefer `initWeldall().verify`, the token handler, or a framework adapter unless you need this lower-level control.

## Rotation and external signers

Instead of a direct key, provide `current()` and `jwks()` methods. `current()` returns a public JWK plus a `sign(payload, protectedHeader)` callback suitable for KMS/Vault. The SDK verifies provider JWKS, protected headers, payloads, and signatures before returning tokens. Keep retiring public keys in `jwks()` until every token they signed has expired.

## Errors

`verify` throws `WeldallAuthError`. `verifyNoThrow` returns `{ ok: true, auth }` or `{ ok: false, error, response }`. Adapter rejection responses use OAuth JSON, including `WWW-Authenticate` for 401/403 errors. Tokens, assertions, proofs, and key material are never logged.

Licensed under Apache-2.0.
