---
title: "How to: Connect GitHub"
description: Set up a GitHub App connector so employees can publish apps to your GitHub organisation through Weldall.
sidebar:
  label: "How to: Connect GitHub"
---

This guide is for the administrators of the GitHub organisation that receives the published apps, and for the Weldall administrator who configures the connector. [Publish apps to GitHub](../connectors/#publish-apps-to-github) explains what publishing does and how the git proxy protects your repositories.

You need an owner of the GitHub organisation, at least one template repository in that organisation, and a Weldall IaC workspace (see [Infrastructure as code](../infrastructure-as-code/)).

## 1. Create the GitHub App

In GitHub, open the organisation's **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **GitHub App name** and **Homepage URL**: any name, and your Weldall URL.
- **Webhook**: clear **Active**. Weldall receives no webhooks.
- **Where can this GitHub App be installed?**: **Only on this account**.

Grant exactly these permissions:

| Section                  | Permission          | Access         | Why Weldall needs it                                                                                |
| ------------------------ | ------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| Repository permissions   | Contents            | Read and write | Fetch and push through the git proxy; read templates                                                |
| Repository permissions   | Metadata            | Read-only      | Read repositories, their branches and the rules that apply to them (GitHub sets this automatically) |
| Repository permissions   | Pull requests       | Read and write | Open pull requests, request the reviewer team, read reviews                                         |
| Repository permissions   | Checks              | Read-only      | Show check results in `weldall app status`                                                          |
| Repository permissions   | Commit statuses     | Read-only      | Show commit statuses in `weldall app status`                                                        |
| Repository permissions   | Deployments         | Read-only      | Read the preview and live links the app's CI reports                                                |
| Organization permissions | Repository creation | Read and write | Create repositories from templates                                                                  |
| Organization permissions | Members             | Read-only      | Check that the reviewer team exists and has write access                                            |

Do not grant **Workflows** or **Administration**. Files under `.github/workflows` always come from the repository, so Weldall never changes them.

:::note[Repository creation uses the installation's full permissions]
For every other operation Weldall requests a token restricted to one repository and to the permissions of that operation. Creating a repository from a template is the exception: in tests against GitHub, only a token with the installation's full permission set could do it, and each refused attempt left an empty repository behind. Weldall therefore uses the full token for this one call, keeps it on the server and never caches it. No narrower grant can be promised for repository creation.
:::

## 2. Install the App and select the repositories

On the App's page, choose **Install App** and install it on your organisation. Choose **Only select repositories** and select every template repository. Repositories the App creates later join the selection automatically.

## 3. Mark the templates

Every template must be in the same organisation and marked as a template: in the repository, open **Settings → General** and tick **Template repository**.

## 4. Generate the private key and hand it over

On the App's page, under **Private keys**, choose **Generate a private key**. GitHub downloads a `.pem` file. Note the **App ID** shown on the same page.

The key lets anyone act as the App. Upload it yourself in the Weldall admin UI (step 6), or pass it to the Weldall administrator through your organisation's secret vault. Never send it by email or chat. Delete the downloaded file after the upload.

## 5. Configure the connector

Declare the connector, the scope that allows publishing, and a shared connection for the key in your IaC workspace. Create both disabled:

```yaml
scopes:
  apps_publish:
    key: apps:publish
    description: Publish apps to GitHub

connectors:
  github:
    key: github
    name: GitHub
    type: github-app
    enabled: false
    envelopeProvider: LOCAL_ENV
    requiredScopes:
      - apps:publish
    provider:
      appId: 123456
      organization: example-org
      apiBaseUrl: https://api.github.com
      templates:
        - name: react
          repository: example-org/react-app-template
      repositoryNamePrefix: app-
      reviewerTeam: app-reviewers
      setupMode: customer-managed
      liveEnvironments:
        - production

sharedConnections:
  github_key:
    key: github-app-key
    connectorKey: github
    name: GitHub App key
    enabled: false
    useScopes:
      - apps:publish
    credentialManagerEmail: admin@example.com
    serviceAccountLabel: GitHub App
    provider:
      kind: github-app-private-key
```

| Field                  | Meaning                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`                | The App ID from step 4.                                                                                                                                                                                 |
| `organization`         | The organisation that owns the templates and receives the repositories.                                                                                                                                 |
| `installationId`       | Optional. Weldall looks up the App's installation on the organisation when it is missing.                                                                                                               |
| `apiBaseUrl`           | `https://api.github.com` (the default). `https://api.<subdomain>.ghe.com` (GitHub Enterprise Cloud with data residency) is accepted but has not been tested. GitHub Enterprise Server is not supported. |
| `templates`            | Up to 50 templates. `name` is what employees and agents choose; `repository` is `owner/name` in the organisation.                                                                                       |
| `repositoryNamePrefix` | Put in front of every new repository name, for example `app-expenses`. May be empty if the organisation holds only published apps.                                                                      |
| `reviewerTeam`         | The slug of the team that reviews the pull requests.                                                                                                                                                    |
| `setupMode`            | `customer-managed`: your organisation provides the branch rule, the reviewer team's access and the CI secrets. No other mode is available yet.                                                          |
| `liveEnvironments`     | GitHub deployment environments whose link is the app's live link, as the CI names them. Links of other environments are preview links. Default: `production`.                                           |

Employees need every scope in the connector's `requiredScopes` to publish, so assign `apps:publish` to them, for example through a group assignment. The shared connection only holds the key. The IaC schema requires `useScopes` on it; set them to the same scope.

Run `weldall plan`, check the plan, then `weldall up`.

## 6. Upload the key and enable the connector

In the Weldall admin UI, open **Admin → Connections**, select the shared connection and upload the `.pem` file under **Provision private key**. Weldall checks that the file is an RSA private key, binds it to the configured App ID and stores it encrypted, like every connector credential. The check in step 7 shows whether GitHub accepts it. Uploading does not enable anything: set `enabled: true` on the connector and on the shared connection in the manifest and apply again.

## 7. Check the setup

As a Weldall administrator, signed in with `weldall login`, run:

```sh
weldall connectors check github
```

The command asks GitHub about the App's authentication and installation, every permission per operation, each template, the reviewer team, the default-branch rule and the commit identity. It only reads. Each line passes, fails, or cannot be verified, with the reason and what to do. The command exits with code `3` when a required check fails. `--json` prints the report for scripts.

Before the first app exists, the reviewer team's write access and the default-branch rule cannot be verified, because GitHub shows both only for an existing repository. Run the check again after the first publish.

## Organisation settings

### Protect the default branch

We recommend an organisation ruleset for the default branch of all repositories whose name starts with your prefix (for example `app-*`):

- **Require a pull request before merging**, with at least one approval, and dismiss stale approvals when new commits are pushed. This also stops direct pushes.
- **Block force pushes**.
- **Restrict deletions**.

The rule is recommended, not required. Weldall's git proxy already refuses every push to the default branch, so publishing works without it. The rule also covers what Weldall cannot see: people and other integrations with write access to the repositories, and force pushes, which the proxy cannot detect. Weldall cannot read organisation rulesets; it checks the rules that apply to each new repository and reports a missing rule as a warning when it creates the repository and in `weldall connectors check`.

### Name the reviewer team

Create a team, for example `app-reviewers`, whose members have GitHub accounts and review the apps. Enter its slug as `reviewerTeam`. Weldall requests a review from this team on every pull request.

The team needs write access to every new repository at the moment Weldall creates it, for example through an organisation role that grants it write access to all repositories. Otherwise the reviews would not count, and the first publish stops with a message for the administrator. After you grant the access, publishing again continues with the same repository.

### CI secrets

New repositories get the template's files, but not its secrets. Give the CI of new repositories the secrets it needs, for example as organisation secrets whose repository access includes all private repositories.

:::caution[Previews run unreviewed code]
The publish branches live in the app's repository, not in a fork. If the template's CI builds a preview for each pull request, it runs code nobody has reviewed yet, with the secrets the CI gives it. Give preview builds only credentials meant for previews.
:::

### Signed commits

The commits Weldall pushes are not signed. A rule that requires signed commits on the `weldall/publish-*` branches blocks every publish. Do not apply such a rule to those branches.

## What has been verified

The following was tried by hand against github.com before the connector was built: issuing installation tokens per repository, creating a private repository from a template (including the refused narrower tokens), opening a pull request, the refusal of pushes that change workflow files, the bot identity of commits, and pushing and fetching through a trial version of the git proxy. The connector as built, including `weldall connectors check`, is tested against a simulated GitHub API and a local git server only. Not yet verified against github.com: the Members, Checks, Commit statuses and Deployments permissions, requesting a team as reviewer, organisation rulesets on newly created repositories, and the preview and live links.
