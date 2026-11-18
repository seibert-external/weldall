/**
 * Host-neutral seam for Git hosts (GitHub and Forgejo), carried over from the Weldall server
 * (`connectors/git-host.ts`). Registry, permission checks, audit and publish stay
 * host-independent; everything that depends on the host lives behind this interface. A Git app
 * instance opens exactly one host at start (`hosts/index.ts`); callers authorize the person
 * (scopes and app ownership in Weldall) before using it.
 */

/**
 * Who provides what a new repository needs (default-branch rule, reviewer team write access,
 * CI secrets). Only "customer-managed" is built: the organisation sets them up and Weldall
 * checks them. "weldall-managed" (Weldall sets them up after creating the repository) is
 * reserved and rejected by configuration validation of every host until it exists.
 */
export type GitHostSetupMode = "customer-managed" | "weldall-managed";

/**
 * Prefix of the short-lived Weldall git credential that the git proxy accepts. A fixed,
 * recognisable prefix lets log and audit redaction (`observability/redaction.ts`) and secret
 * scanners find it without assuming a length.
 */
export const WELDALL_GIT_CREDENTIAL_PREFIX = "wgc_";

/** A repository on the host, in the spelling the host returns. */
export interface GitRepositoryRef {
  /** Organisation or user that owns the repository on the host. */
  owner: string;
  name: string;
}

export type GitAccess = "read" | "write";

/** What the git proxy needs to forward smart-HTTP traffic for one repository. */
export interface GitForwardingTarget {
  /** Repository URL ending in `.git`, without credentials; the proxy appends the smart-HTTP path. */
  url: URL;
  /** Complete upstream `Authorization` header value. Never leaves the server. */
  authorization: string;
  /**
   * Do not start a request with this authorization after this time; null when the host's
   * credential does not expire (Forgejo access tokens).
   */
  expiresAt: Date | null;
}

export interface CreateRepositoryInput {
  /** Template name as configured on the Git app. */
  template: string;
  /** Requested repository name; the host applies the configured name prefix. */
  name: string;
  description: string;
  /**
   * Called once the new repository exists and is confirmed private, before the host waits for its
   * content and checks prerequisites. The caller records it here so that a retry after a later
   * failure resumes with `resume` instead of creating a second repository.
   */
  onCreated?: (repository: NewRepository) => Promise<void>;
  /** Skip creation and only wait for and check this repository, created by an earlier attempt. */
  resume?: GitRepositoryRef;
}

/** A repository the host has just created, before its content is ready. */
export interface NewRepository {
  /** `id` is the stable host id that survives renames, if the host has one. */
  repository: GitRepositoryRef & { id: string | null };
  defaultBranch: string;
  /** Browser URL of the repository. */
  webUrl: string;
}

/** A missing prerequisite that does not block publishing but needs an administrator. */
export interface GitHostWarning {
  code: string;
  /** Administrator-readable explanation with the next step. */
  message: string;
}

export interface CreatedRepository extends NewRepository {
  /** Commit at the head of the default branch: the template state the local folder must match. */
  templateCommit: string;
  warnings: GitHostWarning[];
}

export interface OpenPullRequestInput {
  repository: GitRepositoryRef;
  /** Branch carrying the published commit; it must exist on the host. */
  head: string;
  /** Branch the pull request merges into (the app's default branch). */
  base: string;
  title: string;
  /** Final body, including the trigger line the server added. */
  body: string;
}

export interface GitReviewers {
  users: string[];
  teams: string[];
}

export interface OpenedPullRequest {
  /** False when an open pull request for the same head branch already existed; it is returned unchanged. */
  created: boolean;
  /** Host-side number of the pull request within its repository. */
  number: number;
  webUrl: string;
  headBranch: string;
  baseBranch: string;
  headCommit: string;
  /**
   * Commit ids of the pull request, oldest first, at most {@link PULL_REQUEST_COMMIT_LIMIT}, with
   * their full count when the host reports it; null when the host could not list them.
   */
  commits: { ids: string[]; count: number } | null;
  /** Reviewers requested on the pull request (on creation: those the request succeeded for). */
  requestedReviewers: GitReviewers;
  /** Administrator-readable problems that did not prevent the pull request, e.g. a failed reviewer request. */
  warnings: GitHostWarning[];
}

/** Commit ids a host lists per pull request; the audit keeps the same number. */
export const PULL_REQUEST_COMMIT_LIMIT = 100;

export type PullRequestState = "open" | "merged" | "closed";

/**
 * Review texts, check names and URLs come from the customer's Git and reach an agent on the
 * person's device. Hosts return them as read; the app registry sanitises and bounds them
 * (`app-registry/status.ts`) before they leave the server.
 */
export interface PullRequestReview {
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  body: string;
  submittedAt: Date | null;
}

export interface PullRequestCheck {
  name: string;
  /** Host results are folded into these outcomes; "neutral" covers skipped or informational results. */
  state: "pending" | "success" | "failure" | "neutral";
  detailsUrl: string | null;
}

export interface PullRequestStatus {
  number: number;
  webUrl: string;
  state: PullRequestState;
  headBranch: string;
  headCommit: string;
  /** Submitted reviews, oldest first; empty when they could not be read (see the warnings). */
  reviews: PullRequestReview[];
  /** Check runs and commit statuses of the head commit; empty when they could not be read. */
  checks: PullRequestCheck[];
}

export interface ReadStatusInput {
  repository: GitRepositoryRef;
  /**
   * Which pull request: the one whose head is `branch` (an open one wins, else the most recent),
   * or the current one among head branches `publishBranch` accepts (the most recent open one,
   * else the most recently created one).
   */
  pullRequest: { branch: string } | { publishBranch: (branch: string) => boolean };
}

export interface RepositoryStatus {
  /** Null when no matching pull request exists or the host could not list them (see the warnings). */
  pullRequest: PullRequestStatus | null;
  /** Links the CI reported; null when none was found. */
  links: { preview: string | null; live: string | null };
  /**
   * Parts the host could not read, typically a permission or scope the host credential lacks;
   * the rest of the status is still returned.
   */
  warnings: GitHostWarning[];
}

/** Author and committer of the commit a publish pushes; the host attributes it by the email. */
export interface GitCommitIdentity {
  name: string;
  email: string;
}

export type GitHostCheckState = "pass" | "fail" | "unverifiable";

/**
 * One line of the set-up checklist. Texts are written by the Git app from validated configuration
 * and parsed host fields, never copied from a host response, and never contain a credential.
 */
export interface GitHostCheck {
  /** Stable identifier, e.g. `installation` or `template.react`. */
  id: string;
  /** What is checked, in a few words. */
  title: string;
  state: GitHostCheckState;
  /** False for a recommendation: a failure does not stop publishing. */
  required: boolean;
  /** What was found, or why it could not be verified (including rate limiting). */
  reason: string;
  /** What the administrator or the host organisation's admin must do; null when nothing. */
  action: string | null;
}

/** An existing app repository of this Git app, used for checks that need one (rules, team access). */
export interface GitHostCheckRepository extends GitRepositoryRef {
  defaultBranch: string;
}

/**
 * The four operations every Git host provides, the lookups the git proxy's rules need and the
 * connect checklist.
 */
export interface GitHost {
  /**
   * Checks the host-side prerequisites of this Git app's configuration and returns one line per check. Each
   * check runs on its own: a failing or unverifiable check never stops the others. Read-only: it
   * creates, changes and deletes nothing on the host (short-lived tokens it mints expire unused).
   * Checks that need a repository use `repository` when one exists, otherwise they report
   * that they cannot be verified yet.
   */
  checkSetup(
    input: { repository: GitHostCheckRepository | null },
    signal: AbortSignal,
  ): Promise<GitHostCheck[]>;
  readonly setupMode: GitHostSetupMode;
  /**
   * Repository paths (directories or files, relative to the root) that a publish always takes
   * from the repository instead of the local folder: CI workflow definitions, which the host
   * refuses to accept from the integration (GitHub: `.github/workflows` needs the `workflows`
   * permission) or would run as pushed (Forgejo Actions).
   */
  readonly protectedPaths: readonly string[];
  /**
   * Identity for the commit a publish pushes, so the host attributes it to the integration
   * instead of a person's account. Fails when the host cannot confirm it; callers must not
   * invent one, because the host maps the email to an account.
   */
  readCommitIdentity(
    input: { repository: GitRepositoryRef },
    signal: AbortSignal,
  ): Promise<GitCommitIdentity>;
  /**
   * Creates a private repository from a configured template. In "customer-managed" mode it then
   * checks the organisation's prerequisites and fails with an administrator-readable error; in
   * "weldall-managed" mode it would establish them instead.
   */
  createRepository(input: CreateRepositoryInput, signal: AbortSignal): Promise<CreatedRepository>;
  /**
   * The repository a creation request would produce, without contacting the host. Validates the
   * template and the requested name, so callers can check the app registry before creating.
   */
  resolveNewRepository(input: { template: string; name: string }): GitRepositoryRef;
  /** Target URL and authorization for forwarding git traffic to one repository. */
  getForwardingTarget(
    input: { repository: GitRepositoryRef; access: GitAccess },
    signal: AbortSignal,
  ): Promise<GitForwardingTarget>;
  /**
   * State of the pull request whose head is `branch` in the same repository, so the git proxy can
   * refuse pushes to the branch of a closed or merged pull request. An open pull request wins over
   * closed ones on the same branch, a merged one over a closed one; null when the branch never had
   * one (the first push before the pull request exists).
   */
  readBranchPullRequestState(
    input: { repository: GitRepositoryRef; branch: string },
    signal: AbortSignal,
  ): Promise<PullRequestState | null>;
  /**
   * Opens a pull request from `head` into `base` and requests the reviewers from the Git app's
   * configuration. Returns the open pull request of `head` instead when one exists, so retries
   * never create a second one. A failed reviewer request becomes a warning, never an error.
   */
  openPullRequest(input: OpenPullRequestInput, signal: AbortSignal): Promise<OpenedPullRequest>;
  /**
   * Reads pull request state, reviews, checks and the CI's preview or live link. Parts the host
   * cannot read (e.g. a missing permission of the host credential) become warnings instead of
   * failing the call.
   */
  readStatus(input: ReadStatusInput, signal: AbortSignal): Promise<RepositoryStatus>;
}
