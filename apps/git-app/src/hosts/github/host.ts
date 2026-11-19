import { GitAppError } from "../../errors.js";
import type { GitHost, GitRepositoryRef } from "../git-host.js";
import { deriveWebBaseUrl, type GitHubAppConfig } from "./config.js";
import {
  createGitHubPullRequests,
  GITHUB_PULL_REQUEST_PERMISSIONS,
  readGitHubBranchPullRequestState,
} from "./pull-requests.js";
import { createGitHubChecks } from "./checks.js";
import {
  commitIdentities,
  readGitHubCommitIdentity,
  type CommitIdentityCache,
} from "./identity.js";
import { createGitHubRepositories, GITHUB_REPOSITORY_PERMISSIONS } from "./repositories.js";
import {
  installationTokens,
  type GitHubPermissions,
  type InstallationTokenCache,
} from "./tokens.js";

/**
 * Installation permissions per operation, each requested on a token restricted to exactly one
 * repository, except `createRepository`: those permissions are required of the installation, and
 * `generate` runs with the installation-wide token (no repository or permission restriction,
 * never cached; GitHub refused every narrower token, see `mintRepositoryCreationToken`). A status read requests one token per part (see
 * `GITHUB_PULL_REQUEST_PERMISSIONS`), so a missing permission only removes that part. Together
 * they are the permissions the App needs: Contents (write), Pull requests (write), Checks, Commit
 * statuses and Deployments (read), Metadata (read), plus the organisation permissions Repository
 * creation (write) and Members (read).
 */
export const GITHUB_OPERATION_PERMISSIONS = {
  ...GITHUB_REPOSITORY_PERMISSIONS,
  ...GITHUB_PULL_REQUEST_PERMISSIONS,
  forwardRead: { contents: "read" },
  forwardWrite: { contents: "write" },
  readCommitIdentity: { metadata: "read" },
} as const satisfies Record<string, GitHubPermissions>;

const repositoryName = /^[A-Za-z0-9._-]{1,100}$/;

/** GitHub refuses pushes that change workflow files unless the token has `workflows: write`. */
export const GITHUB_PROTECTED_PATHS = [".github/workflows"] as const;

/** GitHub App implementation of the Git host seam; tokens stay on this server. */
export function createGitHubAppHost({
  config,
  loadPrivateKey,
  tokens = installationTokens,
  identities = commitIdentities,
  timing,
}: {
  config: GitHubAppConfig;
  loadPrivateKey: () => Promise<string>;
  tokens?: InstallationTokenCache;
  identities?: CommitIdentityCache;
  /** Overrides the wait for a new repository's default branch (tests). */
  timing?: { readyTimeoutMs: number; pollIntervalMs: number };
}): GitHost {
  const webBaseUrl = deriveWebBaseUrl(config.apiBaseUrl)!;
  const app = {
    apiBaseUrl: config.apiBaseUrl,
    appId: config.appId,
    organization: config.organization,
    installationId: config.installationId,
  };
  const repositories = createGitHubRepositories({
    config,
    app,
    webBaseUrl,
    loadPrivateKey,
    tokens,
    ...timing,
  });
  /** Only repositories of the configured organisation are reachable through this Git app. */
  const assertRepository = (repository: GitRepositoryRef) => {
    if (
      repository.owner.toLowerCase() !== config.organization.toLowerCase() ||
      !repositoryName.test(repository.name) ||
      repository.name === "." ||
      repository.name === ".."
    )
      throw new GitAppError(
        "invalid_target",
        "The repository is not in this Git app's organisation.",
      );
  };
  const pullRequestsOf = (repository: GitRepositoryRef) =>
    createGitHubPullRequests({
      apiBaseUrl: config.apiBaseUrl,
      webBaseUrl,
      owner: config.organization,
      repository: repository.name,
      mint: async (permissions, signal, options) =>
        (
          await tokens.mint({
            app,
            loadPrivateKey,
            repository: repository.name,
            permissions,
            signal,
            reuseRefusal: options?.reuseRefusal ?? false,
          })
        ).token,
    });
  return {
    setupMode: config.setupMode,
    protectedPaths: GITHUB_PROTECTED_PATHS,
    // A fresh checklist per call: it shares upstream answers only within one run.
    checkSetup: (input, signal) =>
      createGitHubChecks({
        config,
        app,
        webBaseUrl,
        loadPrivateKey,
        tokens,
        repositories,
        operationPermissions: GITHUB_OPERATION_PERMISSIONS,
      })(input, signal),
    async readCommitIdentity({ repository }, signal) {
      assertRepository(repository);
      return identities.resolve(`${config.apiBaseUrl}#${config.appId}`, () =>
        readGitHubCommitIdentity({
          apiBaseUrl: config.apiBaseUrl,
          webBaseUrl,
          appId: config.appId,
          loadPrivateKey,
          mintToken: async (tokenSignal) =>
            (
              await tokens.mint({
                app,
                loadPrivateKey,
                repository: repository.name,
                permissions: GITHUB_OPERATION_PERMISSIONS.readCommitIdentity,
                signal: tokenSignal,
              })
            ).token,
          signal,
        }),
      );
    },
    createRepository: (input, signal) => repositories.createRepository(input, signal),
    resolveNewRepository: (input) => repositories.resolveNewRepository(input),
    async getForwardingTarget({ repository, access }, signal) {
      assertRepository(repository);
      const { token, expiresAt } = await tokens.mint({
        app,
        loadPrivateKey,
        repository: repository.name,
        permissions:
          access === "write"
            ? GITHUB_OPERATION_PERMISSIONS.forwardWrite
            : GITHUB_OPERATION_PERMISSIONS.forwardRead,
        signal,
      });
      return {
        url: new URL(
          `${webBaseUrl}/${encodeURIComponent(config.organization)}/${encodeURIComponent(repository.name)}.git`,
        ),
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        expiresAt,
      };
    },
    async readBranchPullRequestState({ repository, branch }, signal) {
      assertRepository(repository);
      const { token } = await tokens.mint({
        app,
        loadPrivateKey,
        repository: repository.name,
        permissions: GITHUB_OPERATION_PERMISSIONS.readBranchPullRequestState,
        signal,
      });
      return readGitHubBranchPullRequestState({
        apiBaseUrl: config.apiBaseUrl,
        owner: config.organization,
        repository: repository.name,
        branch,
        token,
        signal,
      });
    },
    async openPullRequest(input, signal) {
      assertRepository(input.repository);
      return pullRequestsOf(input.repository).openPullRequest(
        { ...input, reviewerTeam: config.reviewerTeam },
        signal,
      );
    },
    async readStatus(input, signal) {
      assertRepository(input.repository);
      return pullRequestsOf(input.repository).readStatus(
        { ...input, liveEnvironments: config.liveEnvironments },
        signal,
      );
    },
  };
}
