import { z } from "zod";
import { createDpopProof } from "./dpop.js";
import { WeldallAuthError } from "./errors.js";
import { requestMachineToken } from "./machine.js";
import type { DpopKeyPair } from "./types.js";

/**
 * Contract between Weldall and an app host: a separate service, registered in Weldall as a
 * resource, that keeps apps' repositories on a Git host (the "Git app"). It authenticates as a
 * Weldall machine client that holds {@link APP_HOST_SCOPE} and is allowed for its own resource,
 * and uses these endpoints of the Weldall API:
 *
 * - `POST {issuer}/api/app-host/v1/apps` creates an app registry entry for a person.
 * - `PATCH {issuer}/api/app-host/v1/apps/{id}` updates links, default branch and repository.
 * - `POST {issuer}/api/app-host/v1/apps/lookup` resolves an app by id or repository and answers
 *   whether it belongs to a person.
 * - `POST {issuer}/api/app-host/v1/audit-events` records a Git audit event in Weldall's audit log.
 * - `POST {issuer}/api/authorization/v1/check-scopes` (scope {@link SUBJECT_SCOPES_CHECK_SCOPE})
 *   checks that a person still holds {@link LOGIN_SCOPE} and the resource's own scopes.
 *
 * Every request names the caller's `resource` (its resource identifier); Weldall answers only for
 * apps of that resource and only when the machine client is allowed for it. Errors use the OAuth
 * error body `{ error, error_description }`.
 *
 * Good to know when building against it:
 * - A person acts only on apps they own: a success audit event that names an app must name the
 *   app's owner as `subject` (`403 subject_not_owner` otherwise). Rejections may name anyone.
 * - There is no delete or owner-transfer endpoint. A failed first publish leaves a not-ready
 *   entry (template commit null) that the same owner resumes by registering the same repository
 *   again and then setting the template commit.
 * - `git_repository.created` requires a non-null `template`; a registered existing repository is
 *   not reported with it.
 * - A report naming an unknown or unverified subject is `404 unknown_subject`; for a rejection,
 *   report it again with `subject: null` (the machine client is then the actor).
 */

export const APP_HOST_SCOPE = "weldall:app-host";
export const SUBJECT_SCOPES_CHECK_SCOPE = "weldall:subject-scopes-check";
/** Weldall's login permission; a person without it must not be served. */
export const LOGIN_SCOPE = "weldall:login";
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
const branchSchema = text(255);
const auditId = z.string().regex(/^[A-Za-z0-9._:-]{1,191}$/);
const warningCode = z.string().regex(/^[a-z0-9_]{1,64}$/);

const repositoryRef = z
  .object({ owner: repositoryPartSchema, name: repositoryPartSchema })
  .strict();

// ---------------------------------------------------------------------------------------------
// App registry
// ---------------------------------------------------------------------------------------------

/** `POST /api/app-host/v1/apps`. */
export const appHostCreateAppRequestSchema = z
  .object({
    resource: appHostResourceSchema,
    /** The person who owns the app; must exist and hold {@link LOGIN_SCOPE}. */
    owner: weldallSubjectSchema,
    name: text(100),
    purpose: z.string().trim().min(1).max(300),
    repository: z
      .object({
        owner: repositoryPartSchema,
        name: repositoryPartSchema,
        id: repositoryIdSchema.nullable(),
        webUrl: appHostHttpsUrlSchema.nullable(),
      })
      .strict(),
    /** Branch nobody pushes to directly; changes reach it only through reviewed pull requests. */
    defaultBranch: branchSchema,
    /**
     * Template the repository starts from. Register with `commit: null` before the repository is
     * fully set up and set the commit with an update once it is: until then the app is not ready.
     */
    template: z
      .object({ name: text(100), commit: gitCommitIdSchema.nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type AppHostCreateAppRequest = z.input<typeof appHostCreateAppRequestSchema>;

/**
 * `PATCH /api/app-host/v1/apps/{id}`: omitted fields stay, a null link clears it. The repository
 * id can only be set once; a template commit only on a template app that has none yet. The expiry
 * and confirmation are the owner's and never change here.
 */
export const appHostUpdateAppRequestSchema = z
  .object({
    resource: appHostResourceSchema,
    repository: z
      .object({
        owner: repositoryPartSchema,
        name: repositoryPartSchema,
        id: repositoryIdSchema,
        webUrl: appHostHttpsUrlSchema.nullable(),
      })
      .partial()
      .strict()
      .optional(),
    defaultBranch: branchSchema.optional(),
    templateCommit: gitCommitIdSchema.optional(),
    links: z
      .object({
        preview: appHostHttpsUrlSchema.nullable(),
        live: appHostHttpsUrlSchema.nullable(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    ({ repository, defaultBranch, templateCommit, links }) =>
      (repository && Object.keys(repository).length > 0) ||
      defaultBranch !== undefined ||
      templateCommit !== undefined ||
      (links && Object.keys(links).length > 0),
    "at least one change is required",
  );
export type AppHostUpdateAppRequest = z.input<typeof appHostUpdateAppRequestSchema>;

/**
 * `POST /api/app-host/v1/apps/lookup`: by id or by repository (owner and name match
 * case-insensitively, as Git hosts treat them). With `subject`, the answer says whether that
 * person owns the app; an unknown person is `404 unknown_subject`.
 */
export const appHostLookupRequestSchema = z
  .object({
    resource: appHostResourceSchema,
    app: z.union([
      z.object({ id: appIdSchema }).strict(),
      z
        .object({ repositoryOwner: repositoryPartSchema, repositoryName: repositoryPartSchema })
        .strict(),
    ]),
    subject: weldallSubjectSchema.optional(),
  })
  .strict();
export type AppHostLookupRequest = z.input<typeof appHostLookupRequestSchema>;

const appState = z.enum(["active", "expiring_soon", "expired"]);
/** One app as Weldall returns it to its app host. Unknown fields are ignored for forward compatibility. */
export const appHostAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  owner: z.object({ id: z.string() }),
  /** Key of the resource the app belongs to. */
  resource: z.string(),
  repository: z.object({
    owner: z.string(),
    name: z.string(),
    id: z.string().nullable(),
    webUrl: z.string().nullable(),
  }),
  defaultBranch: z.string(),
  template: z.object({ name: z.string(), commit: z.string().nullable() }).nullable(),
  /** False while a template app has no template commit yet; refuse git traffic until it is true. */
  ready: z.boolean(),
  links: z.object({ preview: z.string().nullable(), live: z.string().nullable() }),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  expiresAt: z.string(),
  /** Re-verification state; an expired app is only flagged, never stopped. */
  state: appState,
});
export type AppHostApp = z.output<typeof appHostAppSchema>;

/** Answer to create: `created` is false when the same owner had already registered the repository. */
export const appHostCreateAppResponseSchema = z.object({
  created: z.boolean(),
  app: appHostAppSchema,
});
export const appHostAppResponseSchema = z.object({ app: appHostAppSchema });
export const appHostLookupResponseSchema = z.object({
  app: appHostAppSchema,
  /** Null when no subject was asked about. */
  ownedBySubject: z.boolean().nullable(),
});

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
 * Success events always concern a registered app and the person who acted, who must be the
 * app's owner (`403 subject_not_owner` otherwise).
 */
const success = <T extends AppHostAuditEventType>(eventType: T) =>
  z
    .object({
      ...envelope,
      eventType: z.literal(eventType),
      subject: weldallSubjectSchema,
      appId: appIdSchema,
      details: appHostAuditDetailsSchemas[eventType],
    })
    .strict();
/**
 * A rejection may happen before the person, app or repository is known. Give `appId` when the
 * app was resolved (Weldall then records its repository), otherwise the requested `repository`
 * if known. Without a subject, the reporting machine client is recorded as the actor.
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
    if ("appId" in report && "repository" in report && report.appId && report.repository)
      context.addIssue({
        code: "custom",
        path: ["repository"],
        message: "give either appId or repository, not both",
      });
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

/** `POST /api/authorization/v1/check-scopes`: `subject` is a Weldall user id. */
export const subjectScopeCheckResponseSchema = z.object({
  granted: z.array(z.string()),
  missing: z.array(z.string()),
  evaluatedAt: z.string(),
});
export type SubjectScopeCheckResponse = z.output<typeof subjectScopeCheckResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface WeldallAppHostClientOptions {
  /** Weldall's origin, e.g. `https://weldall.example.com`. */
  issuer: string;
  clientId: string;
  kid: string;
  key: DpopKeyPair;
  /** The app host's own resource identifier, sent with every request. */
  resource: string;
  fetch?: typeof globalThis.fetch;
}

type WithoutResource<T> = T extends unknown ? Omit<T, "resource"> : never;

/**
 * A small client for the endpoints above. It requests machine tokens for the Weldall API (one per
 * scope, reused until shortly before expiry), signs a DPoP proof per request and validates every
 * answer. A rejected request throws {@link WeldallAuthError} with Weldall's error code and status.
 */
export function createWeldallAppHostClient(options: WeldallAppHostClientOptions) {
  const issuer = new URL(options.issuer).origin;
  const fetcher = options.fetch ?? globalThis.fetch;
  const tokens = new Map<string, { accessToken: string; renewAt: number }>();

  async function token(scope: string): Promise<string> {
    const cached = tokens.get(scope);
    if (cached && cached.renewAt > Date.now()) return cached.accessToken;
    const issued = await requestMachineToken({
      issuer,
      clientId: options.clientId,
      resource: `${issuer}/api`,
      scopes: [scope],
      kid: options.kid,
      key: options.key,
      fetch: fetcher,
    });
    // Renew 30 seconds early so a token never expires in flight.
    tokens.set(scope, {
      accessToken: issued.accessToken,
      renewAt: Date.now() + Math.max(0, issued.expiresIn - 30) * 1_000,
    });
    return issued.accessToken;
  }

  async function call<T>(
    scope: string,
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<{ status: number; body: T }> {
    const url = `${issuer}${path}`;
    const accessToken = await token(scope);
    const proof = await createDpopProof({ ...options.key, method, url, accessToken });
    const response = await fetcher(url, {
      method,
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: proof,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok)
      throw new WeldallAuthError(
        typeof json?.error === "string" ? json.error : "server_error",
        typeof json?.error_description === "string"
          ? json.error_description
          : `Weldall answered ${response.status}`,
        response.status,
      );
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new WeldallAuthError("server_error", "invalid Weldall response", 502);
    return { status: response.status, body: parsed.data };
  }

  const withResource = <T extends object>(input: T) => ({ ...input, resource: options.resource });

  return {
    createApp: async (input: Omit<AppHostCreateAppRequest, "resource">) =>
      (
        await call(
          APP_HOST_SCOPE,
          "POST",
          `${APP_HOST_API_PATH}/apps`,
          withResource(input),
          appHostCreateAppResponseSchema,
        )
      ).body,
    updateApp: async (appId: string, input: Omit<AppHostUpdateAppRequest, "resource">) =>
      (
        await call(
          APP_HOST_SCOPE,
          "PATCH",
          `${APP_HOST_API_PATH}/apps/${encodeURIComponent(appId)}`,
          withResource(input),
          appHostAppResponseSchema,
        )
      ).body.app,
    lookupApp: async (input: Omit<AppHostLookupRequest, "resource">) =>
      (
        await call(
          APP_HOST_SCOPE,
          "POST",
          `${APP_HOST_API_PATH}/apps/lookup`,
          withResource(input),
          appHostLookupResponseSchema,
        )
      ).body,
    /** Resolves only when Weldall stored the entry; gate a push on `git_push.forwarded` with it. */
    reportAuditEvent: async (
      input: WithoutResource<AppHostAuditEventRequest>,
    ): Promise<AppHostAuditEventResponse> =>
      (
        await call(
          APP_HOST_SCOPE,
          "POST",
          `${APP_HOST_API_PATH}/audit-events`,
          withResource(input),
          appHostAuditEventResponseSchema,
        )
      ).body,
    /** Needs {@link SUBJECT_SCOPES_CHECK_SCOPE}; `503` means the answer is not authoritative now. */
    checkSubjectScopes: async (subject: string, scopes: readonly string[]) =>
      (
        await call(
          SUBJECT_SCOPES_CHECK_SCOPE,
          "POST",
          "/api/authorization/v1/check-scopes",
          { subject, scopes },
          subjectScopeCheckResponseSchema,
        )
      ).body,
  };
}
export type WeldallAppHostClient = ReturnType<typeof createWeldallAppHostClient>;
