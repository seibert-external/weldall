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

The machine requests a token for the Git app's resource (`requestMachineToken` with `git-app:registry-read`) and reads the registry from the Git app. With several Git apps, it reads each one's registry with its own token. The endpoint, its paging and the fields of an entry are described in the Git app's [README](https://github.com/seibert-external/weldall-git-app#api).
