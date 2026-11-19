import { z } from "zod";
import { GitAppError } from "../../errors.js";
import {
  PULL_REQUEST_COMMIT_LIMIT,
  type GitHostWarning,
  type OpenPullRequestInput,
  type OpenedPullRequest,
  type PullRequestCheck,
  type PullRequestReview,
  type PullRequestState,
  type PullRequestStatus,
  type ReadStatusInput,
  type RepositoryStatus,
} from "../git-host.js";
import { githubApi, LIST_RESPONSE_LIMIT, segment, type GitHubApiResponse } from "./api.js";
import { readGitHubDeploymentLinks } from "./links.js";
import { rateLimited, unexpected } from "./repositories.js";
import type { GitHubPermissions } from "./tokens.js";

const pullRequests = z.array(
  z.object({ state: z.enum(["open", "closed"]), merged_at: z.string().nullable().optional() }),
);

/**
 * State of the pull requests whose head is `branch` of the same repository (GitHub's `head`
 * filter is `<owner>:<branch>`). Open wins over merged, merged over closed; null when none exists.
 * One page of 100 is enough: a publish branch carries at most a handful of pull requests.
 */
export async function readGitHubBranchPullRequestState({
  apiBaseUrl,
  owner,
  repository,
  branch,
  token,
  signal,
}: {
  apiBaseUrl: string;
  owner: string;
  repository: string;
  branch: string;
  /** Installation token restricted to `repository` with `pull_requests: read`. */
  token: string;
  signal: AbortSignal;
}): Promise<PullRequestState | null> {
  const query = new URLSearchParams({ state: "all", head: `${owner}:${branch}`, per_page: "100" });
  const response = await githubApi({
    apiBaseUrl,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?${query}`,
    method: "GET",
    token,
    signal,
  });
  if (response.status !== 200) throw unexpected(response);
  const parsed = pullRequests.safeParse(response.json);
  if (!parsed.success)
    throw new GitAppError("upstream_protocol_error", "GitHub sent an invalid response.", 502);
  if (parsed.data.some(({ state }) => state === "open")) return "open";
  if (parsed.data.some(({ merged_at }) => merged_at)) return "merged";
  return parsed.data.length ? "closed" : null;
}

/** One repository of the configured organisation, with a minter for tokens restricted to it. */
export interface GitHubRepositoryContext {
  apiBaseUrl: string;
  /** Browser origin matching the API base, e.g. https://github.com. */
  webBaseUrl: string;
  owner: string;
  repository: string;
  /**
   * Installation token restricted to `repository`; `token_refused` when a permission is not
   * granted. With `reuseRefusal`, a refusal of the last few minutes is answered from memory
   * (see `TOKEN_REFUSAL_TTL_MS`).
   */
  mint: (
    permissions: GitHubPermissions,
    signal: AbortSignal,
    options?: { reuseRefusal?: boolean },
  ) => Promise<string>;
}

/**
 * Permissions of the pull request operations, each requested on its own token restricted to the
 * one repository, so that a permission the installation lacks only removes its part of the
 * status. `openPullRequest` reads the head branch (`contents: read`) before opening.
 */
export const GITHUB_PULL_REQUEST_PERMISSIONS = {
  openPullRequest: { contents: "read", pull_requests: "write" },
  readBranchPullRequestState: { pull_requests: "read" },
  /** Pull request lookup and its reviews. */
  readPullRequest: { pull_requests: "read" },
  /** Check runs of the head commit. */
  readChecks: { checks: "read" },
  /** Commit statuses of the head commit. */
  readCommitStatuses: { statuses: "read" },
  /** Deployments and their statuses, where the CI's preview or live link is read from. */
  readDeployments: { deployments: "read" },
} as const satisfies Record<string, GitHubPermissions>;

/** Reviews and checks GitHub is asked for; the app registry bounds what leaves the server. */
const REVIEWS_PER_PAGE = 100;
const CHECKS_PER_PAGE = 50;
/** Pull requests scanned for the current publish branch: all open ones, else the most recent. */
const OPEN_PULL_REQUESTS_SCANNED = 100;
const RECENT_PULL_REQUESTS_SCANNED = 30;

const commitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const pullRequestResponse = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable().optional(),
  /** Only on single pull requests (create, get), not in lists. */
  commits: z.number().int().nonnegative().optional(),
  head: z.object({
    ref: z.string().min(1).max(255),
    sha: commitId,
    repo: z.object({ full_name: z.string() }).nullable().optional(),
  }),
  base: z.object({ ref: z.string().min(1).max(255) }),
  requested_reviewers: z.array(z.object({ login: z.string() })).optional(),
  requested_teams: z.array(z.object({ slug: z.string() })).optional(),
});
type GitHubPullRequest = z.infer<typeof pullRequestResponse>;
const reviewResponse = z.object({
  user: z.object({ login: z.string() }).nullable(),
  state: z.string(),
  body: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});
const checkRunsResponse = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      details_url: z.string().nullable().optional(),
      html_url: z.string().nullable().optional(),
    }),
  ),
});
const combinedStatusResponse = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      target_url: z.string().nullable().optional(),
    }),
  ),
});

const protocolError = () =>
  new GitAppError("upstream_protocol_error", "GitHub sent an invalid response.", 502);
/** Marks a 403 that names a missing App permission; mapped to a warning by {@link readPart}. */
const permissionMissing = () =>
  new GitAppError("permission_missing", "GitHub refused the App's token.", 502);

function parse<T extends z.ZodType>(schema: T, response: GitHubApiResponse): z.output<T> {
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}

/** Branch names may contain `/`; each part is encoded on its own (an encoded `/` is refused). */
const branchPath = (branch: string) => branch.split("/").map(segment).join("/");

const reviewStates: Record<string, PullRequestReview["state"] | undefined> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/** Folds GitHub's check run status and conclusion into the host-neutral outcome. */
function checkRunState(status: string, conclusion: string | null | undefined) {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "success";
  if (conclusion === "neutral" || conclusion === "skipped" || conclusion === "stale")
    return "neutral";
  // failure, timed_out, cancelled, action_required, startup_failure and anything new.
  return "failure";
}
function commitStatusState(state: string): PullRequestCheck["state"] {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failure";
}

/** Opening and reading pull requests of one repository, with installation tokens per operation. */
export function createGitHubPullRequests(context: GitHubRepositoryContext) {
  const { apiBaseUrl, owner, repository } = context;
  const label = `${owner}/${repository}`;
  const repositoryPath = `/repos/${segment(owner)}/${segment(repository)}`;
  const webUrl = (number: number) =>
    `${context.webBaseUrl}/${segment(owner)}/${segment(repository)}/pull/${number}`;
  const get = (token: string, path: string, signal: AbortSignal, list = true) =>
    githubApi({
      apiBaseUrl,
      path: `${repositoryPath}${path}`,
      method: "GET",
      token,
      ...(list ? { responseLimit: LIST_RESPONSE_LIMIT } : {}),
      signal,
    });
  /** Only pull requests from a branch of this repository, never from a fork. */
  const fromThisRepository = (pull: GitHubPullRequest) =>
    // A pull request whose head repository was deleted has `repo: null`; it is not ours either.
    pull.head.repo?.full_name.toLowerCase() === label.toLowerCase();

  async function listPullRequests(
    token: string,
    query: Record<string, string>,
    signal: AbortSignal,
  ): Promise<GitHubPullRequest[]> {
    const response = await get(token, `/pulls?${new URLSearchParams(query)}`, signal);
    if (response.status === 403 && !rateLimited(response)) throw permissionMissing();
    if (response.status !== 200) throw unexpected(response);
    return parse(z.array(pullRequestResponse), response).filter(fromThisRepository);
  }

  const openPullRequestOf = async (token: string, branch: string, signal: AbortSignal) =>
    (
      await listPullRequests(
        token,
        { state: "open", head: `${owner}:${branch}`, per_page: "10" },
        signal,
      )
    ).find((pull) => pull.head.ref === branch) ?? null;

  /** Commit ids of a pull request, oldest first; null (with a warning) when unreadable. */
  async function readCommits(
    token: string,
    pull: GitHubPullRequest,
    warnings: GitHostWarning[],
    signal: AbortSignal,
  ): Promise<OpenedPullRequest["commits"]> {
    try {
      const response = await get(
        token,
        `/pulls/${pull.number}/commits?per_page=${PULL_REQUEST_COMMIT_LIMIT}`,
        signal,
      );
      if (response.status !== 200) throw unexpected(response);
      const ids = parse(z.array(z.object({ sha: commitId })), response).map(({ sha }) => sha);
      return { ids, count: Math.max(pull.commits ?? ids.length, ids.length) };
    } catch (error) {
      if (signal.aborted || !(error instanceof GitAppError)) throw error;
      warnings.push({
        code: "commits_unreadable",
        message: `The pull request #${pull.number} in ${label} is open, but Weldall could not read its commits for the audit log: ${error.message}`,
      });
      return null;
    }
  }

  /** Requests a review from the configured team; every failure becomes a warning. */
  async function requestReviewers(
    token: string,
    pull: GitHubPullRequest,
    team: string,
    warnings: GitHostWarning[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const open = `The pull request #${pull.number} in ${label} is open, but`;
    try {
      const response = await githubApi({
        apiBaseUrl,
        path: `${repositoryPath}/pulls/${pull.number}/requested_reviewers`,
        method: "POST",
        token,
        body: { team_reviewers: [team] },
        responseLimit: LIST_RESPONSE_LIMIT,
        signal,
      });
      if (response.status === 201) {
        const teams = parse(pullRequestResponse, response).requested_teams?.map(({ slug }) => slug);
        if (teams?.some((slug) => slug.toLowerCase() === team.toLowerCase())) return [team];
        warnings.push({
          code: "reviewer_request_ignored",
          message: `${open} GitHub did not add the reviewer team "${team}" to it. An administrator must check that the team exists in ${owner} and has access to ${label}, then request the review on GitHub.`,
        });
        return [];
      }
      if (response.status === 422) {
        warnings.push({
          code: "reviewer_request_refused",
          message: `${open} GitHub refused to request a review from the team "${team}": the team does not exist in ${owner} or has no access to ${label}. An administrator must give the team write access to the repository, then request the review on GitHub.`,
        });
        return [];
      }
      if (response.status === 403 && !rateLimited(response)) {
        warnings.push({
          code: "reviewer_request_not_permitted",
          message: `${open} the GitHub App may not request reviewers. Grant it "Pull requests: write", accept the updated permissions on the installation and request the review from "${team}" on GitHub.`,
        });
        return [];
      }
      throw unexpected(response);
    } catch (error) {
      if (signal.aborted || !(error instanceof GitAppError)) throw error;
      warnings.push({
        code: "reviewer_request_failed",
        message: `${open} requesting a review from the team "${team}" failed (${error.message}). Request it on GitHub.`,
      });
      return [];
    }
  }

  async function describe(
    token: string,
    pull: GitHubPullRequest,
    created: boolean,
    requestedTeams: string[],
    warnings: GitHostWarning[],
    signal: AbortSignal,
  ): Promise<OpenedPullRequest> {
    return {
      created,
      number: pull.number,
      webUrl: webUrl(pull.number),
      headBranch: pull.head.ref,
      baseBranch: pull.base.ref,
      headCommit: pull.head.sha,
      commits: await readCommits(token, pull, warnings, signal),
      requestedReviewers: {
        users: created ? [] : (pull.requested_reviewers ?? []).map(({ login }) => login),
        teams: created ? requestedTeams : (pull.requested_teams ?? []).map(({ slug }) => slug),
      },
      warnings,
    };
  }

  /**
   * Returns an open pull request of the branch. When nobody is requested and nobody has reviewed
   * yet (an earlier reviewer request failed), the configured team is requested again; a reviewer
   * who already reviewed is no longer listed as requested and is not asked again.
   */
  async function returnExisting(
    token: string,
    pull: GitHubPullRequest,
    team: string,
    warnings: GitHostWarning[],
    signal: AbortSignal,
  ): Promise<OpenedPullRequest> {
    if (!pull.requested_reviewers?.length && !pull.requested_teams?.length) {
      const reviews = await get(token, `/pulls/${pull.number}/reviews?per_page=1`, signal).catch(
        (error: unknown) => {
          if (signal.aborted || !(error instanceof GitAppError)) throw error;
          return null;
        },
      );
      const reviewed =
        reviews?.status !== 200 || !Array.isArray(reviews.json) || reviews.json.length > 0;
      if (!reviewed) {
        const teams = await requestReviewers(token, pull, team, warnings, signal);
        return describe(
          token,
          { ...pull, requested_teams: teams.map((slug) => ({ slug })) },
          false,
          [],
          warnings,
          signal,
        );
      }
    }
    return describe(token, pull, false, [], warnings, signal);
  }

  const notPermitted = () =>
    new GitAppError(
      "pull_requests_not_permitted",
      `GitHub refused the App access for opening pull requests in ${label}. Grant the GitHub App "Pull requests: write" and "Contents: read", accept the updated permissions on the installation, and check that the repository is still in the installation.`,
      502,
    );

  /**
   * Opens a pull request from `head` into `base`, or returns the open one of `head`. Reviewers
   * are requested on a new pull request, and again on an open one nobody was requested for.
   */
  async function openPullRequest(
    input: OpenPullRequestInput & { reviewerTeam: string },
    signal: AbortSignal,
  ): Promise<OpenedPullRequest> {
    let token: string;
    try {
      token = await context.mint(GITHUB_PULL_REQUEST_PERMISSIONS.openPullRequest, signal);
    } catch (error) {
      if (error instanceof GitAppError && error.code === "token_refused") throw notPermitted();
      throw error;
    }
    const branch = await get(token, `/branches/${branchPath(input.head)}`, signal, false);
    if (branch.status === 404)
      throw new GitAppError(
        "branch_not_found",
        `The branch "${input.head}" does not exist in ${label}. Push it through Weldall first.`,
        409,
      );
    if (branch.status !== 200) throw unexpected(branch);
    const warnings: GitHostWarning[] = [];
    try {
      const existing = await openPullRequestOf(token, input.head, signal);
      if (existing)
        return await returnExisting(token, existing, input.reviewerTeam, warnings, signal);
    } catch (error) {
      if (error instanceof GitAppError && error.code === "permission_missing") throw notPermitted();
      throw error;
    }
    const response = await githubApi({
      apiBaseUrl,
      path: `${repositoryPath}/pulls`,
      method: "POST",
      token,
      body: { title: input.title, head: input.head, base: input.base, body: input.body },
      responseLimit: LIST_RESPONSE_LIMIT,
      signal,
    });
    if (response.status === 201) {
      const pull = parse(pullRequestResponse, response);
      const teams = await requestReviewers(token, pull, input.reviewerTeam, warnings, signal);
      return describe(token, pull, true, teams, warnings, signal);
    }
    if (response.status === 422) {
      // A concurrent call opened it first; GitHub's text is inspected, never forwarded.
      const existing = await openPullRequestOf(token, input.head, signal);
      if (existing) return returnExisting(token, existing, input.reviewerTeam, warnings, signal);
      if (/no commits between/i.test(JSON.stringify(response.json ?? "")))
        throw new GitAppError(
          "nothing_to_publish",
          `The branch "${input.head}" has no commits that "${input.base}" does not already have.`,
          409,
        );
      throw new GitAppError(
        "pull_request_refused",
        `GitHub refused to open a pull request from "${input.head}" into "${input.base}" in ${label}. Check that both branches exist and share history.`,
        502,
      );
    }
    if (response.status === 403 && !rateLimited(response)) throw notPermitted();
    throw unexpected(response);
  }

  /** The pull request a status read refers to (see {@link ReadStatusInput}). */
  async function findPullRequest(
    token: string,
    which: ReadStatusInput["pullRequest"],
    signal: AbortSignal,
  ): Promise<GitHubPullRequest | null> {
    if ("branch" in which) {
      const pulls = (
        await listPullRequests(
          token,
          { state: "all", head: `${owner}:${which.branch}`, per_page: "20" },
          signal,
        )
      ).filter((pull) => pull.head.ref === which.branch);
      return pulls.find((pull) => pull.state === "open") ?? pulls[0] ?? null;
    }
    const matches = (pull: GitHubPullRequest) => which.publishBranch(pull.head.ref);
    const recent = { sort: "created", direction: "desc" };
    const open = await listPullRequests(
      token,
      { state: "open", ...recent, per_page: String(OPEN_PULL_REQUESTS_SCANNED) },
      signal,
    );
    return (
      open.find(matches) ??
      (
        await listPullRequests(
          token,
          { state: "all", ...recent, per_page: String(RECENT_PULL_REQUESTS_SCANNED) },
          signal,
        )
      ).find(matches) ??
      null
    );
  }

  async function readReviews(token: string, number: number, signal: AbortSignal) {
    const response = await get(
      token,
      `/pulls/${number}/reviews?per_page=${REVIEWS_PER_PAGE}`,
      signal,
    );
    if (response.status === 403 && !rateLimited(response)) throw permissionMissing();
    if (response.status !== 200) throw unexpected(response);
    return parse(z.array(reviewResponse), response).flatMap((review): PullRequestReview[] => {
      const state = reviewStates[review.state];
      // Pending reviews are drafts their author has not submitted.
      if (!state) return [];
      const submittedAt = review.submitted_at ? new Date(review.submitted_at) : null;
      return [
        {
          author: review.user?.login ?? "ghost",
          state,
          body: review.body ?? "",
          submittedAt: submittedAt && !Number.isNaN(submittedAt.getTime()) ? submittedAt : null,
        },
      ];
    });
  }

  async function readCheckRuns(token: string, commit: string, signal: AbortSignal) {
    const response = await get(
      token,
      `/commits/${commit}/check-runs?per_page=${CHECKS_PER_PAGE}`,
      signal,
    );
    if (response.status === 403 && !rateLimited(response)) throw permissionMissing();
    if (response.status !== 200) throw unexpected(response);
    const { total_count, check_runs } = parse(checkRunsResponse, response);
    return {
      total: total_count,
      checks: check_runs.map((run): PullRequestCheck => ({
        name: run.name,
        state: checkRunState(run.status, run.conclusion),
        detailsUrl: run.details_url || run.html_url || null,
      })),
    };
  }

  async function readCommitStatuses(token: string, commit: string, signal: AbortSignal) {
    // The combined status holds the latest status per context.
    const response = await get(token, `/commits/${commit}/status?per_page=100`, signal);
    if (response.status === 403 && !rateLimited(response)) throw permissionMissing();
    if (response.status !== 200) throw unexpected(response);
    return parse(combinedStatusResponse, response).statuses.map((status): PullRequestCheck => ({
      name: status.context,
      state: commitStatusState(status.state),
      detailsUrl: status.target_url || null,
    }));
  }

  /**
   * Runs one part of a status read with its own token. A permission the installation lacks (token
   * refused, or 403 on the read) becomes a warning naming it; with `permissionOnly`, other
   * failures still fail the call.
   */
  async function readPart<T>(
    part: { code: string; permission: GitHubPermissions; label: string; what: string },
    warnings: GitHostWarning[],
    run: (token: string) => Promise<T>,
    signal: AbortSignal,
    { permissionOnly = false } = {},
  ): Promise<T | null> {
    try {
      // A refusal only becomes a warning here, so a recent one is not asked for again.
      return await run(await context.mint(part.permission, signal, { reuseRefusal: true }));
    } catch (error) {
      if (signal.aborted || !(error instanceof GitAppError)) throw error;
      if (error.code === "token_refused" || error.code === "permission_missing") {
        warnings.push({
          code: `${part.code}_permission_missing`,
          message: `The GitHub App lacks the permission "${part.label}" on ${label} (or the repository left its installation), so the status leaves out ${part.what}. Grant the permission to the App and accept the updated permissions on the installation.`,
        });
        return null;
      }
      if (permissionOnly) throw error;
      warnings.push({
        code: `${part.code}_unavailable`,
        message: `Weldall could not read ${part.what} of ${label}: ${error.message}`,
      });
      return null;
    }
  }

  async function readStatus(
    input: ReadStatusInput & { liveEnvironments: readonly string[] },
    signal: AbortSignal,
  ): Promise<RepositoryStatus> {
    const warnings: GitHostWarning[] = [];
    const pullRequestPart = {
      code: "pull_requests",
      permission: GITHUB_PULL_REQUEST_PERMISSIONS.readPullRequest,
      label: "Pull requests: read",
    };
    const pull = await readPart(
      { ...pullRequestPart, what: "the pull request" },
      warnings,
      (token) => findPullRequest(token, input.pullRequest, signal),
      signal,
      { permissionOnly: true },
    );
    let pullRequest: PullRequestStatus | null = null;
    if (pull) {
      const commit = pull.head.sha;
      const [reviews, checkRuns, statuses] = await Promise.all([
        readPart(
          { ...pullRequestPart, code: "reviews", what: "the reviews" },
          warnings,
          (token) => readReviews(token, pull.number, signal),
          signal,
        ),
        readPart(
          {
            code: "checks",
            permission: GITHUB_PULL_REQUEST_PERMISSIONS.readChecks,
            label: "Checks: read",
            what: "the check runs",
          },
          warnings,
          (token) => readCheckRuns(token, commit, signal),
          signal,
        ),
        readPart(
          {
            code: "statuses",
            permission: GITHUB_PULL_REQUEST_PERMISSIONS.readCommitStatuses,
            label: "Commit statuses: read",
            what: "the commit statuses",
          },
          warnings,
          (token) => readCommitStatuses(token, commit, signal),
          signal,
        ),
      ]);
      if (checkRuns && checkRuns.total > checkRuns.checks.length)
        warnings.push({
          code: "checks_truncated",
          message: `Only ${checkRuns.checks.length} of ${checkRuns.total} check runs are shown.`,
        });
      pullRequest = {
        number: pull.number,
        webUrl: webUrl(pull.number),
        state: pull.state === "open" ? "open" : pull.merged_at ? "merged" : "closed",
        headBranch: pull.head.ref,
        headCommit: commit,
        reviews: reviews ?? [],
        checks: [...(checkRuns?.checks ?? []), ...(statuses ?? [])],
      };
    }
    const links = await readPart(
      {
        code: "deployments",
        permission: GITHUB_PULL_REQUEST_PERMISSIONS.readDeployments,
        label: "Deployments: read",
        what: "the preview and live links",
      },
      warnings,
      (token) =>
        readGitHubDeploymentLinks({
          get: async (path) => {
            const response = await get(token, path, signal);
            if (response.status === 403 && !rateLimited(response)) throw permissionMissing();
            if (response.status !== 200) throw unexpected(response);
            return response.json;
          },
          headCommit: pullRequest?.headCommit ?? null,
          liveEnvironments: input.liveEnvironments,
        }),
      signal,
    );
    return { pullRequest, links: links ?? { preview: null, live: null }, warnings };
  }

  return { openPullRequest, readStatus };
}
