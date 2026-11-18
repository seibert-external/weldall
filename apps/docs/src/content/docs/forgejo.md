---
title: "How to: Connect Forgejo"
description: Set up a Forgejo connector so employees can publish apps to your Forgejo organisation through Weldall.
sidebar:
  label: "How to: Connect Forgejo"
---

This guide is for the administrators of the Forgejo instance and organisation that receive the published apps, and for the Weldall administrator who configures the connector. Publishing works as described in [Publish apps to GitHub](../connectors/#publish-apps-to-github); [Forgejo](../connectors/#forgejo) lists what is different.

You need a site administrator or an owner of the Forgejo organisation, at least one template repository, and a Weldall IaC workspace (see [Infrastructure as code](../infrastructure-as-code/)). The connector was built and tested against Forgejo 17.

## How Weldall reaches Forgejo

Forgejo has nothing like a GitHub App with short-lived installation tokens. Weldall acts as a dedicated **bot user** and uses one access token of that user for everything: creating repositories, the git proxy, pull requests and status reads. The token stays on the Weldall server and never reaches an employee's machine.

:::caution[The bot token is long-lived and broad]
Forgejo access tokens do not expire, and their scopes cannot be narrowed per repository for what Weldall needs: tokens limited to specific repositories cannot create repositories, and only the user's password or a site administrator can create tokens, so Weldall cannot mint a narrow token per request the way it does on GitHub. Whoever obtains the token can act as the bot user on every repository the bot user can reach, until someone revokes the token in Forgejo. Keep that reach small: a dedicated organisation, a bot user that is neither site administrator nor organisation owner, and the scopes below. Weldall lowers its own access on each new repository to write right after creating it.
:::

## 1. Prepare the organisation

Use an organisation that holds only published apps and their templates, for example `example-org`. The reviewer team needs access to all of its repositories (step 4), and Forgejo has no organisation-wide branch rules, so a dedicated organisation keeps both limited to apps.

## 2. Create the bot user

As a site administrator, create a user for Weldall, for example `weldall-bot`:

- It must **not** be a site administrator.
- Give it a primary email address. Weldall uses the user's name and this address for the commits it pushes, and Forgejo attributes commits by the address.
- Do not make it an owner of the organisation, and do not put it into a team with admin access. `weldall connectors check` fails if it is.

## 3. Let the bot user create repositories

In the organisation, create a team, for example `weldall-publishers`:

- **Permission**: read. **Create repositories**: allowed. **Access to all repositories**: off.
- Add the bot user as the only member, and add every template repository to the team.

Forgejo makes the creator of a new organisation repository its administrator. Weldall immediately sets its own access on the new repository to write, so the bot user cannot change the branch protection or make the repository public.

## 4. Name the reviewer team

Create a team, for example `app-reviewers`, with the reviewers as members:

- **Permission**: write, at least for code and pull requests, so their approvals count.
- **Access to all repositories**: on.

Forgejo adds only the Owners team to a new repository, and Weldall's bot user may not add teams. "Access to all repositories" is the only way the reviewer team reaches new repositories without an owner's action. Weldall requests a review from this team on every pull request and stops the first publish with a message for the administrator when the team has no write access.

## 5. Prepare the templates

For each template repository:

- In **Settings**, tick **Template**.
- Add a **branch protection rule** for the default branch: push disabled, at least one required approval, **Apply to administrators** on. We also recommend dismissing stale approvals and blocking merges on rejected reviews.

Weldall creates each repository with Forgejo's "copy branch protection rules" option, so every new repository starts with the template's rule. Forgejo has no organisation-wide rules, so the template is the only place to set this up. Protected default branches cannot be force-pushed or deleted.

## 6. Create the access token

Signed in as the bot user, open **Settings → Applications → Access tokens** and create a token with:

| Scope                | Why Weldall needs it                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- |
| `write:repository`   | Push and fetch through the git proxy, open pull requests, read reviews and statuses    |
| `write:organization` | Create repositories in the organisation (Forgejo refuses it with `read:organization`)  |
| `read:user`          | Read the bot user's name and email for commits, and its own token scopes for the check |

Do not limit the token to specific repositories: such a token cannot create repositories. Do not add other scopes; the check reports them. Hand the token to the Weldall administrator only through your organisation's secret vault, or paste it yourself in step 8.

## 7. Configure the connector

Declare the connector, the scope that allows publishing, and a shared connection for the token. Create both disabled:

```yaml
scopes:
  apps_publish:
    key: apps:publish
    description: Publish apps to Forgejo

connectors:
  forgejo:
    key: forgejo
    name: Forgejo
    type: forgejo
    enabled: false
    envelopeProvider: LOCAL_ENV
    requiredScopes:
      - apps:publish
    provider:
      baseUrl: https://forgejo.example.com
      organization: example-org
      botUser: weldall-bot
      templates:
        - name: react
          repository: example-org/react-app-template
      repositoryNamePrefix: app-
      reviewerTeam: app-reviewers
      setupMode: customer-managed
      previewStatusContext: weldall/preview
      liveStatusContext: weldall/live

sharedConnections:
  forgejo_token:
    key: forgejo-bot-token
    connectorKey: forgejo
    name: Forgejo bot token
    enabled: false
    useScopes:
      - apps:publish
    credentialManagerEmail: admin@example.com
    serviceAccountLabel: weldall-bot
    provider:
      kind: forgejo-bot-token
```

| Field                  | Meaning                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`              | The https URL of the Forgejo instance, with the sub-path if Forgejo is served under one, without a trailing slash. A DNS name on the default port; IP addresses, ports, credentials and local names are refused. |
| `organization`         | The organisation that receives the repositories.                                                                                                                                                                 |
| `botUser`              | The bot user from step 2. Weldall checks that the token belongs to it.                                                                                                                                           |
| `templates`            | Up to 50 templates. `name` is what employees and agents choose; `repository` is `owner/name`.                                                                                                                    |
| `repositoryNamePrefix` | Put in front of every new repository name, for example `app-expenses`. May be empty.                                                                                                                             |
| `reviewerTeam`         | The name of the reviewer team from step 4.                                                                                                                                                                       |
| `setupMode`            | `customer-managed`: the templates carry the branch protection, the reviewer team has access to all repositories, and your organisation provides the CI secrets. No other mode is available for Forgejo.          |
| `previewStatusContext` | Commit status context whose target URL on the pull request's head commit is the app's preview link. Default `weldall/preview`.                                                                                   |
| `liveStatusContext`    | Commit status context whose target URL on the default branch is the app's live link. Default `weldall/live`.                                                                                                     |

Forgejo has no deployments, so the template's CI reports its links as commit statuses with these contexts, a `success` state and an https target URL.

Weldall sends the bot token only to `baseUrl`, never follows redirects, and checks the server's TLS certificate. The base URL may point into your private network: which Forgejo instance receives the token is the Weldall administrator's decision when configuring the connector. If the instance uses a certificate from an internal certificate authority, the Weldall server must trust that authority (for example through `NODE_EXTRA_CA_CERTS`).

Employees need every scope in the connector's `requiredScopes` to publish. Run `weldall plan`, check the plan, then `weldall up`.

## 8. Paste the token and enable the connector

In the Weldall admin UI, open **Admin → Connections**, select the shared connection and paste the token under **Provision access token**. Weldall binds it to the configured instance and bot user and stores it encrypted, like every connector credential. Pasting does not enable anything: set `enabled: true` on the connector and on the shared connection in the manifest and apply again.

## 9. Check the setup

As a Weldall administrator, run:

```sh
weldall connectors check forgejo
```

The command only reads. It checks that Forgejo accepts the token and that it belongs to the bot user, that the bot user is no site administrator and no organisation owner and may create repositories, the token's scopes (and whether it has more than needed), each template and its branch protection, the reviewer team and its "access to all repositories", the commit identity, and, once an app exists, the reviewer team's access, the default-branch protection and the bot user's access on that app's repository. The command exits with code `3` when a required check fails.

## CI secrets and workflows

New repositories get the template's files, but not its secrets or variables.

:::danger[Forgejo runs workflows pushed onto a publish branch]
This is a difference from GitHub. On GitHub, a push that changes a workflow file is refused, because the App has no Workflows permission. Forgejo accepts it, and Forgejo Actions runs the workflow definitions of the pushed branch. Weldall's publish always keeps `.forgejo/workflows`, `.gitea/workflows` and `.github/workflows` from the repository, so employees do not change them by accident. But anyone who may publish an app can push a workflow of their own onto a `weldall/publish-*` branch through the git proxy by hand. That workflow:

- runs at once, before anyone reviews the pull request;
- can read every Actions secret the repository can reach: its own secrets, and the organisation's secrets, which Forgejo hands to all repositories of the organisation ([Secrets](https://forgejo.org/docs/latest/user/actions/basic-concepts/#secrets));
- runs on the runners available to the repository, with their network access;
- gets the run's automatic token, which has write access to the repository ([Automatic token](https://forgejo.org/docs/latest/user/actions/basic-concepts/#automatic-token)). That token goes to Forgejo directly, so the git proxy's rules (only `weldall/publish-*` branches, never the default branch) do not apply to it. Whether a branch protection rule then still stops it on the default branch was not verified.

Forgejo's documentation describes no way to restrict a secret to a branch or an environment; Weldall did not verify one. A branch protection rule with protected file patterns does not help either: Forgejo compares a new branch against an empty tree and would refuse every publish.

Therefore do one of these:

- **Switch Actions off** for the templates and for every app repository (repository settings, **Actions** unit), and build and deploy from outside Forgejo Actions. Whether a repository created from a template inherits the template's Actions setting was not verified, so check the app repositories; `weldall connectors check` reports the templates and the most recent app repository while Actions is on.
- Or keep deployment credentials out of Forgejo Actions secrets that app repositories can reach: deploy from outside Actions, or run the app repositories' CI on a separate runner in a separate organisation that holds no deployment secrets.
  :::

## What has been verified

The connector was run against a local Forgejo 17: creating a private repository from a template with its branch protection, lowering the bot user's access to write, pushing a publish branch, refusal of a direct push to the protected default branch, opening a pull request with the reviewer team, reading reviews, commit statuses and the preview link, the commit identity, and the full connect check. Not yet run against a production Forgejo instance or through the git proxy against a real Forgejo; the git proxy itself is tested with a real git server.
