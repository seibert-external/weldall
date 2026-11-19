---
title: "How to: Connect GitHub"
description: Create the GitHub App that the Git app uses to publish employees' apps to your GitHub organisation.
sidebar:
  label: "How to: Connect GitHub"
---

This guide is for the administrators of the GitHub organisation that receives the published apps, and for the administrators who run the Git app. [Publish apps](../publish-apps/) explains what publishing does and how the git proxy protects your repositories; [How to: Run the Git app](../git-app/) covers the service and its registration in Weldall.

You need an owner of the GitHub organisation and at least one template repository in that organisation.

## 1. Create the GitHub App

In GitHub, open the organisation's **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **GitHub App name** and **Homepage URL**: any name, and for example the Git app's URL.
- **Webhook**: clear **Active**. The Git app receives no webhooks.
- **Where can this GitHub App be installed?**: **Only on this account**.

Grant exactly these permissions:

| Section                  | Permission          | Access         | Why the Git app needs it                                                                            |
| ------------------------ | ------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| Repository permissions   | Contents            | Read and write | Fetch and push through the git proxy; read templates                                                |
| Repository permissions   | Metadata            | Read-only      | Read repositories, their branches and the rules that apply to them (GitHub sets this automatically) |
| Repository permissions   | Pull requests       | Read and write | Open pull requests, request the reviewer team, read reviews                                         |
| Repository permissions   | Checks              | Read-only      | Show check results in `weldall app status`                                                          |
| Repository permissions   | Commit statuses     | Read-only      | Show commit statuses in `weldall app status`                                                        |
| Repository permissions   | Deployments         | Read-only      | Read the preview and live links the app's CI reports                                                |
| Organization permissions | Repository creation | Read and write | Create repositories from templates                                                                  |
| Organization permissions | Members             | Read-only      | Check that the reviewer team exists and has write access                                            |

Do not grant **Workflows** or **Administration**. Without the Workflows permission, GitHub refuses every push that changes a file under `.github/workflows`, so these files always come from the repository.

:::note[Repository creation uses the installation's full permissions]
For every other operation the Git app requests a token restricted to one repository and to the permissions of that operation. Creating a repository from a template is the exception: in tests against GitHub, only a token with the installation's full permission set could do it, and each refused attempt left an empty repository behind. The Git app therefore uses the full token for this one call, keeps it inside the Git app and never caches it. No narrower grant can be promised for repository creation.
:::

## 2. Install the App and select the repositories

On the App's page, choose **Install App** and install it on your organisation. Choose **Only select repositories** and select every template repository. Repositories the App creates later join the selection automatically.

## 3. Mark the templates

Every template must be in the same organisation and marked as a template: in the repository, open **Settings → General** and tick **Template repository**.

## 4. Generate the private key and hand it over

On the App's page, under **Private keys**, choose **Generate a private key**. GitHub downloads a `.pem` file. Note the **App ID** shown on the same page.

The key lets anyone act as the App. It becomes the Git app's host secret (`GIT_APP_HOST_SECRET_FILE`): store it yourself in the secret manager the Git app's container reads from, or pass it to the administrators who run the Git app through your organisation's secret vault. Never send it by email or chat. Delete the downloaded file afterwards. Give the key exactly as GitHub generated it; encrypted keys are not supported.

## 5. Configure the Git app

Set `GIT_APP_HOST=github` and pass the host configuration as JSON in `GIT_APP_HOST_CONFIG` or in a file named by `GIT_APP_HOST_CONFIG_FILE`:

```json
{
  "appId": "123456",
  "organization": "example-org",
  "apiBaseUrl": "https://api.github.com",
  "templates": [{ "name": "react", "repository": "example-org/react-app-template" }],
  "repositoryNamePrefix": "app-",
  "reviewerTeam": "app-reviewers",
  "setupMode": "customer-managed",
  "liveEnvironments": ["production"]
}
```

| Field                  | Meaning                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`                | The App ID from step 4.                                                                                                                                                                                 |
| `organization`         | The organisation that owns the templates and receives the repositories.                                                                                                                                 |
| `installationId`       | Optional. The Git app looks up the App's installation on the organisation when it is missing.                                                                                                           |
| `apiBaseUrl`           | `https://api.github.com` (the default). `https://api.<subdomain>.ghe.com` (GitHub Enterprise Cloud with data residency) is accepted but has not been tested. GitHub Enterprise Server is not supported. |
| `templates`            | Up to 50 templates. `name` is what employees and agents choose; `repository` is `owner/name` in the organisation.                                                                                       |
| `repositoryNamePrefix` | Put in front of every new repository name, for example `app-expenses`. May be empty if the organisation holds only published apps.                                                                      |
| `reviewerTeam`         | The slug of the team that reviews the pull requests.                                                                                                                                                    |
| `setupMode`            | `customer-managed`: your organisation provides the branch rule, the reviewer team's access and the CI secrets. No other mode is available yet.                                                          |
| `liveEnvironments`     | GitHub deployment environments whose link is the app's live link, as the CI names them. Links of other environments are preview links. Default: `production`.                                           |

The host configuration holds no secret. Then start and register the Git app as described in [How to: Run the Git app](../git-app/).

## 6. Check the setup

As a Weldall administrator with `git-app:admin`, signed in with `weldall login`, run:

```sh
weldall app checklist
```

The Git app asks GitHub about the App's authentication and installation, every permission per operation, each template, the reviewer team, the default-branch rule and the commit identity. It only reads. Each line passes, fails, or cannot be verified, with the reason and what to do. The command exits with code `3` when a required check fails. `--json` prints the report for scripts.

Before the first app exists, the reviewer team's write access and the default-branch rule cannot be verified, because GitHub shows both only for an existing repository. After the first publish, run the check again with `--app <app-id>`.

## Organisation settings

### Protect the default branch

We recommend an organisation ruleset for the default branch of all repositories whose name starts with your prefix (for example `app-*`):

- **Require a pull request before merging**, with at least one approval, and dismiss stale approvals when new commits are pushed. This also stops direct pushes.
- **Block force pushes**.
- **Restrict deletions**.

The rule is recommended, not required. The Git app's git proxy already refuses every push to the default branch, so publishing works without it. The rule also covers what the Git app cannot see: people and other integrations with write access to the repositories, and force pushes, which the proxy cannot detect. The Git app cannot read organisation rulesets; it checks the rules that apply to each new repository and reports a missing rule as a warning when it creates the repository and in `weldall app checklist`.

### Name the reviewer team

Create a team, for example `app-reviewers`, whose members have GitHub accounts and review the apps. Enter its slug as `reviewerTeam`. The Git app requests a review from this team on every pull request.

The team needs write access to every new repository at the moment the Git app creates it, for example through an organisation role that grants it write access to all repositories. Otherwise the reviews would not count, and the first publish stops with a message for the administrator. After you grant the access, publishing again continues with the same repository.

### CI secrets

New repositories get the template's files, but not its secrets. Give the CI of new repositories the secrets it needs, for example as organisation secrets whose repository access includes all private repositories.

:::caution[Previews run unreviewed code]
The publish branches live in the app's repository, not in a fork. If the template's CI builds a preview for each pull request, it runs code nobody has reviewed yet, with the secrets the CI gives it. Give preview builds only credentials meant for previews.
:::

### Signed commits

The commits the CLI creates for a publish are not signed. A rule that requires signed commits on the `weldall/publish-*` branches blocks every publish. Do not apply such a rule to those branches.

## What has been verified

While publishing was designed, the following was tried by hand against github.com: issuing installation tokens per repository, creating a private repository from a template (including the refused narrower tokens), opening a pull request, the refusal of pushes that change workflow files, the bot identity of commits, and pushing and fetching through a trial version of the git proxy. The Git app is tested against a simulated GitHub API and a local git server. On 19 November 2026 it ran against github.com with a test GitHub App, the real CLI and a local Weldall development server: the set-up checklist, creating a repository from a template, fetching and pushing through the git proxy, refused pushes, opening a pull request, the status, `weldall app sync`, and the registry and audit entries in Weldall. Not yet verified against github.com: the Members, Checks, Commit statuses and Deployments permissions (the test App lacked the last three), a reviewer team that really has write access (its answer was simulated) and a successful review request to it, a real branch rule and organisation rulesets on newly created repositories, and the preview and live links.
