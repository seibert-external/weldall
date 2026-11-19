---
title: "How to: Run the Git app"
description: Run the Git app that keeps the repositories of published apps on your GitHub or Forgejo, and register it in Weldall.
sidebar:
  label: "How to: Run the Git app"
---

Employees [publish apps](../publish-apps/) they built with an agent to your organisation's Git host. The **Git app** does the work on the Git host: it creates the repositories, serves git for them, and opens the pull requests. It is a separate service that your organisation runs next to Weldall, one instance per Git host, and that you register in Weldall as a [resource](../service-configuration/). Its code, its Docker image and its operating instructions live in its own repository, [seibert-external/weldall-git-app](https://github.com/seibert-external/weldall-git-app).

The split of responsibilities:

- **The Git app** holds the Git host's secret (the GitHub App's private key or the Forgejo bot user's access token). The secret never leaves it. It also keeps the [app registry](../app-registry/) in its own PostgreSQL database.
- **Weldall** decides who may publish and stores the audit log. The Git app asks Weldall on every request and reports every repository creation, push, fetch, pull request, git credential and app confirmation to it. Weldall keeps no app records.

This guide is for the administrators who run the Git app and register it in Weldall. The host-specific steps are in [How to: Connect GitHub](../github-app/) and [How to: Connect Forgejo](../forgejo/).

## Before you start

- A running Weldall and administrator access to it.
- A public HTTPS origin for the Git app, for example `https://git-app.example.com`. The Git app must be served at the root of that origin, not under a path. Terminate TLS in front of the container.
- A PostgreSQL database for the Git app's app registry, one per Git app.
- The Git host prepared as described in [How to: Connect GitHub](../github-app/) or [How to: Connect Forgejo](../forgejo/). From there you bring the host configuration and the host secret.

Employees' devices reach the Git app over HTTPS. The Git app reaches Weldall, its database and the Git host, and Weldall reaches the Git app to discover its skills.

## 1. Run the Git app

The Git app's [README](https://github.com/seibert-external/weldall-git-app#readme) describes how to run it: the keys to generate (a signing key for its own authorization server, a machine key for its machine client in Weldall, and a git credential key), every configuration variable, the Docker image `docker.io/seibertgroup/weldall-git-app` with a complete `docker run` example, the database, and how to rotate the keys. The parts that concern Weldall:

| Variable                                            | Meaning                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GIT_APP_PUBLIC_ORIGIN`                             | The Git app's public origin, for example `https://git-app.example.com`, without path or trailing slash. |
| `GIT_APP_RESOURCE_IDENTIFIER`                       | The resource identifier registered in Weldall. Default: `<origin>/api`.                                 |
| `GIT_APP_DOWNSTREAM_CLIENT_ID`                      | The downstream client ID registered on the resource in Weldall, for example `weldall-cli-at-git-app`.   |
| `WELDALL_ISSUER`                                    | Weldall's origin, for example `https://weldall.example.com`.                                            |
| `WELDALL_MACHINE_CLIENT_ID`                         | The client ID of the Git app's machine client in Weldall, for example `git-app-machine`.                |
| `WELDALL_MACHINE_KID`, `WELDALL_MACHINE_PUBLIC_JWK` | Key ID and public JWK of the machine key, registered on that machine client.                            |
| `GIT_APP_PUBLISH_SCOPE`, `GIT_APP_ADMIN_SCOPE`      | Defaults `git-app:publish` and `git-app:admin`. Keep the defaults, see the note below.                  |

:::note[Keep the default scope names]
The Weldall CLI recognises a Git app by the scopes `git-app:publish` and `git-app:admin`. With other scope names, `weldall app publish` and the other `weldall app` commands do not find the Git app. Several Git apps share the same scopes.
:::

## 2. Register the Git app in Weldall

Open the administration interface of your Weldall instance.

### Create the scopes

Under **Scopes**, create:

| Scope key               | Allows                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `git-app:publish`       | Publish apps, sync them, read their status, and list and confirm one's own apps                                   |
| `git-app:admin`         | Run the [set-up checklist](#3-run-the-checklist), see every app, and register an existing repository              |
| `git-app:registry-read` | Machine clients of your own tools [read the app registry](../app-registry/#read-the-registry-from-your-own-tools) |

A second Git app uses the same scopes.

### Register the resource

Under **Resources**, create a resource:

| Field                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| Resource key         | `git-app`                                                   |
| Name                 | `Git app (GitHub)`                                          |
| Resource identifier  | `https://git-app.example.com/api`                           |
| Authorization server | `https://git-app.example.com`                               |
| Downstream client ID | `weldall-cli-at-git-app`                                    |
| Request prefixes     | `https://git-app.example.com/api`                           |
| Scopes               | `git-app:publish`, `git-app:admin`, `git-app:registry-read` |
| Enabled              | on                                                          |
| Discover skills      | on                                                          |

The values must match the Git app's configuration. The authorization server is the bare origin from `GIT_APP_PUBLIC_ORIGIN`; the CLI does not accept a Git app whose authorization server has a path. The resource key is what employees pass as `--git-app` when several Git apps exist, and it prefixes the Git app's skills.

With **Discover skills** on, Weldall shows the Git app's skills in the catalog:

- `git-app.publish-app` tells agents how to publish, sync, read the status, and list and confirm one's apps. It is shown to everyone, so an agent can name the missing scope.
- `git-app.admin-checklist` tells an administrator's agent how to run the checklist. It is shown only with `git-app:admin`.
- `git-app.admin-apps` tells an administrator's agent how to read the [app registry](../app-registry/) and register an existing repository. It is shown only with `git-app:admin`.

### Register the machine client

The Git app talks to Weldall with its own machine client. Under **Machine clients**, select **Register machine** and enter the client ID from `WELDALL_MACHINE_CLIENT_ID`, the machine public JWK and its key ID. Under **Machine access**, select:

- **Resources:** the Git app's own resource, `git-app`.
- **Scopes:** `weldall:app-host` and `weldall:subject-scopes-check`.

`weldall:app-host` lets the Git app report audit events, always only for its own resource. `weldall:subject-scopes-check` lets it ask on every request whether the person may still use Weldall and still holds `git-app:publish`. See [Machine authentication](../machine-authentication/).

### Assign the scopes

Assign `weldall:login` and `git-app:publish` to the employees who publish apps, for example through a group assignment. Assign `git-app:admin` to the administrators who run the checklist and review the app registry.

### Or declare it in IaC

Scopes, the resource, the machine client and the assignments can also be declared with [infrastructure as code](../infrastructure-as-code/). The Git app's secrets never belong there:

```yaml
scopes:
  git_app_publish:
    key: git-app:publish
    description: Publish apps
  git_app_admin:
    key: git-app:admin
    description: Run the Git app checklist and see every app
  git_app_registry_read:
    key: git-app:registry-read
    description: Read the app registry

resources:
  git_app:
    key: git-app
    name: Git app (GitHub)
    resourceIdentifier: https://git-app.example.com/api
    authorizationServer: https://git-app.example.com
    downstreamClientId: weldall-cli-at-git-app
    enabled: true
    skillDiscoveryEnabled: true
    requestPrefixes:
      - https://git-app.example.com/api
    scopes:
      - git-app:publish
      - git-app:admin
      - git-app:registry-read

machines:
  git_app:
    clientId: git-app-machine
    name: Git app (GitHub)
    enabled: true
    publicKeys:
      git-app-machine-1: { kty: EC, crv: P-256, x: "…", y: "…" }
    resources:
      - git-app
    scopes:
      - weldall:app-host
      - weldall:subject-scopes-check
```

## 3. Run the checklist

As an administrator with `git-app:admin`, signed in with `weldall login`, run:

```sh
weldall app checklist
```

The Git app asks its Git host about its access, the organisation, the templates, the reviewer team, the default-branch rule and the commit identity. It only reads. Each check passes, fails or cannot be verified, with the reason and what to do. The command exits with code `3` when a required check fails, and `--json` prints the report for scripts. Every run is recorded in Weldall's audit log as `git_host.checked`, because it uses the Git host's secret.

Some checks need an existing repository, for example the reviewer team's write access and the default-branch rule. Before the first app exists, they cannot be verified. After the first publish, name a published app from the [app registry](../app-registry/) (`weldall app list` shows its id):

```sh
weldall app checklist --app <app-id>
```

When Weldall lists several Git apps for you, add `--git-app <resource key>`.

## Several Git apps

Run one Git app per Git host, for example one for GitHub and one for Forgejo, each with its own origin, resource, machine client and keys. When an employee may publish to more than one, the first publish of an app stops and lists the Git apps. The employee chooses with `--git-app <resource key>`, and the app folder remembers the choice.

The CLI sends a token or a git credential only to the origin Weldall lists for that resource key. If you later change a Git app's origin in Weldall, the CLI refuses app folders that still point to the old address and names the new one.

## Rotate the host secret

1. Create the new secret on the Git host: a new private key of the GitHub App, or a new access token of the Forgejo bot user with the same scopes. Both GitHub and Forgejo keep the old one valid until you delete it.
2. Replace the secret file of the Git app and restart it while nobody is publishing.
3. Run `weldall app checklist`.
4. Delete the old key or token on the Git host.

The Git app's other keys (its signing key, its machine key and the git credential key) are rotated as its [README](https://github.com/seibert-external/weldall-git-app#readme) describes. A git credential is valid for five minutes and cannot be revoked on its own. That is why the Git app asks Weldall again on every git request whether the person may still publish: removing `git-app:publish` stops the next request.

:::caution[Status]
The Git app is tested against simulated GitHub and Forgejo APIs and a simulated Weldall, its git proxy against a real git server and its registry against a real PostgreSQL. On 19 November 2026 it ran against github.com with a test GitHub App, the real CLI and a local Weldall development server, then still with the registry in Weldall. What is not verified yet is listed in the Git app's [README](https://github.com/seibert-external/weldall-git-app#not-built-yet).
:::
