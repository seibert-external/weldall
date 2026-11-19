# Changesets

Every pull request that changes a published package should include a changeset:

```sh
pnpm changeset
```

Select the affected packages, choose the SemVer bump, and describe the user-visible change. Documentation, tests, and internal refactors that do not require a release do not need an empty changeset.

Six packages are release units:

- `@weldall/sdk`, `@weldall/cli`, and `@weldall/goose` are published to npm. The Goose stdio MCP server is released independently of the local CLI; its compatibility range and manual acceptance gates are documented in `apps/goose-extension/README.md`. Build regenerates its version-pinned MCP Registry descriptor; registry publication is a separate authorized release step after stock-Goose acceptance.
- `@weldall/weldall`, `@weldall/discovery-proxy` and `@weldall/git-app` are private apps that only receive a version, a Git tag, and a GitHub release; those tags drive the Docker image releases. Every change to `apps/weldall`, `apps/discovery-proxy` or `apps/git-app` that should ship in an image needs a changeset for that app. One exception: an `@weldall/sdk` release also produces `@weldall/weldall` and `@weldall/git-app` patch releases and images without an app changeset, because both depend on the SDK (`workspace:*` plus `updateInternalDependencies: "patch"`) and their images bundle it. The CLI is not bumped this way because it lists the SDK only as a devDependency. The proxy has no workspace dependencies at all.

All other workspace packages are listed under `ignore` in `config.json` and are never versioned: a changeset that names only ignored packages is silently skipped, and one that mixes an ignored package with a release unit is rejected. Changes to `packages/db` ship through `@weldall/weldall`, so add the changeset there.

After changes land on `main`, the official Changesets GitHub Action opens or updates one release pull request. Merging that pull request publishes the npm packages and creates the Git tags and GitHub releases for all six release units.
