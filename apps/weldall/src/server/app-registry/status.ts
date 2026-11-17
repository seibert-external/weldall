import { ConnectorError, type AuthorizedConnectorActor } from "../connectors/contracts";
import { openGitHost } from "../connectors/core/git-hosts";
import type {
  GitCommitIdentity,
  GitHostWarning,
  PullRequestCheck,
  PullRequestReview,
  PullRequestState,
  RepositoryStatus,
} from "../connectors/git-host";
import { safeHttpsUrl, untrustedGitText } from "../connectors/git-text";
import { GIT_PUBLISH_BRANCH_PREFIX, isPublishBranch } from "../git-proxy/rules";
import { resolveOwnApp } from "./own-app";
import { updateAppLinks } from "./service";

/**
 * Bounds for what the status returns. Review texts, check names and logins come from the
 * customer's Git and reach an agent on the person's device: they are sanitised and returned only
 * as data fields.
 */
export const APP_STATUS_LIMITS = {
  /** The most recent reviews. */
  reviews: 30,
  reviewBody: 4_000,
  author: 100,
  checks: 50,
  checkName: 200,
  branch: 255,
} as const;

export interface AppStatusResult {
  app: { id: string; name: string };
  pullRequest: {
    number: number;
    webUrl: string;
    state: PullRequestState;
    headBranch: string;
    headCommit: string;
    reviews: Array<{
      author: string;
      state: PullRequestReview["state"];
      body: string;
      submittedAt: string | null;
    }>;
    checks: Array<{ name: string; state: PullRequestCheck["state"]; detailsUrl: string | null }>;
  } | null;
  /** The registry's links after this read; null until the CI reported one. */
  links: { preview: string | null; live: string | null };
  /**
   * What the CLI's publish step needs from the Git host: the paths it always takes from the
   * repository, and the identity of the commit it pushes (null when the host could not confirm
   * it; see the warnings). Host-neutral, so the CLI hard-codes neither.
   */
  publish: { protectedPaths: string[]; commitIdentity: GitCommitIdentity | null };
  /** Parts that could not be read, e.g. a permission the Git host App lacks. */
  warnings: GitHostWarning[];
}

/** When checks are cut, failures and pending ones are kept first. */
const checkPriority: Record<PullRequestCheck["state"], number> = {
  failure: 0,
  pending: 1,
  success: 2,
  neutral: 3,
};

function presentPullRequest(
  pullRequest: NonNullable<RepositoryStatus["pullRequest"]>,
  warnings: GitHostWarning[],
): NonNullable<AppStatusResult["pullRequest"]> {
  let checks = pullRequest.checks;
  if (checks.length > APP_STATUS_LIMITS.checks) {
    checks = [...checks]
      .sort((a, b) => checkPriority[a.state] - checkPriority[b.state])
      .slice(0, APP_STATUS_LIMITS.checks);
    warnings.push({
      code: "checks_truncated",
      message: `Only ${APP_STATUS_LIMITS.checks} of ${pullRequest.checks.length} checks and commit statuses are shown, failed and pending ones first.`,
    });
  }
  return {
    number: pullRequest.number,
    webUrl: pullRequest.webUrl,
    state: pullRequest.state,
    headBranch: untrustedGitText(pullRequest.headBranch, APP_STATUS_LIMITS.branch),
    headCommit: pullRequest.headCommit,
    reviews: pullRequest.reviews.slice(-APP_STATUS_LIMITS.reviews).map((review) => ({
      author: untrustedGitText(review.author, APP_STATUS_LIMITS.author) || "unknown",
      state: review.state,
      body: untrustedGitText(review.body, APP_STATUS_LIMITS.reviewBody, { multiline: true }),
      submittedAt: review.submittedAt?.toISOString() ?? null,
    })),
    checks: checks.map((check) => ({
      name: untrustedGitText(check.name, APP_STATUS_LIMITS.checkName) || "unnamed",
      state: check.state,
      detailsUrl: safeHttpsUrl(check.detailsUrl),
    })),
  };
}

/**
 * Reads the status of one of the caller's apps: its current pull request with reviews and
 * checks, and the preview and live links the CI reported. Without `branch`, the current pull
 * request is the most recent open one from a publish branch, else the most recently created one.
 * A link the host reports is written to the registry when it differs from the stored one.
 */
export async function readAppStatus({
  actor,
  appId,
  branch,
  signal,
}: {
  actor: AuthorizedConnectorActor;
  appId: string;
  /** A publish branch; omit for the current pull request. */
  branch?: string | undefined;
  signal: AbortSignal;
}): Promise<AppStatusResult> {
  let app = await resolveOwnApp({ actor, appId });
  if (branch !== undefined && !isPublishBranch(branch, app.defaultBranch))
    throw new ConnectorError(
      "invalid_request",
      `Name a branch called ${GIT_PUBLISH_BRANCH_PREFIX}<name>, or none for the current pull request.`,
    );
  const host = await openGitHost({ connectorId: app.connectorId });
  const target = { owner: app.repositoryOwner, name: app.repositoryName };
  const status = await host.readStatus(
    {
      repository: target,
      pullRequest:
        branch === undefined
          ? { publishBranch: (head) => isPublishBranch(head, app.defaultBranch) }
          : { branch },
    },
    signal,
  );
  const warnings = [...status.warnings];
  let commitIdentity: GitCommitIdentity | null = null;
  try {
    commitIdentity = await host.readCommitIdentity({ repository: target }, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    warnings.push({
      code: "commit_identity_unavailable",
      message: `${error instanceof ConnectorError ? error.message : "The Git host did not confirm the identity for published commits."} Publishing waits until it does; retry later.`,
    });
  }
  const preview = safeHttpsUrl(status.links.preview);
  const live = safeHttpsUrl(status.links.live);
  const changed = {
    ...(preview && preview !== app.previewUrl ? { previewUrl: preview } : {}),
    ...(live && live !== app.liveUrl ? { liveUrl: live } : {}),
  };
  if (Object.keys(changed).length) app = { ...app, ...(await updateAppLinks(app.id, changed)) };
  return {
    app: { id: app.id, name: app.name },
    pullRequest: status.pullRequest ? presentPullRequest(status.pullRequest, warnings) : null,
    links: { preview: app.previewUrl, live: app.liveUrl },
    publish: { protectedPaths: [...host.protectedPaths], commitIdentity },
    warnings,
  };
}
