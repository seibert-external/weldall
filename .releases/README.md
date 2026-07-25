# Release manifests

The Forgejo release-PR workflow writes immutable JSON manifests here when pnpm native change intents bump a public package version.

After the release PR merges, the publish workflow derives each manifest's introduction commit from the first-parent history, builds and packs that exact commit without credentials, publishes missing npm versions, and creates package-specific tags and Forgejo releases. Manifests remain in the repository so interrupted releases can be resumed safely without assigning an old version to a newer commit.
