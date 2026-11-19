---
title: Publish apps
description: Employees publish apps they built with an agent to the organisation's GitHub or Forgejo, without a Git account; a reviewer of the organisation merges them.
sidebar:
  label: Publish apps
---

An employee builds a small app with an agent on their own machine and asks the agent to publish it. They have no GitHub or Forgejo account. Weldall creates a private repository for the app in your organisation, sends the changes, and opens a pull request. A reviewer in your organisation approves and merges it on the Git host; nothing reaches the default branch without that pull request. Each later publish sends the next change to the same repository, again as a pull request.

The work on the Git host is done by the **Git app**, a separate service your organisation runs next to Weldall, one per Git host. [How to: Run the Git app](../git-app/) describes the setup.

## What the employee does

The employee needs the scopes `weldall:login` and `git-app:publish`. The agent runs the commands in the app's folder, a git repository whose first commit is the template the app started from. The first publish names the app and its purpose:

```sh
weldall app publish --name expenses --purpose "Track team expenses" --json
weldall app publish --title "Add receipt upload" --json
weldall app status --json
```

`--title` and `--body` set the pull request's title and description. In a desktop client with the Weldall extension, the agent uses the `publish_app` and `app_status` tools, which run the same commands. The Git app's skill in the Weldall catalog (`<resource key>.publish-app`) tells the agent this workflow.

When the organisation runs several Git apps, for example one for GitHub and one for Forgejo, the first publish stops with `git_app_ambiguous` and lists them. The agent asks where the app belongs and publishes again with `--git-app <resource key>`. The folder remembers the choice.

## What a publish does

Each publish fetches the repository's current state, merges it with the folder, and sends the result as one commit to a branch named `weldall/publish-*`. While the previous pull request is open, publish updates it; after it is merged or closed, the next publish opens a new one.

- Publish refuses files that look like secrets or data, such as `.env` files, private keys, credential files, database files and dumps, and files over 10 MiB. Nothing is sent; the result names the files and the reason.
- Workflow files always come from the repository: `.github/workflows` on GitHub, and on Forgejo also `.forgejo/workflows` and `.gitea/workflows`. Local changes to them are not published, and publish names them in a notice.
- When publish sent the change but could not open the pull request, it reports `pull_request_not_opened`. Publishing again opens the pull request without sending the change again.

`weldall app sync` only brings the repository's state into the folder and publishes nothing, for example after a reviewer merged a change.

### Conflicts

When the folder and the repository changed the same lines, publish and sync stop with `conflict`, send nothing and name the files. Publishing again with `--resolve` writes the merge result with conflict markers into the folder. Then the employee decides each file:

```sh
weldall app publish --resolve --json
weldall app publish --decide src/total.ts=folder --decide logo.png=repo --json
```

`folder` takes the file as edited in the folder, without markers; `local` and `repo` take that side's version.

## Review, status and who merges

`weldall app status` shows the pull request with its reviews and checks, and the preview and live links the app's CI reports. `--app <app-id>` reads another of the employee's apps.

The Git app requests a review from the organisation's reviewer team on every pull request. A reviewer approves and merges it on GitHub or Forgejo. Neither the employee nor the agent can approve or merge through Weldall. When the reviewer requests changes, the employee makes them and publishes again; the open pull request is updated.

Every published app is in the [app registry](../app-registry/), where administrators see all apps and owners confirm every 90 days that their apps are still needed (`weldall app list`, `weldall app confirm`).

## What goes into your organisation's Git

Only a reference to the person, never their name or email address:

- Each commit carries a `Weldall-App: <app id>` trailer. The commits are authored by the Git host identity the Git app uses: the GitHub App's bot account or the Forgejo bot user.
- The pull request text starts with `Published with Weldall (Weldall user <id>).`, with the opaque Weldall user ID.

Who that person is stays in Weldall: in the app registry and in the audit log.

## How git reaches the repository

Git on the employee's machine never talks to the Git host. It pushes to and fetches from the Git app at `https://git-app.example.com/git/<owner>/<repository>.git`. The Git app checks every request before it forwards anything:

- The git credential is valid, names this repository and, for a push, grants write access.
- Weldall confirms, without caching, that the person may still use Weldall, holds `git-app:publish`, and owns the app registered for this repository. Without an answer from Weldall, nothing is forwarded.
- A push updates only branches named `weldall/publish-*`. The Git app refuses pushes to the default branch, tags, branch deletion, more than five branches at once, push options, signed pushes, and pushes to the branch of a closed or merged pull request. Git shows the reason as `! [remote rejected] … (weldall: …)`.
- A push is forwarded only after Weldall has stored its audit entry. Otherwise git shows `the audit log is unavailable, nothing was pushed`.

Only then does the Git app use its access to the Git host and stream the request there. On GitHub it requests a token for this one repository, with read or write access to its contents. On Forgejo it uses the bot user's token, which cannot be narrowed.

## What reaches the employee's machine

Provider tokens never reach the CLI, and this holds for the Git host too: no GitHub or Forgejo token leaves the Git app.

Git cannot send Weldall's DPoP-bound login, so the CLI acts as git's credential helper (`weldall git-credential`). For each git command it requests a **git credential** from the Git app with the existing login and hands it to git as a password. The git credential is not a Git host token:

- It is valid for five minutes, for one app's repository and one person.
- It is read-only unless publish asks for write access.
- It works only at the Git app's git route, under all of the rules above. It cannot call the Git host's API or reach any other repository.
- Unlike Weldall's access tokens, it is **not bound to the device key**. Whoever copies it within those five minutes can fetch that repository, or push to its publish branches if it grants write access. That includes an agent running on the device with the employee's rights: it can obtain and read a git credential, even though the Weldall procedure tells it not to.
- The Git app signs git credentials and does not store them. A single git credential cannot be revoked, but removing the person's `git-app:publish` scope stops the next git request.

The CLI hands a git credential only to the origin Weldall lists for the Git app. Git asks the helper only for that origin's git route, publish clears every other credential helper for it, and the helper stores nothing, so the git credential does not end up in a keychain.

## What Weldall records

The audit log records repository creation (`git_repository.*`), every push before it is forwarded and its result (`git_push.*`, with person, repository, branch, old and new commit, size and outcome), every fetch (`git_fetch.*`), pull requests with their commits (`git_pull_request.*`), every git credential issued or refused (`git_credential.*`), and every checklist run (`git_host.checked`). The Git app hands out a git credential only after Weldall stored its audit entry. Refusals are recorded too, except the first request of each git command, which git always sends without a credential. Weldall redacts credentials from the metadata of every audit event before storing it.

## Limits

| Limit                       | Value                                 |
| --------------------------- | ------------------------------------- |
| Request body of one push    | 100 MiB                               |
| Response of one fetch       | 1 GiB                                 |
| Duration of one git request | 280 seconds                           |
| Concurrent git transfers    | 16 per Git app, 4 per person          |
| Git credentials             | 20 per person and minute, per Git app |
| Files in a publish          | 10 MiB per file, 100 MiB in total     |

A typical publish sends a few kilobytes. Publish needs git 2.39 or newer.

## What the Git app cannot enforce

The git proxy sees which branch a push updates, but not whether the push rewrites history. It cannot detect a force push to a publish branch. The Git app also cannot read GitHub's organisation rulesets, only the rules that apply to an existing repository. Protect the default branch on the Git host with a rule that requires a reviewed pull request and blocks force pushes and deletion: see [GitHub](../github-app/#protect-the-default-branch) and [Forgejo](../forgejo/#5-prepare-the-templates).

On Forgejo, someone who may publish can push a workflow file through the git proxy by hand, and Forgejo Actions runs it before any review. Read [CI secrets and workflows](../forgejo/#ci-secrets-and-workflows) before you switch on publishing to Forgejo.

:::caution[Status]
The Git app and the CLI's publish commands are tested against simulated GitHub and Forgejo APIs and a simulated Weldall, and the git proxy against a real git server. The building blocks were tried by hand against github.com and a local Forgejo while publishing was designed, but the complete flow has not yet run against a real GitHub, Forgejo or Weldall. The preview and live links depend on the app template's CI reporting them.
:::
