import { z } from "zod";
import {
  APP_HOST_AUDIT_LIMITS,
  gitCommitIdSchema,
  LONE_SURROGATES,
  repositoryIdSchema,
  repositoryPartSchema,
  weldallSubjectSchema,
} from "../app-host/contract";
import { redactCredentials } from "../observability/redaction";

/**
 * Bounds for Git audit metadata. Free text (reasons, ref, branch and template names) is the only
 * redacted metadata: credentials in it become `[***]`, control characters and lone surrogates
 * (which PostgreSQL's JSONB cannot hold) are replaced, and it is cut to the stored length with
 * {@link TRUNCATION_MARKER} instead of rejected, so an unusual or over-long branch name or reason
 * never loses an entry or fails a git operation. The app host contract accepts free text up to
 * `APP_HOST_AUDIT_LIMITS.text` characters, far above these stored lengths. Identifiers (ids,
 * repository names, commit ids, credential ids) are validated, never redacted. Lists are capped by the reporting app host with the list lengths of the app host contract
 * (`../app-host/contract.ts`, the one source for them); the matching `…Count` field keeps the
 * full number, so `count > list.length` shows that the list was cut.
 */
export const GIT_AUDIT_LIMITS = {
  /** Git puts no hard limit on ref names; 255 covers every realistic branch name. */
  ref: 255,
  template: 100,
  reason: 500,
  /** Ref updates recorded per push; a publish pushes one branch. */
  refUpdates: APP_HOST_AUDIT_LIMITS.refUpdates,
  /** Commit ids recorded per pull request; a publish adds one commit per push. */
  commits: APP_HOST_AUDIT_LIMITS.commits,
  /** Warning codes recorded per created repository or opened pull request. */
  warnings: APP_HOST_AUDIT_LIMITS.warnings,
  /** Failed check ids recorded per checklist run. */
  checks: APP_HOST_AUDIT_LIMITS.checks,
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

/**
 * Redacts credentials, replaces what JSONB cannot store and truncates; never fails on content or
 * length. Lone surrogates become U+FFFD; control characters (NUL among them) become spaces.
 */
export function boundedGitText(value: string, maximum: number): string {
  // Redact before flattening control characters so multi-line PEM blocks are still recognised.
  const text = redactCredentials(value.replace(LONE_SURROGATES, "\ufffd"))
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
const gitCommitId = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  gitCommitIdSchema,
);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reason = gitText(GIT_AUDIT_LIMITS.reason);

/**
 * Which repository behind which app host (the resource it is registered as, always known: the
 * reporting machine client is allowed for it), and the app's id in that app host's own registry.
 * The id is the app host's: Weldall keeps no app records and never resolves it.
 */
const resolvedTarget = {
  resourceId: id,
  appId: id,
  repositoryOwner: repositoryPartSchema,
  repositoryName: repositoryPartSchema,
};
/** A rejection can happen before the repository or app is known. */
const rejectedTarget = {
  resourceId: id,
  appId: id.nullable(),
  repositoryOwner: repositoryPartSchema.nullable(),
  repositoryName: repositoryPartSchema.nullable(),
  reason,
};

const repositoryCreated = z
  .object({
    ...resolvedTarget,
    repositoryId: repositoryIdSchema.nullable(),
    template: gitText(GIT_AUDIT_LIMITS.template),
    templateCommit: gitCommitId.nullable(),
    defaultBranch: gitText(GIT_AUDIT_LIMITS.ref),
    /** The call resumed with a repository that an earlier attempt of the same owner created. */
    existingRepository: z.boolean(),
    warnings: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(GIT_AUDIT_LIMITS.warnings),
  })
  .strict();
/** An administrator registered an existing repository as an app of `owner` (a Weldall user id). */
const repositoryRegistered = z
  .object({
    ...resolvedTarget,
    owner: weldallSubjectSchema,
    repositoryId: repositoryIdSchema.nullable(),
    defaultBranch: gitText(GIT_AUDIT_LIMITS.ref),
    warnings: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(GIT_AUDIT_LIMITS.warnings),
  })
  .strict();
/**
 * An administrator assigned or changed the owner of a registered app; both owners are Weldall
 * user ids, `previousOwner` is null when the app had none.
 */
const ownerAssigned = z
  .object({
    ...resolvedTarget,
    owner: weldallSubjectSchema,
    previousOwner: weldallSubjectSchema.nullable(),
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
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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
 * An administrator ran the set-up checklist of an app host (read-only on the Git host, but it
 * uses the app host's Git host credential). Records the counts and the ids of failed checks, not the texts.
 */
const hostChecked = z
  .object({
    resourceId: id,
    /** The existing app repository that checks needing one used; null when none exists yet. */
    repositoryOwner: repositoryPartSchema.nullable(),
    repositoryName: repositoryPartSchema.nullable(),
    passed: count,
    failed: count,
    unverifiable: count,
    failedChecks: z.array(z.string().regex(/^[a-z0-9._-]{1,120}$/)).max(GIT_AUDIT_LIMITS.checks),
    durationMs: count,
  })
  .strict();

const appState = z.enum(["active", "expiring_soon", "expired"]);
/**
 * The owner confirmed in the app host's registry that an app is still needed: the expiry
 * moved from `previousExpiresAt` to `expiresAt`. `previousState` shows whether it was flagged.
 */
const confirmationSucceeded = z
  .object({
    ...resolvedTarget,
    previousExpiresAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    previousState: appState,
  })
  .strict();
/**
 * A confirmation was refused. An unknown id and another person's app are refused alike, so the
 * app host names neither app nor repository; the requested id is in the reason.
 */
const confirmationDenied = z.object(rejectedTarget).strict();

export const gitMetadataSchemas = {
  "git_repository.created": repositoryCreated,
  "git_repository.registered": repositoryRegistered,
  "app_owner.assigned": ownerAssigned,
  "git_repository.denied": repositoryRejected,
  "git_repository.failed": repositoryRejected,
  "git_push.forwarded": pushForwarded,
  "git_push.completed": pushCompleted,
  "git_push.denied": pushRejected,
  "git_push.failed": pushRejected,
  "git_fetch.completed": fetchCompleted,
  "git_fetch.denied": fetchRejected,
  "git_fetch.failed": fetchRejected,
  "git_pull_request.opened": pullRequestOpened,
  "git_pull_request.denied": pullRequestRejected,
  "git_pull_request.failed": pullRequestRejected,
  "git_credential.issued": credentialIssued,
  "git_credential.denied": credentialRejected,
  "git_credential.failed": credentialRejected,
  "git_host.checked": hostChecked,
  "app_confirmation.succeeded": confirmationSucceeded,
  "app_confirmation.denied": confirmationDenied,
} as const;

export type GitAuditEventType = keyof typeof gitMetadataSchemas;
