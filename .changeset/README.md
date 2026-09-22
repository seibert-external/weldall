# Changesets

Every pull request that changes a published package should include a changeset:

```sh
pnpm changeset
```

Select the affected packages, choose the SemVer bump, and describe the user-visible change. Documentation, tests, and internal refactors that do not require a release do not need an empty changeset.

Four packages are release units:

- `@weldall/sdk` and `@weldall/cli` are published to npm.
- `@weldall/weldall` and `@weldall/discovery-proxy` are private apps that only receive a version, a Git tag, and a GitHub release; those tags drive the Docker image releases. Every change to `apps/weldall` or `apps/discovery-proxy` that should ship in an image needs a changeset for that app. One exception: an `@weldall/sdk` release also produces a `@weldall/weldall` patch release and image without an app changeset, because the server depends on the SDK (`workspace:*` plus `updateInternalDependencies: "patch"`) and the image bundles it. The CLI is not bumped this way because it lists the SDK only as a devDependency. The proxy has no workspace dependencies at all.

All other workspace packages are listed under `ignore` in `config.json` and are never versioned: a changeset that names only ignored packages is silently skipped, and one that mixes an ignored package with a release unit is rejected. Changes to `packages/db` ship through `@weldall/weldall`, so add the changeset there.

After changes land on `main`, the official Changesets GitHub Action opens or updates one release pull request. Merging that pull request publishes the npm packages and creates the Git tags and GitHub releases for all four release units.
