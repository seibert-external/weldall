import { GitAppError } from "../../errors.js";
import type { GitHost, GitRepositoryRef } from "../git-host.js";
import { createForgejoChecks } from "./checks.js";
import type { ForgejoConfig } from "./config.js";
import { readForgejoCommitIdentity } from "./identity.js";
import { createForgejoPullRequests } from "./pull-requests.js";
import { createForgejoRepositories } from "./repositories.js";

const repositoryName = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Forgejo enforces nothing about workflow files: a push that changes them is accepted, and Forgejo
 * Actions runs the pushed definition (measured with Forgejo 17). A branch protection rule with
 * protected file patterns cannot guard publish branches either, because Forgejo compares a new
 * branch against an empty tree and refuses every first push. Publish therefore keeps all three
 * directories Forgejo Actions reads from the repository, as on GitHub; this protects people from
 * accidental workflow changes, not from someone who pushes through the git proxy by hand.
 */
export const FORGEJO_PROTECTED_PATHS = [
  ".forgejo/workflows",
  ".gitea/workflows",
  ".github/workflows",
] as const;

/**
 * Forgejo implementation of the Git host seam. Forgejo has nothing like GitHub's installation
 * tokens: every operation uses the bot user's long-lived access token, which stays on this server.
 */
export function createForgejoHost({
  config,
  loadToken,
  timing,
}: {
  config: ForgejoConfig;
  loadToken: () => Promise<string>;
  /** Overrides the wait for a new repository's default branch (tests). */
  timing?: { readyTimeoutMs: number; pollIntervalMs: number };
}): GitHost {
  const repositories = createForgejoRepositories({ config, loadToken, ...timing });
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
    createForgejoPullRequests({ config, repository: repository.name, loadToken });
  return {
    setupMode: config.setupMode,
    protectedPaths: FORGEJO_PROTECTED_PATHS,
    checkSetup: (input, signal) =>
      createForgejoChecks({ config, loadToken, repositories })(input, signal),
    async readCommitIdentity({ repository }, signal) {
      assertRepository(repository);
      return readForgejoCommitIdentity({ config, token: await loadToken(), signal });
    },
    createRepository: (input, signal) => repositories.createRepository(input, signal),
    resolveNewRepository: (input) => repositories.resolveNewRepository(input),
    async getForwardingTarget({ repository }) {
      assertRepository(repository);
      const token = await loadToken();
      return {
        url: new URL(
          `${config.baseUrl}/${encodeURIComponent(config.organization)}/${encodeURIComponent(repository.name)}.git`,
        ),
        // Forgejo takes an access token as the Basic password; the user name is not checked.
        // The token's scopes cannot be narrowed per request, so reads and writes use the same one.
        authorization: `Basic ${Buffer.from(`weldall:${token}`).toString("base64")}`,
        expiresAt: null,
      };
    },
    async readBranchPullRequestState({ repository, branch }, signal) {
      assertRepository(repository);
      return pullRequestsOf(repository).readBranchPullRequestState(branch, signal);
    },
    async openPullRequest(input, signal) {
      assertRepository(input.repository);
      return pullRequestsOf(input.repository).openPullRequest(input, signal);
    },
    async readStatus(input, signal) {
      assertRepository(input.repository);
      return pullRequestsOf(input.repository).readStatus(input, signal);
    },
  };
}
