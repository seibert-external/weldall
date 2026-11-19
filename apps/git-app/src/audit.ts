import { randomUUID } from "node:crypto";
import {
  APP_HOST_AUDIT_LIMITS,
  type AppHostAuditEventRequest,
  type AppHostAuditEventResponse,
} from "@weldall/sdk";
import { GitAppError } from "./errors.js";
import { truncateText } from "./git-text.js";
import { errorForLog, type Logger } from "./log.js";
import { redactCredentials } from "./redaction.js";
import {
  isTransientWeldallFailure,
  weldallCode,
  weldallFailure,
  type AppHostApi,
} from "./weldall.js";

type Report = AppHostAuditEventRequest extends infer T
  ? T extends unknown
    ? Omit<T, "resource" | "eventId">
    : never
  : never;
export type AuditReport = Report;
type RejectionType = Extract<Report, { reason: string }>["eventType"];
export type AuditRejection = Extract<Report, { eventType: RejectionType }>;

/** Free text for the audit log (reasons, branch and template names): redacted, bounded, never empty. */
const TEXT_LIMIT = 500;
export const auditText = (value: string) =>
  truncateText(
    redactCredentials(value)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim() || "-",
    TEXT_LIMIT,
  );

/** First entries of a list as the contract accepts them. */
export const auditList = <T>(values: readonly T[], limit: keyof typeof APP_HOST_AUDIT_LIMITS) =>
  values.slice(0, APP_HOST_AUDIT_LIMITS[limit]);

/**
 * Reports audit events to Weldall. A report gets one event id that is reused on its one retry
 * (Weldall stores it once). Only a stored entry resolves.
 */
export function createAuditReporter({
  weldall,
  log,
  eventId = () => randomUUID(),
}: {
  weldall: AppHostApi;
  log: Logger;
  eventId?: () => string;
}) {
  async function send(report: Report): Promise<AppHostAuditEventResponse> {
    const id = eventId();
    const request = { ...report, eventId: id } as Parameters<AppHostApi["reportAuditEvent"]>[0];
    try {
      return await weldall.reportAuditEvent(request);
    } catch (error) {
      // A rejection by Weldall is final; a lost answer or an outage is retried once, same id.
      if (!isTransientWeldallFailure(error)) throw error;
      return await weldall.reportAuditEvent(request);
    }
  }

  return {
    /**
     * Records a success event. Throws `audit_unavailable` (503) when Weldall did not store it,
     * so the caller can stop before the effect counts as done.
     */
    async success(report: Exclude<Report, AuditRejection>): Promise<void> {
      try {
        await send(report);
      } catch (error) {
        log("error", "audit report failed", { eventType: report.eventType, ...errorForLog(error) });
        const failure = weldallFailure(error, "record the audit entry");
        throw new GitAppError("audit_unavailable", failure.message, 503);
      }
    },
    /**
     * Records a denied or failed request. Best effort: the person gets the original error either
     * way, and a report that cannot be stored is logged. An unknown subject is reported again
     * without one (the Git app's machine client is then the actor), as the contract asks; an app
     * Weldall does not know for this resource (`not_found`: deleted, or another resource's) is
     * reported again without the app, naming `withoutApp.repository` instead (the contract takes
     * either an app or a repository).
     */
    async rejection(
      report: AuditRejection,
      withoutApp: { repository: { owner: string; name: string } | null } = { repository: null },
    ): Promise<void> {
      let pending = { ...report, reason: auditText(report.reason) } as AuditRejection;
      for (;;)
        try {
          await send(pending);
          return;
        } catch (error) {
          const code = weldallCode(error);
          if (code === "unknown_subject" && pending.subject !== null)
            pending = { ...pending, subject: null } as AuditRejection;
          else if (code === "not_found" && "appId" in pending && pending.appId !== null)
            pending = {
              ...pending,
              appId: null,
              repository: withoutApp.repository,
            } as AuditRejection;
          else {
            log("error", "audit report of a rejection failed", {
              eventType: report.eventType,
              ...errorForLog(error),
            });
            return;
          }
        }
    },
  };
}
export type AuditReporter = ReturnType<typeof createAuditReporter>;
