# Git app

The Git app keeps the repositories of people's apps on one Git host (GitHub through a GitHub App, or Forgejo through a bot user). It is a separate service that an organisation registers in Weldall as a resource, secured with `@weldall/sdk` like any other service (see `apps/expenses`). It talks to Weldall through the app host API in `packages/sdk/src/app-host.ts`: the registry, ownership, permission checks and the audit log stay in Weldall; the Git host secret stays in the Git app.

Each running instance serves exactly one Git host. Run two instances (two resources) for GitHub and Forgejo.

Status: first part. Repository creation, pull requests, status, links and the set-up checklist work against the fake host and fake Weldall in the tests. Nothing here has run against a real GitHub, Forgejo or Weldall yet. See [Not built yet](#not-built-yet).

## Layout

| Path                                                | What                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                      | Entry point: loads the configuration (fails fast) and serves on `PORT`.                                                                                               |
| `src/app.ts`                                        | Hono app: the SDK's authorization server routes, `/health`, the protected API routes.                                                                                 |
| `src/config.ts`                                     | Environment parsing and validation.                                                                                                                                   |
| `src/hosts/`                                        | The Git host interface (`git-host.ts`), the drivers `github/` and `forgejo/`, bounded HTTP (`http.ts`) and the factory (`index.ts`).                                  |
| `src/services/`                                     | One module per endpoint: `create-app.ts`, `pull-requests.ts`, `status.ts`, `checklist.ts`, plus `own-app.ts` and the pull request text.                               |
| `src/access.ts`                                     | Current permission check through Weldall (`checkSubjectScopes`).                                                                                                      |
| `src/audit.ts`                                      | Audit reports to Weldall (`reportAuditEvent`).                                                                                                                        |
| `src/redaction.ts`, `src/git-text.ts`, `src/log.ts` | Credential redaction, sanitising of host text, and the redacting JSON logger.                                                                                         |
| `test/fixtures/`                                    | Fake GitHub and Forgejo APIs (replace the global `fetch`), the in-process fake Weldall app host API, and a harness that obtains real access tokens from the instance. |

## Configuration

Everything comes from the environment. Secrets come only from the environment or from a file whose path is in `<NAME>_FILE` (exactly one of both). The Git app reports every problem at once, by variable name, and never prints a value.

| Variable                                                                         | Required | Meaning                                                                                                                          |
| -------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_APP_HOST`                                                                   | yes      | `github` or `forgejo`.                                                                                                           |
| `GIT_APP_HOST_CONFIG` or `GIT_APP_HOST_CONFIG_FILE`                              | yes      | Host configuration as JSON (see below).                                                                                          |
| `GIT_APP_HOST_SECRET` or `GIT_APP_HOST_SECRET_FILE`                              | yes      | Secret: the GitHub App's private key (PEM as GitHub generated it), or the Forgejo bot user's access token.                       |
| `GIT_APP_PUBLIC_ORIGIN`                                                          | yes      | The instance's public https origin, e.g. `https://git-app.example.com`. It is the issuer of the instance's authorization server. |
| `GIT_APP_RESOURCE_IDENTIFIER`                                                    | no       | Resource identifier registered in Weldall; default `<origin>/api`. The API routes are always under `/api`.                       |
| `GIT_APP_DOWNSTREAM_CLIENT_ID`                                                   | yes      | Downstream client ID registered on the resource in Weldall, e.g. `weldall-cli-at-git-app`.                                       |
| `GIT_APP_SIGNING_KID`, `GIT_APP_SIGNING_PUBLIC_JWK`                              | yes      | Key id and public ES256 JWK of the key the instance signs its own access tokens with.                                            |
| `GIT_APP_SIGNING_PRIVATE_JWK` or `..._FILE`                                      | yes      | Secret: the matching private JWK.                                                                                                |
| `GIT_APP_PUBLISH_SCOPE`                                                          | no       | Default `git-app:publish`.                                                                                                       |
| `GIT_APP_ADMIN_SCOPE`                                                            | no       | Default `git-app:admin`.                                                                                                         |
| `WELDALL_ISSUER`                                                                 | yes      | Weldall's origin, e.g. `https://weldall.example.com`.                                                                            |
| `WELDALL_MACHINE_CLIENT_ID`, `WELDALL_MACHINE_KID`, `WELDALL_MACHINE_PUBLIC_JWK` | yes      | The Weldall machine client the instance uses for the app host API, its key id and public ES256 JWK.                              |
| `WELDALL_MACHINE_PRIVATE_JWK` or `..._FILE`                                      | yes      | Secret: the machine client's private JWK.                                                                                        |
| `PORT`                                                                           | no       | Default `3002`.                                                                                                                  |

The host configuration has the same schema as the former connector's `providerConfig` (`src/hosts/github/config.ts`, `src/hosts/forgejo/config.ts`). GitHub:

```json
{
  "appId": "123456",
  "organization": "example-apps",
  "installationId": "987654",
  "apiBaseUrl": "https://api.github.com",
  "templates": [{ "name": "react", "repository": "example-apps/react-starter" }],
  "repositoryNamePrefix": "app-",
  "reviewerTeam": "app-reviewers",
  "setupMode": "customer-managed",
  "liveEnvironments": ["production"]
}
```

`installationId` is looked up from the organisation when omitted; `apiBaseUrl` defaults to `https://api.github.com` (or `https://api.<subdomain>.ghe.com`). Forgejo:

```json
{
  "baseUrl": "https://git.example.com",
  "organization": "example-apps",
  "botUser": "weldall-bot",
  "templates": [{ "name": "react", "repository": "example-apps/react-starter" }],
  "repositoryNamePrefix": "app-",
  "reviewerTeam": "app-reviewers",
  "setupMode": "customer-managed",
  "previewStatusContext": "weldall/preview",
  "liveStatusContext": "weldall/live"
}
```

Only `customer-managed` is built: the organisation provides the default-branch rules, the reviewer team's write access and CI secrets; the Git app checks them.

## Set-up in Weldall

1. Create the scopes `git-app:publish` (create apps, open pull requests, read status) and `git-app:admin` (run the set-up checklist), or the names configured above. Two instances may share them or use their own.
2. Register the resource: resource identifier `https://git-app.example.com/api`, authorization server `https://git-app.example.com`, downstream client ID as configured, request prefix `https://git-app.example.com/api`, scopes `git-app:publish` and `git-app:admin`.
3. Register a machine client with the instance's machine public key. Allow it the Git app's own resource, and the system scopes `weldall:app-host` and `weldall:subject-scopes-check`.
4. Assign `weldall:login` and `git-app:publish` to the people who publish apps, and `git-app:admin` to the administrators who run the checklist.

## API

All routes need a DPoP-bound user access token from the instance's own token endpoint (Weldall's ID-JAG exchange, as for every resource). Apps belong to people, so machine tokens get `403`. Every route first asks Weldall whether the person still holds `weldall:login` and the route's scope (`checkSubjectScopes`); without an answer from Weldall nothing happens on the host (`503`). Errors are `{ error, error_description }`.

| Method and path                     | Scope     | Behaviour                                                                                                                                                                                                                                                                             |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                       | none      | `{ "status": "ok" }`.                                                                                                                                                                                                                                                                 |
| `POST /api/apps`                    | `publish` | `{ template, name, purpose }`: creates the private repository from the template and registers the app for the person. Repeating the call resumes the same owner's repository. Another person's name is `409 app_exists`. Audited as `git_repository.created`/`.denied`/`.failed`.     |
| `GET /api/apps/{id}`                | `publish` | One of the person's apps as Weldall's registry has it; another person's app and an unknown id are the same `404`. Listing stays in Weldall (`GET /api/me/apps` there).                                                                                                                |
| `POST /api/apps/{id}/pull-requests` | `publish` | `{ head, title, body }`: opens the pull request from a `weldall/publish-*` branch into the default branch. The body starts with a hidden marker and `Published with Weldall (Weldall user <id>).`, never a name. Requests the reviewer team. Audited with the pull request's commits. |
| `GET /api/apps/{id}/status`         | `publish` | Pull request state, reviews (sanitised text), checks, preview and live links, protected paths and the commit identity. `?branch=weldall/publish-…` picks a branch. New links are written back to Weldall (`updateApp`). Not audited (the contract has no event for reads).            |
| `GET /api/admin/checklist`          | `admin`   | The host's set-up checklist (was `weldall connectors check`). `?app=<id>` names a ready app whose repository the rule and team checks use. Read-only on the host; audited as `git_host.checked`.                                                                                      |

### Order of side effects when creating an app

1. Weldall: permission check and registry lookup (name free or the person's own).
2. Host: create the private repository from the template.
3. Weldall: register the app, not ready yet (template commit null), right after the host confirmed the repository.
4. Host: wait for the default branch, check the reviewer team and branch rules.
5. Weldall: report `git_repository.created`.
6. Weldall: set the template commit, which makes the app ready.

An app becomes ready only after its audit entry is stored. If step 5 or 6 fails, the person gets `503` and a repeat resumes and reports again. Step 3 is retried once on a network error or `5xx`. If it still fails, the repository may exist without a registry entry: it is reported as `git_repository.failed` with the repository name (best effort) and logged, it cannot be used (the git proxy will serve only ready apps), and an administrator must delete it. Rejections are reported best effort; when Weldall cannot store one, it is logged.

## Development

```sh
pnpm --filter @weldall/git-app test
pnpm --filter @weldall/git-app typecheck
```

The tests use no network: the GitHub and Forgejo APIs are fixtures that replace `fetch`, Weldall is an in-process fake that validates every request against the SDK's contract schemas.

## Not built yet

- **Git proxy and git credential**: `/git/<owner>/<repo>.git` with the push rules, `git_push.*`/`git_fetch.*` audit and the short-lived credential (`git_credential.*`). Their building blocks are in place: `GitHost.getForwardingTarget` and `readBranchPullRequestState`, `publish-branches.ts`, `WELDALL_GIT_CREDENTIAL_PREFIX` and its redaction. The server's `git-proxy/` is the template.
- **Skills** describing the endpoints for agents.
- **Docker image and release wiring**, and a changeset release unit if the image is released (the package is in the changeset `ignore` list for now).
- **Shared replay store**: DPoP proofs are replay-checked in memory, so run one replica per instance until a shared store is configured.
- **Live verification** against GitHub, Forgejo and Weldall, and removal of the in-server Git host code.
