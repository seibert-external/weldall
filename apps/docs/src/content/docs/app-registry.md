---
title: App registry
description: Every app published through a Git app, who owns it, what it is for, and when its owner must confirm it again.
sidebar:
  label: App registry
---

Every app an employee publishes through a [Git app](../git-app/) is in that Git app's app registry from its first publish. Administrators see what exists, who owns it, what it is for, and which apps nobody has confirmed for a while. Each Git app keeps the registry of its own apps in its own database; Weldall keeps no app records, but its audit log records every registration and confirmation.

## What is recorded

The Git app adds the entry when it creates the app's repository. Nobody has to register an app by hand. An administrator can also register an existing repository of the organisation as an app (`POST /api/admin/apps`, see the Git app's [README](https://github.com/seibert-external/weldall-git-app#api)).

| Field          | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| Name           | The name given at the first publish                                           |
| Owner          | The Weldall user who published the app first                                  |
| Purpose        | What the app is for, in the owner's words                                     |
| Repository     | The organisation and repository on the Git app's host, with a link            |
| Template       | The template the app started from                                             |
| Preview, live  | The links the app's CI reports; the Git app keeps only `https` links          |
| Created        | When the entry was created                                                    |
| Last confirmed | When the owner last confirmed the app; empty until the first confirmation     |
| Expires        | When the owner must confirm the app again                                     |
| State          | `active`, `expiring_soon` or `expired`, derived from the expiry on every read |

Name, purpose and links come from people or from the app's CI. Show them as plain text, never as markup.

## Re-verification

A new app expires 90 days after its first publish. Before that, the owner confirms that the app is still needed:

```sh
weldall app list
weldall app confirm <app-id>
```

`weldall app list` asks every Git app the owner may publish with and shows their apps with state and expiry, the earliest expiry first. `weldall app confirm` sets the expiry to 90 days from now and records when and by whom. Run in the app's folder, `weldall app confirm` without an id confirms that folder's app at its Git app; with an id, the CLI finds the Git app whose registry lists the app, or takes `--git-app <resource key>`. Both commands accept `--json`. In a desktop client with the Weldall extension, the agent can list the apps with the `list_apps` tool and tell the person which ones need confirming. It confirms an app with `confirm_app` only when the person asks for it.

Publishing does **not** confirm an app. Confirming is a deliberate act of the owner, so an app that is still updated but no longer reviewed for need does not stay active by accident.

The state follows from the expiry:

| State           | When                                                       |
| --------------- | ---------------------------------------------------------- |
| `active`        | More than 14 days before the expiry                        |
| `expiring_soon` | 14 days or less before the expiry                          |
| `expired`       | From the expiry on, until the owner confirms the app again |

### What "expired" means

An expired app is **only flagged**. Nothing stops, deletes or blocks it: its owner can still publish, the Git app still accepts pushes, and the app keeps running wherever it runs. Administrators see the flag in the Git app's API and decide what to do. Nobody is notified; the owner sees the state with `weldall app list`.

## Who sees what

Everything is read from the Git app's API at its origin, for example `https://git-app.example.com/api`. The person or machine needs the scope on the Git app's resource in Weldall:

- **The owner** (`git-app:publish`) sees and confirms only their own apps: `GET /api/apps` and `POST /api/apps/{id}/confirm`, which `weldall app list` and `weldall app confirm` call. An unknown app id and another person's app get the same answer.
- **Administrators** (`git-app:admin`) see every app with its owner (Weldall user id and email address), who registered it and who confirmed it last: `GET /api/admin/apps`, expired and expiring apps first, filtered by `state` and searched with `q` (app, purpose, repository, owner), paged with `page` and `pageSize`. There is no admin page yet; an administrator's agent calls it with `weldall request`, guided by the Git app's skill `<resource key>.admin-apps`.
- **Your own tools** read the whole registry through a machine client with `git-app:registry-read` (see below).

Nobody else sees the registry. Registrations, confirmations and refused confirmations are recorded in Weldall's audit log as `git_repository.created`, `git_repository.registered`, `app_confirmation.succeeded` and `app_confirmation.denied`.

## Read the registry from your own tools

A backend, a script or a CMDB import reads the registry with [machine authentication](../machine-authentication/). Register a machine client and allow it the Git app's resource and the scope `git-app:registry-read`, either under **Machine clients** or through IaC:

```yaml
machines:
  registry-export:
    clientId: registry-export
    name: App registry export
    enabled: true
    publicKeys:
      current: { kty: EC, crv: P-256, x: "…", y: "…" }
    resources: [git-app]
    scopes: ["git-app:registry-read"]
```

The machine requests a token for the Git app's resource and calls `GET /api/registry/apps` there. With several Git apps, read each one's registry with its own token.

```ts
import { createDpopProof, requestMachineToken } from "@weldall/sdk";

const gitApp = "https://git-app.example.com";
const token = await requestMachineToken({
  issuer: "https://weldall.example.com",
  clientId: "registry-export",
  resource: `${gitApp}/api`,
  scopes: ["git-app:registry-read"],
  kid: process.env.MACHINE_SIGNING_KID!,
  key,
});
const apps = [];
let cursor: string | null = null;
do {
  const url = `${gitApp}/api/registry/apps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
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

The answer lists the apps oldest first, so new apps are usually appended; `nextCursor` is `null` on the last page. Paging never repeats an entry, but an entry whose registration committed late can land behind a cursor already passed, so read the whole list again for a complete picture. All dates are ISO 8601 in UTC.

```json
{
  "resource": "https://git-app.example.com/api",
  "apps": [
    {
      "id": "app_3f2a9c0d1e4b5a6f7081",
      "name": "expense-tracker",
      "purpose": "Tracks team expenses until the finance tool supports receipts.",
      "owner": { "id": "u_8f2c", "email": "jane.adams@example.com" },
      "registeredBy": "u_8f2c",
      "confirmedBy": null,
      "repository": {
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

`resource` is the resource identifier of the Git app that answered.

The owner is given as Weldall user id and email address, not by name. The email address is the one in the owner's last token; it is `null` for an app an administrator registered until its owner has used the Git app. The id stays the same when the address changes, and Weldall's directory has the name.

The endpoint is for machine clients only: a person's token gets `403`. A token without `git-app:registry-read` gets `403`; a missing or invalid token gets `401`.
