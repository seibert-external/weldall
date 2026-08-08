---
title: "How to: Integrate a service"
description: Build a web service, register it in Weldall, and publish it to employees as a skill.
sidebar:
  label: "How to: Integrate a service"
---

This walkthrough builds a small web service that lists contracts. The example uses Hono, a modern and lightweight alternative to Express. The Weldall SDK provides Hono middleware for securing its routes. Interfaces and adapters for Fetch, Next.js, and Astro are listed on the [SDKs](../sdks/) page.

The work is split between two roles: application developers secure incoming requests and publish the agent instructions. Weldall administrators register the service, enable skill discovery, and assign permissions.

## Prerequisites

You need a running Weldall instance and administrator access. If Weldall is not running yet, start with [How to: Set up Weldall](../weldall-setup/).

The example service also requires:

- Node.js 22.15 or newer
- pnpm
- an HTTPS URL for the deployed service

:::note[Result]
At the end, an authorized agent can run `weldall request --scope contracts:read https://contracts.example.com/api/contracts`.
:::

## For application developers

### 1. Create the Hono project

Create a new project and install Hono and the Weldall SDK:

```sh
mkdir weldall-contracts
cd weldall-contracts
pnpm init
pnpm pkg set type=module
pnpm add @hono/node-server @weldall/sdk hono
pnpm add --save-dev @types/node tsx typescript
mkdir src
```

### 2. Implement the contract service

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
        content:
          "# List contracts\n\nRun `weldall request --scope contracts:read https://contracts.example.com/api/contracts`.",
      },
    ],
  },
  allowInsecureLoopback: publicOrigin.startsWith("http://localhost"),
});

await weldall.ready(); // optional: validate the Weldall configuration at startup

const app = new Hono<{ Variables: WeldallVariables }>();
weldall.registerRoutes(app);

app.get("/api/contracts", weldall.protect({ scopes: ["contracts:read"] }), (context) => {
  const auth = weldall.getAuth(context);
  return context.json({
    requestedBy: auth.identity.subject,
    requestedByEmail: auth.identity.email,
    contracts: [
      { id: "contract-1001", customer: "Nordstern GmbH", status: "active" },
      { id: "contract-1002", customer: "Südwind AG", status: "review" },
    ],
  });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
```

The `skills` attribute publishes the agent instructions with the service. See [SDKs](../sdks/) for the other options and framework examples.

`weldall.protect` checks every incoming request before the handler reads contract data. The handler runs only when the request satisfies the `contracts:read` scope. The identity contains the stable Weldall subject and the verified email that Weldall signed into the ID-JAG and the SDK copied into the downstream access token. How the service uses that identity with its own user database remains application-specific.

:::note[Replay protection with horizontal scaling]
`inMemory()` stores used ID-JAGs and DPoP proofs only in the current process. With multiple service instances, one instance does not know which replays another instance has already seen. The replay store prevents an ID-JAG from being exchanged more than once and a DPoP proof from being reused; it does not mark the access token itself as consumed after one use.

Weldall issues ID-JAGs for five minutes and access tokens for ten minutes. A DPoP proof is accepted for at most 60 seconds. Decide whether these bounded windows are sufficient for your use case. If they are not, use a shared atomic replay store. See [Security](../oauth-security/) for more context.
:::

### 3. Start the service locally

Set the URL of your Weldall instance and start the service:

```sh
WELDALL_ISSUER=https://weldall.example.com \
PUBLIC_ORIGIN=http://localhost:8787 \
pnpm exec tsx src/index.ts
```

A request without Weldall authorization to `http://localhost:8787/api/contracts` is rejected. The endpoint is now protected.

### 4. Deploy the service over HTTPS

Deploy the service at a public HTTPS URL. The rest of this walkthrough uses:

```text
https://contracts.example.com
```

Set `PUBLIC_ORIGIN` to this exact URL in the deployed environment. The resource identifier, endpoints, and later Weldall configuration must use the same origin.

## For Weldall administrators

Open the administration interface of the Weldall instance.

### 1. Create the scope

Open **Scopes**, select **Create scope**, and enter:

| Field       | Value            |
| ----------- | ---------------- |
| Scope key   | `contracts:read` |
| Description | `Read contracts` |

### 2. Register the resource

Open **Resources**, select **Create resource**, and use these values:

| Field                | Value                               |
| -------------------- | ----------------------------------- |
| Resource key         | `contracts`                         |
| Name                 | `Contracts`                         |
| Resource identifier  | `https://contracts.example.com/api` |
| Authorization server | `https://contracts.example.com`     |
| Downstream client ID | `weldall-cli-at-contracts`          |
| Request prefixes     | `https://contracts.example.com/api` |
| Scopes               | `contracts:read`                    |
| Enabled              | on                                  |
| Discover skills      | on                                  |

The values must match the configuration in the Hono service. Weldall does not send credentials or request data to URLs outside the registered prefixes.

### 3. Check skill discovery

Open **Skills** and check that `contracts.list` is shown from the `contracts` resource. Weldall automatically prefixes the local skill ID `list` from the SDK configuration with the resource key.

### 4. Assign permission

Open **Assignments** and create an assignment for the test user's email address. Assign `weldall:login` so the user may authenticate the CLI with this Weldall server, plus `contracts:read` for the service capability. Weldall never grants `weldall:login` automatically from the identity provider; assign it before the user's first CLI login. Removing it blocks new CLI login, token refresh, and further downstream token issuance, while already-issued CLI access tokens expire normally. Browser UI login and browser sessions are unaffected.

### 5. Test the integration

Sign in on the test user's device and inspect the published skill:

```sh
weldall login
weldall skills
weldall skills show contracts.list
```

The agent can then run the request described by the skill:

```sh
weldall request \
  --scope contracts:read \
  https://contracts.example.com/api/contracts
```

The service returns the contract list together with the identity for which Weldall authorized the request. Remove the assignment and the same request is rejected; a skill configured as **Hidden if unallowed** also disappears.
