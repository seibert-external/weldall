import { z } from "zod";

/**
 * Contract of `POST /api/app-host/v1/audit-events`: a Git app (a separate service registered in
 * Weldall as a resource, https://github.com/seibert-external/weldall-git-app) reports the Git and
 * app registry audit events of its resource. It authenticates as a Weldall machine client that
 * holds {@link APP_HOST_SCOPE} and is allowed for its own resource, and names that resource in
 * every report. Errors use the OAuth error body `{ error, error_description }`.
 *
 * This file is the authority. The Git app keeps a copy with its client (`src/app-host.ts` there);
 * change it when this contract changes. Both repositories check their side against the same
 * example request, `apps/weldall/test/fixtures/app-host/audit-event-request.json` here and
 * `test/fixtures/app-host/audit-event-request.json` there; keep the two files identical.
 *
 * The app registry (apps, owners, re-verification) is the Git app's own: Weldall keeps no app
 * records. An event names the app by the Git app's id (`appId`, opaque to Weldall) and always by
 * its repository when known, so the audit log shows the repository without looking anything up.
 *
 * Good to know when building against it:
 * - The Git app decides who may act on an app: a success event names the person who acted, and
 *   for repository, push, fetch, pull request and credential events that is the app's owner.
 * - `git_repository.created` requires a non-null `template`; an existing repository an
 *   administrator registers is reported as `git_repository.registered`.
 * - A report naming an unknown or unverified subject is `404 unknown_subject`; for a rejection,
 *   report it again with `subject: null` (the machine client is then the actor).
 */

export const APP_HOST_SCOPE = "weldall:app-host";
export const APP_HOST_API_PATH = "/api/app-host/v1";

/** List lengths the audit report accepts; send the first entries and the full count. */
export const APP_HOST_AUDIT_LIMITS = {
  refUpdates: 20,
  commits: 100,
  warnings: 10,
  checks: 70,
  /** Free text (reasons, branch and template names) is cut by Weldall well below this. */
  text: 2_000,
} as const;

const controlCharacters = /[\u0000-\u001f\u007f]/;
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !controlCharacters.test(value), "must not contain control characters");
const freeText = z.string().min(1).max(APP_HOST_AUDIT_LIMITS.text);
const count = z.number().int().nonnegative();

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}
/** An https link without credentials, at most 2,000 characters. */
export const appHostHttpsUrlSchema = z
  .string()
  .max(2_000)
  .refine(isHttpsUrl, "must be an https URL without credentials");

/** The caller's resource identifier, exactly as registered in Weldall. */
export const appHostResourceSchema = z.string().url().max(2_000);
/** A Weldall user id: the `sub` of a verified Weldall user token. Never an email address. */
export const weldallSubjectSchema = text(191);
export const appIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Owner (organisation or user) or name of a repository on the Git host. */
export const repositoryPartSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
/** Stable host-side repository id that survives renames. */
export const repositoryIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
/** Lower-case SHA-1 or SHA-256 object id. */
export const gitCommitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const auditId = z.string().regex(/^[A-Za-z0-9._:-]{1,191}$/);
const warningCode = z.string().regex(/^[a-z0-9_]{1,64}$/);

const repositoryRef = z
  .object({ owner: repositoryPartSchema, name: repositoryPartSchema })
  .strict();

// ---------------------------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------------------------

const refUpdate = z
  .object({ ref: freeText, oldCommit: gitCommitIdSchema, newCommit: gitCommitIdSchema })
  .strict();
const refUpdates = {
  refUpdates: z.array(refUpdate).max(APP_HOST_AUDIT_LIMITS.refUpdates),
  /** Full number of ref updates; larger than the list when the list was cut. */
  refUpdateCount: count,
};
/** Id of the git credential the traffic used, as in its `git_credential.issued` entry. */
const credentialId = auditId.nullable();
const transfer = {
  credentialId,
  requestBytes: count,
  responseBytes: count,
  durationMs: count,
  upstreamStatus: z.number().int().min(100).max(599),
};
const partialTransfer = {
  credentialId,
  requestBytes: count.nullable(),
  responseBytes: count.nullable(),
  durationMs: count.nullable(),
  upstreamStatus: z.number().int().min(100).max(599).nullable(),
};
const access = z.enum(["read", "write"]);

/** Event-specific fields of each reportable Git audit event (`details` in the report). */
export const appHostAuditDetailsSchemas = {
  "git_repository.created": z
    .object({
      repositoryId: repositoryIdSchema.nullable(),
      template: freeText,
      templateCommit: gitCommitIdSchema.nullable(),
      defaultBranch: freeText,
      /** The call resumed with a repository an earlier attempt of the same owner created. */
      existingRepository: z.boolean(),
      warnings: z.array(warningCode).max(APP_HOST_AUDIT_LIMITS.warnings),
    })
    .strict(),
  /**
   * An administrator registered an existing repository of the organisation (one not created from
   * a template by this app host) as an app of `owner`; the subject is the administrator.
   */
  "git_repository.registered": z
    .object({
      owner: weldallSubjectSchema,
      repositoryId: repositoryIdSchema.nullable(),
      defaultBranch: freeText,
      warnings: z.array(warningCode).max(APP_HOST_AUDIT_LIMITS.warnings),
    })
    .strict(),
  /** `template` is null for a refused registration of an existing repository. */
  "git_repository.denied": z.object({ template: freeText.nullable() }).strict(),
  "git_repository.failed": z.object({ template: freeText.nullable() }).strict(),
  /** Report before forwarding a push; forward only after Weldall accepted this entry. */
  "git_push.forwarded": z.object({ ...refUpdates, credentialId }).strict(),
  "git_push.completed": z.object({ ...refUpdates, ...transfer }).strict(),
  "git_push.denied": z.object({ ...refUpdates, ...partialTransfer }).strict(),
  "git_push.failed": z.object({ ...refUpdates, ...partialTransfer }).strict(),
  "git_fetch.completed": z.object(transfer).strict(),
  "git_fetch.denied": z.object(partialTransfer).strict(),
  "git_fetch.failed": z.object(partialTransfer).strict(),
  "git_pull_request.opened": z
    .object({
      number: z.number().int().positive(),
      webUrl: appHostHttpsUrlSchema,
      headBranch: freeText,
      baseBranch: freeText,
      headCommit: gitCommitIdSchema,
      commits: z.array(gitCommitIdSchema).max(APP_HOST_AUDIT_LIMITS.commits),
      /** Null when the host could not list the commits. */
      commitCount: count.nullable(),
      existingPullRequest: z.boolean(),
      warnings: z.array(warningCode).max(APP_HOST_AUDIT_LIMITS.warnings),
    })
    .strict(),
  "git_pull_request.denied": z.object({ headBranch: freeText.nullable() }).strict(),
  "git_pull_request.failed": z.object({ headBranch: freeText.nullable() }).strict(),
  /** Never the credential itself. */
  "git_credential.issued": z
    .object({ credentialId: auditId, access, expiresAt: z.string().datetime() })
    .strict(),
  "git_credential.denied": z.object({ access: access.nullable() }).strict(),
  "git_credential.failed": z.object({ access: access.nullable() }).strict(),
  /** The Git app's set-up checklist ran; counts and the ids of failed checks, not their texts. */
  "git_host.checked": z
    .object({
      passed: count,
      failed: count,
      unverifiable: count,
      failedChecks: z
        .array(z.string().regex(/^[a-z0-9._-]{1,120}$/))
        .max(APP_HOST_AUDIT_LIMITS.checks),
      durationMs: count,
    })
    .strict(),
  /**
   * The owner confirmed that an app is still needed (re-verification): its expiry moved from
   * `previousExpiresAt` to `expiresAt`. `previousState` shows whether the app was flagged.
   */
  "app_confirmation.succeeded": z
    .object({
      previousExpiresAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      previousState: z.enum(["active", "expiring_soon", "expired"]),
    })
    .strict(),
  /**
   * A confirmation was refused. An unknown id and another person's app are refused alike, so the
   * report names neither an app nor a repository; the requested id is in the reason.
   */
  "app_confirmation.denied": z.object({}).strict(),
} as const;
export type AppHostAuditEventType = keyof typeof appHostAuditDetailsSchemas;
export const APP_HOST_AUDIT_EVENT_TYPES = Object.keys(
  appHostAuditDetailsSchemas,
) as AppHostAuditEventType[];

/** Reason codes a rejection may carry; the default is `invalid_request` (denied) or `internal_error` (failed). */
export const APP_HOST_AUDIT_REASON_CODES = [
  "invalid_request",
  "invalid_grant",
  "scope_not_granted",
  "internal_error",
] as const;

const envelope = {
  resource: appHostResourceSchema,
  /**
   * Chosen by the reporter (e.g. a UUID) and reused on every retry of the same report: Weldall
   * records it once and answers a repeated identical report as a duplicate.
   */
  eventId: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
};
/**
 * Success events always concern a registered app (by the app host's id and its repository) and
 * the person who acted. The app host has checked that the person may act on the app.
 */
const success = <T extends AppHostAuditEventType>(eventType: T) =>
  z
    .object({
      ...envelope,
      eventType: z.literal(eventType),
      subject: weldallSubjectSchema,
      appId: appIdSchema,
      repository: repositoryRef,
      details: appHostAuditDetailsSchemas[eventType],
    })
    .strict();
/**
 * A rejection may happen before the person, app or repository is known. Give `appId` when the
 * app was resolved and `repository` whenever it is known (the app's, or the requested one).
 * Without a subject, the reporting machine client is recorded as the actor.
 */
const rejection = <T extends AppHostAuditEventType>(eventType: T) =>
  z
    .object({
      ...envelope,
      eventType: z.literal(eventType),
      subject: weldallSubjectSchema.nullable(),
      appId: appIdSchema.nullable(),
      repository: repositoryRef.nullable(),
      /** Shown to administrators; credentials are redacted and long text is cut. */
      reason: freeText,
      reasonCode: z.enum(APP_HOST_AUDIT_REASON_CODES).optional(),
      details: appHostAuditDetailsSchemas[eventType],
    })
    .strict();

/** `POST /api/app-host/v1/audit-events`. */
export const appHostAuditEventRequestSchema = z
  .discriminatedUnion("eventType", [
    success("git_repository.created"),
    success("git_repository.registered"),
    rejection("git_repository.denied"),
    rejection("git_repository.failed"),
    success("git_push.forwarded"),
    success("git_push.completed"),
    rejection("git_push.denied"),
    rejection("git_push.failed"),
    success("git_fetch.completed"),
    rejection("git_fetch.denied"),
    rejection("git_fetch.failed"),
    success("git_pull_request.opened"),
    rejection("git_pull_request.denied"),
    rejection("git_pull_request.failed"),
    success("git_credential.issued"),
    rejection("git_credential.denied"),
    rejection("git_credential.failed"),
    success("app_confirmation.succeeded"),
    rejection("app_confirmation.denied"),
    z
      .object({
        ...envelope,
        eventType: z.literal("git_host.checked"),
        /** The person who ran the checklist; null when the Git app ran it on its own. */
        subject: weldallSubjectSchema.nullable(),
        /** The existing repository checks needing one used; null when none exists yet. */
        repository: repositoryRef.nullable(),
        details: appHostAuditDetailsSchemas["git_host.checked"],
      })
      .strict(),
  ])
  .superRefine((report, context) => {
    const details = report.details as { refUpdates?: unknown[]; refUpdateCount?: number };
    if (
      details.refUpdates &&
      details.refUpdateCount !== undefined &&
      details.refUpdateCount < details.refUpdates.length
    )
      context.addIssue({
        code: "custom",
        path: ["details", "refUpdateCount"],
        message: "refUpdateCount must count every ref update",
      });
  });
export type AppHostAuditEventRequest = z.input<typeof appHostAuditEventRequestSchema>;

/**
 * Only a 2xx answer with `accepted: true` means the entry is stored: `201` for a new entry, `200`
 * with `duplicate: true` for a repeated identical report. A different report under an `eventId`
 * already used is `409 event_id_conflict`; anything else means not recorded.
 */
export const appHostAuditEventResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string(),
  auditEventId: z.string(),
  duplicate: z.boolean(),
  recordedAt: z.string(),
});
export type AppHostAuditEventResponse = z.output<typeof appHostAuditEventResponseSchema>;
