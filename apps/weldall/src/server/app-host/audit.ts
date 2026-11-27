import { isDeepStrictEqual } from "node:util";
import { db, Prisma } from "@weldall/db";
import { WeldallAuthError } from "@weldall/sdk";
import type { z } from "zod";
import {
  auditRequestIdentifiers,
  normalizeAuditMetadata,
  writeNormalizedAuditEvent,
  type AuditEventInput,
} from "../audit/service";
import { loggedOauthErrorResponse } from "../oauth/error-response";
import type { WeldallMachineActor } from "../oauth/machine-api";
import {
  appHostRequestBody,
  appHostResource,
  appHostSubject,
  authenticateAppHost,
  type AppHostResource,
} from "./caller";
import { appHostAuditEventRequestSchema } from "./contract";

/**
 * `POST /api/app-host/v1/audit-events`: an app host reports the audit events of its apps
 * (repository creation and registration, owner assignment, pushes, fetches, pull requests, git credentials, set-up
 * checks, re-verification) into Weldall's audit log, with the metadata schemas of
 * `audit/git-metadata.ts`. The contract is `./contract.ts`.
 *
 * - The person (`subject`, a Weldall user id) is the entry's actor; without one (only possible for
 *   rejections and checks) the machine client is. The reporting machine client is always recorded
 *   as the entry's `clientId`.
 * - The entry's subject is the app host's resource the machine client is allowed for. The app
 *   id and repository are taken from the report as they are: the app registry is the app host's,
 *   and the app host decides who may act on an app. Weldall keeps no app records to check them against.
 * - Free text is redacted for credentials and bounded by the metadata schemas.
 * - `eventId` makes the report idempotent: it becomes the entry's deduplication key (per
 *   resource). A repeated identical report answers `200` with `duplicate: true`; a different
 *   report under a used `eventId` is `409 event_id_conflict`.
 * - Only a 2xx answer means the entry is stored; an app host forwards a push only after its
 *   `git_push.forwarded` entry was accepted.
 */

type Report = z.output<typeof appHostAuditEventRequestSchema>;

const noStore = { "cache-control": "no-store", pragma: "no-cache" } as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function appHostReportAuditEvent(request: Request): Promise<Response> {
  const identifiers = auditRequestIdentifiers(request);
  try {
    const machine = await authenticateAppHost(request);
    const report = await appHostRequestBody(request, appHostAuditEventRequestSchema);
    const resource = await appHostResource(machine, report.resource);
    const event = await auditEntry(machine, resource, report, identifiers);
    let metadata: unknown;
    try {
      metadata = normalizeAuditMetadata(event.eventType, event.metadata);
    } catch {
      throw new WeldallAuthError("invalid_request", "the event does not fit its audit schema");
    }
    let duplicate = false;
    try {
      await writeNormalizedAuditEvent(event, metadata);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      duplicate = true;
    }
    const stored = await db.auditEvent.findUnique({
      where: { deduplicationKey: event.deduplicationKey! },
    });
    if (!stored) throw new Error("Reported audit event was not stored.");
    if (duplicate && !sameEntry(stored, event, metadata))
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
  machine: WeldallMachineActor,
  resource: AppHostResource,
  report: Report,
  identifiers: ReturnType<typeof auditRequestIdentifiers>,
): Promise<AuditEventInput & { deduplicationKey: string }> {
  const person = report.subject === null ? null : await appHostSubject(report.subject);
  const repository = report.repository;
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
          appId: report.appId,
          ...(rejected ? { reason: report.reason } : {}),
          ...report.details,
        };
  const outcome = report.eventType.endsWith(".denied")
    ? "denied"
    : report.eventType.endsWith(".failed")
      ? "failed"
      : "success";
  return {
    eventType: report.eventType,
    ...(person
      ? { actorType: "user" as const, actorId: person.id, actorEmail: person.email }
      : { actorType: "machine" as const, actorId: machine.clientId }),
    clientId: machine.clientId,
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
    subjectType: "resource",
    subjectId: resource.id,
    metadata,
  };
}

/**
 * Whether a stored entry records the same event as a repeated report (request ids aside);
 * `metadata` is the report's metadata as normalised for storage.
 */
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
  metadata: unknown,
): boolean {
  return (
    stored.eventType === event.eventType &&
    stored.actorType === event.actorType &&
    stored.actorId === event.actorId &&
    stored.outcome === event.outcome &&
    stored.reasonCode === (event.reasonCode ?? null) &&
    stored.subjectType === (event.subjectType ?? null) &&
    stored.subjectId === (event.subjectId ?? null) &&
    isDeepStrictEqual(stored.metadata, metadata)
  );
}
