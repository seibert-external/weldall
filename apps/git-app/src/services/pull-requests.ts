import { auditList, auditText } from "../audit.js";
import { authorizePerson } from "../access.js";
import { GitAppError } from "../errors.js";
import type { GitHostWarning, GitReviewers } from "../hosts/git-host.js";
import { GIT_PUBLISH_BRANCH_PREFIX, isPublishBranch } from "../publish-branches.js";
import type { GitAppServices, Person } from "./context.js";
import { resolveOwnApp } from "./own-app.js";
import { pullRequestBody, pullRequestTitle } from "./pull-request-body.js";
import type { AppHostApp } from "@weldall/sdk";

export interface OpenPullRequestInput {
  /** Branch under {@link GIT_PUBLISH_BRANCH_PREFIX} that the person pushed through the git proxy. */
  head: string;
  title: string;
  body: string;
}

export interface OpenPullRequestResult {
  /** False when the branch's open pull request already existed and is returned unchanged. */
  created: boolean;
  app: { id: string; name: string };
  pullRequest: {
    number: number;
    webUrl: string;
    headBranch: string;
    baseBranch: string;
    headCommit: string;
  };
  requestedReviewers: GitReviewers;
  warnings: GitHostWarning[];
}

/** Codes that reject the person's request rather than report a failure. */
const deniedCodes = new Set([
  "access_denied",
  "invalid_request",
  "not_found",
  "invalid_target",
  "repository_not_ready",
  "branch_not_found",
  "nothing_to_publish",
]);

/**
 * Opens the pull request for one of the person's apps from a publish branch into the app's
 * default branch (never a caller-chosen base), with the trigger line carrying the Weldall user id
 * at the top of the body, and requests the configured reviewers (carried over from the server's
 * `app-registry/pull-requests.ts`). Idempotent per head branch: an open pull request of the
 * branch is returned instead of a second one. The audit records the person and the commits the
 * pull request contains. If Weldall does not store the audit entry, the person gets 503 although
 * the pull request is open; a repeat returns it and reports it again (`existingPullRequest`).
 */
export async function openPullRequest({
  services,
  person,
  appId,
  input,
  signal,
}: {
  services: GitAppServices;
  person: Person;
  appId: string;
  input: OpenPullRequestInput;
  signal: AbortSignal;
}): Promise<OpenPullRequestResult> {
  let app: AppHostApp | null = null;
  try {
    await authorizePerson(services.weldall, person.id, [services.scopes.publish]);
    app = await resolveOwnApp(services, person, appId);
    if (!isPublishBranch(input.head, app.defaultBranch))
      throw new GitAppError(
        "invalid_request",
        `Pull requests are opened only from branches named ${GIT_PUBLISH_BRANCH_PREFIX}<name>.`,
      );
    const title = pullRequestTitle(input.title);
    const repository = { owner: app.repository.owner, name: app.repository.name };
    const opened = await services.host.host.openPullRequest(
      {
        repository,
        head: input.head,
        base: app.defaultBranch,
        title,
        body: pullRequestBody(input.body, person),
      },
      signal,
    );
    await services.audit.success({
      eventType: "git_pull_request.opened",
      subject: person.id,
      appId: app.id,
      details: {
        number: opened.number,
        webUrl: opened.webUrl,
        headBranch: opened.headBranch,
        baseBranch: opened.baseBranch,
        headCommit: opened.headCommit,
        commits: auditList(opened.commits?.ids ?? [], "commits"),
        commitCount: opened.commits?.count ?? null,
        existingPullRequest: !opened.created,
        warnings: auditList(
          opened.warnings.map(({ code }) => code),
          "warnings",
        ),
      },
    });
    return {
      created: opened.created,
      app: { id: app.id, name: app.name },
      pullRequest: {
        number: opened.number,
        webUrl: opened.webUrl,
        headBranch: opened.headBranch,
        baseBranch: opened.baseBranch,
        headCommit: opened.headCommit,
      },
      requestedReviewers: opened.requestedReviewers,
      warnings: opened.warnings,
    };
  } catch (error) {
    const known = error instanceof GitAppError;
    if (!(known && error.code === "audit_unavailable"))
      // Another person's app never resolves, so `app` is always the person's own here.
      await services.audit.rejection({
        eventType:
          known && deniedCodes.has(error.code)
            ? "git_pull_request.denied"
            : "git_pull_request.failed",
        ...(known && error.code === "access_denied"
          ? { reasonCode: "scope_not_granted" as const }
          : {}),
        reason: known ? error.message : "Opening the pull request failed unexpectedly.",
        subject: person.id,
        appId: app?.id ?? null,
        repository: null,
        details: { headBranch: input.head ? auditText(input.head) : null },
      });
    throw error;
  }
}
