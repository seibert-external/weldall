# @weldall/sdk

Weldall's Node.js resource-server SDK for Fetch, Hono 4, Next.js 16 App Router, and Astro 7 SSR.

## Requirements

- Node.js `>=22.15.0`
- Node runtime only (Next.js routes must export `runtime = "nodejs"`)
- HTTPS origins; loopback HTTP requires `allowInsecureLoopback: true`

## Install

```sh
pnpm add @weldall/sdk
# add hono, next, or astro for the matching optional adapter
```

## Core

```ts
import { inMemory, initWeldall } from "@weldall/sdk";

const weldall = initWeldall("https://weldall.example.com", {
  resource: "https://expenses.example.com/api",
  publicOrigin: "https://expenses.example.com",
  clientId: "weldall-cli-at-expenses",
  supportedScopes: ["expenses:read", "expenses:write"],
  signingKey: { kid, privateJwk, publicJwk },
  replayStore: inMemory(),
});

await weldall.ready(); // optional eager discovery; exchange is otherwise lazy
const auth = await weldall.verify(request, { scopes: ["expenses:read"] });
const result = await weldall.verifyNoThrow(request);
```

`scopes` is all-of. When `anyScopes` is also present, at least one of those scopes is additionally required. An empty policy means authenticated-only.

`handlers.token`, `handlers.authorizationServerMetadata`, `handlers.protectedResourceMetadata`, and `handlers.jwks` are standard Fetch handlers. They exchange Weldall ID-JAGs for local ES256 DPoP-bound `at+jwt` tokens and publish the local server metadata.

## Replay storage

`ReplayStore.consume(key, expiresAt)` must atomically return `true` only for the first consume. The SDK namespaces DPoP and ID-JAG keys. Store errors fail closed. `inMemory({ suppressWarning: true })` is process-local and suitable only for single-process development. A shared Redis/database implementation is required for horizontal deployments. Explicit `replayStore: "disabled"` is supported for controlled diagnostics only and is unsafe.

## Rotation and external signers

Instead of a direct key, provide `current()` and `jwks()` methods. `current()` returns a public JWK plus a `sign(payload, protectedHeader)` callback suitable for KMS/Vault. The SDK verifies provider JWKS, protected headers, payloads, and signatures before returning tokens. Keep retiring public keys in `jwks()` until every token they signed has expired.

## Framework adapters

- `@weldall/sdk/hono`: `protect`, `getAuth`, `registerRoutes`; use `Hono<{ Variables: WeldallVariables }>`.
- `@weldall/sdk/next`: `withWeldall(policy, (_request, auth, routeContext) => ...)`; mount Fetch `handlers`; Node runtime only.
- `@weldall/sdk/astro`: `protect`, `getAuth`, Astro-shaped `handlers`; declare `weldallAuth` in `App.Locals`; SSR/on-demand rendering only.

See `examples/basic`, `examples/hono`, `examples/next`, and `examples/astro`.

## Migration from the prototype

Replace prototype OAuth-package imports with root low-level helpers or the relevant SDK adapter. Deployment-specific issuer/resource/client constants belong in application configuration, not this package. Hono applications should remove custom token, metadata, JWKS, access-token, and DPoP middleware and use `registerRoutes()` plus `protect()` as shown in `examples/hono` and `apps/expenses`.

## Errors

`verify` throws `WeldallAuthError`. `verifyNoThrow` returns `{ ok: true, auth }` or `{ ok: false, error, response }`. Adapter rejection responses are the same core OAuth JSON responses, including `WWW-Authenticate` for 401/403 errors. Tokens, assertions, proofs, and key material are never logged.

Licensed under Apache-2.0.
