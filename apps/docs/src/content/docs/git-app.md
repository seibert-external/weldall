---
title: "How to: Run the Git app"
description: Run the Git app that keeps the repositories of published apps on your GitHub or Forgejo, and register it in Weldall.
sidebar:
  label: "How to: Run the Git app"
---

Employees [publish apps](../publish-apps/) they built with an agent to your organisation's Git host. The **Git app** does the work on the Git host: it creates the repositories, serves git for them, and opens the pull requests. It is a separate service that your organisation runs next to Weldall, one instance per Git host, and that you register in Weldall as a [resource](../service-configuration/).

The split of responsibilities:

- **The Git app** holds the Git host's secret (the GitHub App's private key or the Forgejo bot user's access token). The secret never leaves it.
- **Weldall** decides who may publish, keeps the [app registry](../app-registry/) and stores the audit log. The Git app asks Weldall on every request and reports every repository creation, push, fetch, pull request and git credential to it.

This guide is for the administrators who run the Git app and register it in Weldall. The host-specific steps are in [How to: Connect GitHub](../github-app/) and [How to: Connect Forgejo](../forgejo/).

## Before you start

- A running Weldall and administrator access to it.
- A public HTTPS origin for the Git app, for example `https://git-app.example.com`. The Git app must be served at the root of that origin, not under a path. Terminate TLS in front of the container.
- The Git host prepared as described in [How to: Connect GitHub](../github-app/) or [How to: Connect Forgejo](../forgejo/). From there you bring the host configuration and the host secret.

Employees' devices reach the Git app over HTTPS. The Git app reaches Weldall and the Git host, and Weldall reaches the Git app to discover its skills.

## 1. Generate the keys

The Git app needs two ES256 key pairs and one random key:

- a **signing key** for the access tokens its own authorization server issues,
- a **machine key** for its machine client in Weldall,
- a **git credential key** that signs the short-lived git credentials.

The generator only needs Node.js:

```sh
docker run --rm node:24-slim node -e '
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const jwk = (key) => JSON.stringify(key.export({ format: "jwk" }));
const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
const machine = generateKeyPairSync("ec", { namedCurve: "P-256" });
console.log("GIT_APP_SIGNING_KID=git-app-signing-1");
console.log(`GIT_APP_SIGNING_PUBLIC_JWK=${jwk(signing.publicKey)}`);
console.log(`GIT_APP_SIGNING_PRIVATE_JWK=${jwk(signing.privateKey)}`);
console.log("WELDALL_MACHINE_KID=git-app-machine-1");
console.log(`WELDALL_MACHINE_PUBLIC_JWK=${jwk(machine.publicKey)}`);
console.log(`WELDALL_MACHINE_PRIVATE_JWK=${jwk(machine.privateKey)}`);
console.log(`GIT_APP_GIT_CREDENTIAL_KEY=${randomBytes(32).toString("base64")}`);'
```

Store the output in your secret manager. The private JWKs and the git credential key are secrets; the public JWKs and key IDs are not.

## 2. Configure the Git app

The Git app reads its configuration from the environment. Every secret comes either from a variable or from a file whose path is in `<NAME>_FILE`, never both. Prefer files mounted from your secret manager.

| Variable                                            | Required | Meaning                                                                                                                                 |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_APP_HOST`                                      | yes      | `github` or `forgejo`.                                                                                                                  |
| `GIT_APP_HOST_CONFIG` or `GIT_APP_HOST_CONFIG_FILE` | yes      | The host configuration as JSON, see [GitHub](../github-app/#5-configure-the-git-app) or [Forgejo](../forgejo/#7-configure-the-git-app). |
| `GIT_APP_HOST_SECRET` or `GIT_APP_HOST_SECRET_FILE` | yes      | Secret: the GitHub App's private key, or the Forgejo bot user's access token.                                                           |
| `GIT_APP_PUBLIC_ORIGIN`                             | yes      | The Git app's public origin, for example `https://git-app.example.com`, without path or trailing slash.                                 |
| `GIT_APP_RESOURCE_IDENTIFIER`                       | no       | The resource identifier registered in Weldall. Default: `<origin>/api`.                                                                 |
| `GIT_APP_DOWNSTREAM_CLIENT_ID`                      | yes      | The downstream client ID registered on the resource in Weldall, for example `weldall-cli-at-git-app`.                                   |
| `GIT_APP_SIGNING_KID`, `GIT_APP_SIGNING_PUBLIC_JWK` | yes      | Key ID and public JWK of the signing key.                                                                                               |
| `GIT_APP_SIGNING_PRIVATE_JWK` or `..._FILE`         | yes      | Secret: the private JWK of the signing key.                                                                                             |
| `GIT_APP_GIT_CREDENTIAL_KEY` or `..._FILE`          | yes      | Secret: the git credential key, base64 of at least 32 random bytes.                                                                     |
| `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY` or `..._FILE` | no       | Secret: the previous git credential key during a [rotation](#rotate-the-git-credential-key).                                            |
| `GIT_APP_PUBLISH_SCOPE`                             | no       | Default `git-app:publish`. Keep the default, see the note below.                                                                        |
| `GIT_APP_ADMIN_SCOPE`                               | no       | Default `git-app:admin`. Keep the default, see the note below.                                                                          |
| `WELDALL_ISSUER`                                    | yes      | Weldall's origin, for example `https://weldall.example.com`.                                                                            |
| `WELDALL_MACHINE_CLIENT_ID`                         | yes      | The client ID of the Git app's machine client in Weldall, for example `git-app-machine`.                                                |
| `WELDALL_MACHINE_KID`, `WELDALL_MACHINE_PUBLIC_JWK` | yes      | Key ID and public JWK of the machine key.                                                                                               |
| `WELDALL_MACHINE_PRIVATE_JWK` or `..._FILE`         | yes      | Secret: the private JWK of the machine key.                                                                                             |
| `PORT`                                              | no       | Default `3002`.                                                                                                                         |

A missing or invalid configuration stops the Git app at start. It lists every problem by variable name and never prints a value.

:::note[Keep the default scope names]
The Weldall CLI recognises a Git app by the scopes `git-app:publish` and `git-app:admin`. With other scope names, `weldall app publish` and the other `weldall app` commands do not find the Git app. Several Git apps share the same two scopes.
:::

## 3. Run the container

The image is `docker.io/seibertgroup/weldall-git-app`, see [Docker images](../docker/). Run one container per Git host:

```sh
docker run -d --name weldall-git-app -p 3002:3002 \
  -e GIT_APP_HOST=github \
  -e GIT_APP_HOST_CONFIG_FILE=/run/secrets/host.json \
  -e GIT_APP_HOST_SECRET_FILE=/run/secrets/github-app.pem \
  -e GIT_APP_PUBLIC_ORIGIN=https://git-app.example.com \
  -e GIT_APP_DOWNSTREAM_CLIENT_ID=weldall-cli-at-git-app \
  -e GIT_APP_SIGNING_KID=git-app-signing-1 \
  -e GIT_APP_SIGNING_PUBLIC_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…"}' \
  -e GIT_APP_SIGNING_PRIVATE_JWK_FILE=/run/secrets/signing.jwk \
  -e GIT_APP_GIT_CREDENTIAL_KEY_FILE=/run/secrets/git-credential.key \
  -e WELDALL_ISSUER=https://weldall.example.com \
  -e WELDALL_MACHINE_CLIENT_ID=git-app-machine \
  -e WELDALL_MACHINE_KID=git-app-machine-1 \
  -e WELDALL_MACHINE_PUBLIC_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…"}' \
  -e WELDALL_MACHINE_PRIVATE_JWK_FILE=/run/secrets/machine.jwk \
  -v /srv/git-app/secrets:/run/secrets:ro \
  docker.io/seibertgroup/weldall-git-app:X.Y.Z
```

- The container listens on plain HTTP on `PORT` and answers `GET /health` with `{ "status": "ok" }`.
- It runs as the unprivileged user with uid 1000. The mounted files must be readable by that user.
- **Run exactly one container per Git app.** The Git app keeps its replay protection and its transfer and credential limits in the memory of its process; a second container would not see them.
- **Stop timeout.** On `SIGTERM` the Git app stops accepting requests and gives running ones at most 8 seconds. Set your platform's stop timeout to 10 seconds or more (`docker stop --time`, Compose `stop_grace_period`, Kubernetes `terminationGracePeriodSeconds`). A push or fetch that runs longer is cut off and fails on the employee's machine, so restart or upgrade the Git app while nobody is publishing.

## 4. Register the Git app in Weldall

Open the administration interface of your Weldall instance.

### Create the scopes

Under **Scopes**, create:

| Scope key         | Allows                                                        |
| ----------------- | ------------------------------------------------------------- |
| `git-app:publish` | Publish apps, sync them, and read their status                |
| `git-app:admin`   | Run the [set-up checklist](#5-run-the-checklist) of a Git app |

A second Git app uses the same two scopes.

### Register the resource

Under **Resources**, create a resource:

| Field                | Value                              |
| -------------------- | ---------------------------------- |
| Resource key         | `git-app`                          |
| Name                 | `Git app (GitHub)`                 |
| Resource identifier  | `https://git-app.example.com/api`  |
| Authorization server | `https://git-app.example.com`      |
| Downstream client ID | `weldall-cli-at-git-app`           |
| Request prefixes     | `https://git-app.example.com/api`  |
| Scopes               | `git-app:publish`, `git-app:admin` |
| Enabled              | on                                 |
| Discover skills      | on                                 |

The values must match the Git app's configuration. The authorization server is the bare origin from `GIT_APP_PUBLIC_ORIGIN`; the CLI does not accept a Git app whose authorization server has a path. The resource key is what employees pass as `--git-app` when several Git apps exist, and it prefixes the Git app's skills.

With **Discover skills** on, Weldall shows two skills of the Git app in the catalog:

- `git-app.publish-app` tells agents how to publish, sync and read the status. It is shown to everyone, so an agent can name the missing scope.
- `git-app.admin-checklist` tells an administrator's agent how to run the checklist. It is shown only with `git-app:admin`.

Once apps are registered for the resource, Weldall no longer lets you delete it.

### Register the machine client

The Git app talks to Weldall with its own machine client. Under **Machine clients**, select **Register machine** and enter the client ID from `WELDALL_MACHINE_CLIENT_ID`, the machine public JWK and its key ID. Under **Machine access**, select:

- **Resources:** the Git app's own resource, `git-app`.
- **Scopes:** `weldall:app-host` and `weldall:subject-scopes-check`.

`weldall:app-host` lets the Git app register apps, update their links and report audit events, always only for the apps of its own resource. `weldall:subject-scopes-check` lets it ask on every request whether the person may still use Weldall and still holds `git-app:publish`. See [Machine authentication](../machine-authentication/).

### Assign the scopes

Assign `weldall:login` and `git-app:publish` to the employees who publish apps, for example through a group assignment. Assign `git-app:admin` to the administrators who run the checklist.

### Or declare it in IaC

Scopes, the resource, the machine client and the assignments can also be declared with [infrastructure as code](../infrastructure-as-code/). The Git app's secrets never belong there:

```yaml
scopes:
  git_app_publish:
    key: git-app:publish
    description: Publish apps
  git_app_admin:
    key: git-app:admin
    description: Run the Git app checklist

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

## 5. Run the checklist

As an administrator with `git-app:admin`, signed in with `weldall login`, run:

```sh
weldall app checklist
```

The Git app asks its Git host about its access, the organisation, the templates, the reviewer team, the default-branch rule and the commit identity. It only reads. Each check passes, fails or cannot be verified, with the reason and what to do. The command exits with code `3` when a required check fails, and `--json` prints the report for scripts. Every run is recorded in Weldall's audit log as `git_host.checked`, because it uses the Git host's secret.

Some checks need an existing repository, for example the reviewer team's write access and the default-branch rule. Before the first app exists, they cannot be verified. After the first publish, name a published app from the [app registry](../app-registry/):

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

## Rotate the git credential key

A git credential is valid for five minutes. The Git app checks it against the current key and, if set, the previous one:

1. Generate a new key, for example with `openssl rand -base64 32`.
2. Set the new key as `GIT_APP_GIT_CREDENTIAL_KEY` and the old one as `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY`, and restart the Git app.
3. After five minutes, remove `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY` and restart again.

Replacing the key without the previous slot invalidates every git credential it signed. No other mechanism revokes a single git credential. That is why the Git app asks Weldall again on every git request whether the person may still publish: removing `git-app:publish` stops the next request.

:::caution[Status]
The Git app is tested against simulated GitHub and Forgejo APIs and a simulated Weldall, and its git proxy against a real git server. On 19 November 2026 it ran against github.com with a test GitHub App, the real CLI and a local Weldall development server: the set-up checklist, creating a repository from a template, fetching and pushing through the git proxy, refused pushes, opening a pull request, the status, `weldall app sync`, and the registry and audit entries in Weldall. Not yet verified: a browser login (the session was prepared), the production build and the Docker image in a deployment, registration through the admin UI or infrastructure as code, a reviewer team that really has write access (its answer was simulated) and a real branch rule, checks, commit statuses, deployments and the preview and live links (the test App lacked those permissions), Forgejo, public hosting, the limits under load, and the sandbox.
:::
