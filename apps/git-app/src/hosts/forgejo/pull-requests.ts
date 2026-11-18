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
import { safeHttpsUrl } from "../../git-text.js";
import {
  branchPath,
  FORGEJO_PAGE_SIZE,
  forgejoApi,
  LIST_RESPONSE_LIMIT,
  protocolError,
  segment,
  totalCount,
  unexpected,
  type ForgejoApiResponse,
} from "./api.js";
import type { ForgejoConfig } from "./config.js";

const commitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const pullRequestResponse = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  head: z.object({
    ref: z.string().min(1).max(255),
    sha: commitId,
    repo: z.object({ full_name: z.string() }).nullable().optional(),
  }),
  base: z.object({ ref: z.string().min(1).max(255) }),
  requested_reviewers: z
    .array(z.object({ login: z.string() }))
    .nullable()
    .optional(),
  requested_reviewers_teams: z
    .array(z.object({ name: z.string() }))
    .nullable()
    .optional(),
});
type ForgejoPullRequest = z.infer<typeof pullRequestResponse>;
const reviewResponse = z.object({
  user: z.object({ login: z.string() }).nullable().optional(),
  state: z.string(),
  body: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
  dismissed: z.boolean().optional(),
});
const combinedStatusResponse = z.object({
  statuses: z
    .array(
      z.object({
        context: z.string(),
        status: z.string(),
        target_url: z.string().nullable().optional(),
      }),
    )
    .nullable(),
});
const repositoryResponse = z.object({ default_branch: z.string().min(1).max(255) });

/** Pull requests scanned for the current publish branch: all open ones, else the most recent. */
const RECENT_PULL_REQUESTS_SCANNED = 30;

/** Forgejo review states; requested and pending (draft) reviews are not submitted reviews. */
const reviewStates: Record<string, PullRequestReview["state"] | undefined> = {
  APPROVED: "approved",
  REQUEST_CHANGES: "changes_requested",
  COMMENT: "commented",
};

/** Forgejo's commit status values folded into the host-neutral outcome. */
function statusState(status: string): PullRequestCheck["state"] {
  if (status === "success") return "success";
  if (status === "pending") return "pending";
  if (status === "warning") return "neutral";
  // failure, error and anything new.
  return "failure";
}

const permissionMissing = () =>
  new GitAppError("permission_missing", "Forgejo refused the bot user's token.", 502);

function parse<T extends z.ZodType>(schema: T, response: ForgejoApiResponse): z.output<T> {
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}

/**
 * State of the pull requests whose head is `branch` of the same repository. Open wins over
 * merged, merged over closed; null when none exists.
 */
export function pullRequestStateOf(pulls: ForgejoPullRequest[]): PullRequestState | null {
  if (pulls.some(({ state }) => state === "open")) return "open";
  if (pulls.some(({ merged }) => merged)) return "merged";
  return pulls.length ? "closed" : null;
}

/** Pull requests, reviews and status of one repository of the configured organisation. */
export function createForgejoPullRequests({
  config,
  repository,
  loadToken,
}: {
  config: ForgejoConfig;
  repository: string;
  loadToken: () => Promise<string>;
}) {
  const owner = config.organization;
  const label = `${owner}/${repository}`;
  const repositoryPath = `/repos/${segment(owner)}/${segment(repository)}`;
  const webUrl = (number: number) =>
    `${config.baseUrl}/${segment(owner)}/${segment(repository)}/pulls/${number}`;
  const api = async (input: Omit<Parameters<typeof forgejoApi>[0], "baseUrl" | "token">) =>
    forgejoApi({ ...input, baseUrl: config.baseUrl, token: await loadToken() });
  const get = (path: string, signal: AbortSignal) =>
    api({
      path: `${repositoryPath}${path}`,
      method: "GET",
      responseLimit: LIST_RESPONSE_LIMIT,
      signal,
    });
  /** Only pull requests from a branch of this repository, never from a fork or AGit. */
  const fromThisRepository = (pull: ForgejoPullRequest) =>
    pull.head.repo?.full_name.toLowerCase() === label.toLowerCase();

  async function listPage(query: Record<string, string>, signal: AbortSignal) {
    const response = await get(`/pulls?${new URLSearchParams(query)}`, signal);
    if (response.status === 403) throw permissionMissing();
    if (response.status !== 200) throw unexpected(response);
    const listed = parse(z.array(pullRequestResponse), response);
    return {
      pulls: listed.filter(fromThisRepository),
      listed: listed.length,
      total: totalCount(response),
    };
  }
  const listPullRequests = async (query: Record<string, string>, signal: AbortSignal) =>
    (await listPage(query, signal)).pulls;

  /**
   * Pull requests whose head is `branch`, newest first. Relies on Forgejo's `head` filter; when a
   * server ignores it and lists more pull requests than one page without a match, the answer
   * cannot be trusted (a closed one may be beyond the page), so the lookup fails instead of
   * reporting "none".
   */
  async function pullRequestsOf(branch: string, state: "open" | "all", signal: AbortSignal) {
    const page = await listPage({ state, head: branch, limit: String(FORGEJO_PAGE_SIZE) }, signal);
    const matching = page.pulls.filter((pull) => pull.head.ref === branch);
    if (!matching.length && page.total !== null && page.total > page.listed)
      throw new GitAppError(
        "upstream_unavailable",
        "Forgejo did not narrow the pull requests to the branch, so Weldall cannot tell whether it had one. Retry later.",
        503,
      );
    return matching;
  }

  async function readBranchPullRequestState(branch: string, signal: AbortSignal) {
    return pullRequestStateOf(await pullRequestsOf(branch, "all", signal));
  }

  /** Commit ids of a pull request, oldest first; null (with a warning) when unreadable. */
  async function readCommits(
    pull: ForgejoPullRequest,
    warnings: GitHostWarning[],
    signal: AbortSignal,
  ): Promise<OpenedPullRequest["commits"]> {
    try {
      // Forgejo lists the newest commits first, at most one page of 50 per request.
      const ids: string[] = [];
      let count: number | null = null;
      for (let page = 1; ids.length < PULL_REQUEST_COMMIT_LIMIT; page += 1) {
        const response = await get(
          `/pulls/${pull.number}/commits?limit=${FORGEJO_PAGE_SIZE}&page=${page}`,
          signal,
        );
        if (response.status !== 200) throw unexpected(response);
        const batch = parse(z.array(z.object({ sha: commitId })), response);
        count ??= totalCount(response);
        ids.push(...batch.map(({ sha }) => sha));
        if (batch.length < FORGEJO_PAGE_SIZE || (count !== null && ids.length >= count)) break;
      }
      const newest = ids.slice(0, PULL_REQUEST_COMMIT_LIMIT);
      return { ids: newest.reverse(), count: Math.max(count ?? 0, newest.length) };
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
    pull: ForgejoPullRequest,
    warnings: GitHostWarning[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const team = config.reviewerTeam;
    const open = `The pull request #${pull.number} in ${label} is open, but`;
    try {
      const response = await api({
        path: `${repositoryPath}/pulls/${pull.number}/requested_reviewers`,
        method: "POST",
        body: { team_reviewers: [team] },
        responseLimit: LIST_RESPONSE_LIMIT,
        signal,
      });
      if (response.status === 201) return [team];
      if (response.status === 404 || response.status === 422) {
        // Forgejo's text is not forwarded: 404 for an unknown team, 422 for one without access.
        warnings.push({
          code: "reviewer_request_refused",
          message: `${open} Forgejo refused to request a review from the team "${team}": the team does not exist in ${owner} or has no access to ${label}. An owner of ${owner} must give the team access to all repositories, then request the review in Forgejo.`,
        });
        return [];
      }
      if (response.status === 403) {
        warnings.push({
          code: "reviewer_request_not_permitted",
          message: `${open} the bot user ${config.botUser} may not request reviewers. Check that its token has the scope write:repository, then request the review from "${team}" in Forgejo.`,
        });
        return [];
      }
      throw unexpected(response);
    } catch (error) {
      if (signal.aborted || !(error instanceof GitAppError)) throw error;
      warnings.push({
        code: "reviewer_request_failed",
        message: `${open} requesting a review from the team "${team}" failed (${error.message}). Request it in Forgejo.`,
      });
      return [];
    }
  }

  async function describe(
    pull: ForgejoPullRequest,
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
      commits: await readCommits(pull, warnings, signal),
      requestedReviewers: {
        users: created ? [] : (pull.requested_reviewers ?? []).map(({ login }) => login),
        teams: created
          ? requestedTeams
          : (pull.requested_reviewers_teams ?? []).map(({ name }) => name),
      },
      warnings,
    };
  }

  /**
   * Returns an open pull request of the branch. When nobody is requested and nobody has reviewed
   * yet (an earlier reviewer request failed), the configured team is requested again.
   */
  async function returnExisting(
    pull: ForgejoPullRequest,
    warnings: GitHostWarning[],
    signal: AbortSignal,
  ): Promise<OpenedPullRequest> {
    if (!pull.requested_reviewers?.length && !pull.requested_reviewers_teams?.length) {
      const reviews = await get(`/pulls/${pull.number}/reviews?limit=1`, signal).catch(
        (error: unknown) => {
          if (signal.aborted || !(error instanceof GitAppError)) throw error;
          return null;
        },
      );
      const reviewed =
        reviews?.status !== 200 || !Array.isArray(reviews.json) || reviews.json.length > 0;
      if (!reviewed) {
        const teams = await requestReviewers(pull, warnings, signal);
        return describe(
          { ...pull, requested_reviewers_teams: teams.map((name) => ({ name })) },
          false,
          [],
          warnings,
          signal,
        );
      }
    }
    return describe(pull, false, [], warnings, signal);
  }

  const notPermitted = () =>
    new GitAppError(
      "pull_requests_not_permitted",
      `Forgejo refused the bot user ${config.botUser} access for opening pull requests in ${label}. Check that its token has the scope write:repository and that it still has write access to the repository.`,
      502,
    );

  async function openPullRequest(
    input: OpenPullRequestInput,
    signal: AbortSignal,
  ): Promise<OpenedPullRequest> {
    const branch = await get(`/branches/${branchPath(input.head)}`, signal);
    if (branch.status === 404)
      throw new GitAppError(
        "branch_not_found",
        `The branch "${input.head}" does not exist in ${label}. Push it through Weldall first.`,
        409,
      );
    if (branch.status === 403) throw notPermitted();
    if (branch.status !== 200) throw unexpected(branch);
    const warnings: GitHostWarning[] = [];
    const openOf = async () => (await pullRequestsOf(input.head, "open", signal))[0] ?? null;
    try {
      const existing = await openOf();
      if (existing) return await returnExisting(existing, warnings, signal);
    } catch (error) {
      if (error instanceof GitAppError && error.code === "permission_missing") throw notPermitted();
      throw error;
    }
    const response = await api({
      path: `${repositoryPath}/pulls`,
      method: "POST",
      body: { title: input.title, head: input.head, base: input.base, body: input.body },
      responseLimit: LIST_RESPONSE_LIMIT,
      signal,
    });
    if (response.status === 201) {
      const pull = parse(pullRequestResponse, response);
      const teams = await requestReviewers(pull, warnings, signal);
      return describe(pull, true, teams, warnings, signal);
    }
    if (response.status === 409) {
      // A concurrent call opened it first.
      const existing = await openOf();
      if (existing) return returnExisting(existing, warnings, signal);
    }
    if (response.status === 409 || response.status === 422 || response.status === 404)
      throw new GitAppError(
        "pull_request_refused",
        `Forgejo refused to open a pull request from "${input.head}" into "${input.base}" in ${label}. Check that both branches exist and share history.`,
        502,
      );
    if (response.status === 403) throw notPermitted();
    throw unexpected(response);
  }

  /** The pull request a status read refers to (see {@link ReadStatusInput}). */
  async function findPullRequest(
    which: ReadStatusInput["pullRequest"],
    signal: AbortSignal,
  ): Promise<ForgejoPullRequest | null> {
    if ("branch" in which) {
      const pulls = await pullRequestsOf(which.branch, "all", signal);
      return pulls.find((pull) => pull.state === "open") ?? pulls[0] ?? null;
    }
    const matches = (pull: ForgejoPullRequest) => which.publishBranch(pull.head.ref);
    // Forgejo lists the newest pull requests first by default.
    const open = await listPullRequests(
      { state: "open", limit: String(FORGEJO_PAGE_SIZE) },
      signal,
    );
    return (
      open.find(matches) ??
      (
        await listPullRequests(
          { state: "all", limit: String(RECENT_PULL_REQUESTS_SCANNED) },
          signal,
        )
      ).find(matches) ??
      null
    );
  }

  async function readReviews(number: number, signal: AbortSignal) {
    // Forgejo lists the oldest reviews first; with more than one page, the newest pages matter.
    const first = await get(`/pulls/${number}/reviews?limit=${FORGEJO_PAGE_SIZE}`, signal);
    if (first.status === 403) throw permissionMissing();
    if (first.status !== 200) throw unexpected(first);
    let raw = parse(z.array(reviewResponse), first);
    const total = totalCount(first);
    if (total !== null && total > FORGEJO_PAGE_SIZE) {
      const last = Math.ceil(total / FORGEJO_PAGE_SIZE);
      const pages = await Promise.all(
        [last - 1, last].map(async (page) => {
          const response = await get(
            `/pulls/${number}/reviews?limit=${FORGEJO_PAGE_SIZE}&page=${page}`,
            signal,
          );
          if (response.status !== 200) throw unexpected(response);
          return parse(z.array(reviewResponse), response);
        }),
      );
      raw = pages.flat();
    }
    return raw.flatMap((review): PullRequestReview[] => {
      const state = review.dismissed ? "dismissed" : reviewStates[review.state];
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

  /** Latest status per context of `ref` (a commit id or branch). */
  async function readCombinedStatus(ref: string, signal: AbortSignal) {
    const response = await get(
      `/commits/${branchPath(ref)}/status?limit=${FORGEJO_PAGE_SIZE}`,
      signal,
    );
    if (response.status === 403) throw permissionMissing();
    if (response.status === 404) return [];
    if (response.status !== 200) throw unexpected(response);
    return parse(combinedStatusResponse, response).statuses ?? [];
  }

  /** Forgejo Actions report links relative to the instance; they are resolved against its origin. */
  const absoluteUrl = (value: string | null | undefined) => {
    if (!value) return null;
    try {
      return safeHttpsUrl(new URL(value, `${new URL(config.baseUrl).origin}/`).href);
    } catch {
      return null;
    }
  };
  /** The link of a successful status with `context`; only absolute https links count. */
  const linkOf = (
    statuses: z.infer<typeof combinedStatusResponse>["statuses"],
    context: string,
  ) => {
    const status = (statuses ?? []).find((candidate) => candidate.context === context);
    return status?.status === "success" ? safeHttpsUrl(status.target_url) : null;
  };

  /**
   * Runs one part of a status read. A refused token (403) becomes a warning; with
   * `permissionOnly`, other failures still fail the call.
   */
  async function readPart<T>(
    part: { code: string; what: string },
    warnings: GitHostWarning[],
    run: () => Promise<T>,
    signal: AbortSignal,
    { permissionOnly = false } = {},
  ): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (signal.aborted || !(error instanceof GitAppError)) throw error;
      if (error.code === "permission_missing") {
        warnings.push({
          code: `${part.code}_permission_missing`,
          message: `Forgejo refused the bot user ${config.botUser} access to ${part.what} of ${label}, so the status leaves it out. Check that its token has the scope write:repository and that it still has access to the repository.`,
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
    input: ReadStatusInput,
    signal: AbortSignal,
  ): Promise<RepositoryStatus> {
    const warnings: GitHostWarning[] = [];
    const pull = await readPart(
      { code: "pull_requests", what: "the pull request" },
      warnings,
      () => findPullRequest(input.pullRequest, signal),
      signal,
      { permissionOnly: true },
    );
    let pullRequest: PullRequestStatus | null = null;
    let headStatuses: z.infer<typeof combinedStatusResponse>["statuses"] = null;
    if (pull) {
      const [reviews, statuses] = await Promise.all([
        readPart(
          { code: "reviews", what: "the reviews" },
          warnings,
          () => readReviews(pull.number, signal),
          signal,
        ),
        readPart(
          { code: "statuses", what: "the commit statuses" },
          warnings,
          () => readCombinedStatus(pull.head.sha, signal),
          signal,
        ),
      ]);
      headStatuses = statuses;
      pullRequest = {
        number: pull.number,
        webUrl: webUrl(pull.number),
        state: pull.state === "open" ? "open" : pull.merged ? "merged" : "closed",
        headBranch: pull.head.ref,
        headCommit: pull.head.sha,
        reviews: reviews ?? [],
        checks: (statuses ?? []).map((status) => ({
          name: status.context,
          state: statusState(status.status),
          detailsUrl: absoluteUrl(status.target_url),
        })),
      };
    }
    const live = await readPart(
      { code: "links", what: "the live link" },
      warnings,
      async () => {
        const response = await api({ path: repositoryPath, method: "GET", signal });
        if (response.status === 403) throw permissionMissing();
        if (response.status !== 200) throw unexpected(response);
        const { default_branch } = parse(repositoryResponse, response);
        return linkOf(await readCombinedStatus(default_branch, signal), config.liveStatusContext);
      },
      signal,
    );
    return {
      pullRequest,
      links: { preview: linkOf(headStatuses, config.previewStatusContext), live },
      warnings,
    };
  }

  return { openPullRequest, readStatus, readBranchPullRequestState };
}
