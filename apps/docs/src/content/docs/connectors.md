---
title: Connectors
description: Call Google and Atlassian Cloud APIs on behalf of the signed-in user, and publish apps to GitHub.
---

Connectors let you call a service **on behalf of the user**. Each person connects their own account and approves access. Weldall keeps the credentials encrypted on the server and makes the calls; provider tokens never reach the CLI.

Google and Atlassian Cloud (Jira and Confluence) are supported connector providers. A GitHub App connector [publishes apps to GitHub](#publish-apps-to-github) for people without a GitHub account. Want to use another service with an API token? You can already do that through a [resource](../service-configuration/) that proxies requests to it and keeps the token server-side.

Connectors/shared connections can be created disabled and provisioned in the UI, then explicitly enabled. Provisioning/rotation does not enable them; both must be enabled for use. [IaC](../infrastructure-as-code/#public-configuration-ui-only-credentials) manages public configuration/import, never secrets.

## Set up Google

In **Admin → Connectors**, add a Google connector with your Google OAuth client ID and secret. Register `https://weldall.example.com/api/connectors/google/callback` as an authorized redirect URI in Google, replacing the origin with your Weldall URL. Choose the Google permissions to offer and the Weldall scopes users need to access the connector, then enable it.

Users can then connect their own account. For a connector with the key `google`:

```sh
weldall connectors
weldall connections connect google --name my-google
weldall request --connection my-google \
  https://www.googleapis.com/calendar/v3/calendars/primary/events
```

Approve Calendar access during setup to use this example. Use `--connection` instead of `--scope` for connector requests. The connection belongs to you and works across your signed-in devices.

The Google connector also supports BigQuery's read-only, row-insertion, and full-management OAuth permissions. Administrators choose which permissions to offer; users only see and approve those choices. For example, a connection with read-only BigQuery access can run a query as the connected user, preserving that user's BigQuery row- and column-level access:

```sh
weldall request --connection my-google -X POST \
  --json '{"query":"SELECT name FROM `my-project.analytics.customers` LIMIT 10","useLegacySql":false,"maximumBytesBilled":"10000000"}' \
  https://bigquery.googleapis.com/bigquery/v2/projects/my-project/queries
```

It also offers Drive read-only access, which lists and reads files, and Sheets and Docs permissions, which read and edit spreadsheets and documents. Full Drive access is not offered. For example, read a range from an existing spreadsheet, then read an existing document:

```sh
weldall request --connection my-google \
  'https://sheets.googleapis.com/v4/spreadsheets/<spreadsheet-id>/values/Sheet1!A1:D20'
weldall request --connection my-google \
  https://docs.googleapis.com/v1/documents/<document-id>
```

Approve the matching permission during setup. URL-encode sheet names with spaces or special characters. Write cells with `-X PUT` on the same `values` URL plus `?valueInputOption=RAW`, so text is stored as entered and never evaluated as a formula.

Chat permissions list spaces, read messages and send messages as the person; sending needs a Chat app configured in the Google Cloud project that owns the OAuth client. For example, list the latest messages in a space:

```sh
weldall request --connection my-google \
  'https://chat.googleapis.com/v1/spaces/<space-id>/messages?pageSize=20&orderBy=createTime%20DESC'
```

It also offers Google Ads access. Google has only one Ads permission, `adwords`, which also allows changes, so a connection that needs only reports can still change campaigns. The Google Cloud project that owns the OAuth client needs the Google Ads API enabled and an access level above Test, which you apply for on the API's overview page in the Cloud Console. Google no longer requires a developer token. Pass `login-customer-id` when you reach the account through a manager account. For example, run a GAQL search:

```sh
weldall request --connection my-google -X POST \
  -H 'login-customer-id: <manager-customer-id>' \
  --json '{"query":"SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS"}' \
  https://googleads.googleapis.com/v26/customers/<customer-id>/googleAds:search
```

To remove it, run `weldall connections disconnect my-google`. Weldall attempts to revoke access at Google and removes the stored connection. If revocation cannot be confirmed, the CLI asks you to finish in your Google account settings.

## Set up Atlassian Cloud

### 1. Configure the OAuth app

Create a **resource-level OAuth 2.0 (3LO) integration** in the [Atlassian developer console](https://developer.atlassian.com/console/myapps/). Enable sharing, add the Jira or Confluence permissions you need, and enable the User Identity API (`read:me`). Register `https://weldall.example.com/api/connectors/atlassian/callback` with your Weldall origin. Weldall requests `read:me` and `offline_access` automatically.

### 2. Allow company sites

Under **Admin → Connectors → Atlassian Cloud**, enter the client ID and secret, select products and permissions, and enable the connector. Add the allowed site cloud IDs; you can find each site's `cloudId` at `https://your-site.atlassian.net/_edge/tenant_info`.

### 3. Connect your account

For a connector named `company-jira`, run:

```sh
weldall connections connect company-jira --name my-jira
weldall request --connection my-jira \
  https://api.atlassian.com/ex/jira/CLOUD_ID/rest/api/3/myself
```

Choose a site on Atlassian's consent screen. Weldall checks it against the allowlist. Each additional site needs a separate connection. `weldall connections show my-jira` shows the site ID, ready-to-use request examples, and pagination instructions. Use `--agentic` for agent-oriented output.

Requests use `api.atlassian.com`, not the site's own domain. For Confluence pages, use `/ex/confluence/CLOUD_ID/wiki/api/v2/pages`.

:::note[Disconnect]
`weldall connections disconnect my-jira` removes the connection from Weldall. To revoke Atlassian access, remove the app in your [Atlassian account settings](https://id.atlassian.com/manage-profile/apps). This can affect other connections using that app.
:::

## Publish apps to GitHub

An employee builds a small app with an agent on their own machine and asks the agent to publish it. They have no GitHub account. Weldall creates a private repository for the app in your GitHub organisation, sends the changes, and opens a pull request. A reviewer in your organisation approves and merges it on GitHub; nothing reaches the default branch without that pull request. Each later publish sends the next change to the same repository, again as a pull request.

A **GitHub App connector** does this. It has no personal connections: one shared connection holds the App's private key, and only Weldall's server uses it. The connector does not appear in `weldall connectors`. [How to: Connect GitHub](../github-app/) describes the setup.

### What the employee does

The agent runs one command in the app's folder. The first publish names the app and its purpose:

```sh
weldall app publish --name expenses --purpose "Track team expenses" --json
weldall app publish --title "Add receipt upload" --json
weldall app status --json
```

Each publish fetches the repository's current state, merges it with the folder, and sends the result as one commit to a branch named `weldall/publish-*`. While the previous pull request is open, publish updates it; after it is merged or closed, the next publish opens a new one. When the folder and the repository changed the same lines, publish stops and sends nothing. Publish also refuses files that look like secrets or data, such as `.env` files, private keys and database dumps. `weldall app sync` only brings the repository's state into the folder. `weldall app status` shows the pull request, its reviews and checks, and the preview and live links the app's CI reports. In a desktop client with the Weldall extension, the agent uses the `publish_app` and `app_status` tools, which run the same commands.

Every published app is in the [app registry](../app-registry/), where administrators see all apps and owners confirm every 90 days that their apps are still needed (`weldall app list`, `weldall app confirm`).

The commits are authored by the App's bot account and carry a `Weldall-App:` trailer. The pull request names only the Weldall user ID of the person who published. Their name stays in Weldall's audit log.

### The git proxy

Git on the employee's machine never talks to GitHub. It pushes to and fetches from Weldall at `https://weldall.example.com/git/<connector>/<owner>/<repository>.git`. Weldall checks every request before it forwards anything:

- The person owns the app registered for this repository and may use the connector.
- A push updates only branches named `weldall/publish-*`. Weldall refuses pushes to the default branch, tags, branch deletion, push options, signed pushes, and pushes to the branch of a closed or merged pull request. Git shows the reason as `! [remote rejected] … (weldall: …)`.

Only then does Weldall fetch a GitHub installation token for this one repository, with read or write access to its contents, and stream the request to GitHub. The token stays on the server.

### What reaches the machine

Provider tokens never reach the CLI, and this holds for GitHub too. No GitHub token leaves the Weldall server.

Git cannot send Weldall's DPoP-bound login, so the CLI acts as git's credential helper (`weldall git-credential`). For each git command it requests a **git credential** from Weldall with the existing login and hands it to git as a password. The git credential is a Weldall secret, not a GitHub token:

- It is valid for five minutes and for one app's repository and one person. Weldall stores only its hash.
- It is read-only unless publish asks for write access.
- It works only on Weldall's git proxy, with all of the proxy's rules. It cannot call GitHub's API or reach any other repository.
- Unlike Weldall's access tokens, it is **not bound to the device key**. Whoever copies it within those five minutes can fetch that repository, or push to its publish branches if it grants write access.

Git asks the helper only for the proxy's URL, and publish clears all other helpers for that URL, so the git credential is not stored in a keychain.

### What Weldall records

The audit log records repository creation (`git_repository.*`), every push before it is forwarded and its result (`git_push.*`, with person, repository, branch, old and new commit, size and outcome), every fetch (`git_fetch.*`), pull requests with their commits (`git_pull_request.*`), every git credential issued or refused (`git_credential.*`), and every connector check (`git_host.checked`). Refusals are recorded too, except the first request of each git command, which git always sends without a credential.

### Limits

| Limit                       | Value                               |
| --------------------------- | ----------------------------------- |
| Request body of one push    | 100 MiB                             |
| Response of one fetch       | 1 GiB                               |
| Duration of one git request | 280 seconds                         |
| Concurrent git transfers    | 16 per server process, 4 per person |
| Git credentials             | 20 per person per minute            |
| Files in a publish          | 10 MiB per file, 100 MiB in total   |

A typical publish sends a few kilobytes. Publish needs git 2.39 or newer.

### What Weldall cannot enforce

The git proxy sees which branch a push updates, but not whether the push rewrites history. It cannot detect a force push to a publish branch. Weldall also cannot read your organisation's rulesets, only the rules that apply to an existing repository. Protect the default branch on GitHub with a rule that requires a reviewed pull request and blocks force pushes and deletion. [How to: Connect GitHub](../github-app/#protect-the-default-branch) explains the recommended rule.

:::caution[Status]
Publishing is tested against a simulated GitHub API and a local git server. The building blocks were tried against github.com by hand, but the complete flow has not yet run against github.com. GitHub Enterprise Cloud with data residency (`https://api.<subdomain>.ghe.com`) is accepted by the configuration but has not been tested. GitHub Enterprise Server is not supported. The preview and live links depend on the app template's CI reporting GitHub deployments.
:::

## Request limits

Weldall allows **60 requests per connection in each 60-second window**. Once that limit is reached, it returns HTTP `429` before contacting OpenBao or the provider. Requests that pass this check still count if they later fail. This is Weldall's limit; the provider's API limits apply separately.

You can also have up to **10 open, unexpired connection-setup attempts per user**, across all connectors. Each attempt is valid for ten minutes. Cancel unused attempts or wait for them to expire before starting another.

## Credential encryption

Weldall generates a new 32-byte key each time it stores credentials and uses it to encrypt them. It then encrypts this data-encryption key (DEK) with a second key, the key-encryption key (KEK). This is called **envelope encryption**.

PostgreSQL stores only the encrypted credentials and the encrypted DEK. To read the credentials, the DEK is decrypted first, then Weldall uses it to decrypt the credentials. The KEK stays outside the database, so a stolen database backup alone is not enough to read them.

### Manage encryption keys

When you create a connector, you choose where its KEK is managed. You cannot change that choice later, including through the API or IaC. To switch providers, create a new connector and ask users to reconnect their accounts.

- **`LOCAL_ENV` (default):** Set `WELDALL_CONNECTOR_KEK` on the Weldall server to a base64-encoded key made from 32 random bytes, generated independently of your other keys. All `LOCAL_ENV` connectors use this KEK. Keep it unchanged in your secret manager, separate from database backups. Anyone with both the database and the KEK can decrypt these connectors' credentials.
- **`OPENBAO`:** OpenBao manages a separate `aes256-gcm96` Transit key for each connector and creates it on the first encryption request. Weldall calls OpenBao once per write to encrypt the DEK and once per read to decrypt it. You can rotate the Transit key in OpenBao without rewriting stored credentials; they remain readable.

Weldall still encrypts OAuth client secrets with `WELDALL_CREDENTIAL_ENCRYPTION_KEY`, regardless of the envelope provider you choose.

### Set up OpenBao

Set your OpenBao server's address and an access token on the Weldall server:

```dotenv
WELDALL_OPENBAO_HOST=https://openbao.example.com
WELDALL_OPENBAO_TOKEN=...
```

Enable the Transit secrets engine at `transit/` in OpenBao. The token only needs these permissions:

```hcl
path "transit/encrypt/weldall-connector-*" { capabilities = ["create", "update"] }
path "transit/decrypt/weldall-connector-*" { capabilities = ["update"] }
```

Weldall only needs OpenBao when encrypting or decrypting connection data. If a variable is missing, OpenBao is unreachable, or the token is rejected, that operation fails with HTTP `503`. The error message contains no secrets. Weldall still starts, you can still manage connectors, and `LOCAL_ENV` connectors keep working.

Back up OpenBao as well as PostgreSQL. Weldall does not rotate or delete Transit keys automatically. After deleting a connector, remove its `weldall-connector-*` key in OpenBao yourself once you no longer need it.
