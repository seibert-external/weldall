import { ConnectorError, type AuthorizedConnectorActor } from "../connectors/contracts";
import { openGitHost } from "../connectors/core/git-hosts";
import type { GitHostWarning, GitReviewers } from "../connectors/git-host";
import { writeGitPullRequestAudit } from "../connectors/git-audit";
import { withoutHiddenCharacters } from "../connectors/git-text";
import { GIT_PUBLISH_BRANCH_PREFIX, isPublishBranch } from "../git-proxy/rules";
import { resolveOwnApp, type OwnApp } from "./own-app";

/** Bounds for the caller's title and body; GitHub allows 65,536 characters of body. */
export const PULL_REQUEST_TITLE_LIMIT = 200;
export const PULL_REQUEST_BODY_LIMIT = 16_000;

/**
 * Hidden marker before the trigger line. Markdown renders it invisibly; it lets reviewers and
 * tools find the server's line, and is removed from the caller's text so it cannot be imitated.
 */
export const PUBLISH_TRIGGER_MARKER = "<!-- weldall:published-by -->";
const markerPattern = /<!--\s*weldall:published-by\s*-->/gi;

/**
 * Look-alike folding for matching only: compatibility forms, accents, case, common Cyrillic and
 * Greek homoglyphs and digit look-alikes collapse to plain Latin letters; everything else is
 * dropped. `i` and `l` fold together (`I`/`l`/`1`).
 */
const confusables: Record<string, string> = {
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
  "\u0458": "j",
  "\u0455": "s",
  "\u0501": "d",
  "\u04bb": "h",
  "\u04cf": "l",
  "\u051d": "w",
  "\u0432": "b",
  "\u043a": "k",
  "\u043c": "m",
  "\u043d": "h",
  "\u0442": "t",
  "\u03bf": "o",
  "\u03b1": "a",
  "\u03b5": "e",
  "\u03b9": "i",
  "\u03ba": "k",
  "\u03bd": "v",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u0251": "a",
  "\u0261": "g",
  "\u026a": "i",
  "\u029f": "l",
  "0": "o",
  "1": "l",
  "3": "e",
  "5": "s",
  "|": "l",
};
const skeleton = (value: string) =>
  [
    ...value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase(),
  ]
    .map((character) => confusables[character] ?? character)
    .join("")
    .replace(/[^a-z]+/g, "")
    .replace(/i/g, "l");
const triggerSkeletons = [
  "published with weldall",
  "published through weldall",
  "published via weldall",
  "weldall user",
].map(skeleton);
/** Whether a line of the caller's text imitates the trigger line, also with look-alike characters. */
const imitatesTrigger = (line: string) => {
  const folded = skeleton(line);
  return triggerSkeletons.some((pattern) => folded.includes(pattern));
};

/**
 * The line the server puts at the top of every pull request body. It stays in the customer's Git
 * for good, so it carries only a reference: the opaque Weldall user id, which only Weldall's audit
 * resolves to a person. No name and no email address (decided 2026-11-17: only a reference goes
 * into the customer's Git for now).
 */
export function publishTriggerLine(person: { id: string }): string {
  return `Published with Weldall (Weldall user ${person.id}).`;
}

/** Removes control characters except line breaks and tabs, and normalises line ends. */
const withoutControls = (value: string) =>
  value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** The caller's title as one bounded line. */
export function pullRequestTitle(value: string): string {
  const title = withoutControls(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PULL_REQUEST_TITLE_LIMIT);
  if (!title) throw new ConnectorError("invalid_request", "Give the pull request a title.");
  return title;
}

/**
 * The pull request body: the marker and the server's trigger line first, then the caller's text
 * after a rule. Nothing the caller writes can precede or collapse the trigger line (an unclosed
 * `<details>` only hides the caller's own text). Hidden characters are stripped from the caller's
 * text, and copies of the marker and lines that imitate the trigger line, also with look-alike
 * characters, are removed.
 */
export function pullRequestBody(value: string, person: { id: string }): string {
  const body = withoutHiddenCharacters(withoutControls(value).slice(0, PULL_REQUEST_BODY_LIMIT))
    .replace(markerPattern, "")
    .split("\n")
    .filter((line) => !imitatesTrigger(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const trigger = `${PUBLISH_TRIGGER_MARKER}\n${publishTriggerLine(person)}`;
  // The blank line keeps the rule from turning the trigger line into a heading.
  return body ? `${trigger}\n\n---\n\n${body}` : trigger;
}

export interface OpenAppPullRequestInput {
  /** Branch under {@link GIT_PUBLISH_BRANCH_PREFIX} that the caller pushed through the git proxy. */
  head: string;
  title: string;
  body: string;
}

export interface AppPullRequestResult {
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

/** Codes that reject the caller's request rather than report a failure of Weldall or the host. */
const deniedCodes = new Set([
  "invalid_request",
  "connection_denied",
  "not_found",
  "disabled",
  "repository_not_ready",
  "branch_not_found",
  "nothing_to_publish",
]);

/**
 * Opens the pull request for one of the caller's apps from a publish branch into the app's
 * default branch (never a caller-chosen base), with the trigger line at the top of the body, and
 * requests the connector's reviewers. Idempotent per head branch: an open pull request of the
 * branch is returned instead of a second one. The audit records the person and the commits the
 * pull request contains (not who wrote them; that is in the push entries); failed reviewer
 * requests come back as warnings while the pull request stays open.
 */
export async function openAppPullRequest({
  actor,
  appId,
  input,
  signal,
}: {
  actor: AuthorizedConnectorActor;
  appId: string;
  input: OpenAppPullRequestInput;
  signal: AbortSignal;
}): Promise<AppPullRequestResult> {
  let app: OwnApp | null = null;
  try {
    app = await resolveOwnApp({ actor, appId });
    if (!isPublishBranch(input.head, app.defaultBranch))
      throw new ConnectorError(
        "invalid_request",
        `Pull requests are opened only from branches named ${GIT_PUBLISH_BRANCH_PREFIX}<name>.`,
      );
    const title = pullRequestTitle(input.title);
    const repository = { owner: app.repositoryOwner, name: app.repositoryName };
    const host = await openGitHost({ connectorId: app.connectorId });
    const opened = await host.openPullRequest(
      {
        repository,
        head: input.head,
        base: app.defaultBranch,
        title,
        body: pullRequestBody(input.body, { id: actor.id }),
      },
      signal,
    );
    await writeGitPullRequestAudit({
      actor,
      outcome: "success",
      connectorId: app.connectorId,
      appId: app.id,
      repository,
      number: opened.number,
      webUrl: opened.webUrl,
      headBranch: opened.headBranch,
      baseBranch: opened.baseBranch,
      headCommit: opened.headCommit,
      commits: opened.commits?.ids ?? null,
      ...(opened.commits ? { commitCount: opened.commits.count } : {}),
      existingPullRequest: !opened.created,
      warnings: opened.warnings.map(({ code }) => code),
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
    const known = error instanceof ConnectorError;
    // Another person's app never resolves, so `app` is always the caller's own here.
    await writeGitPullRequestAudit({
      actor,
      outcome: known && deniedCodes.has(error.code) ? "denied" : "failed",
      ...(known && error.code === "connection_denied"
        ? { reasonCode: "scope_not_granted" as const }
        : {}),
      reason: known ? error.message : "Opening the pull request failed unexpectedly.",
      connectorId: app?.connectorId ?? null,
      appId: app?.id ?? null,
      repository: app ? { owner: app.repositoryOwner, name: app.repositoryName } : null,
      headBranch: input.head,
    });
    throw error;
  }
}
