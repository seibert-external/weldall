import { isDeepStrictEqual } from "node:util";
import { db } from "@weldall/db";
import { appHostAuditEventRequestSchema, WeldallAuthError } from "@weldall/sdk";
import type { z } from "zod";
import {
  auditRequestIdentifiers,
  normalizeAuditMetadata,
  prismaAuditWriter,
  type AuditEventInput,
} from "../audit/service";
import { loggedOauthErrorResponse } from "../oauth/error-response";
import {
  appHostRequestBody,
  appHostResource,
  appHostSubject,
  authenticateAppHost,
  isUniqueViolation,
  noStore,
  type AppHostCaller,
  type AppHostResource,
} from "./caller";

/**
 * `POST /api/app-host/v1/audit-events`: a Git app reports the Git audit events of its apps
 * (repository creation, pushes, fetches, pull requests, git credentials, set-up checks) into
 * Weldall's audit log. The events and their metadata are the ones the in-server Git host path
 * writes, with `resourceId` in place of `connectorId`.
 *
 * - The person (`subject`, a Weldall user id) is the entry's actor; without one (only possible for
 *   rejections and checks) the machine client is. The reporting machine client is always recorded
 *   as the entry's `clientId`.
 * - Only apps of the resource the machine client is allowed for can be named.
 * - Free text is redacted for credentials and bounded exactly like the in-server entries.
 * - `eventId` makes the report idempotent: it becomes the entry's deduplication key (per
 *   resource). A repeated identical report answers `200` with `duplicate: true`; a different
 *   report under a used `eventId` is `409 event_id_conflict`.
 * - Only a 2xx answer means the entry is stored; a Git app forwards a push only after its
 *   `git_push.forwarded` entry was accepted.
 */

type Report = z.output<typeof appHostAuditEventRequestSchema>;

/**
 * Who may be recorded as having done something to an app. A person publishes only to apps they
 * own, so a success event that names an app must name its owner; rejections may name anyone (or
 * nobody), since they record what was refused. The one place to widen this (e.g. collaborators).
 */
export function assertMayReport({
  outcome,
  person,
  app,
}: {
  outcome: "success" | "denied" | "failed";
  person: { id: string } | null;
  app: { ownerId: string } | null;
}): void {
  if (outcome === "success" && app && person?.id !== app.ownerId)
    throw new WeldallAuthError(
      "subject_not_owner",
      "a successful event on an app must name the app's owner as subject",
      403,
    );
}

export async function appHostReportAuditEvent(request: Request): Promise<Response> {
  const identifiers = auditRequestIdentifiers(request);
  try {
    const caller = await authenticateAppHost(request);
    const report = await appHostRequestBody(request, appHostAuditEventRequestSchema);
    const resource = await appHostResource(caller, report.resource);
    const event = await auditEntry(caller, resource, report, identifiers);
    try {
      normalizeAuditMetadata(event.eventType, event.metadata);
    } catch {
      throw new WeldallAuthError("invalid_request", "the event does not fit its audit schema");
    }
    let duplicate = false;
    try {
      await prismaAuditWriter.write(event);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      duplicate = true;
    }
    const stored = await db.auditEvent.findUnique({
      where: { deduplicationKey: event.deduplicationKey! },
    });
    if (!stored) throw new Error("Reported audit event was not stored.");
    if (duplicate && !sameEntry(stored, event))
      throw new WeldallAuthError(
        "event_id_conflict",
        "a different event was already reported under this eventId",
        409,
      );
    return Response.json(
      {
        accepted: true,
        eventId: report.eventId,
        auditEventId: stored.id,
        duplicate,
        recordedAt: stored.occurredAt.toISOString(),
      },
      { status: duplicate ? 200 : 201, headers: noStore },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

async function auditEntry(
  caller: AppHostCaller,
  resource: AppHostResource,
  report: Report,
  identifiers: ReturnType<typeof auditRequestIdentifiers>,
): Promise<AuditEventInput & { deduplicationKey: string }> {
  const person = report.subject === null ? null : await appHostSubject(report.subject);
  const app =
    "appId" in report && report.appId !== null
      ? await db.app.findFirst({
          where: { id: report.appId, resourceId: resource.id },
          select: { id: true, ownerId: true, repositoryOwner: true, repositoryName: true },
        })
      : null;
  if ("appId" in report && report.appId !== null && !app)
    throw new WeldallAuthError("not_found", "no app of this resource has this id", 404);
  const repository = app
    ? { owner: app.repositoryOwner, name: app.repositoryName }
    : "repository" in report
      ? report.repository
      : null;
  const target = {
    resourceId: resource.id,
    repositoryOwner: repository?.owner ?? null,
    repositoryName: repository?.name ?? null,
  };
  const rejected = "reason" in report;
  const metadata =
    report.eventType === "git_host.checked"
      ? { ...target, ...report.details }
      : {
          ...target,
          appId: app?.id ?? null,
          ...(rejected ? { reason: report.reason } : {}),
          ...report.details,
        };
  const outcome = report.eventType.endsWith(".denied")
    ? "denied"
    : report.eventType.endsWith(".failed")
      ? "failed"
      : "success";
  assertMayReport({ outcome, person, app });
  return {
    eventType: report.eventType,
    ...(person
      ? { actorType: "user" as const, actorId: person.id, actorEmail: person.email }
      : { actorType: "machine" as const, actorId: caller.machine.clientId }),
    clientId: caller.machine.clientId,
    ...identifiers,
    deduplicationKey: `app-host:${resource.id}:${report.eventId}`,
    outcome,
    ...(outcome === "success"
      ? {}
      : {
          reasonCode:
            ("reasonCode" in report ? report.reasonCode : undefined) ??
            (outcome === "denied" ? "invalid_request" : "internal_error"),
        }),
    ...(app
      ? { subjectType: "app", subjectId: app.id }
      : { subjectType: "resource", subjectId: resource.id }),
    metadata,
  };
}

/** Whether a stored entry records the same event as a repeated report (request ids aside). */
function sameEntry(
  stored: {
    eventType: string;
    actorType: string;
    actorId: string;
    outcome: string;
    reasonCode: string | null;
    subjectType: string | null;
    subjectId: string | null;
    metadata: unknown;
  },
  event: AuditEventInput,
): boolean {
  return (
    stored.eventType === event.eventType &&
    stored.actorType === event.actorType &&
    stored.actorId === event.actorId &&
    stored.outcome === event.outcome &&
    stored.reasonCode === (event.reasonCode ?? null) &&
    stored.subjectType === (event.subjectType ?? null) &&
    stored.subjectId === (event.subjectId ?? null) &&
    isDeepStrictEqual(stored.metadata, normalizeAuditMetadata(event.eventType, event.metadata))
  );
}
