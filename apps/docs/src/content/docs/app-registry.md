---
title: App registry
description: Every app published through Weldall, who owns it, what it is for, and when its owner must confirm it again.
sidebar:
  label: App registry
---

Every app an employee [publishes through Weldall](../connectors/#publish-apps-to-github) is in the app registry from its first publish. IT sees what exists, who owns it, what it is for, and which apps nobody has confirmed for a while.

## What is recorded

Weldall adds the entry when it creates the app's repository. Nobody has to register an app by hand.

| Field          | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| Name           | The name given at the first publish                                           |
| Owner          | The Weldall user who published the app first                                  |
| Purpose        | What the app is for, in the owner's words                                     |
| Repository     | The Git host connector, organisation and repository, with a link to the host  |
| Template       | The template the app started from                                             |
| Preview, live  | The links the app's CI reports; Weldall shows only `https` links              |
| Created        | When the entry was created                                                    |
| Last confirmed | When the owner last confirmed the app; empty until the first confirmation     |
| Expires        | When the owner must confirm the app again                                     |
| State          | `active`, `expiring_soon` or `expired`, derived from the expiry on every read |

Name, purpose and links come from people or from the app's CI. Weldall shows them as plain text and never as markup.

## Re-verification

A new app expires 90 days after its first publish. Before that, the owner confirms that the app is still needed:

```sh
weldall app list
weldall app confirm <app-id>
```

`weldall app list` shows the owner's apps with their state and expiry, expired and expiring ones first. `weldall app confirm` sets the expiry to 90 days from now and records when and by whom. Run in the app's folder, `weldall app confirm` without an id confirms that folder's app. Both commands accept `--json`. In a desktop client with the Weldall extension, the agent can list the apps with the `list_apps` tool and tell the person which ones need confirming. It confirms an app with `confirm_app` only when the person asks for it.

Publishing does **not** confirm an app. Confirming is a deliberate act of the owner, so an app that is still updated but no longer reviewed for need does not stay active by accident.

The state follows from the expiry:

| State           | When                                                       |
| --------------- | ---------------------------------------------------------- |
| `active`        | More than 14 days before the expiry                        |
| `expiring_soon` | 14 days or less before the expiry                          |
| `expired`       | From the expiry on, until the owner confirms the app again |

### What "expired" means

An expired app is **only flagged**. Weldall does not stop, delete or block it: its owner can still publish, the git proxy still accepts pushes, and the app keeps running wherever it runs. IT sees the flag in the admin list and in the API and decides what to do. Weldall sends no notification; the owner sees the state with `weldall app list`.

## Who sees what

- **The owner** sees and confirms only their own apps. An unknown app id and another person's app get the same answer.
- **Administrators** see every app under **App registry** in the Weldall admin area: name, owner, purpose, repository, template, preview and live link, created, last confirmed, expiry and state. Expired and expiring apps come first. The list can be filtered by state and searched by app, purpose, repository and owner. It is read-only.
- **Your own tools** read the registry through a machine client with the `weldall:app-registry-read` scope (see below).

Nobody else sees the registry. Confirmations and refused confirmations are recorded in the audit log as `app_confirmation.succeeded` and `app_confirmation.denied`.

## Read the registry from your own tools

A backend, a script or a CMDB import reads the registry with [machine authentication](../machine-authentication/). Register a machine client and allow it the machine-only system scope `weldall:app-registry-read`, either under **Machine clients** or through IaC:

```yaml
machines:
  registry-export:
    clientId: registry-export
    name: App registry export
    enabled: true
    publicKeys:
      current: { kty: EC, crv: P-256, x: "…", y: "…" }
    resources: []
    scopes: ["weldall:app-registry-read"]
```

The machine requests a token for the Weldall API and calls `GET /api/app-registry/v1/apps`:

```ts
import { createDpopProof, requestMachineToken } from "@weldall/sdk";

const issuer = "https://weldall.example.com";
const token = await requestMachineToken({
  issuer,
  clientId: "registry-export",
  resource: `${issuer}/api`,
  scopes: ["weldall:app-registry-read"],
  kid: process.env.MACHINE_SIGNING_KID!,
  key,
});
const apps = [];
let cursor: string | null = null;
do {
  const url = `${issuer}/api/app-registry/v1/apps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const response = await fetch(url, {
    headers: {
      authorization: `DPoP ${token.accessToken}`,
      dpop: await createDpopProof({ ...key, method: "GET", url, accessToken: token.accessToken }),
    },
  });
  const page = await response.json();
  apps.push(...page.apps);
  cursor = page.nextCursor;
} while (cursor);
```

Query parameters, each at most once:

| Parameter | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `limit`   | Entries per page, 1 to 200; default 100                         |
| `cursor`  | The `nextCursor` of the previous page                           |
| `state`   | Only apps in this state: `active`, `expiring_soon` or `expired` |

The answer lists the apps in the order they were created, oldest first, so new apps are appended and paging neither repeats nor skips an entry. `nextCursor` is `null` on the last page. All dates are ISO 8601 in UTC.

```json
{
  "apps": [
    {
      "id": "cm3k9x2f80001",
      "name": "expense-tracker",
      "purpose": "Tracks team expenses until the finance tool supports receipts.",
      "owner": { "id": "u_8f2c", "email": "jane.adams@example.com" },
      "repository": {
        "connector": "github-apps",
        "owner": "acme-apps",
        "name": "app-expense-tracker",
        "webUrl": "https://github.com/acme-apps/app-expense-tracker"
      },
      "template": "react",
      "links": { "preview": null, "live": "https://expense-tracker.example.com/" },
      "createdAt": "2026-11-02T09:14:00.000Z",
      "confirmedAt": null,
      "expiresAt": "2027-01-31T09:14:00.000Z",
      "state": "active"
    }
  ],
  "nextCursor": null,
  "generatedAt": "2026-11-18T08:00:00.000Z",
  "reverificationDays": 90,
  "expiringSoonDays": 14
}
```

The owner is given as Weldall user id and email address, not by name. The email address lets IT reach the person and find them in its directory, and the id stays the same when the address changes. The directory already has the name, so the API leaves it out.

A token without `weldall:app-registry-read` gets `403 insufficient_scope`; a missing or invalid machine token gets `401`. The OAuth metadata announces the endpoint as `weldall_app_registry`. A Weldall server without the app registry does not know the scope, so a token request for it fails with `invalid_scope`.
