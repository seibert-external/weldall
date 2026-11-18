import { z } from "zod";
import { redactCredentials } from "../observability/redaction";

/**
 * Bounds for Git audit metadata. Free text is redacted and cut with {@link TRUNCATION_MARKER}
 * instead of rejected, so an unusual branch name or a long reason never fails a git operation.
 * Lists are capped by the writers in `connectors/git-audit.ts`; the matching `…Count` field keeps
 * the full number, so `count > list.length` shows that the list was cut.
 */
export const GIT_AUDIT_LIMITS = {
  /** GitHub allows 100 characters for repository and organisation names. */
  repositoryPart: 100,
  /** Git puts no hard limit on ref names; 255 covers every realistic branch name. */
  ref: 255,
  template: 100,
  reason: 500,
  /** Ref updates recorded per push; a publish pushes one branch. */
  refUpdates: 20,
  /** Commit ids recorded per pull request; a publish adds one commit per push. */
  commits: 100,
  /** Warning codes recorded per created repository or opened pull request. */
  warnings: 10,
  /** Failed check ids recorded per checklist run. */
  checks: 70,
} as const;

export const TRUNCATION_MARKER = "…[truncated]";

/** Cuts `value` to at most `maximum` characters, ending in {@link TRUNCATION_MARKER} when cut. */
export function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let kept = value.slice(0, Math.max(0, maximum - TRUNCATION_MARKER.length));
  // Do not leave half of a surrogate pair before the marker.
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${TRUNCATION_MARKER}`;
}

/** Redacts credentials, flattens control characters and truncates; never fails on length. */
export function boundedGitText(value: string, maximum: number): string {
  // Redact before flattening control characters so multi-line PEM blocks are still recognised.
  const text = redactCredentials(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return truncateText(text || "-", maximum);
}

const gitText = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? boundedGitText(value, maximum) : value),
    z.string().min(1).max(maximum),
  );
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,191}$/);
/** SHA-1 or SHA-256 object id; the all-zero id marks a created or deleted ref. */
export const gitCommitId = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
);
const count = z.number().int().nonnegative();
const reason = gitText(GIT_AUDIT_LIMITS.reason);

/**
 * Which repository on which Git host connector, and its app registry entry. Entries reported by a
 * Git app carry `resourceId` instead of `connectorId` (see {@link gitMetadataSchemas}).
 */
const resolvedTarget = {
  connectorId: id,
  appId: id,
  repositoryOwner: gitText(GIT_AUDIT_LIMITS.repositoryPart),
  repositoryName: gitText(GIT_AUDIT_LIMITS.repositoryPart),
};
/** A rejection can happen before the connector, repository or app is known. */
const rejectedTarget = {
  connectorId: id.nullable(),
  appId: id.nullable(),
  repositoryOwner: gitText(GIT_AUDIT_LIMITS.repositoryPart).nullable(),
  repositoryName: gitText(GIT_AUDIT_LIMITS.repositoryPart).nullable(),
  reason,
};

const repositoryCreated = z
  .object({
    ...resolvedTarget,
    repositoryId: z.string().min(1).max(64).nullable(),
    template: gitText(GIT_AUDIT_LIMITS.template),
    templateCommit: gitCommitId.nullable(),
    defaultBranch: gitText(GIT_AUDIT_LIMITS.ref),
    /** The call resumed with a repository that an earlier attempt of the same owner created. */
    existingRepository: z.boolean(),
    warnings: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(GIT_AUDIT_LIMITS.warnings),
  })
  .strict();
const repositoryRejected = z
  .object({ ...rejectedTarget, template: gitText(GIT_AUDIT_LIMITS.template).nullable() })
  .strict();

/** Links proxy traffic to the `git_credential.issued` entry of the credential it used. */
const credentialId = id.nullable();
const refUpdate = z
  .object({ ref: gitText(GIT_AUDIT_LIMITS.ref), oldCommit: gitCommitId, newCommit: gitCommitId })
  .strict();
const refUpdates = {
  refUpdates: z.array(refUpdate).max(GIT_AUDIT_LIMITS.refUpdates),
  refUpdateCount: count,
};
const transfer = {
  credentialId,
  requestBytes: count,
  responseBytes: count,
  durationMs: count,
  upstreamStatus: z.number().int().min(100).max(599),
};
/** Rejected or failed transfers may stop before any byte, duration or upstream status exists. */
const partialTransfer = {
  credentialId,
  requestBytes: count.nullable(),
  responseBytes: count.nullable(),
  durationMs: count.nullable(),
  upstreamStatus: z.number().int().min(100).max(599).nullable(),
};

/** Written before a push reaches the host; the push is refused when this entry cannot be written. */
const pushForwarded = z.object({ ...resolvedTarget, ...refUpdates, credentialId }).strict();
const pushCompleted = z.object({ ...resolvedTarget, ...refUpdates, ...transfer }).strict();
const pushRejected = z.object({ ...rejectedTarget, ...refUpdates, ...partialTransfer }).strict();
const fetchCompleted = z.object({ ...resolvedTarget, ...transfer }).strict();
const fetchRejected = z.object({ ...rejectedTarget, ...partialTransfer }).strict();

const pullRequestOpened = z
  .object({
    ...resolvedTarget,
    number: z.number().int().positive(),
    webUrl: z.string().url().max(2_000),
    headBranch: gitText(GIT_AUDIT_LIMITS.ref),
    baseBranch: gitText(GIT_AUDIT_LIMITS.ref),
    headCommit: gitCommitId,
    /**
     * Commits the pull request contained when the actor opened it or had it returned. They may
     * include commits others pushed on the host; who pushed what is in the `git_push.*` entries.
     */
    commits: z.array(gitCommitId).max(GIT_AUDIT_LIMITS.commits),
    /** Null when the host could not list the commits (see `warnings`). */
    commitCount: count.nullable(),
    /** The pull request of this branch was already open and is returned instead of a second one. */
    existingPullRequest: z.boolean(),
    /** Codes of problems that did not prevent the pull request, e.g. a refused reviewer request. */
    warnings: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(GIT_AUDIT_LIMITS.warnings),
  })
  .strict();
const pullRequestRejected = z
  .object({ ...rejectedTarget, headBranch: gitText(GIT_AUDIT_LIMITS.ref).nullable() })
  .strict();

const access = z.enum(["read", "write"]);
const credentialIssued = z
  .object({
    ...resolvedTarget,
    credentialId: id,
    access,
    expiresAt: z.string().datetime(),
  })
  .strict();
const credentialRejected = z.object({ ...rejectedTarget, access: access.nullable() }).strict();

/**
 * An administrator ran the connect checklist of a Git host connector (read-only on the host, but
 * it uses the stored credential). Records the counts and the ids of failed checks, not the texts.
 */
const hostChecked = z
  .object({
    connectorId: id,
    /** The existing app repository that checks needing one used; null when none exists yet. */
    repositoryOwner: gitText(GIT_AUDIT_LIMITS.repositoryPart).nullable(),
    repositoryName: gitText(GIT_AUDIT_LIMITS.repositoryPart).nullable(),
    passed: count,
    failed: count,
    unverifiable: count,
    failedChecks: z.array(z.string().regex(/^[a-z0-9._-]{1,120}$/)).max(GIT_AUDIT_LIMITS.checks),
    durationMs: count,
  })
  .strict();

/**
 * The same entry for a repository behind a Git app registered as a resource, which reports it
 * through `/api/app-host/v1/audit-events`: `resourceId` (always known, the reporting machine
 * client is allowed for it) replaces `connectorId`.
 */
function orResource<Shape extends z.ZodRawShape & { connectorId: z.ZodType }>(
  schema: z.ZodObject<Shape>,
) {
  return z.union([
    schema,
    schema
      .omit({ connectorId: true } as { connectorId: true } & Record<
        Exclude<"connectorId", keyof Shape>,
        never
      >)
      .extend({ resourceId: id })
      .strict(),
  ]);
}

export const gitMetadataSchemas = {
  "git_repository.created": orResource(repositoryCreated),
  "git_repository.denied": orResource(repositoryRejected),
  "git_repository.failed": orResource(repositoryRejected),
  "git_push.forwarded": orResource(pushForwarded),
  "git_push.completed": orResource(pushCompleted),
  "git_push.denied": orResource(pushRejected),
  "git_push.failed": orResource(pushRejected),
  "git_fetch.completed": orResource(fetchCompleted),
  "git_fetch.denied": orResource(fetchRejected),
  "git_fetch.failed": orResource(fetchRejected),
  "git_pull_request.opened": orResource(pullRequestOpened),
  "git_pull_request.denied": orResource(pullRequestRejected),
  "git_pull_request.failed": orResource(pullRequestRejected),
  "git_credential.issued": orResource(credentialIssued),
  "git_credential.denied": orResource(credentialRejected),
  "git_credential.failed": orResource(credentialRejected),
  "git_host.checked": orResource(hostChecked),
} as const;

export type GitAuditEventType = keyof typeof gitMetadataSchemas;
export type GitAuditMetadata<T extends GitAuditEventType> = z.output<
  (typeof gitMetadataSchemas)[T]
>;
