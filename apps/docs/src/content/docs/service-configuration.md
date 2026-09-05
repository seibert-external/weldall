---
title: "How to: Integrate a service"
description: Protect a service with the TypeScript or Python SDK, register it in Weldall, and publish a skill.
sidebar:
  label: Registration
---

An employee asks an agent to list contracts. The service should return them only when the employee has permission. The SDK checks the request before the service reads the data. A skill tells the agent which command to run:

```sh
weldall request --scope contracts:read https://contracts.example.com/api/contracts
```

Application developers protect the route and publish the skill. Weldall administrators register the service and assign permissions.

## 1. Build the service

Choose the guide for your service's language:

- [TypeScript](./typescript/): build the contract service with Hono and `@weldall/sdk`. The page also links to the Fetch, Next.js, and Astro examples on GitHub.
- [Python](./python/): build the same service with FastAPI and `weldall-sdk`, or use the Django example on GitHub.

Both guides use the registration values below. You need a running Weldall instance and administrator access. If Weldall is not running yet, start with [How to: Set up Weldall](../weldall-setup/).

## For Weldall administrators

Once the service is available over HTTPS, open the administration interface of your Weldall instance.

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

The values must match the service configuration. Weldall does not send credentials or request data to URLs outside the registered prefixes.

### 3. Check skill discovery

Open **Skills** and check that `contracts.list` is shown from the `contracts` resource. Weldall prefixes the local skill ID `list` with the resource key.

### 4. Assign permission

Assign `weldall:login` and `contracts:read` to the test user. Use **Assignments** for the user's email address, or **Group assignments** for a matching provider group. Assign `weldall:login` before the user's first CLI login; Weldall does not grant it automatically through the identity provider.

### 5. Test the integration

Sign in on the test user's device and inspect the published skill:

```sh
weldall login
weldall skills
weldall skills show contracts.list
```

Run the request from the skill:

```sh
weldall request \
  --scope contracts:read \
  https://contracts.example.com/api/contracts
```

The service returns the contract list and the identity for which Weldall authorized the request.

Remove the user's effective `contracts:read` permission and check again. Weldall hides the skill and stops issuing new authorization for that scope. An already-issued access token can remain valid until it expires. See [Security](../oauth-security/) for token lifetimes and revocation behavior.
