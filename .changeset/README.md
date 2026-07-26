# Changesets

Every pull request that changes a published package should include a changeset:

```sh
pnpm changeset
```

Select `@weldall/sdk` and/or `@weldall/cli`, choose the SemVer bump, and describe the user-visible change. Documentation, tests, and internal refactors that do not require a release do not need an empty changeset.

After changes land on `main`, the official Changesets GitHub Action opens or updates one release pull request. Merging that pull request publishes the packages and creates the corresponding Git tags and GitHub releases.
