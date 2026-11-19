import type { AppHostApp } from "@weldall/sdk";
import { authorizePerson } from "../access.js";
import { GitAppError } from "../errors.js";
import type {
  GitCommitIdentity,
  GitHostWarning,
  PullRequestCheck,
  PullRequestReview,
  PullRequestState,
  RepositoryStatus,
} from "../hosts/git-host.js";
import { safeHttpsUrl, untrustedGitText } from "../git-text.js";
import { GIT_PUBLISH_BRANCH_PREFIX, isPublishBranch } from "../publish-branches.js";
import { weldallFailure } from "../weldall.js";
import type { GitAppServices, Person } from "./context.js";
import { resolveOwnApp } from "./own-app.js";

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
  /** Parts that could not be read, e.g. a permission the Git host credential lacks. */
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
 * Reads the status of one of the person's apps: its current pull request with reviews and
 * checks, and the preview and live links the CI reported. Without `branch`, the current pull request is the most recent open
 * one from a publish branch, else the most recently created one. A link the host reports is
 * written back to Weldall's registry (`updateApp`) when it differs from the stored one; when
 * Weldall does not take it, the call fails closed with 503.
 */
export async function readAppStatus({
  services,
  person,
  appId,
  branch,
  signal,
}: {
  services: GitAppServices;
  person: Person;
  appId: string;
  /** A publish branch; omit for the current pull request. */
  branch?: string | undefined;
  signal: AbortSignal;
}): Promise<AppStatusResult> {
  await authorizePerson(services.weldall, person.id, [services.scopes.publish]);
  let app: AppHostApp = await resolveOwnApp(services, person, appId);
  const defaultBranch = app.defaultBranch;
  if (branch !== undefined && !isPublishBranch(branch, defaultBranch))
    throw new GitAppError(
      "invalid_request",
      `Name a branch called ${GIT_PUBLISH_BRANCH_PREFIX}<name>, or none for the current pull request.`,
    );
  const { host } = services.host;
  const target = { owner: app.repository.owner, name: app.repository.name };
  const status = await host.readStatus(
    {
      repository: target,
      pullRequest:
        branch === undefined
          ? { publishBranch: (head) => isPublishBranch(head, defaultBranch) }
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
      message: `${error instanceof GitAppError ? error.message : "The Git host did not confirm the identity for published commits."} Publishing waits until it does; retry later.`,
    });
  }
  const preview = safeHttpsUrl(status.links.preview);
  const live = safeHttpsUrl(status.links.live);
  const changed = {
    ...(preview && preview !== app.links.preview ? { preview } : {}),
    ...(live && live !== app.links.live ? { live } : {}),
  };
  if (Object.keys(changed).length)
    try {
      app = await services.weldall.updateApp(app.id, { links: changed });
    } catch (error) {
      throw weldallFailure(error, "store the app's links");
    }
  return {
    app: { id: app.id, name: app.name },
    pullRequest: status.pullRequest ? presentPullRequest(status.pullRequest, warnings) : null,
    links: { preview: app.links.preview, live: app.links.live },
    publish: { protectedPaths: [...host.protectedPaths], commitIdentity },
    warnings,
  };
}
