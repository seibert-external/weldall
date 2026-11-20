---
title: "How to: Connect Forgejo"
description: Prepare a Forgejo organisation and bot user so the Git app can publish employees' apps to your self-hosted Forgejo.
sidebar:
  label: "How to: Connect Forgejo"
---

This guide is for the administrators of the Forgejo instance and organisation that receive the published apps, and for the administrators who run the Git app. Publishing works as described in [Publish apps](../publish-apps/); [How to: Run the Git app](../git-app/) covers the service and its registration in Weldall. This page lists what is specific to Forgejo.

You need a site administrator or an owner of the Forgejo organisation, and at least one template repository. The Forgejo support was built and tested against Forgejo 17.

## How the Git app reaches Forgejo

Forgejo has nothing like a GitHub App with short-lived installation tokens. The Git app acts as a dedicated **bot user** and uses one access token of that user for everything: creating repositories, the git proxy, pull requests and status reads. The token is the Git app's host secret. It stays inside the Git app and never reaches an employee's machine.

:::caution[The bot token is long-lived and broad]
Forgejo access tokens do not expire, and their scopes cannot be narrowed per repository for what the Git app needs: tokens limited to specific repositories cannot create repositories, and only the user's password or a site administrator can create tokens, so the Git app cannot mint a narrow token per request the way it does on GitHub. Whoever obtains the token can act as the bot user on every repository the bot user can reach, until someone revokes the token in Forgejo. Keep that reach small: a dedicated organisation, a bot user that is neither site administrator nor organisation owner, and the scopes below. The Git app lowers the bot user's access on each new repository to write right after creating it.
:::

## 1. Prepare the organisation

Use an organisation that holds only published apps and their templates, for example `example-org`. The reviewer team needs access to all of its repositories (step 4), and Forgejo has no organisation-wide branch rules, so a dedicated organisation keeps both limited to apps.

## 2. Create the bot user

As a site administrator, create a user for the Git app, for example `weldall-bot`:

- It must **not** be a site administrator.
- Give it a primary email address. The Git app uses the user's name and this address as the author of published commits, and Forgejo attributes commits by the address.
- Do not make it an owner of the organisation, and do not put it into a team with admin access. `weldall app checklist` fails if it is.

## 3. Let the bot user create repositories

In the organisation, create a team, for example `weldall-publishers`:

- **Permission**: read. **Create repositories**: allowed. **Access to all repositories**: off.
- Add the bot user as the only member, and add every template repository to the team.

Forgejo makes the creator of a new organisation repository its administrator. The Git app immediately sets the bot user's access on the new repository to write, so the bot user cannot change the branch protection or make the repository public.

## 4. Name the reviewer team

Create a team, for example `app-reviewers`, with the reviewers as members:

- **Permission**: write, at least for code and pull requests, so their approvals count.
- **Access to all repositories**: on.

Forgejo adds only the Owners team to a new repository, and the bot user may not add teams. "Access to all repositories" is the only way the reviewer team reaches new repositories without an owner's action. The Git app requests a review from this team on every pull request and stops the first publish with a message for the administrator when the team has no write access.

## 5. Prepare the templates

For each template repository:

- In **Settings**, tick **Template**.
- Add a **branch protection rule** for the default branch: push disabled, at least one required approval, **Apply to administrators** on. We also recommend dismissing stale approvals and blocking merges on rejected reviews.

The Git app creates each repository with Forgejo's "copy branch protection rules" option, so every new repository starts with the template's rule. Forgejo has no organisation-wide rules, so the template is the only place to set this up. Protected default branches cannot be force-pushed or deleted.

## 6. Create the access token

Signed in as the bot user, open **Settings → Applications → Access tokens** and create a token with:

| Scope                | Why the Git app needs it                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| `write:repository`   | Push and fetch through the git proxy, open pull requests, read reviews and statuses    |
| `write:organization` | Create repositories in the organisation (Forgejo refuses it with `read:organization`)  |
| `read:user`          | Read the bot user's name and email for commits, and its own token scopes for the check |

Do not limit the token to specific repositories: such a token cannot create repositories. Do not add other scopes; the checklist reports them. The token becomes the Git app's host secret (`GIT_APP_HOST_SECRET_FILE`): store it yourself in the secret manager the Git app's container reads from, or hand it to the administrators who run the Git app only through your organisation's secret vault.

## 7. Configure the Git app

Set `GIT_APP_HOST=forgejo` and pass the host configuration as JSON in `GIT_APP_HOST_CONFIG` or in a file named by `GIT_APP_HOST_CONFIG_FILE`:

```json
{
  "baseUrl": "https://forgejo.example.com",
  "organization": "example-org",
  "botUser": "weldall-bot",
  "templates": [{ "name": "react", "repository": "example-org/react-app-template" }],
  "repositoryNamePrefix": "app-",
  "reviewerTeam": "app-reviewers",
  "setupMode": "customer-managed",
  "previewStatusContext": "weldall/preview",
  "liveStatusContext": "weldall/live"
}
```

| Field                  | Meaning                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`              | The https URL of the Forgejo instance, with the sub-path if Forgejo is served under one, without a trailing slash. A DNS name on the default port; IP addresses, ports, credentials and local names are refused. |
| `organization`         | The organisation that receives the repositories.                                                                                                                                                                 |
| `botUser`              | The bot user from step 2. The checklist checks that the token belongs to it.                                                                                                                                     |
| `templates`            | Up to 50 templates. `name` is what employees and agents choose; `repository` is `owner/name`.                                                                                                                    |
| `repositoryNamePrefix` | Put in front of every new repository name, for example `app-expenses`. May be empty.                                                                                                                             |
| `reviewerTeam`         | The name of the reviewer team from step 4.                                                                                                                                                                       |
| `setupMode`            | `customer-managed`: the templates carry the branch protection, the reviewer team has access to all repositories, and your organisation provides the CI secrets. No other mode is available for Forgejo.          |
| `previewStatusContext` | Commit status context whose target URL on the pull request's head commit is the app's preview link. Default `weldall/preview`.                                                                                   |
| `liveStatusContext`    | Commit status context whose target URL on the default branch is the app's live link. Default `weldall/live`.                                                                                                     |

Forgejo has no deployments, so the template's CI reports its links as commit statuses with these contexts, a `success` state and an https target URL.

The Git app sends the bot token only to `baseUrl`, never follows redirects, and checks the server's TLS certificate. The base URL may point into your private network: which Forgejo instance receives the token is the decision of whoever configures the Git app. If the instance uses a certificate from an internal certificate authority, the Git app's container must trust that authority, for example through Node.js's `NODE_EXTRA_CA_CERTS`.

Then start and register the Git app as described in [How to: Run the Git app](../git-app/).

## 8. Check the setup

As a Weldall administrator with `git-app:admin`, run:

```sh
weldall app checklist
```

The command only reads. It checks that Forgejo accepts the token and that it belongs to the bot user, that the bot user is no site administrator and no organisation owner and may create repositories, the token's scopes (and whether it has more than needed), each template and its branch protection, the reviewer team and its "access to all repositories", whether Forgejo Actions is off, and the commit identity. With `--app <app-id>` it also checks that app's repository: the reviewer team's access, the default-branch protection and the bot user's access. The command exits with code `3` when a required check fails.

## CI secrets and workflows

New repositories get the template's files, but not its secrets or variables.

:::danger[Forgejo runs workflows pushed onto a publish branch]
This is a difference from GitHub. On GitHub, a push that changes a workflow file is refused, because the App has no Workflows permission. Forgejo accepts it, and Forgejo Actions runs the workflow definitions of the pushed branch. Publish always keeps `.forgejo/workflows`, `.gitea/workflows` and `.github/workflows` from the repository, so employees do not change them by accident. But anyone who may publish an app can push a workflow of their own onto a `weldall/publish-*` branch through the git proxy by hand. That workflow:

- runs at once, before anyone reviews the pull request;
- can read every Actions secret the repository can reach: its own secrets, and the organisation's secrets, which Forgejo hands to all repositories of the organisation ([Secrets](https://forgejo.org/docs/latest/user/actions/basic-concepts/#secrets));
- runs on the runners available to the repository, with their network access;
- gets the run's automatic token, which has write access to the repository ([Automatic token](https://forgejo.org/docs/latest/user/actions/basic-concepts/#automatic-token)). That token goes to Forgejo directly, so the git proxy's rules (only `weldall/publish-*` branches, never the default branch) do not apply to it. Whether a branch protection rule then still stops it on the default branch was not verified.

Forgejo's documentation describes no way to restrict a secret to a branch or an environment; none was verified. A branch protection rule with protected file patterns does not help either: Forgejo compares a new branch against an empty tree and would refuse every publish.

Therefore do one of these:

- **Switch Actions off** for the templates and for every app repository (repository settings, **Actions** unit), and build and deploy from outside Forgejo Actions. Whether a repository created from a template inherits the template's Actions setting was not verified, so check the app repositories; `weldall app checklist` reports the templates, and with `--app` that app's repository, while Actions is on.
- Or keep deployment credentials out of Forgejo Actions secrets that app repositories can reach: deploy from outside Actions, or run the app repositories' CI on a separate runner in a separate organisation that holds no deployment secrets.
  :::

## What has been verified

While publishing was designed, the Forgejo support was run against a local Forgejo 17: creating a private repository from a template with its branch protection, lowering the bot user's access to write, pushing a publish branch, refusal of a direct push to the protected default branch, opening a pull request with the reviewer team, reading reviews, commit statuses and the preview link, the commit identity, and the full set-up check. The Git app itself is tested against a simulated Forgejo API and a local git server only. It has not yet run against a real Forgejo, and the git proxy has not yet run in front of one.
